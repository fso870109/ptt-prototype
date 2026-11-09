'use strict';
// ====== 一鍵對講 PTT 原型（前端）======
// 語音格式：16kHz / 16-bit / 單聲道 PCM，每 ~100ms 一包，透過 WebSocket 二進位訊框傳送。
const $ = (s) => document.querySelector(s);
const SR = 16000;
const store = {
  get id() { let v = localStorage.getItem('ptt_id'); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^0-9a-zA-Z_-]/g, ''); localStorage.setItem('ptt_id', v); } return v; },
  get name() { return localStorage.getItem('ptt_name') || ''; }, set name(v) { localStorage.setItem('ptt_name', v); },
  get channel() { return localStorage.getItem('ptt_channel') || ''; }, set channel(v) { localStorage.setItem('ptt_channel', v); },
  heard() { try { return JSON.parse(localStorage.getItem('ptt_heard') || '{}'); } catch { return {}; } },
  markHeard(id) { const h = this.heard(); h[id] = 1; const keys = Object.keys(h); if (keys.length > 3000) keys.slice(0, 1000).forEach(k => delete h[k]); localStorage.setItem('ptt_heard', JSON.stringify(h)); },
  seen(conv) { try { return (JSON.parse(localStorage.getItem('ptt_seen') || '{}'))[conv] || 0; } catch { return 0; } },
  setSeen(conv, ts) { let o = {}; try { o = JSON.parse(localStorage.getItem('ptt_seen') || '{}'); } catch {} if ((o[conv] || 0) < ts) { o[conv] = ts; localStorage.setItem('ptt_seen', JSON.stringify(o)); } },
};

const S = {
  ws: null, connected: false, retry: 0, myId: store.id, myName: '',
  channels: [], channel: '', members: [], online: [], dms: [],
  target: null,           // {type:'channel', id, name} | {type:'dm', peerId, peerName, conv}
  history: [], liveStreams: new Map(), // streamId -> {nextTime, from, conv, gotAudio}
  activeTalks: new Map(),  // conv -> {from, fromName, streamId}
  pressing: false, granted: false, streamId: 0, pending: [], pendingConv: '',
};

