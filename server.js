// PTT 原型伺服器（第二階段）
// - HTTP：靜態檔、登入 API、管理後台 API、位置 API
// - WebSocket：信令、語音即時轉發（不保存錄音）、floor control（含優先搶話）、位置、緊急警報
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./lib/store');
const A = require('./lib/auth');

const PORT = +process.env.PORT || 8800;
const PUB = path.join(__dirname, 'public');
const SAMPLE_RATE = 16000;
const MAX_TALK_MS = 60000;
const STALL_MS = 3000;
const SESSION_DAYS = 30;

// 頻道角色：主管 > 一般 > 只聽（只聽不能講）；警報中的發送者 = 100（最高）
const CH_ROLES = { supervisor: { label: '主管', prio: 3, talk: true }, member: { label: '一般', prio: 2, talk: true }, listener: { label: '只聽', prio: 0, talk: false } };
const ALERT_PRIO = 100;

const store = new Store({ databaseUrl: process.env.DATABASE_URL || '', dataDir: process.env.DATA_DIR || path.join(__dirname, 'data') });
const D = () => store.doc;
const now = () => Date.now();
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const cleanName = (s, n = 20) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const validUsername = (s) => /^[a-zA-Z0-9_.-]{3,32}$/.test(s || '');
const dmKey = (a, b) => 'dm:' + [a, b].sort().join(':');
const isDm = (c) => typeof c === 'string' && c.startsWith('dm:');
const dmParts = (c) => c.slice(3).split(':');

// ---------- 帳號 / 頻道 ----------
const userById = (id) => D().users.find(u => u.id === id);
const userByName = (n) => D().users.find(u => u.username.toLowerCase() === String(n || '').toLowerCase());
const chById = (id) => D().channels.find(c => c.id === id);
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt });
const nameOf = (id) => { const u = userById(id); return u ? u.displayName : '?'; };
function roleIn(u, ch) {
  if (!u || !ch || u.disabled) return null;
  if (ch.members[u.id]) return ch.members[u.id];
  if (u.role === 'admin') return 'supervisor';
  if (ch.open) return 'member';
  return null;
}
function ensureLobby() { if (!chById('lobby')) D().channels.unshift({ id: 'lobby', name: '大廳', open: true, members: {}, createdAt: now() }); }
async function seedAdmin() {
  const un = process.env.ADMIN_USERNAME, pw = process.env.ADMIN_PASSWORD;
  if (!un || !pw) { if (!D().users.some(u => u.role === 'admin')) console.warn('[seed] 沒有管理員，請設定 ADMIN_USERNAME / ADMIN_PASSWORD'); return; }
  let u = userByName(un);
  if (!u) { u = { id: 'u' + uid(6), username: un, displayName: process.env.ADMIN_DISPLAY_NAME || '管理員', role: 'admin', passHash: A.hashPassword(pw), createdAt: now() }; D().users.push(u); console.log('[seed] 已建立管理員', un); }
  else {
    u.role = 'admin'; u.disabled = false;
    if (process.env.ADMIN_RESET_PASSWORD === '1' || !A.verifyPassword(pw, u.passHash)) {
      // 以環境變數為準：遺失密碼時只要改 Render 環境變數再重啟即可
      u.passHash = A.hashPassword(pw); for (const [k, s] of Object.entries(D().sessions)) if (s.userId === u.id) delete D().sessions[k];
      console.log('[seed] 已依環境變數更新管理員密碼');
    }
  }
}

// ---------- Session ----------
async function createSession(u) {
  const token = A.newToken();
  D().sessions[A.sha256(token)] = { userId: u.id, exp: now() + SESSION_DAYS * 864e5, createdAt: now() };
  await store.save();
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = D().sessions[A.sha256(String(token))];
  if (!s || s.exp < now()) return null;
  const u = userById(s.userId);
  return u && !u.disabled ? u : null;
}
function revokeSessions(userId) { for (const [k, s] of Object.entries(D().sessions)) if (s.userId === userId) delete D().sessions[k]; }
setInterval(() => { let ch = false; for (const [k, s] of Object.entries(D().sessions)) if (s.exp < now()) { delete D().sessions[k]; ch = true; } if (ch) store.save().catch(() => {}); }, 3600e3);

