// PTT 原型伺服器：HTTP 靜態檔 + WebSocket（信令 + 語音即時轉發 + floor control）
// 語音只做即時轉發：不寫入磁碟、不保留在記憶體，講完就沒有了。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8800;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DB = path.join(DATA, 'db.json');        // 只存頻道清單（沒有任何音訊）
const SAMPLE_RATE = 16000;            // 客戶端上傳 16kHz / 16-bit / 單聲道 PCM
const MAX_TALK_MS = 60000;            // 單次發話上限 60 秒

fs.mkdirSync(DATA, { recursive: true });

// ---------- 簡易 JSON 資料庫 ----------
let db = { channels: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
db = { channels: db.channels || [] }; // 舊版的 messages 欄位一律丟棄
if (!db.channels.length) db.channels.push({ id: 'lobby', name: '大廳', createdAt: Date.now() });
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ channels: db.channels }));
    fs.renameSync(tmp, DB);
  }, 200);
}
save();

const now = () => Date.now();
const uid = () => crypto.randomBytes(8).toString('hex');
const dmKey = (a, b) => 'dm:' + [a, b].sort().join(':');
const isDm = (c) => c.startsWith('dm:');
const dmParts = (c) => c.slice(3).split(':');
const cleanName = (s, n = 20) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

// ---------- 線上狀態 ----------
/** userId -> { id, name, sockets:Set<ws>, channel } */
const users = new Map();
/** conv -> { userId, ws, streamId, bytes, startedAt, lastAudio, timer }（bytes 只是計數，不保存內容） */
const floors = new Map();
let streamSeq = 1;
/** conv -> { from, fromName, toName, ts, durMs }：只記「最近誰說過話」的純文字狀態，伺服器重啟即消失 */
const lastTalk = new Map();

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendUser(userId, obj) { const u = users.get(userId); if (u) for (const s of u.sockets) send(s, obj); }
function membersOf(channelId) {
  return [...users.values()].filter(u => u.channel === channelId && u.sockets.size)
    .map(u => ({ id: u.id, name: u.name }));
}
function onlineList() { return [...users.values()].filter(u => u.sockets.size).map(u => ({ id: u.id, name: u.name, channel: u.channel })); }
function recipients(conv) {
  if (isDm(conv)) return dmParts(conv).filter(id => users.has(id));
  return [...users.values()].filter(u => u.channel === conv).map(u => u.id);
}
function broadcastConv(conv, obj, exceptUserId) {
  for (const id of recipients(conv)) if (id !== exceptUserId) sendUser(id, obj);
}
function broadcastPresence(channelId) {
  if (!channelId) return;
  broadcastConv(channelId, { t: 'members', channel: channelId, members: membersOf(channelId) });
}
function broadcastAll(obj) { for (const u of users.values()) for (const s of u.sockets) send(s, obj); }
function channelInfo(c) {
  const lt = lastTalk.get(c.id);
  return { id: c.id, name: c.name, online: membersOf(c.id).length, last: lt ? lt.ts : 0, lastTalk: lt || null };
}
function dmSummaries(userId) {
  const list = [...lastTalk.entries()].filter(([conv]) => isDm(conv) && dmParts(conv).includes(userId));
  return list.map(([conv, m]) => {
    const other = dmParts(conv).find(x => x !== userId) || userId;
    const ou = users.get(other);
    return { conv, peerId: other, peerName: ou ? ou.name : (m.from === other ? m.fromName : m.toName) || '對方', last: m.ts, lastTalk: m };
  });
}
function canAccess(userId, conv) {
  if (isDm(conv)) return dmParts(conv).includes(userId);
  return db.channels.some(c => c.id === conv);
}

