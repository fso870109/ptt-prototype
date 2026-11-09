// PTT 原型伺服器：HTTP 靜態檔 + REST API + WebSocket（信令 + 語音轉發 + floor control）
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
const AUDIO = path.join(DATA, 'audio');
const DB = path.join(DATA, 'db.json');
const SAMPLE_RATE = 16000;            // 客戶端上傳 16kHz / 16-bit / 單聲道 PCM
const MAX_TALK_MS = 60000;            // 單次發話上限 60 秒
const MIN_TALK_BYTES = SAMPLE_RATE * 2 * 0.3; // 少於 0.3 秒不存

fs.mkdirSync(AUDIO, { recursive: true });

// ---------- 簡易 JSON 資料庫 ----------
let db = { channels: [], messages: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
db.channels ||= []; db.messages ||= [];
if (!db.channels.length) db.channels.push({ id: 'lobby', name: '大廳', createdAt: Date.now() });
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
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
/** conv -> { userId, streamId, chunks:[], bytes, startedAt, timer } */
const floors = new Map();
let streamSeq = 1;

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
  const msgs = db.messages.filter(m => m.conv === c.id);
  return { id: c.id, name: c.name, online: membersOf(c.id).length, last: msgs.length ? msgs[msgs.length - 1].ts : 0 };
}
function dmSummaries(userId) {
  const map = new Map();
  for (const m of db.messages) if (isDm(m.conv) && dmParts(m.conv).includes(userId)) map.set(m.conv, m);
  return [...map.entries()].map(([conv, m]) => {
    const other = dmParts(conv).find(x => x !== userId) || userId;
    const ou = users.get(other);
    return { conv, peerId: other, peerName: ou ? ou.name : (m.from === other ? m.fromName : m.toName) || '對方', last: m.ts };
  });
}
function canAccess(userId, conv) {
  if (isDm(conv)) return dmParts(conv).includes(userId);
  return db.channels.some(c => c.id === conv);
}

// ---------- WAV ----------
function wavHeader(dataLen) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SAMPLE_RATE, 24); b.writeUInt32LE(SAMPLE_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b;
}

// ---------- Floor control ----------
function endFloor(conv, reason) {
  const f = floors.get(conv); if (!f) return;
  floors.delete(conv); clearTimeout(f.timer);
  const u = users.get(f.userId);
  const durMs = Math.round(f.bytes / 2 / SAMPLE_RATE * 1000);
  let msg = null;
  if (f.bytes >= MIN_TALK_BYTES) {
    const id = uid();
    const pcm = Buffer.concat(f.chunks);
    fs.writeFileSync(path.join(AUDIO, id + '.wav'), Buffer.concat([wavHeader(pcm.length), pcm]));
    let toName;
    if (isDm(conv)) { const other = dmParts(conv).find(x => x !== f.userId); toName = users.get(other)?.name; }
    msg = { id, conv, from: f.userId, fromName: u ? u.name : '?', toName, ts: f.startedAt, durMs };
    db.messages.push(msg); save();
  }
  const ev = { t: 'talk_end', conv, streamId: f.streamId, from: f.userId, reason, message: msg };
  broadcastConv(conv, ev);
  if (msg && !isDm(conv)) broadcastAll({ t: 'channel_activity', channel: conv, last: msg.ts });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/health') return json(res, 200, { ok: true, online: onlineList().length, channels: db.channels.length, messages: db.messages.length });
  if (p === '/api/channels') return json(res, 200, db.channels.map(channelInfo));
  if (p === '/api/history') {
    const conv = url.searchParams.get('conv') || '';
    const user = url.searchParams.get('user') || '';
    const since = +url.searchParams.get('since') || 0;
    if (!canAccess(user, conv)) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, db.messages.filter(m => m.conv === conv && m.ts > since).slice(-200));
  }
  const am = p.match(/^\/audio\/([0-9a-f]{16})\.wav$/);
  if (am) {
    const file = path.join(AUDIO, am[1] + '.wav');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size;
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range) { // iOS Safari 需要 Range 支援才能播放 audio
      const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }
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
      fl.chunks.push(buf); fl.bytes += buf.length;
      const out = Buffer.alloc(4 + buf.length); out.writeUInt32BE(fl.streamId, 0); buf.copy(out, 4);
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
        if (talking) endFloor(talking, 'switch');
        const cur = floors.get(conv);
        if (cur && cur.userId !== me.id) return send(ws, { t: 'floor_denied', conv, reason: 'busy', by: cur.userId, byName: users.get(cur.userId)?.name });
        if (cur) endFloor(conv, 'restart');
        const f = { userId: me.id, ws, streamId: streamSeq++, chunks: [], bytes: 0, startedAt: now() };
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

// 心跳：清掉死連線
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 20000);

server.listen(PORT, () => console.log(`[ptt] listening on :${PORT}`));
