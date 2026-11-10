// Geelo 伺服器
// - HTTP：靜態檔、登入 API、管理後台 API、文字/照片、位置 API、調度台頁面
// - WebSocket：信令、語音即時轉發（不保存錄音）、floor control、位置、警報、聊天、調度監聽與來電佇列
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./lib/store');
const A = require('./lib/auth');
const { Media, PHOTO_MAX_BYTES, PHOTO_RETENTION_MS, PHOTO_QUOTA_BYTES, TEXT_MAX, ALLOWED_MIME, sniffMime } = require('./lib/media');
const Orgs = require('./lib/orgs');
const Billing = require('./lib/billing');
const Stt = require('./lib/stt');
const { Reports } = require('./lib/reports');
const { CallLog } = require('./lib/calllog');
const Apns = require('./lib/apns');
const createExtra = require('./lib/http-extra');

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
const media = new Media(store);
const reports = new Reports(store);
const callLog = new CallLog(store);
const apns = new Apns.Apns();
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
const orgById = (id) => D().orgs.find(o => o.id === id);
const orgByCode = (c) => D().orgs.find(o => o.code === Orgs.normCode(c));
function userByName(n, orgId) {
  const name = String(n || '').toLowerCase();
  if (orgId === null || orgId === undefined) return D().users.find(u => u.username.toLowerCase() === name && u.role === 'admin');
  return D().users.find(u => u.username.toLowerCase() === name && u.orgId === orgId);
}
const chById = (id) => D().channels.find(c => c.id === id);
function bindUser(u, orgScope) { if (!u) return null; const v = Object.create(u); v.orgScope = orgScope === undefined ? (u.orgId || null) : orgScope; return v; }
function orgIdOf(u) { if (!u) return null; return u.role === 'admin' ? (u.orgScope || null) : (u.orgId || null); }
function viewerOf(id) {
  const u = userById(id); if (!u) return null;
  if (u.role !== 'admin') return u;
  const o = online.get(id);
  return bindUser(u, o && 'orgId' in o ? o.orgId : null);
}
function sameOrg(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  const oa = orgIdOf(a), ob = orgIdOf(b);
  return !!(oa && ob && oa === ob);
}
function orgUsable(o) { return Orgs.orgStatus(o, now()) === 'active'; }
function seatCount(orgId) { return D().users.filter(u => u.orgId === orgId && !u.disabled).length; }
function seatLimit(o) { return (o && o.seatLimit) || ((D().plans[(o && o.plan) || 'free'] || D().plans.free).seats); }
function planOf(id) { return D().plans[id] || D().plans.free; }
function publicUser(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, orgId: orgIdOf(u), disabled: !!u.disabled, createdAt: u.createdAt }; }
function publicOrgFor(u) {
  const o = orgById(orgIdOf(u)); if (!o) return null;
  return Orgs.publicOrg(o, { seatsUsed: seatCount(o.id), status: Orgs.orgStatus(o, now()) });
}
const nameOf = (id) => { const u = userById(id); return u ? u.displayName : '?'; };
function roleIn(u, ch) {
  if (!u || !ch || u.disabled) return null;
  if (orgIdOf(u) && ch.orgId && orgIdOf(u) !== ch.orgId) return null;
  if (ch.members[u.id]) return ch.members[u.id];
  if (u.role === 'admin' || u.role === 'org_admin' || u.role === 'dispatcher') {
    return (orgIdOf(u) && ch.orgId === orgIdOf(u)) ? 'supervisor' : null;
  }
  if (ch.open) return 'member';
  return null;
}
function canAccess(u, conv) {
  if (!u || !conv) return false;
  if (isDm(conv)) {
    const parts = dmParts(conv);
    if (!parts.includes(u.id)) return false;
    const peer = userById(parts.find(x => x !== u.id));
    return !!peer && sameOrg(u, peer);
  }
  return !!roleIn(u, chById(conv));
}
function isDispatcher(u) { return !!u && (u.role === 'admin' || u.role === 'org_admin' || u.role === 'dispatcher') && !!orgIdOf(u); }
function isOrgManager(u) { return !!u && (u.role === 'admin' || u.role === 'org_admin') && !!orgIdOf(u); }
function isPlatform(u) { return !!u && u.role === 'admin'; }
function ensureLobbies() {
  for (const org of D().orgs) {
    const id = Orgs.lobbyId(org.id);
    if (!chById(id)) D().channels.unshift({ id, name: '大廳', open: true, members: {}, orgId: org.id, system: 'lobby', createdAt: now() });
  }
}
function lobbyFor(u) { return orgIdOf(u) ? chById(Orgs.lobbyId(orgIdOf(u))) : null; }
async function seedAdmin() {
  const un = process.env.ADMIN_USERNAME, pw = process.env.ADMIN_PASSWORD;
  if (!un || !pw) { if (!D().users.some(u => u.role === 'admin')) console.warn('[seed] 沒有平台管理員，請設定 ADMIN_USERNAME / ADMIN_PASSWORD'); return; }
  let u = userByName(un, null);
  if (!u) { u = { id: 'u' + uid(6), username: un, displayName: process.env.ADMIN_DISPLAY_NAME || '平台管理員', role: 'admin', orgId: null, passHash: A.hashPassword(pw), createdAt: now() }; D().users.push(u); console.log('[seed] 已建立平台管理員', un); }
  else {
    u.role = 'admin'; u.disabled = false; u.orgId = null;
    if (process.env.ADMIN_RESET_PASSWORD === '1' || !A.verifyPassword(pw, u.passHash)) {
      // 以環境變數為準：遺失密碼時只要改 Render 環境變數再重啟即可
      u.passHash = A.hashPassword(pw); for (const [k, s] of Object.entries(D().sessions)) if (s.userId === u.id) delete D().sessions[k];
      console.log('[seed] 已依環境變數更新管理員密碼');
    }
  }
}