// ---------- Floor control ----------
function endFloor(conv, reason) {
  const f = floors.get(conv); if (!f) return;
  floors.delete(conv); clearTimeout(f.timer);
  const u = users.get(f.userId);
  const durMs = Math.round(f.bytes / 2 / SAMPLE_RATE * 1000);
  let info = null;
  if (f.bytes > 0) {
    let toName;
    if (isDm(conv)) { const other = dmParts(conv).find(x => x !== f.userId); toName = users.get(other)?.name; }
    info = { from: f.userId, fromName: u ? u.name : '?', toName, ts: f.startedAt, durMs };
    lastTalk.set(conv, info);
  }
  broadcastConv(conv, { t: 'talk_end', conv, streamId: f.streamId, from: f.userId, reason, lastTalk: info });
  if (info && !isDm(conv)) broadcastAll({ t: 'channel_activity', channel: conv, last: info.ts, lastTalk: info });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/health') return json(res, 200, { ok: true, online: onlineList().length, channels: db.channels.length, activeTalks: floors.size, storesAudio: false });
  if (p === '/api/channels') return json(res, 200, db.channels.map(channelInfo));
  if (p.startsWith('/api/') || p.startsWith('/audio/')) return json(res, 404, { error: 'not_found' }); // 沒有歷史、沒有錄音檔
  let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (ws) => {
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  let me = null;      // user record
  let talking = null; // conv I currently hold the floor in (for this socket)

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 語音資料：只有握有發言權的 socket 能送；伺服器加上 4-byte streamId 後轉發
      if (!me || !talking) return;
      const fl = floors.get(talking);
      if (!fl || fl.userId !== me.id || fl.ws !== ws) return;
      const buf = Buffer.from(data);
      if (fl.bytes + buf.length > SAMPLE_RATE * 2 * (MAX_TALK_MS / 1000 + 1)) return;
      fl.bytes += buf.length; fl.lastAudio = now(); // 只計長度，不保留音訊
      const out = Buffer.allocUnsafe(4 + buf.length); out.writeUInt32BE(fl.streamId, 0); buf.copy(out, 4);
      for (const id of recipients(talking)) if (id !== me.id) { const u = users.get(id); for (const s of u.sockets) if (s.readyState === 1) s.send(out); }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'hello') {
      const id = /^[0-9a-zA-Z_-]{6,40}$/.test(m.id || '') ? m.id : uid();
      const name = cleanName(m.name) || '匿名';
      me = users.get(id) || { id, name, sockets: new Set(), channel: null };
      me.name = name; me.sockets.add(ws); users.set(id, me);
      send(ws, { t: 'welcome', id, name, channels: db.channels.map(channelInfo), dms: dmSummaries(id), online: onlineList(), serverTime: now() });
      if (me.channel) { broadcastPresence(me.channel); send(ws, { t: 'joined', channel: me.channel }); }
      broadcastAll({ t: 'online', online: onlineList() });
      // 若有人正在頻道/私訊中發話，告知新連線者
      for (const [conv, f] of floors) if (recipients(conv).includes(id) && f.userId !== id) send(ws, { t: 'talk_start', conv, streamId: f.streamId, from: f.userId, fromName: users.get(f.userId)?.name });
      return;
    }
    if (!me) return;
    switch (m.t) {
      case 'create_channel': {
        const name = cleanName(m.name, 30); if (!name) return;
        let c = db.channels.find(x => x.name === name);
        if (!c) { c = { id: 'c' + uid().slice(0, 8), name, createdAt: now(), by: me.name }; db.channels.push(c); save(); broadcastAll({ t: 'channels', channels: db.channels.map(channelInfo) }); }
        send(ws, { t: 'channel_created', channel: c.id });
        break;
      }
      case 'join': {
        if (!db.channels.some(c => c.id === m.channel)) return send(ws, { t: 'error', msg: '頻道不存在' });
        const prev = me.channel; me.channel = m.channel;
        if (prev && prev !== m.channel) { if (talking === prev) { endFloor(prev, 'left'); talking = null; } broadcastPresence(prev); }
        for (const s of me.sockets) send(s, { t: 'joined', channel: m.channel });
        broadcastPresence(m.channel);
        broadcastAll({ t: 'channels', channels: db.channels.map(channelInfo) });
        broadcastAll({ t: 'online', online: onlineList() });
        const f = floors.get(m.channel);
        if (f && f.userId !== me.id) send(ws, { t: 'talk_start', conv: m.channel, streamId: f.streamId, from: f.userId, fromName: users.get(f.userId)?.name });
        break;
      }
      case 'ptt_start': {
        let conv = m.conv;
        if (m.to) conv = dmKey(me.id, m.to);
        if (!conv || !canAccess(me.id, conv) || (!isDm(conv) && me.channel !== conv)) return send(ws, { t: 'floor_denied', conv, reason: 'no_access' });
        // 沒有錄音保存：私人對講對象不在線就直接拒絕
        if (isDm(conv)) { const peer = dmParts(conv).find(x => x !== me.id); const pu = users.get(peer); if (!pu || !pu.sockets.size) return send(ws, { t: 'floor_denied', conv, reason: 'offline', byName: pu ? pu.name : '' }); }
        if (talking) endFloor(talking, 'switch');
        const cur = floors.get(conv);
        if (cur && cur.userId !== me.id) return send(ws, { t: 'floor_denied', conv, reason: 'busy', by: cur.userId, byName: users.get(cur.userId)?.name });
        if (cur) endFloor(conv, 'restart');
        const f = { userId: me.id, ws, streamId: streamSeq++, bytes: 0, startedAt: now(), lastAudio: now() };
        f.timer = setTimeout(() => { if (floors.get(conv) === f) { endFloor(conv, 'timeout'); talking = null; send(ws, { t: 'floor_revoked', conv, reason: 'timeout' }); } }, MAX_TALK_MS);
        floors.set(conv, f); talking = conv;
        send(ws, { t: 'floor_granted', conv, streamId: f.streamId, maxMs: MAX_TALK_MS });
        broadcastConv(conv, { t: 'talk_start', conv, streamId: f.streamId, from: me.id, fromName: me.name, toName: isDm(conv) ? users.get(dmParts(conv).find(x => x !== me.id))?.name : undefined }, me.id);
        break;
      }
      case 'ptt_stop': {
        if (talking) { const f = floors.get(talking); if (f && f.ws === ws) endFloor(talking, 'released'); talking = null; }
        break;
      }
      case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
    }
  });

  ws.on('close', () => {
    if (talking) { const f = floors.get(talking); if (f && f.ws === ws) endFloor(talking, 'disconnect'); }
    if (!me) return;
    me.sockets.delete(ws);
    if (!me.sockets.size) {
      const ch = me.channel;
      setTimeout(() => { if (!me.sockets.size) { broadcastPresence(ch); broadcastAll({ t: 'online', online: onlineList() }); broadcastAll({ t: 'channels', channels: db.channels.map(channelInfo) }); } }, 0);
    }
  });
});

// 心跳：清掉死連線（經過雲端代理時，對方斷網不一定會立刻觸發 close）
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 10000);
// 發話中超過 STALL_MS 沒收到語音封包（例如手機斷網）→ 自動釋放發言權；剛按下尚未有音訊時給 10 秒（第一次要等麥克風權限）
const STALL_MS = 3000;
setInterval(() => {
  for (const [conv, f] of floors) if (now() - f.lastAudio > (f.bytes ? STALL_MS : 10000)) {
    endFloor(conv, 'stalled');
    send(f.ws, { t: 'floor_revoked', conv, reason: 'stalled' });
  }
}, 500);

server.listen(PORT, () => console.log(`[ptt] listening on :${PORT}`));