// ---------- 線上狀態（只在記憶體）----------
/** userId -> { sockets:Set<ws>, channel } */
const online = new Map();
/** conv -> { userId, ws, streamId, prio, bytes, startedAt, lastAudio, timer } */
const floors = new Map();
/** conv -> { from, fromName, toName, ts, durMs }：純文字的最近說話者 */
const lastTalk = new Map();
/** userId -> { lat, lng, acc, battery, charging, ts }：只留最新一筆，不做軌跡 */
const locations = new Map();
/** alertId -> { id, userId, name, channel, channelName, lat, lng, acc, ts, notified:Set } */
const alerts = new Map();
let streamSeq = 1;

const isOnline = (id) => { const o = online.get(id); return !!(o && o.sockets.size); };
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendUser(id, obj) { const o = online.get(id); if (o) for (const s of o.sockets) send(s, obj); }
function channelOf(id) { const o = online.get(id); return o ? o.channel : null; }
function membersOf(chId) {
  const ch = chById(chId); if (!ch) return [];
  return [...online.entries()].filter(([id, o]) => o.channel === chId && o.sockets.size).map(([id]) => ({ id, name: nameOf(id), role: roleIn(userById(id), ch) }));
}
function onlineList() { return [...online.entries()].filter(([id, o]) => o.sockets.size && userById(id)).map(([id, o]) => ({ id, name: nameOf(id), channel: o.channel })); }
function recipients(conv) {
  if (isDm(conv)) return dmParts(conv).filter(isOnline);
  return [...online.entries()].filter(([, o]) => o.channel === conv).map(([id]) => id);
}
function broadcastConv(conv, obj, except) { for (const id of recipients(conv)) if (id !== except) sendUser(id, obj); }
function broadcastPresence(chId) { if (chId) broadcastConv(chId, { t: 'members', channel: chId, members: membersOf(chId) }); }
function broadcastOnline() { const list = onlineList(); for (const id of online.keys()) sendUser(id, { t: 'online', online: list }); }
function channelsFor(u) {
  return D().channels.filter(c => roleIn(u, c)).map(c => {
    const r = roleIn(u, c); const lt = lastTalk.get(c.id);
    return { id: c.id, name: c.name, open: !!c.open, myRole: r, myRoleLabel: CH_ROLES[r].label, canTalk: CH_ROLES[r].talk, online: membersOf(c.id).length, last: lt ? lt.ts : 0, lastTalk: lt || null };
  });
}
function pushChannels(id) { const u = userById(id); if (u) sendUser(id, { t: 'channels', channels: channelsFor(u) }); }
function pushChannelsAll() { for (const id of online.keys()) pushChannels(id); }
function dmSummaries(userId) {
  return [...lastTalk.entries()].filter(([c]) => isDm(c) && dmParts(c).includes(userId)).map(([conv, m]) => {
    const other = dmParts(conv).find(x => x !== userId) || userId;
    return { conv, peerId: other, peerName: nameOf(other), last: m.ts, lastTalk: m };
  });
}
function kick(userId, code = 4003, reason = 'revoked') { const o = online.get(userId); if (o) for (const s of [...o.sockets]) { send(s, { t: 'auth_failed', reason }); s.close(code, reason); } }

// 使用者失去目前頻道權限時，移回大廳
function enforceAccess(userId) {
  const u = userById(userId); const o = online.get(userId); if (!o) return;
  if (!u || u.disabled) return kick(userId);
  if (o.channel && !roleIn(u, chById(o.channel))) {
    const prev = o.channel; o.channel = roleIn(u, chById('lobby')) ? 'lobby' : null;
    for (const [conv, f] of floors) if (f.userId === userId && conv === prev) endFloor(conv, 'left');
    sendUser(userId, { t: 'joined', channel: o.channel, reason: 'access_changed' });
    broadcastPresence(prev); broadcastPresence(o.channel);
  }
  pushChannels(userId);
  if (o.channel) broadcastPresence(o.channel);
}