// ---------- Session ----------
async function createSession(u, orgId) {
  const token = A.newToken();
  D().sessions[A.sha256(token)] = { userId: u.id, orgId: orgId || null, exp: now() + SESSION_DAYS * 864e5, createdAt: now() };
  await store.save();
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = D().sessions[A.sha256(String(token))];
  if (!s || s.exp < now()) return null;
  const u = userById(s.userId);
  if (!u || u.disabled) return null;
  if (u.role === 'admin') return bindUser(u, s.orgId || null);
  const org = orgById(u.orgId);
  if (!orgUsable(org)) return null;
  return u;
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
const lastSpeaker = new Map(); // conv -> { userId, until } 供字幕在鬆開後短暫送出最終結果
/** userId -> { lat, lng, acc, battery, charging, ts }：只留最新一筆，不做軌跡 */
const locations = new Map();
/** alertId -> { id, userId, name, channel, channelName, lat, lng, acc, ts, notified:Set } */
const alerts = new Map();
/** id -> { id, from, fromName, channel, channelName, ts, status, heldBy, heldByName } */
const dispatchQueue = new Map();
let streamSeq = 1;
function dispatchersOnline(viewer) {
  return [...online.keys()].map(viewerOf).filter(u => u && isDispatcher(u) && (!viewer || sameOrg(viewer, u))).map(u => ({ id: u.id, name: u.displayName }));
}
function queueView(orgId) { return [...dispatchQueue.values()].filter(q => !orgId || q.orgId === orgId).map(q => ({ ...q })); }
function broadcastDispatchers(obj, orgId) {
  for (const id of online.keys()) {
    const u = viewerOf(id);
    if (u && isDispatcher(u) && (!orgId || orgIdOf(u) === orgId)) sendUser(id, obj);
  }
}

const isOnline = (id) => { const o = online.get(id); return !!(o && o.sockets.size); };
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendUser(id, obj) { const o = online.get(id); if (o) for (const s of o.sockets) send(s, obj); }
function channelOf(id) { const o = online.get(id); return o ? o.channel : null; }
function membersOf(chId) {
  const ch = chById(chId); if (!ch) return [];
  return [...online.entries()].filter(([id, o]) => o.channel === chId && o.sockets.size).map(([id]) => ({ id, name: nameOf(id), role: roleIn(userById(id), ch) }));
}
function onlineList(viewer) {
  return [...online.entries()].filter(([id, o]) => {
    if (!o.sockets.size) return false;
    const u = viewerOf(id);
    return !!(u && (!viewer || sameOrg(viewer, u)));
  }).map(([id, o]) => ({ id, name: nameOf(id), channel: o.channel }));
}
function recipients(conv) {
  if (isDm(conv)) return dmParts(conv).filter(isOnline);
  const ids = new Set();
  for (const [id, o] of online) {
    if (o.channel === conv) ids.add(id);
    if (o.listen && o.listen.has(conv)) ids.add(id);
  }
  return [...ids];
}
function broadcastConv(conv, obj, except) { for (const id of recipients(conv)) if (id !== except) sendUser(id, obj); }
function broadcastPresence(chId) { if (chId) broadcastConv(chId, { t: 'members', channel: chId, members: membersOf(chId) }); }
function broadcastOnline() {
  for (const id of online.keys()) {
    const u = viewerOf(id);
    if (u) sendUser(id, { t: 'online', online: onlineList(u) });
  }
  for (const id of online.keys()) {
    const u = viewerOf(id);
    if (u && isDispatcher(u)) sendUser(id, { t: 'dispatchers', list: dispatchersOnline(u) });
  }
}
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
function kick(userId, code = 4003, reason = 'revoked') {
  const o = online.get(userId); if (!o) return;
  for (const s of [...o.sockets]) {
    s.revoked = true; o.sockets.delete(s); // 立即從線上名單移除，不再收到任何語音
    if (s.talking) { const f = floors.get(s.talking); if (f && f.ws === s) endFloor(s.talking, 'revoked'); }
    send(s, { t: 'auth_failed', reason }); s.close(code, reason);
    setTimeout(() => { try { s.terminate(); } catch {} }, 1500); // 經過雲端代理時 close 交握可能卡住
  }
  broadcastPresence(o.channel); broadcastOnline();
}

// 使用者失去目前頻道權限時，移回大廳
function enforceAccess(userId) {
  const u = userById(userId); const o = online.get(userId); if (!o) return;
  const view = viewerOf(userId) || u;
  if (!u || u.disabled) return kick(userId);
  const org = orgById(orgIdOf(view));
  if (u.role !== 'admin' && !orgUsable(org)) return kick(userId, 4003, 'org_inactive');
  if (o.channel && !roleIn(view, chById(o.channel))) {
    const lobby = lobbyFor(view);
    const prev = o.channel; o.channel = (lobby && roleIn(view, lobby)) ? lobby.id : null;
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
  lastSpeaker.set(conv, { userId: f.userId, until: now() + 4000 });
  let info = null;
  if (f.bytes > 0) {
    let toName; if (isDm(conv)) toName = nameOf(dmParts(conv).find(x => x !== f.userId));
    info = { from: f.userId, fromName: nameOf(f.userId), toName, ts: f.startedAt, durMs: Math.round(f.bytes / 2 / SAMPLE_RATE * 1000) };
    lastTalk.set(conv, info);
    const kind = isDm(conv) ? 'dm' : 'channel';
    const ch = kind === 'channel' ? chById(conv) : null;
    const peerId = kind === 'dm' ? dmParts(conv).find(x => x !== f.userId) : null;
    const speaker = userById(f.userId);
    callLog.add({
      id: 'k' + uid(8),
      orgId: (speaker && (speaker.orgId || orgIdOf(speaker))) || (ch && ch.orgId) || null,
      conv, kind,
      channelId: ch ? ch.id : null,
      channelName: ch ? ch.name : '',
      peerId: peerId || null,
      peerName: peerId ? nameOf(peerId) : (info.toName || ''),
      from: f.userId, fromName: nameOf(f.userId),
      startedAt: f.startedAt, durMs: info.durMs,
      preempted: reason === 'preempted',
      ts: now()
    }).catch(e => console.error('[calllog]', e.message));
  }
  broadcastConv(conv, { t: 'talk_end', conv, streamId: f.streamId, from: f.userId, reason, lastTalk: info, ...extra });
  if (info && !isDm(conv)) for (const id of online.keys()) { const u = userById(id); if (u && roleIn(u, chById(conv))) sendUser(id, { t: 'channel_activity', channel: conv, last: info.ts, lastTalk: info }); }
}

// ---------- 位置可見範圍 ----------
function canSeeLoc(viewer, targetId) {
  if (!viewer) return false;
  const target = viewerOf(targetId) || userById(targetId);
  if (!target) return false;
  if (viewer.id !== targetId && !sameOrg(viewer, target)) return false;
  if (viewer.role === 'admin' || viewer.role === 'org_admin' || viewer.role === 'dispatcher' || viewer.id === targetId) return true;
  const vc = channelOf(viewer.id); return !!vc && vc === channelOf(targetId);
}
function locEntry(id) {
  const l = locations.get(id); if (!l) return null;
  return { id, name: nameOf(id), online: isOnline(id), channel: channelOf(id), channelName: chById(channelOf(id))?.name || '', ...l };
}
function locsFor(viewer) { return [...locations.keys()].filter(id => userById(id) && canSeeLoc(viewer, id)).map(locEntry); }
function pushLocTo(targetId) { const e = locEntry(targetId); if (!e) return; for (const id of online.keys()) if (canSeeLoc(viewerOf(id), targetId)) sendUser(id, { t: 'loc', loc: e }); }
function pushAllLocs(id) { const u = viewerOf(id); if (u) sendUser(id, { t: 'locs', locs: locsFor(u) }); }

// ---------- 緊急警報 ----------
function alertAudience(a) {
  const ids = new Set([a.userId]);
  const oid = a.orgId;
  for (const [id, o] of online) {
    const u = viewerOf(id); if (!u) continue;
    if (oid && orgIdOf(u) !== oid) continue;
    if (u.role === 'admin' || u.role === 'org_admin' || u.role === 'dispatcher' || (a.channel && o.channel === a.channel)) ids.add(id);
  }
  return ids;
}
function alertView(a) { const { notified, ...rest } = a; return rest; }
function alertsVisibleTo(u) {
  return [...alerts.values()].filter(a => {
    if (a.userId === u.id) return true;
    if (a.orgId && a.orgId !== orgIdOf(u)) return false;
    if (u.role === 'admin' || u.role === 'org_admin' || u.role === 'dispatcher') return true;
    return !!(a.channel && channelOf(u.id) === a.channel);
  }).map(alertView);
}
function startAlert(u, m) {
  let a = activeAlertOf(u.id);
  const ch = channelOf(u.id);
  const pos = (typeof m.lat === 'number' && typeof m.lng === 'number') ? { lat: m.lat, lng: m.lng, acc: m.acc || null } : (locations.get(u.id) ? { lat: locations.get(u.id).lat, lng: locations.get(u.id).lng, acc: locations.get(u.id).acc } : { lat: null, lng: null, acc: null });
  if (!a) { a = { id: 'a' + uid(6), userId: u.id, name: u.displayName, orgId: orgIdOf(u), channel: ch, channelName: chById(ch)?.name || '', ts: now(), notified: new Set(), ...pos }; alerts.set(a.id, a); }
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

function upsertPttPush(rec) {
  D().pttPush = D().pttPush || [];
  D().pttPush = D().pttPush.filter(x => !(x.userId === rec.userId && String(x.channelId || '') === String(rec.channelId || '')));
  D().pttPush.push(rec);
}
function removePttPush(userId, channelId) {
  D().pttPush = (D().pttPush || []).filter(x => {
    if (x.userId !== userId) return true;
    if (channelId) return String(x.channelId || '') !== String(channelId);
    return false;
  });
}
async function notifyTalkStart(conv, fromUser, streamId) {
  if (!Apns.enabled()) return;
  const list = D().pttPush || [];
  const targets = list.filter(x => {
    if (x.userId === fromUser.id) return false;
    if (isOnline(x.userId)) return false;
    if (isDm(conv)) return dmParts(conv).includes(x.userId);
    return x.channelId === conv;
  });
  for (const tgt of targets) {
    try {
      const r = await apns.send({
        token: tgt.token,
        bundle: tgt.bundleId,
        payload: { activeSpeaker: fromUser.displayName, conv, from: fromUser.id, fromName: fromUser.displayName, streamId }
      });
      if (r && r.unregistered) removePttPush(tgt.userId, tgt.channelId);
    } catch (e) { console.error('[apns] send', e.message); }
  }
}
function inviteAbsUrl(req, code) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host + '/join?code=' + encodeURIComponent(code);
}
async function qrSvg(text) {
  const QR = require('qrcode');
  return QR.toString(text, { type: 'svg', margin: 1, width: 256, errorCorrectionLevel: 'M' });
}
function rememberChannel(u, chId) {
  const raw = userById(u.id);
  if (raw && raw.lastChannel !== chId) { raw.lastChannel = chId; store.save().catch(() => {}); }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, max = 20000) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { resolve(null); } });
  });
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }
const loginFails = new Map(); // key -> {n, until}
function rateLimited(key) { const r = loginFails.get(key); return r && r.n >= 10 && r.until > now(); }
function noteFail(key) { const r = loginFails.get(key) || { n: 0, until: 0 }; if (r.until < now()) r.n = 0; r.n++; r.until = now() + 10 * 60e3; loginFails.set(key, r); }