// ---------- 音訊：AudioContext 解鎖（iOS Safari 必須在使用者手勢中 resume）----------
let actx = null;
function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
  }
  return actx;
}
function unlockAudio() {
  const c = audioCtx();
  if (c.state !== 'running') c.resume().catch(() => {});
  // 播放一段極短靜音，iOS 才會真的解鎖輸出
  const b = c.createBuffer(1, 1, c.sampleRate); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
  // iOS 17+：讓 Web Audio 不受靜音鍵影響（不支援的瀏覽器會忽略）
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  // 解鎖 <audio>（歷史回放用）
  const p = $('#player'); if (!p.dataset.unlocked) { p.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; p.play().then(() => p.pause()).catch(() => {}); p.dataset.unlocked = '1'; }
}
['touchstart', 'pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }, { passive: true }));

// ---------- 播放即時串流 ----------
function playPcm(streamId, int16) {
  const c = audioCtx();
  let st = S.liveStreams.get(streamId);
  if (!st) { st = { nextTime: 0 }; S.liveStreams.set(streamId, st); }
  st.gotAudio = true;
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
  const buf = c.createBuffer(1, f.length, SR);
  buf.copyToChannel ? buf.copyToChannel(f, 0) : buf.getChannelData(0).set(f);
  const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
  const now = c.currentTime;
  if (st.nextTime < now + 0.05) st.nextTime = now + 0.18; // 起播 / 斷流後重新留 180ms 抖動緩衝
  src.start(st.nextTime);
  st.nextTime += buf.duration;
}

// ---------- 錄音 ----------
let mic = null, micNode = null, micSrc = null, micStopTimer = null, ds = null;
async function ensureMic() {
  clearTimeout(micStopTimer);
  if (mic && mic.getAudioTracks().some(t => t.readyState === 'live')) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('此瀏覽器不支援麥克風（需 HTTPS）');
  mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const c = audioCtx();
  micSrc = c.createMediaStreamSource(mic);
  micNode = c.createScriptProcessor(2048, 1, 1);
  const mute = c.createGain(); mute.gain.value = 0;
  micSrc.connect(micNode); micNode.connect(mute); mute.connect(c.destination);
  ds = makeDownsampler(c.sampleRate, SR);
  let acc = [], accLen = 0;
  micNode.onaudioprocess = (e) => {
    if (!S.pressing) return;
    const input = e.inputBuffer.getChannelData(0);
    let peak = 0; for (let i = 0; i < input.length; i += 8) peak = Math.max(peak, Math.abs(input[i]));
    $('#meterBar').style.width = Math.min(100, peak * 140) + '%';
    const out = ds(input); acc.push(out); accLen += out.length;
    if (accLen >= SR / 10) { // ~100ms
      const pkt = new Int16Array(accLen); let o = 0; for (const a of acc) { pkt.set(a, o); o += a.length; }
      acc = []; accLen = 0; sendAudio(pkt);
    }
  };
}
function releaseMicLater() {
  clearTimeout(micStopTimer);
  // 放開後保留 20 秒麥克風，連續對講不會每次重新要權限；之後關閉以釋放 iOS 的錄音狀態
  micStopTimer = setTimeout(() => { try { mic && mic.getTracks().forEach(t => t.stop()); micSrc && micSrc.disconnect(); micNode && micNode.disconnect(); } catch {} mic = null; micNode = null; }, 20000);
}
function makeDownsampler(inRate, outRate) {
  const ratio = inRate / outRate; let pos = 0; let last = 0;
  return (input) => {
    const n = Math.floor((input.length - pos) / ratio) + 1;
    const out = new Int16Array(Math.max(0, n)); let k = 0;
    for (; pos < input.length && k < out.length; pos += ratio) {
      const i = Math.floor(pos), fr = pos - i;
      const a = input[i], b = i + 1 < input.length ? input[i + 1] : a;
      let v = a + (b - a) * fr; v = Math.max(-1, Math.min(1, v));
      out[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    pos -= input.length; last = input[input.length - 1];
    return out.subarray(0, k);
  };
}
function sendAudio(pkt) {
  if (S.granted && S.ws && S.ws.readyState === 1) S.ws.send(pkt.buffer);
  else if (S.pressing && !S.granted) { S.pending.push(pkt); if (S.pending.length > 30) S.pending.shift(); }
}

// ---------- PTT 按鈕 ----------
const btn = $('#ptt');
async function pttDown(e) {
  e.preventDefault();
  if (S.pressing || btn.disabled) return;
  if (!S.connected) return toast('尚未連線');
  unlockAudio();
  const t = S.target; if (!t) return;
  const conv = t.type === 'dm' ? t.conv : t.id;
  const busy = S.activeTalks.get(conv);
  if (busy && busy.from !== S.myId) { flashBusy(busy.fromName); return; }
  S.pressing = true; S.granted = false; S.pending = []; S.pendingConv = conv;
  btn.classList.add('pressing'); $('#pttText').textContent = '連線中…';
  if (navigator.vibrate) navigator.vibrate(20);
  wsSend(t.type === 'dm' ? { t: 'ptt_start', to: t.peerId } : { t: 'ptt_start', conv });
  try { await ensureMic(); } catch (err) { toast('無法使用麥克風：' + (err.message || err.name)); pttUp(); }
}
function pttUp(e) {
  if (e) e.preventDefault();
  if (!S.pressing) return;
  S.pressing = false;
  // 最後一小段（<100ms）不足一包的資料直接捨棄，影響很小
  if (S.granted) wsSend({ t: 'ptt_stop' });
  else wsSend({ t: 'ptt_stop' });
  S.granted = false; S.pending = [];
  btn.classList.remove('pressing', 'talking'); $('#pttText').textContent = '按住講話'; $('#meterBar').style.width = '0';
  releaseMicLater(); updateTalkStatus();
}
btn.addEventListener('pointerdown', (e) => { btn.setPointerCapture && btn.setPointerCapture(e.pointerId); pttDown(e); });
btn.addEventListener('pointerup', pttUp);
btn.addEventListener('pointercancel', pttUp);
btn.addEventListener('lostpointercapture', pttUp);
btn.addEventListener('contextmenu', (e) => e.preventDefault());
// 鍵盤：電腦上按住空白鍵講話
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') pttDown(e); });
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') pttUp(e); });
window.addEventListener('blur', () => pttUp());

function flashBusy(name) {
  btn.classList.add('busy'); $('#pttText').textContent = `${name || '有人'} 正在說話`;
  if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  setTimeout(() => { btn.classList.remove('busy'); if (!S.pressing) $('#pttText').textContent = '按住講話'; }, 1500);
}

// ---------- WebSocket ----------
function wsSend(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function setConn(state, text) { $('#connDot').className = 'dot ' + state; $('#connText').textContent = text; S.connected = state === 'on'; updatePttEnabled(); }
function connect() {
  clearTimeout(connect.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer'; S.ws = ws;
  setConn('wait', S.retry ? `重新連線中…（第 ${S.retry} 次）` : '連線中…');
  ws.onopen = () => { S.retry = 0; ws.send(JSON.stringify({ t: 'hello', id: S.myId, name: S.myName })); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      const dv = new DataView(ev.data); const sid = dv.getUint32(0);
      const pcm = new Int16Array(ev.data.slice(4));
      playPcm(sid, pcm); return;
    }
    handle(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    if (S.pressing) pttUp();
    S.activeTalks.clear(); updateTalkStatus();
    const d = Math.min(10000, 1000 * Math.pow(1.6, S.retry++));
    setConn('off', `已斷線，${Math.round(d / 1000)} 秒後重連`);
    connect.timer = setTimeout(connect, d);
  };
  ws.onerror = () => {};
}
// 心跳：偵測半開連線（手機切網路時常見）
setInterval(() => {
  if (!S.ws || S.ws.readyState !== 1) return;
  const ts = Date.now(); wsSend({ t: 'ping', ts });
  S.lastPingSent = ts;
  setTimeout(() => { if (S.lastPong < ts && S.ws && S.ws.readyState === 1) { try { S.ws.close(); } catch {} } }, 8000);
}, 15000);
S.lastPong = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!S.ws || S.ws.readyState > 1) { S.retry = 0; connect(); }
    else if (S.target) loadHistory();
  }
});
window.addEventListener('online', () => { if (!S.ws || S.ws.readyState > 1) { S.retry = 0; connect(); } });

function handle(m) {
  switch (m.t) {
    case 'welcome':
      S.myId = m.id; S.channels = m.channels; S.dms = m.dms || []; S.online = m.online || [];
      setConn('on', '已連線');
      renderChannels(); renderDms(); renderOthers();
      { const want = S.channel || store.channel || 'lobby';
        const ok = S.channels.some(c => c.id === want) ? want : 'lobby';
        wsSend({ t: 'join', channel: ok }); }
      if (S.target) loadHistory();
      break;
    case 'pong': S.lastPong = Date.now(); break;
    case 'channels': S.channels = m.channels; renderChannels(); break;
    case 'channel_created': wsSend({ t: 'join', channel: m.channel }); break;
    case 'joined': {
      const changed = S.channel !== m.channel;
      S.channel = m.channel; store.channel = m.channel;
      const c = S.channels.find(x => x.id === m.channel);
      if (changed || !S.target || S.target.type === 'channel') { S.target = { type: 'channel', id: m.channel, name: c ? c.name : m.channel }; renderTarget(); loadHistory(); }
      renderChannels();
      break;
    }
    case 'members': if (m.channel === S.channel) { S.members = m.members; renderMembers(); } break;
    case 'online': S.online = m.online; renderOthers(); renderMembers(); break;
    case 'floor_granted':
      if (!S.pressing || m.conv !== S.pendingConv) { wsSend({ t: 'ptt_stop' }); break; }
      S.granted = true; S.streamId = m.streamId;
      btn.classList.remove('pressing'); btn.classList.add('talking'); $('#pttText').textContent = '說話中… 放開結束';
      for (const p of S.pending) S.ws.send(p.buffer); S.pending = [];
      if (navigator.vibrate) navigator.vibrate(40);
      break;
    case 'floor_denied':
      if (m.reason === 'busy') { const was = S.pressing; S.pressing = false; S.pending = []; btn.classList.remove('pressing', 'talking'); releaseMicLater(); if (was) flashBusy(m.byName); }
      else { pttUp(); toast('無法發話：' + (m.reason === 'no_access' ? '請先加入頻道' : m.reason)); }
      break;
    case 'floor_revoked': pttUp(); toast(m.reason === 'stalled' ? '網路不穩，語音中斷，已結束發話' : '已達單次發話上限 60 秒'); break;
    case 'talk_start':
      S.activeTalks.set(m.conv, { from: m.from, fromName: m.fromName, streamId: m.streamId });
      S.liveStreams.set(m.streamId, { nextTime: 0, from: m.from, conv: m.conv });
      unlockIfPossible(); updateTalkStatus();
      if (m.conv.startsWith('dm:') && !(S.target && S.target.conv === m.conv)) toast(`📞 ${m.fromName} 私人對講中`);
      break;
    case 'talk_end': {
      const a = S.activeTalks.get(m.conv); if (a && a.streamId === m.streamId) S.activeTalks.delete(m.conv);
      const st = S.liveStreams.get(m.streamId); S.liveStreams.delete(m.streamId);
      if (m.message) {
        if (m.message.from === S.myId || (st && st.gotAudio)) store.markHeard(m.message.id); // 即時聽過了
        if (m.conv.startsWith('dm:')) upsertDm(m.message);
        if (S.target && (S.target.type === 'dm' ? S.target.conv : S.target.id) === m.conv) { S.history.push(m.message); renderHistory(); }
        else if (m.conv.startsWith('dm:')) renderDms();
      }
      updateTalkStatus();
      break;
    }
    case 'channel_activity': { const c = S.channels.find(x => x.id === m.channel); if (c) { c.last = m.last; renderChannels(); } break; }
    case 'error': toast(m.msg); break;
  }
}
function unlockIfPossible() { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }

// ---------- 畫面 ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2600); }
function fmtTime(ts) { const d = new Date(ts); const today = new Date().toDateString() === d.toDateString(); return (today ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function updatePttEnabled() { btn.disabled = !S.connected || !S.target; }
function currentConv() { return S.target ? (S.target.type === 'dm' ? S.target.conv : S.target.id) : ''; }
function updateTalkStatus() {
  const parts = [];
  for (const [conv, a] of S.activeTalks) {
    if (a.from === S.myId) continue;
    if (conv.startsWith('dm:')) parts.push(`🔊 ${a.fromName} 正在私下對你說話`);
    else { const c = S.channels.find(x => x.id === conv); parts.push(`🔊 ${a.fromName} 正在說話${conv !== currentConv() ? `（${c ? c.name : ''}）` : ''}`); }
  }
  $('#talkStatus').textContent = parts.join('　') || '\u00a0';
  const busy = S.activeTalks.get(currentConv());
  if (!S.pressing) { btn.classList.toggle('busy', !!(busy && busy.from !== S.myId)); $('#pttText').textContent = busy && busy.from !== S.myId ? `${busy.fromName} 正在說話` : '按住講話'; }
}
function renderTarget() {
  const t = S.target;
  $('#targetLabel').textContent = !t ? '尚未加入頻道' : t.type === 'dm' ? `🔒 私人對講：${t.peerName}` : `# ${t.name}`;
  $('#backToChannel').classList.toggle('hidden', !(t && t.type === 'dm'));
  updatePttEnabled(); updateTalkStatus();
}
function renderChannels() {
  $('#channelList').innerHTML = S.channels.map(c => {
    const unread = c.last && c.last > store.seen(c.id) && c.id !== S.channel;
    return `<li data-ch="${esc(c.id)}" class="${c.id === S.channel ? 'active' : ''}"><span># ${esc(c.name)}${unread ? '<span class="newdot"></span>' : ''}</span><span class="meta">${c.online} 人在線</span></li>`;
  }).join('');
  const c = S.channels.find(x => x.id === S.channel); if (c && S.target && S.target.type === 'channel' && S.target.name !== c.name) { S.target.name = c.name; renderTarget(); }
}
function renderMembers() {
  $('#memberList').innerHTML = S.members.map(u => `<li data-uid="${esc(u.id)}" data-name="${esc(u.name)}"><span>🟢 ${esc(u.name)}${u.id === S.myId ? '（你）' : ''}</span>${u.id === S.myId ? '' : '<span class="meta">私人對講 ›</span>'}</li>`).join('') || '<li class="muted">（沒有人）</li>';
}
function renderOthers() {
  const ids = new Set(S.members.map(u => u.id));
  const others = S.online.filter(u => !ids.has(u.id) && u.id !== S.myId);
  $('#otherList').innerHTML = others.map(u => { const c = S.channels.find(x => x.id === u.channel); return `<li data-uid="${esc(u.id)}" data-name="${esc(u.name)}"><span>🟢 ${esc(u.name)}</span><span class="meta">${c ? '#' + esc(c.name) : ''} · 私人對講 ›</span></li>`; }).join('') || '<li class="muted">（沒有）</li>';
}
function upsertDm(msg) {
  const peerId = msg.conv.slice(3).split(':').find(x => x !== S.myId) || S.myId;
  let d = S.dms.find(x => x.conv === msg.conv);
  const peerName = msg.from === peerId ? msg.fromName : (msg.toName || d?.peerName || '對方');
  if (!d) { d = { conv: msg.conv, peerId, peerName, last: msg.ts }; S.dms.push(d); }
  d.last = Math.max(d.last, msg.ts); if (msg.from === peerId) d.peerName = msg.fromName;
  renderDms();
}
function renderDms() {
  S.dms.sort((a, b) => b.last - a.last);
  let unreadN = 0;
  $('#dmList').innerHTML = S.dms.map(d => {
    const unread = d.last > store.seen(d.conv) && currentConv() !== d.conv; if (unread) unreadN++;
    return `<li data-uid="${esc(d.peerId)}" data-name="${esc(d.peerName)}"><span>🔒 ${esc(d.peerName)}${unread ? '<span class="newdot"></span>' : ''}</span><span class="meta">${fmtTime(d.last)}</span></li>`;
  }).join('') || '<li class="muted">還沒有私人對講。到「成員」點一個人即可開始。</li>';
  $('#dmBadge').textContent = unreadN; $('#dmBadge').classList.toggle('hidden', !unreadN);
}
function openDm(peerId, peerName) {
  if (peerId === S.myId) return;
  const conv = 'dm:' + [S.myId, peerId].sort().join(':');
  S.target = { type: 'dm', peerId, peerName, conv }; renderTarget(); loadHistory(); renderDms();
}

async function loadHistory() {
  const conv = currentConv(); if (!conv) return;
  try {
    const r = await fetch(`/api/history?conv=${encodeURIComponent(conv)}&user=${encodeURIComponent(S.myId)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const list = await r.json();
    if (conv !== currentConv()) return;
    S.history = list; renderHistory();
  } catch (e) { toast('讀取紀錄失敗'); }
}
function renderHistory() {
  const heard = store.heard(); const conv = currentConv();
  const items = S.history.slice(-100);
  let unread = 0;
  $('#historyList').innerHTML = items.slice().reverse().map(m => {
    const mine = m.from === S.myId; const un = !mine && !heard[m.id]; if (un) unread++;
    return `<li data-id="${m.id}" class="${un ? 'unread' : ''} ${mine ? 'mine' : ''}"><div class="info"><div class="who">${esc(mine ? '我' : m.fromName)}</div><div class="when">${fmtTime(m.ts)} · ${(m.durMs / 1000).toFixed(1)} 秒</div></div><button data-play="${m.id}">▶ 播放</button></li>`;
  }).join('') || '<li class="muted">還沒有語音紀錄</li>';
  $('#unreadCount').textContent = unread; $('#playUnread').classList.toggle('hidden', !unread);
  if (items.length) store.setSeen(conv, items[items.length - 1].ts);
  renderChannels(); if (conv.startsWith('dm:')) renderDms();
}

// ---------- 歷史回放 ----------
const player = $('#player'); let queue = [];
function playMsg(id) {
  unlockAudio();
  document.querySelectorAll('.hist li.playing').forEach(li => li.classList.remove('playing'));
  const li = document.querySelector(`.hist li[data-id="${id}"]`); if (li) li.classList.add('playing');
  player.src = `/audio/${id}.wav`; player.dataset.id = id;
  player.play().catch(err => toast('播放失敗：' + err.name));
  store.markHeard(id);
}
player.addEventListener('ended', () => {
  document.querySelectorAll('.hist li.playing').forEach(li => { li.classList.remove('playing'); li.classList.remove('unread'); });
  if (queue.length) playMsg(queue.shift()); else renderHistory();
});
$('#historyList').addEventListener('click', (e) => { const id = e.target.dataset.play; if (id) { queue = []; playMsg(id); } });
$('#playUnread').addEventListener('click', () => {
  const heard = store.heard();
  queue = S.history.filter(m => m.from !== S.myId && !heard[m.id]).map(m => m.id);
  if (queue.length) playMsg(queue.shift());
});

// ---------- 事件 ----------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  ['channels', 'members', 'dms'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
}));
$('#channelList').addEventListener('click', (e) => { const li = e.target.closest('li[data-ch]'); if (!li) return; if (li.dataset.ch === S.channel) { const c = S.channels.find(x => x.id === S.channel); S.target = { type: 'channel', id: S.channel, name: c ? c.name : '' }; renderTarget(); loadHistory(); } else wsSend({ t: 'join', channel: li.dataset.ch }); });
$('#createChannel').addEventListener('click', () => { const n = $('#newChannel').value.trim(); if (!n) return toast('請輸入頻道名稱'); wsSend({ t: 'create_channel', name: n }); $('#newChannel').value = ''; });
$('#newChannel').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#createChannel').click(); });
['#memberList', '#otherList', '#dmList'].forEach(sel => $(sel).addEventListener('click', (e) => { const li = e.target.closest('li[data-uid]'); if (li) openDm(li.dataset.uid, li.dataset.name); }));
$('#backToChannel').addEventListener('click', () => { const c = S.channels.find(x => x.id === S.channel); S.target = { type: 'channel', id: S.channel, name: c ? c.name : '' }; renderTarget(); loadHistory(); });
$('#logout').addEventListener('click', () => { localStorage.removeItem('ptt_name'); location.reload(); });

function enter() {
  const n = $('#nick').value.trim(); if (!n) return toast('請輸入暱稱');
  unlockAudio();
  S.myName = n; store.name = n;
  $('#meName').textContent = n;
  $('#login').classList.add('hidden'); $('#main').classList.remove('hidden');
  connect();
}
$('#enter').addEventListener('click', enter);
$('#nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
$('#nick').value = store.name;
if (store.name) {
  // 已登入過：直接進入；AudioContext 會在第一次觸碰時解鎖
  S.myName = store.name; $('#meName').textContent = store.name;
  $('#login').classList.add('hidden'); $('#main').classList.remove('hidden'); connect();
  toast('點一下畫面任一處以啟用聲音');
  document.addEventListener('pointerdown', function once() { unlockAudio(); document.removeEventListener('pointerdown', once); });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