// ---------- Floor control（含優先搶話）----------
function activeAlertOf(userId) { for (const a of alerts.values()) if (a.userId === userId) return a; return null; }
function prioFor(u, conv) {
  if (activeAlertOf(u.id)) return ALERT_PRIO;
  if (isDm(conv)) return CH_ROLES.member.prio;
  const r = roleIn(u, chById(conv)); return r ? CH_ROLES[r].prio : -1;
}
function endFloor(conv, reason, extra = {}) {
  const f = floors.get(conv); if (!f) return;
  floors.delete(conv); clearTimeout(f.timer);
  if (f.ws.talking === conv) f.ws.talking = null;
  let info = null;
  if (f.bytes > 0) {
    let toName; if (isDm(conv)) toName = nameOf(dmParts(conv).find(x => x !== f.userId));
    info = { from: f.userId, fromName: nameOf(f.userId), toName, ts: f.startedAt, durMs: Math.round(f.bytes / 2 / SAMPLE_RATE * 1000) };
    lastTalk.set(conv, info);
  }
  broadcastConv(conv, { t: 'talk_end', conv, streamId: f.streamId, from: f.userId, reason, lastTalk: info, ...extra });
  if (info && !isDm(conv)) for (const id of online.keys()) { const u = userById(id); if (u && roleIn(u, chById(conv))) sendUser(id, { t: 'channel_activity', channel: conv, last: info.ts, lastTalk: info }); }
}

// ---------- 位置可見範圍 ----------
function canSeeLoc(viewer, targetId) {
  if (!viewer) return false;
  if (viewer.role === 'admin' || viewer.id === targetId) return true;
  const vc = channelOf(viewer.id); return !!vc && vc === channelOf(targetId);
}
function locEntry(id) {
  const l = locations.get(id); if (!l) return null;
  return { id, name: nameOf(id), online: isOnline(id), channel: channelOf(id), channelName: chById(channelOf(id))?.name || '', ...l };
}
function locsFor(viewer) { return [...locations.keys()].filter(id => userById(id) && canSeeLoc(viewer, id)).map(locEntry); }
function pushLocTo(targetId) { const e = locEntry(targetId); if (!e) return; for (const id of online.keys()) if (canSeeLoc(userById(id), targetId)) sendUser(id, { t: 'loc', loc: e }); }
function pushAllLocs(id) { const u = userById(id); if (u) sendUser(id, { t: 'locs', locs: locsFor(u) }); }

// ---------- 緊急警報 ----------
function alertAudience(a) {
  const ids = new Set([a.userId]);
  for (const [id, o] of online) { const u = userById(id); if (!u) continue; if (u.role === 'admin' || (a.channel && o.channel === a.channel)) ids.add(id); }
  return ids;
}
function alertView(a) { const { notified, ...rest } = a; return rest; }
function alertsVisibleTo(u) { return [...alerts.values()].filter(a => u.role === 'admin' || a.userId === u.id || (a.channel && channelOf(u.id) === a.channel)).map(alertView); }
function startAlert(u, m) {
  let a = activeAlertOf(u.id);
  const ch = channelOf(u.id);
  const pos = (typeof m.lat === 'number' && typeof m.lng === 'number') ? { lat: m.lat, lng: m.lng, acc: m.acc || null } : (locations.get(u.id) ? { lat: locations.get(u.id).lat, lng: locations.get(u.id).lng, acc: locations.get(u.id).acc } : { lat: null, lng: null, acc: null });
  if (!a) { a = { id: 'a' + uid(6), userId: u.id, name: u.displayName, channel: ch, channelName: chById(ch)?.name || '', ts: now(), notified: new Set(), ...pos }; alerts.set(a.id, a); }
  else Object.assign(a, pos);
  if (pos.lat != null) { locations.set(u.id, { ...(locations.get(u.id) || {}), lat: pos.lat, lng: pos.lng, acc: pos.acc, ts: now() }); }
  for (const id of alertAudience(a)) { a.notified.add(id); sendUser(id, { t: 'alert', alert: alertView(a) }); }
  console.log('[alert] start', a.id, u.username);
  return a;
}
function endAlert(a, byUser) {
  alerts.delete(a.id);
  const ids = new Set([...a.notified, ...alertAudience(a)]);
  for (const id of ids) sendUser(id, { t: 'alert_end', id: a.id, by: byUser ? byUser.displayName : '系統' });
  console.log('[alert] end', a.id, byUser && byUser.username);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { resolve(null); } });
  });
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }
const loginFails = new Map(); // key -> {n, until}
function rateLimited(key) { const r = loginFails.get(key); return r && r.n >= 10 && r.until > now(); }
function noteFail(key) { const r = loginFails.get(key) || { n: 0, until: 0 }; if (r.until < now()) r.n = 0; r.n++; r.until = now() + 10 * 60e3; loginFails.set(key, r); }