const extra = createExtra({
  json, readBody, cors, uid, now, store, reports, callLog, media,
  D, userById, userByName, orgById, orgByCode, chById, orgIdOf,
  publicUser, nameOf, roleIn, canAccess, isOrgManager, isPlatform, isDispatcher,
  seatCount, seatLimit, orgUsable, validUsername, cleanName, A, Orgs,
  revokeSessions, kick, locations, online, broadcastOnline, pushChannelsAll,
  upsertPttPush, removePttPush, inviteAbsUrl, qrSvg
});


function orgDetail(o) {
  return {
    ...Orgs.publicOrg(o, { seatsUsed: seatCount(o.id), status: Orgs.orgStatus(o, now()) }),
    billing: { ...(o.billing || {}), example: true, status: Orgs.orgStatus(o, now()) },
    planInfo: planOf(o.plan)
  };
}
async function wipeOrg(orgId) {
  const ids = D().users.filter(u => u.orgId === orgId).map(u => u.id);
  const convs = D().channels.filter(c => c.orgId === orgId).map(c => c.id);
  for (const c of [...convs]) endFloor(c, 'deleted');
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) convs.push(dmKey(ids[i], ids[j]));
  for (const [qid, q] of [...dispatchQueue]) if (q.orgId === orgId || ids.includes(q.from)) dispatchQueue.delete(qid);
  for (const [aid, a] of [...alerts]) if (a.orgId === orgId || ids.includes(a.userId)) alerts.delete(aid);
  for (const id of ids) { revokeSessions(id); kick(id); online.delete(id); locations.delete(id); }
  D().users = D().users.filter(u => u.orgId !== orgId);
  D().channels = D().channels.filter(c => c.orgId !== orgId);
  D().invites = (D().invites || []).filter(i => i.orgId !== orgId);
  D().pttPush = (D().pttPush || []).filter(x => !ids.includes(x.userId));
  reports.deleteByOrg(orgId).catch(e => console.error('[reports]', e.message));
  callLog.deleteByOrg(orgId).catch(e => console.error('[calllog]', e.message));
  await media.deleteConvs(convs).catch(e => console.error('[media]', e.message));
  D().orgs = D().orgs.filter(o => o.id !== orgId);
}
async function platformApi(req, res, p, method, me) {
  const seg = p.split('/').slice(3); // after /api/platform/
  const b = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};
  if (b === null) return json(res, 400, { error: 'bad_request' });
  const platExtra = await extra.platformExtra(req, res, seg, method, me, b);
  if (platExtra !== false) return platExtra;
  if (seg[0] === 'plans' && !seg[1] && method === 'GET') return json(res, 200, { plans: D().plans, example: true, message: '金額為可調整的範例佔位值，未接真實金流' });
  if (seg[0] === 'plans' && !seg[1] && method === 'PATCH') {
    for (const key of ['free', 'standard', 'pro']) {
      if (!b[key]) continue;
      const cur = D().plans[key] || Orgs.defaultPlans()[key];
      const n = b[key];
      if (n.label) cur.label = String(n.label).slice(0, 20);
      if (n.seats != null) cur.seats = Math.max(1, Math.min(10000, +n.seats || cur.seats));
      if (n.priceMonthly != null) cur.priceMonthly = Math.max(0, +n.priceMonthly || 0);
      if (n.priceYearly != null) cur.priceYearly = Math.max(0, +n.priceYearly || 0);
      cur.example = true;
      D().plans[key] = cur;
    }
    await store.save();
    return json(res, 200, { plans: D().plans, example: true });
  }
  if (seg[0] === 'orgs' && !seg[1] && method === 'GET') return json(res, 200, { orgs: D().orgs.map(orgDetail), plans: D().plans, platformCode: Orgs.PLATFORM_CODE, example: true });
  if (seg[0] === 'orgs' && !seg[1] && method === 'POST') {
    const code = Orgs.normCode(b.code);
    const name = cleanName(b.name, 40);
    if (!Orgs.validOrgCode(code) || code === Orgs.PLATFORM_CODE) return json(res, 400, { error: 'bad_org', message: '公司代碼需為 2–16 位英數字，且不可為 ' + Orgs.PLATFORM_CODE });
    if (!name) return json(res, 400, { error: 'bad_name', message: '請輸入公司名稱' });
    if (orgByCode(code)) return json(res, 409, { error: 'exists', message: '公司代碼已存在' });
    const plan = (b.plan === 'standard' || b.plan === 'pro') ? b.plan : 'free';
    let adminUser, adminPassword, generated = false, adminUsername = '';
    if (b.adminUsername) {
      adminUsername = String(b.adminUsername || '').trim();
      if (!validUsername(adminUsername)) return json(res, 400, { error: 'bad_username', message: '公司管理員帳號格式不正確' });
      adminPassword = b.adminPassword ? String(b.adminPassword) : A.genPassword(); generated = !b.adminPassword;
      if (adminPassword.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
    }
    const org = {
      id: 'o' + uid(6), code, name, disabled: false, plan,
      seatLimit: b.seatLimit ? Math.max(1, +b.seatLimit) : planOf(plan).seats,
      expiresAt: plan === 'free' ? null : (b.expiresAt || (now() + 14 * 864e5)),
      settings: { saveCaptions: false },
      billing: { status: plan === 'free' ? 'active' : 'trial', lastMarkedPaidAt: null, lastMarkedPaidBy: null, note: '新建立；金額為範例佔位值', example: true },
      createdAt: now()
    };
    D().orgs.push(org);
    D().channels.unshift({ id: Orgs.lobbyId(org.id), name: '大廳', open: true, members: {}, orgId: org.id, system: 'lobby', createdAt: now() });
    if (adminUsername) {
      adminUser = { id: 'u' + uid(6), username: adminUsername, displayName: cleanName(b.adminDisplayName) || adminUsername, role: 'org_admin', orgId: org.id, passHash: A.hashPassword(adminPassword), createdAt: now() };
      D().users.push(adminUser);
    }
    await store.save();
    return json(res, 201, { org: orgDetail(org), admin: adminUser ? publicUser(adminUser) : undefined, password: generated ? adminPassword : undefined });
  }
  if (seg[0] !== 'orgs' || !seg[1]) return json(res, 404, { error: 'not_found' });
  const org = orgById(seg[1]); if (!org) return json(res, 404, { error: 'not_found' });
  if (!seg[2] && method === 'GET') return json(res, 200, { org: orgDetail(org), users: D().users.filter(u => u.orgId === org.id).map(u => publicUser(u)) });
  if (!seg[2] && method === 'PATCH') {
    if (b.name !== undefined) org.name = cleanName(b.name, 40) || org.name;
    if (b.code !== undefined) {
      const code = Orgs.normCode(b.code);
      if (!Orgs.validOrgCode(code) || code === Orgs.PLATFORM_CODE) return json(res, 400, { error: 'bad_org', message: '公司代碼不合法' });
      if (orgByCode(code) && orgByCode(code).id !== org.id) return json(res, 409, { error: 'exists', message: '公司代碼已存在' });
      org.code = code;
    }
    if (b.plan === 'free' || b.plan === 'standard' || b.plan === 'pro') {
      org.plan = b.plan;
      if (b.seatLimit === undefined) org.seatLimit = planOf(b.plan).seats;
    }
    if (b.seatLimit != null) org.seatLimit = Math.max(1, Math.min(10000, +b.seatLimit || org.seatLimit));
    if (b.expiresAt !== undefined) org.expiresAt = b.expiresAt === null ? null : +b.expiresAt;
    if (b.disabled !== undefined) {
      org.disabled = !!b.disabled;
      if (org.disabled) for (const u of D().users.filter(x => x.orgId === org.id)) { revokeSessions(u.id); kick(u.id, 4003, 'org_inactive'); }
    }
    if (b.settings && b.settings.saveCaptions !== undefined) { org.settings = org.settings || {}; org.settings.saveCaptions = !!b.settings.saveCaptions; }
    await store.save();
    return json(res, 200, { org: orgDetail(org) });
  }
  if (!seg[2] && method === 'DELETE') {
    if (org.id === Orgs.DEFAULT_ORG_ID) return json(res, 400, { error: 'protected', message: '預設公司不能刪除，只能停用' });
    await wipeOrg(org.id); await store.save();
    return json(res, 200, { ok: true });
  }
  if (seg[2] === 'mark-paid' && method === 'POST') {
    const days = Math.max(1, Math.min(3660, +b.days || 30));
    org.expiresAt = now() + days * 864e5;
    org.disabled = false;
    org.billing = Object.assign({}, org.billing, { status: 'active', lastMarkedPaidAt: now(), lastMarkedPaidBy: me.id, note: b.note ? String(b.note).slice(0, 200) : (org.billing && org.billing.note) || '', example: true });
    await store.save();
    return json(res, 200, { org: orgDetail(org), message: '已手動標記付款（佔位，未經過真實金流），到期日已延後 ' + days + ' 天' });
  }
  if (seg[2] === 'admins' && method === 'POST') {
    const username = String(b.username || '').trim();
    if (!validUsername(username)) return json(res, 400, { error: 'bad_username', message: '帳號格式不正確' });
    if (userByName(username, org.id)) return json(res, 409, { error: 'exists', message: '帳號已存在' });
    if (seatCount(org.id) >= seatLimit(org)) return json(res, 403, { error: 'seat_limit', message: '已達人數上限' });
    let password = b.password ? String(b.password) : A.genPassword(); const generated = !b.password;
    if (password.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
    const u = { id: 'u' + uid(6), username, displayName: cleanName(b.displayName) || username, role: 'org_admin', orgId: org.id, passHash: A.hashPassword(password), createdAt: now() };
    D().users.push(u); await store.save();
    return json(res, 201, { user: publicUser(u), password: generated ? password : undefined });
  }
  return json(res, 404, { error: 'not_found' });
}

async function api(req, res, p, url) {
  const method = req.method;
  if (p === '/api/health') {
    const ms = await media.stats();
    return json(res, 200, { ok: true, storage: store.kind, online: onlineList().length, channels: D().channels.length, users: D().users.length, orgs: D().orgs.length, activeTalks: floors.size, activeAlerts: alerts.size, dispatchQueue: dispatchQueue.size, storesAudio: false, serverStt: false, messages: ms.messages, photos: ms.photos, photoBytes: ms.photoBytes, photoRetentionDays: PHOTO_RETENTION_MS / 864e5, photoQuotaBytes: PHOTO_QUOTA_BYTES, reportsRetentionDays: 90, callLogRetentionDays: 90, apns: Apns.enabled() });
  }
  if (await extra.publicApi(req, res, p, method)) return;
  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req); if (!b) return json(res, 400, { error: 'bad_request' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + String(b.username || '').toLowerCase();
    if (rateLimited(key)) return json(res, 429, { error: 'too_many_attempts', message: '嘗試次數過多，請 10 分鐘後再試' });
    const code = Orgs.normCode(b.org || b.orgCode);
    if (!code) return json(res, 400, { error: 'need_org', message: '請輸入公司代碼' });
    let scopeOrgId = null, u = null;
    if (code === Orgs.PLATFORM_CODE) {
      u = userByName(b.username, null);
      if (!u || u.role !== 'admin' || !A.verifyPassword(b.password || '', u.passHash)) { noteFail(key); return json(res, 401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' }); }
      if (u.disabled) return json(res, 403, { error: 'disabled', message: '此帳號已停用' });
      scopeOrgId = null;
    } else {
      const org = orgByCode(code);
      if (!org) { noteFail(key); return json(res, 401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' }); }
      if (org.disabled) return json(res, 403, { error: 'org_disabled', message: '此公司已被停用' });
      if (Orgs.orgStatus(org, now()) === 'expired') return json(res, 403, { error: 'org_expired', message: '此公司方案已到期，請聯絡平台管理員標記付款' });
      u = userByName(b.username, org.id);
      if (!u) {
        const padmin = userByName(b.username, null);
        if (padmin && padmin.role === 'admin') u = padmin;
      }
      if (!u || !A.verifyPassword(b.password || '', u.passHash)) { noteFail(key); return json(res, 401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' }); }
      if (u.disabled) return json(res, 403, { error: 'disabled', message: '此帳號已停用' });
      if (u.role !== 'admin' && u.orgId !== org.id) { noteFail(key); return json(res, 401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' }); }
      scopeOrgId = org.id;
    }
    loginFails.delete(key);
    const token = await createSession(u, scopeOrgId);
    const bound = u.role === 'admin' ? bindUser(u, scopeOrgId) : u;
    return json(res, 200, { token, user: publicUser(bound), org: publicOrgFor(bound) });
  }
  const me = userFromToken(bearer(req));
  if (!me) return json(res, 401, { error: 'unauthorized', message: '請先登入' });
  if (p === '/api/logout' && method === 'POST') { delete D().sessions[A.sha256(bearer(req))]; await store.save(); return json(res, 200, { ok: true }); }
  if (p === '/api/me') return json(res, 200, { user: publicUser(me), channels: channelsFor(me), org: publicOrgFor(me) });
  if (await extra.userApi(req, res, p, method, me, url)) return;
  if (p === '/api/me/password' && method === 'POST') {
    const b = await readBody(req); const raw = userById(me.id);
    if (!b || !raw || !A.verifyPassword(b.oldPassword || '', raw.passHash)) return json(res, 400, { error: 'wrong_password', message: '舊密碼錯誤' });
    if (String(b.newPassword || '').length < 8) return json(res, 400, { error: 'weak_password', message: '新密碼至少 8 個字元' });
    raw.passHash = A.hashPassword(b.newPassword); await store.save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/billing/checkout' && method === 'POST') {
    const b = await readBody(req) || {};
    const org = orgById(orgIdOf(me));
    return json(res, 200, Billing.checkoutPlaceholder({ org, planId: b.plan || (org && org.plan) || 'standard', period: b.period, plans: D().plans }));
  }
  if (p === '/api/locations') return json(res, 200, { locations: locsFor(me) });
  if (p === '/api/alerts') return json(res, 200, { alerts: alertsVisibleTo(me) });
  if (p === '/api/messages' && method === 'GET') {
    const conv = url.searchParams.get('conv') || '';
    if (!canAccess(me, conv)) return json(res, 403, { error: 'forbidden', message: '沒有這個對話的權限' });
    const since = +url.searchParams.get('since') || 0;
    const limit = +url.searchParams.get('limit') || 100;
    return json(res, 200, { messages: await media.listMessages(conv, { since, limit }) });
  }
  if (p === '/api/messages' && method === 'POST') {
    const b = await readBody(req, 8000); if (!b) return json(res, 400, { error: 'bad_request' });
    const conv = String(b.conv || '');
    if (!canAccess(me, conv)) return json(res, 403, { error: 'forbidden', message: '沒有這個對話的權限' });
    if (isDm(conv)) { /* 文字私訊允許對方離線 */ }
    else if (!roleIn(me, chById(conv))) return json(res, 403, { error: 'forbidden' });
    const text = String(b.text || '').replace(/\u0000/g, '').trim();
    if (!text) return json(res, 400, { error: 'empty', message: '請輸入文字' });
    if (text.length > TEXT_MAX) return json(res, 400, { error: 'too_long', message: '文字最多 ' + TEXT_MAX + ' 字' });
    const msg = { id: 'm' + uid(8), conv, from: me.id, fromName: me.displayName, kind: 'text', text, ts: now() };
    await media.addMessage(msg);
    broadcastConv(conv, { t: 'chat', message: msg }, me.id);
    sendUser(me.id, { t: 'chat', message: msg });
    return json(res, 201, { message: msg });
  }
  if (p === '/api/photos' && method === 'POST') {
    const b = await readBody(req, 400000); if (!b) return json(res, 400, { error: 'bad_request', message: '請求太大或格式不對' });
    const conv = String(b.conv || '');
    if (!canAccess(me, conv)) return json(res, 403, { error: 'forbidden', message: '沒有這個對話的權限' });
    let buf;
    try { buf = Buffer.from(String(b.data || ''), 'base64'); } catch { return json(res, 400, { error: 'bad_data' }); }
    if (!buf.length) return json(res, 400, { error: 'empty', message: '沒有圖片資料' });
    if (buf.length > PHOTO_MAX_BYTES) return json(res, 413, { error: 'too_large', message: '照片超過約 200KB，請再壓縮' });
    const mime = sniffMime(buf);
    if (!mime || !ALLOWED_MIME.has(mime)) return json(res, 400, { error: 'bad_type', message: '只接受 JPEG、WebP 或 PNG' });
    const id = uid(8);
    const ts = now();
    await media.addPhoto({ id, conv, mime, buf, ts });
    const msg = { id: 'm' + uid(8), conv, from: me.id, fromName: me.displayName, kind: 'photo', photoId: id, mime, ts };
    await media.addMessage(msg);
    broadcastConv(conv, { t: 'chat', message: msg }, me.id);
    sendUser(me.id, { t: 'chat', message: msg });
    return json(res, 201, { message: msg });
  }
  const photoGet = p.match(/^\/api\/photos\/([0-9a-f]{16})$/);
  if (photoGet && method === 'GET') {
    const ph = await media.getPhoto(photoGet[1]);
    if (!ph) return json(res, 404, { error: 'not_found' });
    if (!canAccess(me, ph.conv)) return json(res, 403, { error: 'forbidden', message: '沒有這張照片的權限' });
    cors(res);
    res.writeHead(200, { 'Content-Type': ph.mime, 'Content-Length': ph.buf.length, 'Cache-Control': 'private, max-age=86400' });
    return res.end(ph.buf);
  }

  // ----- 平台後台（平台管理員）-----
  if (p.startsWith('/api/platform/')) {
    if (!isPlatform(me)) return json(res, 403, { error: 'forbidden', message: '需要平台管理員權限' });
    return await platformApi(req, res, p, method, me);
  }

  // ----- 管理後台（公司管理員或已進入某公司的平台管理員）-----
  if (!p.startsWith('/api/admin/')) return json(res, 404, { error: 'not_found' });
  if (isPlatform(me) && !orgIdOf(me)) return json(res, 400, { error: 'need_org', message: '平台管理員請先用公司代碼登入該公司，或到平台後台管理公司' });
  if (!isOrgManager(me)) return json(res, 403, { error: 'forbidden', message: '需要公司管理員權限（平台管理員請用公司代碼登入該公司）' });
  const scopeOrg = orgById(orgIdOf(me));
  if (!scopeOrg) return json(res, 400, { error: 'need_org', message: '平台管理員請先用公司代碼登入該公司，或到平台後台管理公司' });
  const seg = p.split('/').slice(3); // ['users', id?] ...
  const b = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};
  if (b === null) return json(res, 400, { error: 'bad_request' });
  const admExtra = await extra.adminExtra(req, res, seg, method, me, scopeOrg, b);
  if (admExtra !== false) return admExtra;

  if (seg[0] === 'users') {
    if (!seg[1] && method === 'GET') return json(res, 200, { users: D().users.filter(u => u.orgId === scopeOrg.id).map(u => ({ ...publicUser(u), online: isOnline(u.id), channel: channelOf(u.id) })) });
    if (!seg[1] && method === 'POST') {
      const username = String(b.username || '').trim();
      if (!validUsername(username)) return json(res, 400, { error: 'bad_username', message: '帳號需 3–32 個英數字或 _ . -' });
      if (userByName(username, scopeOrg.id)) return json(res, 409, { error: 'exists', message: '帳號已存在' });
      if (seatCount(scopeOrg.id) >= seatLimit(scopeOrg)) return json(res, 403, { error: 'seat_limit', message: '已達此公司方案的人數上限（' + seatLimit(scopeOrg) + '）' });
      let password = b.password ? String(b.password) : ''; let generated = false;
      if (!password) { password = A.genPassword(); generated = true; }
      if (password.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
      const role = (b.role === 'org_admin' || b.role === 'dispatcher') ? b.role : 'user';
      const u = { id: 'u' + uid(6), username, displayName: cleanName(b.displayName) || username, role, orgId: scopeOrg.id, passHash: A.hashPassword(password), createdAt: now() };
      D().users.push(u); await store.save();
      return json(res, 201, { user: publicUser(u), password: generated ? password : undefined });
    }
    const u = userById(seg[1]); if (!u) return json(res, 404, { error: 'not_found' });
    if (method === 'PATCH') {
      if (u.id === me.id && (b.disabled === true || (b.role && b.role !== me.role))) return json(res, 400, { error: 'self_lockout', message: '不能停用自己或移除自己的管理員權限' });
      if (u.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' });
      if (b.displayName !== undefined) u.displayName = cleanName(b.displayName) || u.displayName;
      if (b.role === 'user' || b.role === 'dispatcher' || b.role === 'org_admin') u.role = b.role;
      if (b.role === 'admin') return json(res, 400, { error: 'bad_role', message: '不能在公司後台把帳號設為平台管理員' });
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
      if (u.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' });
      D().users = D().users.filter(x => x.id !== u.id); revokeSessions(u.id);
      for (const c of D().channels) delete c.members[u.id];
      locations.delete(u.id);
      media.convsForUser(u.id).then(cs => media.deleteConvs(cs)).then(() => media.deleteByFrom(u.id)).catch(e => console.error('[media]', e.message));
      await store.save(); kick(u.id); online.delete(u.id); broadcastOnline();
      return json(res, 200, { ok: true });
    }
  }
  if (seg[0] === 'channels') {
    if (!seg[1] && method === 'GET') return json(res, 200, { channels: D().channels.filter(c => c.orgId === scopeOrg.id).map(c => ({ id: c.id, name: c.name, open: !!c.open, members: Object.entries(c.members).map(([id, role]) => ({ id, name: nameOf(id), role })), online: membersOf(c.id).length })) });
    if (!seg[1] && method === 'POST') {
      const name = cleanName(b.name, 30); if (!name) return json(res, 400, { error: 'bad_name', message: '請輸入頻道名稱' });
      if (D().channels.some(c => c.orgId === scopeOrg.id && c.name === name)) return json(res, 409, { error: 'exists', message: '頻道名稱已存在' });
      const c = { id: 'c' + uid(4), name, open: !!b.open, members: {}, orgId: scopeOrg.id, createdAt: now() };
      D().channels.push(c); await store.save(); pushChannelsAll();
      return json(res, 201, { channel: c });
    }
    const c = chById(seg[1]); if (!c || c.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' });
    if (!seg[2] && method === 'PATCH') {
      if (b.name !== undefined) c.name = cleanName(b.name, 30) || c.name;
      if (b.open !== undefined) c.open = !!b.open;
      await store.save(); for (const id of online.keys()) enforceAccess(id);
      return json(res, 200, { channel: c });
    }
    if (!seg[2] && method === 'DELETE') {
      if (Orgs.isLobbyChannel(c)) return json(res, 400, { error: 'protected', message: '大廳不能刪除' });
      endFloor(c.id, 'deleted');
      D().channels = D().channels.filter(x => x.id !== c.id); lastTalk.delete(c.id);
      await media.deleteConvs([c.id]).catch(e => console.error('[media]', e.message));
      await store.save();
      for (const id of online.keys()) enforceAccess(id);
      return json(res, 200, { ok: true });
    }
    if (seg[2] === 'members' && seg[3]) {
      const u = userById(seg[3]); if (!u || u.orgId !== scopeOrg.id) return json(res, 404, { error: 'no_user' });
      if (method === 'PUT') { if (!CH_ROLES[b.role]) return json(res, 400, { error: 'bad_role', message: '角色需為 supervisor / member / listener' }); c.members[u.id] = b.role; }
      else if (method === 'DELETE') delete c.members[u.id];
      else return json(res, 405, { error: 'method' });
      await store.save(); enforceAccess(u.id);
      return json(res, 200, { ok: true, members: c.members });
    }
  }
  if (seg[0] === 'settings') {
    if (method === 'GET') return json(res, 200, { settings: scopeOrg.settings || { saveCaptions: false }, org: publicOrgFor(me) });
    if (method === 'PATCH') {
      scopeOrg.settings = scopeOrg.settings || { saveCaptions: false };
      if (b.saveCaptions !== undefined) scopeOrg.settings.saveCaptions = !!b.saveCaptions;
      await store.save();
      return json(res, 200, { settings: scopeOrg.settings });
    }
  }
  if (seg[0] === 'alerts') {
    if (!seg[1] && method === 'GET') return json(res, 200, { alerts: [...alerts.values()].filter(a => a.orgId === scopeOrg.id).map(alertView) });
    if (seg[1] && seg[2] === 'resolve' && method === 'POST') { const a = alerts.get(seg[1]); if (!a || a.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' }); endAlert(a, me); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (p.startsWith('/api/')) return await api(req, res, p, url);
    if (p.startsWith('/audio/')) return json(res, 404, { error: 'not_found' }); // 不保存錄音
    let rel = p === '/' ? 'index.html'
      : (p === '/admin' || p === '/admin/') ? 'admin.html'
      : (p === '/dispatch' || p === '/dispatch/') ? 'dispatch.html'
      : (p === '/platform' || p === '/platform/') ? 'platform.html'
      : (p === '/privacy' || p === '/privacy/') ? 'privacy.html'
      : (p === '/terms' || p === '/terms/') ? 'terms.html'
      : (p === '/delete-account' || p === '/delete-account/') ? 'delete-account.html'
      : (p === '/join' || p === '/join/') ? 'join.html'
      : p.slice(1);
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
    if (ws.revoked) return;
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
      let o = online.get(u.id); if (!o) { o = { sockets: new Set(), channel: null, listen: new Set(), orgId: orgIdOf(u) }; online.set(u.id, o); }
      o.orgId = orgIdOf(u);
      o.sockets.add(ws);
      const want = (m.resume && m.resume.channel) || u.lastChannel;
      if (!o.channel && want && canAccess(u, want) && roleIn(u, chById(want))) o.channel = want;
      send(ws, { t: 'welcome', user: publicUser(u), org: publicOrgFor(u), channels: channelsFor(u), dms: dmSummaries(u.id), online: onlineList(u), alerts: alertsVisibleTo(u), roles: CH_ROLES, queue: isDispatcher(u) ? queueView(orgIdOf(u)) : [], dispatchers: isDispatcher(u) ? dispatchersOnline(u) : [], serverTime: now(), resumedChannel: o.channel || null });
      if (o.channel) { send(ws, { t: 'joined', channel: o.channel, resumed: true }); broadcastPresence(o.channel); }
      broadcastOnline();
      for (const [conv, f] of floors) if (recipients(conv).includes(u.id) && f.userId !== u.id) send(ws, { t: 'talk_start', conv, streamId: f.streamId, from: f.userId, fromName: nameOf(f.userId), prio: f.prio });
      return;
    }
    if (!me) return send(ws, { t: 'auth_failed', reason: 'not_logged_in' });
    {
      const raw = userById(me.id);
      const scope = orgIdOf(me);
      if (!raw || raw.disabled) { send(ws, { t: 'auth_failed', reason: 'revoked' }); return ws.close(4003, 'revoked'); }
      if (raw.role !== 'admin' && !orgUsable(orgById(raw.orgId))) { send(ws, { t: 'auth_failed', reason: 'org_inactive' }); return ws.close(4003, 'org_inactive'); }
      me = raw.role === 'admin' ? bindUser(raw, scope) : raw;
    }
    const o = online.get(me.id);
    switch (m.t) {
      case 'join': {
        const ch = chById(m.channel);
        if (!ch || !roleIn(me, ch)) return send(ws, { t: 'error', code: 'no_access', msg: '你沒有這個頻道的權限' });
        const prev = o.channel; o.channel = ch.id;
        if (prev && prev !== ch.id) { for (const s of o.sockets) if (s.talking === prev) endFloor(prev, 'left'); broadcastPresence(prev); }
        for (const s of o.sockets) send(s, { t: 'joined', channel: ch.id, myRole: roleIn(me, ch) });
        rememberChannel(me, ch.id);
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
        if (m.to || isDm(conv)) {
          if (m.to) {
            const peer = userById(m.to);
            if (!peer || peer.disabled || peer.id === me.id) return send(ws, { t: 'floor_denied', conv: null, reason: 'no_access' });
            conv = dmKey(me.id, peer.id);
          }
          const parts = dmParts(conv);
          if (!parts.includes(me.id)) return send(ws, { t: 'floor_denied', conv, reason: 'no_access' });
          const peer = userById(parts.find(x => x !== me.id));
          if (!peer || peer.disabled || !sameOrg(me, peer)) return send(ws, { t: 'floor_denied', conv, reason: 'no_access' });
          if (!isOnline(peer.id)) return send(ws, { t: 'floor_denied', conv, reason: 'offline', byName: peer.displayName });
        } else {
          const ch = chById(conv); const r = roleIn(me, ch);
          const listening = !!(o.listen && o.listen.has(conv));
          if (!ch || !r || (o.channel !== conv && !listening)) return send(ws, { t: 'floor_denied', conv, reason: 'no_access' });
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
        notifyTalkStart(conv, me, f.streamId).catch(e => console.error('[apns]', e.message));
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
      case 'loc_off': { locations.delete(me.id); for (const id of online.keys()) { const v = viewerOf(id); if (v && sameOrg(v, me)) sendUser(id, { t: 'loc_remove', id: me.id }); } break; }
      case 'get_locs': pushAllLocs(me.id); break;
      case 'alert_start': startAlert(me, m); break;
      case 'alert_resolve': {
        const a = alerts.get(m.id);
        if (!a) return send(ws, { t: 'error', code: 'no_alert', msg: '警報已結束' });
        if (me.role !== 'admin' && me.role !== 'org_admin' && me.role !== 'dispatcher' && a.userId !== me.id) return send(ws, { t: 'error', code: 'forbidden', msg: '只有管理員、調度員或發送者可以解除警報' });
        endAlert(a, me); break;
      }
      case 'listen': {
        if (!isDispatcher(me)) return send(ws, { t: 'error', code: 'forbidden', msg: '只有調度員或管理員可以同時監聽多個頻道' });
        const ids = Array.isArray(m.channels) ? m.channels.map(String) : [];
        o.listen = new Set(ids.filter(id => roleIn(me, chById(id))));
        send(ws, { t: 'listening', channels: [...o.listen] });
        for (const ch of o.listen) {
          const f = floors.get(ch);
          if (f && f.userId !== me.id) send(ws, { t: 'talk_start', conv: ch, streamId: f.streamId, from: f.userId, fromName: nameOf(f.userId), prio: f.prio });
        }
        break;
      }
      case 'dispatch_call': {
        if (isDispatcher(me)) return send(ws, { t: 'error', code: 'forbidden', msg: '調度員請從佇列接聽來電' });
        for (const q of dispatchQueue.values()) if (q.from === me.id && q.status === 'waiting') { send(ws, { t: 'queue_self', item: q }); return; }
        const item = { id: 'q' + uid(6), from: me.id, fromName: me.displayName, orgId: orgIdOf(me), channel: o.channel, channelName: chById(o.channel)?.name || '', ts: now(), status: 'waiting', heldBy: null, heldByName: null };
        dispatchQueue.set(item.id, item);
        send(ws, { t: 'queue_self', item });
        broadcastDispatchers({ t: 'queue', items: queueView(item.orgId) }, item.orgId);
        break;
      }
      case 'dispatch_pickup': {
        if (!isDispatcher(me)) return send(ws, { t: 'error', code: 'forbidden', msg: '需要調度員權限' });
        const item = dispatchQueue.get(m.id);
        if (!item || item.orgId !== orgIdOf(me) || item.status !== 'waiting') return send(ws, { t: 'error', code: 'no_queue', msg: '此通呼叫已被接聽或不存在' });
        item.status = 'held'; item.heldBy = me.id; item.heldByName = me.displayName;
        const conv = dmKey(item.from, me.id);
        sendUser(item.from, { t: 'dispatch_pickup', item, by: me.id, byName: me.displayName, conv });
        sendUser(me.id, { t: 'dispatch_pickup', item, by: me.id, byName: me.displayName, conv, pickup: true });
        broadcastDispatchers({ t: 'queue', items: queueView(orgIdOf(me)) }, orgIdOf(me));
        break;
      }
      case 'dispatch_transfer': {
        if (!isDispatcher(me)) return send(ws, { t: 'error', code: 'forbidden', msg: '需要調度員權限' });
        const item = dispatchQueue.get(m.id);
        const peer = userById(m.to);
        if (!item || item.orgId !== orgIdOf(me) || item.heldBy !== me.id) return send(ws, { t: 'error', code: 'no_queue', msg: '你沒有這通通話可以轉接' });
        if (!peer || !sameOrg(me, peer) || !isDispatcher(peer) || !isOnline(peer.id) || peer.id === me.id) return send(ws, { t: 'error', code: 'no_peer', msg: '對方不是在線的調度員' });
        item.heldBy = peer.id; item.heldByName = peer.displayName;
        const conv = dmKey(item.from, peer.id);
        sendUser(item.from, { t: 'dispatch_transfer', item, by: me.displayName, to: peer.id, toName: peer.displayName, conv });
        sendUser(peer.id, { t: 'dispatch_transfer', item, from: me.id, fromName: me.displayName, conv, pickup: true });
        broadcastDispatchers({ t: 'queue', items: queueView(orgIdOf(me)) }, orgIdOf(me));
        break;
      }
      case 'dispatch_done': {
        const item = dispatchQueue.get(m.id);
        if (!item) return;
        if (item.orgId && item.orgId !== orgIdOf(me)) return send(ws, { t: 'error', code: 'forbidden', msg: '不能結束這通呼叫' });
        if (me.id !== item.from && item.heldBy !== me.id && me.role !== 'admin' && me.role !== 'org_admin') return send(ws, { t: 'error', code: 'forbidden', msg: '不能結束這通呼叫' });
        dispatchQueue.delete(item.id);
        sendUser(item.from, { t: 'dispatch_done', id: item.id });
        if (item.heldBy) sendUser(item.heldBy, { t: 'dispatch_done', id: item.id });
        broadcastDispatchers({ t: 'queue', items: queueView(orgIdOf(me)) }, orgIdOf(me));
        break;
      }
      case 'caption': {
        const conv = String(m.conv || ws.talking || (o && o.channel) || '');
        const text = String(m.text || '').replace(/\u0000/g, '').trim().slice(0, TEXT_MAX);
        if (!text || !conv || !canAccess(me, conv)) return;
        const holding = floors.get(conv) && floors.get(conv).userId === me.id;
        const rec = lastSpeaker.get(conv);
        const recent = rec && rec.userId === me.id && rec.until > now();
        if (!holding && !recent) return send(ws, { t: 'error', code: 'forbidden', msg: '只有正在講話的人可以送出字幕' });
        const interim = !!m.interim;
        const cap = { t: 'caption', conv, from: me.id, fromName: me.displayName, text, interim, ts: now() };
        broadcastConv(conv, cap);
        if (!interim) {
          const org = orgById(orgIdOf(me));
          if (org && org.settings && org.settings.saveCaptions) {
            const msg = { id: 'm' + uid(8), conv, from: me.id, fromName: me.displayName, kind: 'caption', text, ts: cap.ts };
            media.addMessage(msg).catch(e => console.error('[caption]', e.message));
            broadcastConv(conv, { t: 'chat', message: msg }, me.id);
            sendUser(me.id, { t: 'chat', message: msg });
          }
        }
        break;
      }
      case 'chat': {
        const conv = String(m.conv || '');
        if (!canAccess(me, conv)) return send(ws, { t: 'error', code: 'forbidden', msg: '沒有這個對話的權限' });
        const text = String(m.text || '').replace(/\u0000/g, '').trim();
        if (!text) return send(ws, { t: 'error', code: 'empty', msg: '請輸入文字' });
        if (text.length > TEXT_MAX) return send(ws, { t: 'error', code: 'too_long', msg: '文字最多 ' + TEXT_MAX + ' 字' });
        const msg = { id: 'm' + uid(8), conv, from: me.id, fromName: me.displayName, kind: 'text', text, ts: now() };
        media.addMessage(msg).catch(e => console.error('[chat]', e.message));
        broadcastConv(conv, { t: 'chat', message: msg }, me.id);
        sendUser(me.id, { t: 'chat', message: msg });
        break;
      }
      case 'ping': send(ws, { t: 'pong', ts: m.ts, serverTime: now() }); break;
      case 'ptt_push_token': {
        if (m.channelId === null || m.token === '') { removePttPush(me.id, m.channelId || null); store.save().catch(() => {}); send(ws, { t: 'ptt_push_ok', cleared: true }); break; }
        const token = String(m.token || '').trim();
        if (!token || token.length < 16) { send(ws, { t: 'error', code: 'bad_token', msg: '缺少有效的 PTT token' }); break; }
        upsertPttPush({ userId: me.id, channelId: m.channelId ? String(m.channelId) : null, token, bundleId: String(m.bundleId || process.env.APNS_BUNDLE_ID || 'app.ptt.mobile').slice(0, 80), channelUUID: String(m.channelUUID || '').slice(0, 80), kind: 'voip-ptt', updatedAt: now() });
        store.save().catch(() => {});
        send(ws, { t: 'ptt_push_ok' });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.talking) { const f = floors.get(ws.talking); if (f && f.ws === ws) endFloor(ws.talking, 'disconnect'); }
    if (!me) return;
    const o = online.get(me.id); if (!o) return;
    o.sockets.delete(ws);
    if (!o.sockets.size) {
      broadcastPresence(o.channel); broadcastOnline(); pushChannelsAll(); if (locations.has(me.id)) pushLocTo(me.id);
      for (const [id, q] of [...dispatchQueue]) if (q.from === me.id && q.status === 'waiting') { dispatchQueue.delete(id); broadcastDispatchers({ t: 'queue', items: queueView(orgIdOf(me)) }, orgIdOf(me)); }
    }
  });
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 10000);
setInterval(() => {
  for (const [conv, f] of floors) if (now() - f.lastAudio > (f.bytes ? STALL_MS : 10000)) { endFloor(conv, 'stalled'); send(f.ws, { t: 'floor_revoked', conv, reason: 'stalled' }); }
}, 500);

(async () => {
  await store.init();
  await media.init();
  await reports.init();
  await callLog.init();
  ensureLobbies();
  await seedAdmin();
  await store.save();
  const runClean = () => Promise.all([
    media.cleanup({ validUserIds: D().users.map(u => u.id).concat(['deleted']) }),
    reports.cleanup(),
    callLog.cleanup()
  ]).then(([m, r, c]) => console.log('[cleanup] media', m, 'reports', r, 'calls', c)).catch(e => console.error('[cleanup]', e.message));
  runClean();
  setInterval(runClean, 3600e3);
  setInterval(() => {
    for (const id of [...online.keys()]) {
      const u = viewerOf(id); if (!u) continue;
      if (u.role === 'admin') continue;
      if (!orgUsable(orgById(u.orgId))) kick(id, 4003, 'org_inactive');
    }
  }, 30000);
  server.listen(PORT, () => console.log(`[ptt] listening on :${PORT} (storage=${store.kind})`));
})().catch(e => { console.error('[ptt] startup failed', e); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await store.close(); } catch {} process.exit(0); });