async function api(req, res, p, url) {
  const method = req.method;
  if (p === '/api/health') return json(res, 200, { ok: true, storage: store.kind, online: onlineList().length, channels: D().channels.length, users: D().users.length, activeTalks: floors.size, activeAlerts: alerts.size, storesAudio: false });
  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'bad_request' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + String(b.username || '').toLowerCase();
    if (rateLimited(key)) return json(res, 429, { error: 'too_many_attempts', message: '嘗試次數過多，請 10 分鐘後再試' });
    const u = userByName(b.username);
    if (!u || !A.verifyPassword(b.password || '', u.passHash)) { noteFail(key); return json(res, 401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' }); }
    if (u.disabled) return json(res, 403, { error: 'disabled', message: '此帳號已停用' });
    loginFails.delete(key);
    return json(res, 200, { token: await createSession(u), user: publicUser(u) });
  }
  const me = userFromToken(bearer(req));
  if (!me) return json(res, 401, { error: 'unauthorized', message: '請先登入' });
  if (p === '/api/logout' && method === 'POST') { delete D().sessions[A.sha256(bearer(req))]; await store.save(); return json(res, 200, { ok: true }); }
  if (p === '/api/me') return json(res, 200, { user: publicUser(me), channels: channelsFor(me) });
  if (p === '/api/me/password' && method === 'POST') {
    const b = await readBody(req); if (!b || !A.verifyPassword(b.oldPassword || '', me.passHash)) return json(res, 400, { error: 'wrong_password', message: '舊密碼錯誤' });
    if (String(b.newPassword || '').length < 8) return json(res, 400, { error: 'weak_password', message: '新密碼至少 8 個字元' });
    me.passHash = A.hashPassword(b.newPassword); await store.save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/locations') return json(res, 200, { locations: locsFor(me) });
  if (p === '/api/alerts') return json(res, 200, { alerts: alertsVisibleTo(me) });

  // ----- 管理後台 -----
  if (!p.startsWith('/api/admin/')) return json(res, 404, { error: 'not_found' });
  if (me.role !== 'admin') return json(res, 403, { error: 'forbidden', message: '需要管理員權限' });
  const seg = p.split('/').slice(3); // ['users', id?] ...
  const b = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};
  if (b === null) return json(res, 400, { error: 'bad_request' });

  if (seg[0] === 'users') {
    if (!seg[1] && method === 'GET') return json(res, 200, { users: D().users.map(u => ({ ...publicUser(u), online: isOnline(u.id), channel: channelOf(u.id) })) });
    if (!seg[1] && method === 'POST') {
      const username = String(b.username || '').trim();
      if (!validUsername(username)) return json(res, 400, { error: 'bad_username', message: '帳號需 3–32 個英數字或 _ . -' });
      if (userByName(username)) return json(res, 409, { error: 'exists', message: '帳號已存在' });
      let password = b.password ? String(b.password) : ''; let generated = false;
      if (!password) { password = A.genPassword(); generated = true; }
      if (password.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
      const u = { id: 'u' + uid(6), username, displayName: cleanName(b.displayName) || username, role: b.role === 'admin' ? 'admin' : 'user', passHash: A.hashPassword(password), createdAt: now() };
      D().users.push(u); await store.save();
      return json(res, 201, { user: publicUser(u), password: generated ? password : undefined });
    }
    const u = userById(seg[1]); if (!u) return json(res, 404, { error: 'not_found' });
    if (method === 'PATCH') {
      if (u.id === me.id && (b.disabled === true || (b.role && b.role !== 'admin'))) return json(res, 400, { error: 'self_lockout', message: '不能停用自己或移除自己的管理員權限' });
      if (b.displayName !== undefined) u.displayName = cleanName(b.displayName) || u.displayName;
      if (b.role === 'admin' || b.role === 'user') u.role = b.role;
      let password;
      if (b.resetPassword || b.password) {
        password = b.password ? String(b.password) : A.genPassword();
        if (password.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
        u.passHash = A.hashPassword(password); revokeSessions(u.id);
      }
      if (b.disabled !== undefined) { u.disabled = !!b.disabled; if (u.disabled) revokeSessions(u.id); }
      await store.save();
      if (u.disabled || password) kick(u.id); else enforceAccess(u.id);
      return json(res, 200, { user: publicUser(u), password: (b.resetPassword && !b.password) ? password : undefined });
    }
    if (method === 'DELETE') {
      if (u.id === me.id) return json(res, 400, { error: 'self_lockout', message: '不能刪除自己' });
      D().users = D().users.filter(x => x.id !== u.id); revokeSessions(u.id);
      for (const c of D().channels) delete c.members[u.id];
      locations.delete(u.id); await store.save(); kick(u.id); online.delete(u.id); broadcastOnline();
      return json(res, 200, { ok: true });
    }
  }
  if (seg[0] === 'channels') {
    if (!seg[1] && method === 'GET') return json(res, 200, { channels: D().channels.map(c => ({ id: c.id, name: c.name, open: !!c.open, members: Object.entries(c.members).map(([id, role]) => ({ id, name: nameOf(id), role })), online: membersOf(c.id).length })) });
    if (!seg[1] && method === 'POST') {
      const name = cleanName(b.name, 30); if (!name) return json(res, 400, { error: 'bad_name', message: '請輸入頻道名稱' });
      if (D().channels.some(c => c.name === name)) return json(res, 409, { error: 'exists', message: '頻道名稱已存在' });
      const c = { id: 'c' + uid(4), name, open: !!b.open, members: {}, createdAt: now() };
      D().channels.push(c); await store.save(); pushChannelsAll();
      return json(res, 201, { channel: c });
    }
    const c = chById(seg[1]); if (!c) return json(res, 404, { error: 'not_found' });
    if (!seg[2] && method === 'PATCH') {
      if (b.name !== undefined) c.name = cleanName(b.name, 30) || c.name;
      if (b.open !== undefined) c.open = !!b.open;
      await store.save(); for (const id of online.keys()) enforceAccess(id);
      return json(res, 200, { channel: c });
    }
    if (!seg[2] && method === 'DELETE') {
      if (c.id === 'lobby') return json(res, 400, { error: 'protected', message: '大廳不能刪除' });
      endFloor(c.id, 'deleted');
      D().channels = D().channels.filter(x => x.id !== c.id); lastTalk.delete(c.id); await store.save();
      for (const id of online.keys()) enforceAccess(id);
      return json(res, 200, { ok: true });
    }
    if (seg[2] === 'members' && seg[3]) {
      const u = userById(seg[3]); if (!u) return json(res, 404, { error: 'no_user' });
      if (method === 'PUT') { if (!CH_ROLES[b.role]) return json(res, 400, { error: 'bad_role', message: '角色需為 supervisor / member / listener' }); c.members[u.id] = b.role; }
      else if (method === 'DELETE') delete c.members[u.id];
      else return json(res, 405, { error: 'method' });
      await store.save(); enforceAccess(u.id);
      return json(res, 200, { ok: true, members: c.members });
    }
  }
  if (seg[0] === 'alerts') {
    if (!seg[1] && method === 'GET') return json(res, 200, { alerts: [...alerts.values()].map(alertView) });
    if (seg[1] && seg[2] === 'resolve' && method === 'POST') { const a = alerts.get(seg[1]); if (!a) return json(res, 404, { error: 'not_found' }); endAlert(a, me); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, p, url);
    if (p.startsWith('/audio/')) return json(res, 404, { error: 'not_found' }); // 不保存錄音
    let rel = p === '/' ? 'index.html' : p === '/admin' || p === '/admin/' ? 'admin.html' : p.slice(1);
    let f = path.normalize(path.join(PUB, rel));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server_error' }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (ws) => {
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  ws.talking = null;
  let me = null;
  const authTimer = setTimeout(() => { if (!me) ws.close(4001, 'auth_timeout'); }, 10000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!me || !ws.talking) return;
      const fl = floors.get(ws.talking);
      if (!fl || fl.ws !== ws) return;
      const buf = Buffer.from(data);
      if (fl.bytes + buf.length > SAMPLE_RATE * 2 * (MAX_TALK_MS / 1000 + 1)) return;
      fl.bytes += buf.length; fl.lastAudio = now(); // 只計長度，不保留音訊
      const out = Buffer.allocUnsafe(4 + buf.length); out.writeUInt32BE(fl.streamId, 0); buf.copy(out, 4);
      for (const id of recipients(ws.talking)) if (id !== me.id) { const o = online.get(id); for (const s of o.sockets) if (s.readyState === 1) s.send(out); }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'hello') {
      const u = userFromToken(m.token);
      if (!u) { send(ws, { t: 'auth_failed', reason: 'invalid_token' }); return ws.close(4001, 'auth'); }
      clearTimeout(authTimer);
      me = u; ws.userId = u.id;
      let o = online.get(u.id); if (!o) { o = { sockets: new Set(), channel: null }; online.set(u.id, o); }
      o.sockets.add(ws);
      send(ws, { t: 'welcome', user: publicUser(u), channels: channelsFor(u), dms: dmSummaries(u.id), online: onlineList(), alerts: alertsVisibleTo(u), roles: CH_ROLES, serverTime: now() });
      if (o.channel) { send(ws, { t: 'joined', channel: o.channel }); broadcastPresence(o.channel); }
      broadcastOnline();
      for (const [conv, f] of floors) if (recipients(conv).includes(u.id) && f.userId !== u.id) send(ws, { t: 'talk_start', conv, streamId: f.streamId, from: f.userId, fromName: nameOf(f.userId), prio: f.prio });
      return;
    }
    if (!me) return send(ws, { t: 'auth_failed', reason: 'not_logged_in' });
    me = userById(me.id);
    if (!me || me.disabled) { send(ws, { t: 'auth_failed', reason: 'revoked' }); return ws.close(4003, 'revoked'); }
    const o = online.get(me.id);
    switch (m.t) {
      case 'join': {
        const ch = chById(m.channel);
        if (!ch || !roleIn(me, ch)) return send(ws, { t: 'error', code: 'no_access', msg: '你沒有這個頻道的權限' });
        const prev = o.channel; o.channel = ch.id;
        if (prev && prev !== ch.id) { for (const s of o.sockets) if (s.talking === prev) endFloor(prev, 'left'); broadcastPresence(prev); }
        for (const s of o.sockets) send(s, { t: 'joined', channel: ch.id, myRole: roleIn(me, ch) });
        broadcastPresence(ch.id); pushChannelsAll(); broadcastOnline();
        const f = floors.get(ch.id);
        if (f && f.userId !== me.id) send(ws, { t: 'talk_start', conv: ch.id, streamId: f.streamId, from: f.userId, fromName: nameOf(f.userId), prio: f.prio });
        for (const a of alerts.values()) if (a.channel === ch.id && !a.notified.has(me.id)) { a.notified.add(me.id); send(ws, { t: 'alert', alert: alertView(a) }); }
        // 位置可見範圍隨頻道改變
        pushAllLocs(me.id); if (locations.has(me.id)) pushLocTo(me.id);
        break;
      }
      case 'ptt_start': {
        let conv = m.conv;
        if (m.to) {
          const peer = userById(m.to);
          if (!peer || peer.disabled || peer.id === me.id) return send(ws, { t: 'floor_denied', conv: null, reason: 'no_access' });
          conv = dmKey(me.id, peer.id);
          if (!isOnline(peer.id)) return send(ws, { t: 'floor_denied', conv, reason: 'offline', byName: peer.displayName });
        } else {
          const ch = chById(conv); const r = roleIn(me, ch);
          if (!ch || !r || o.channel !== conv) return send(ws, { t: 'floor_denied', conv, reason: 'no_access' });
          if (!CH_ROLES[r].talk && !activeAlertOf(me.id)) return send(ws, { t: 'floor_denied', conv, reason: 'listen_only' });
        }
        if (ws.talking && ws.talking !== conv) endFloor(ws.talking, 'switch');
        const prio = prioFor(me, conv);
        const cur = floors.get(conv);
        if (cur && cur.userId !== me.id) {
          if (prio > cur.prio) {
            // 優先搶話：中斷較低優先權者
            send(cur.ws, { t: 'floor_revoked', conv, reason: 'preempted', byName: me.displayName, by: me.id });
            endFloor(conv, 'preempted', { by: me.id, byName: me.displayName });
          } else return send(ws, { t: 'floor_denied', conv, reason: 'busy', by: cur.userId, byName: nameOf(cur.userId) });
        } else if (cur) endFloor(conv, 'restart');
        const f = { userId: me.id, ws, streamId: streamSeq++, prio, bytes: 0, startedAt: now(), lastAudio: now() };
        f.timer = setTimeout(() => { if (floors.get(conv) === f) { endFloor(conv, 'timeout'); send(ws, { t: 'floor_revoked', conv, reason: 'timeout' }); } }, MAX_TALK_MS);
        floors.set(conv, f); ws.talking = conv;
        send(ws, { t: 'floor_granted', conv, streamId: f.streamId, prio, maxMs: MAX_TALK_MS });
        broadcastConv(conv, { t: 'talk_start', conv, streamId: f.streamId, from: me.id, fromName: me.displayName, prio, toName: isDm(conv) ? nameOf(dmParts(conv).find(x => x !== me.id)) : undefined }, me.id);
        break;
      }
      case 'ptt_stop': { if (ws.talking) { const f = floors.get(ws.talking); if (f && f.ws === ws) endFloor(ws.talking, 'released'); ws.talking = null; } break; }
      case 'loc': {
        const lat = +m.lat, lng = +m.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        const prev = locations.get(me.id);
        if (prev && now() - prev.ts < 2000) return; // 節流
        const battery = (typeof m.battery === 'number' && m.battery >= 0 && m.battery <= 1) ? Math.round(m.battery * 100) : null;
        locations.set(me.id, { lat, lng, acc: isFinite(+m.acc) ? Math.round(+m.acc) : null, battery, charging: typeof m.charging === 'boolean' ? m.charging : null, ts: now() });
        pushLocTo(me.id);
        break;
      }
      case 'loc_off': { locations.delete(me.id); for (const id of online.keys()) sendUser(id, { t: 'loc_remove', id: me.id }); break; }
      case 'get_locs': pushAllLocs(me.id); break;
      case 'alert_start': startAlert(me, m); break;
      case 'alert_resolve': {
        const a = alerts.get(m.id);
        if (!a) return send(ws, { t: 'error', code: 'no_alert', msg: '警報已結束' });
        if (me.role !== 'admin' && a.userId !== me.id) return send(ws, { t: 'error', code: 'forbidden', msg: '只有管理員或發送者可以解除警報' });
        endAlert(a, me); break;
      }
      case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.talking) { const f = floors.get(ws.talking); if (f && f.ws === ws) endFloor(ws.talking, 'disconnect'); }
    if (!me) return;
    const o = online.get(me.id); if (!o) return;
    o.sockets.delete(ws);
    if (!o.sockets.size) { broadcastPresence(o.channel); broadcastOnline(); pushChannelsAll(); if (locations.has(me.id)) pushLocTo(me.id); }
  });
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 10000);
setInterval(() => {
  for (const [conv, f] of floors) if (now() - f.lastAudio > (f.bytes ? STALL_MS : 10000)) { endFloor(conv, 'stalled'); send(f.ws, { t: 'floor_revoked', conv, reason: 'stalled' }); }
}, 500);

(async () => {
  await store.init();
  ensureLobby();
  await seedAdmin();
  await store.save();
  server.listen(PORT, () => console.log(`[ptt] listening on :${PORT} (storage=${store.kind})`));
})().catch(e => { console.error('[ptt] startup failed', e); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await store.close(); } catch {} process.exit(0); });
