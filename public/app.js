'use strict';
// ====== 一鍵對講 PTT 原型（前端・第二階段）======
// 語音格式：16kHz / 16-bit / 單聲道 PCM，每 ~100ms 一包，透過 WebSocket 二進位訊框傳送。
// 語音只即時播放，不錄存：伺服器與瀏覽器都不保留任何音訊。
const $ = (s) => document.querySelector(s);
const SR = 16000;
const store = {
  get token() { return localStorage.getItem('ptt_token') || ''; }, set token(v) { v ? localStorage.setItem('ptt_token', v) : localStorage.removeItem('ptt_token'); },
  get channel() { return localStorage.getItem('ptt_channel') || ''; }, set channel(v) { localStorage.setItem('ptt_channel', v || ''); },
  get shareLoc() { return localStorage.getItem('ptt_share_loc') === '1'; }, set shareLoc(v) { localStorage.setItem('ptt_share_loc', v ? '1' : '0'); },
  get org() { return localStorage.getItem('ptt_org') || ''; }, set org(v) { v ? localStorage.setItem('ptt_org', v) : localStorage.removeItem('ptt_org'); },
};
const ROLE_LABEL = { supervisor: '主管', member: '一般', listener: '只聽' };

const S = {
  ws: null, connected: false, retry: 0, me: null, myId: '',
  channels: [], channel: '', members: [], online: [], dms: [],
  target: null,           // {type:'channel', id, name} | {type:'dm', peerId, peerName, conv}
  log: [], liveStreams: new Map(), lastTalk: {},
  activeTalks: new Map(),  // conv -> {from, fromName, streamId}
  pressing: false, granted: false, streamId: 0, pending: [], pendingConv: '',
  alerts: new Map(), ackedAlerts: new Set(), locs: new Map(),
  chat: [], chatConv: '',
};
function speechEngine() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
function updateSttHint() {
  const el = $('#sttHint'); if (!el) return;
  const extra = (S.org && S.org.settings && S.org.settings.saveCaptions)
    ? '此公司有開啟「把最終字幕存成文字紀錄」。'
    : '預設只即時顯示字幕、不存檔；公司管理員可在後台開啟存檔。';
  if (!speechEngine()) el.textContent = '這個瀏覽器不支援即時語音轉文字（建議使用 Chrome 或 Edge；部分 iOS Safari 與 Firefox 無法使用）。對講功能不受影響，只是沒有即時字幕。' + extra;
  else el.textContent = '講話時會嘗試產生即時字幕（繁體中文）。本伺服器不保存語音。部分瀏覽器（例如 Chrome）可能會把聲音送到廠商的辨識服務。' + extra;
}
function showCaptionLive(m) {
  const el = $('#captionLive'); if (!el) return;
  if (!m || !m.text) { el.classList.add('hidden'); el.textContent = ''; return; }
  const mine = m.from === S.myId;
  el.classList.remove('hidden');
  el.textContent = (m.interim ? '字幕（辨識中）：' : '字幕：') + (mine ? '' : ((m.fromName || '') + '：')) + m.text;
  clearTimeout(showCaptionLive.t);
  if (!m.interim) showCaptionLive.t = setTimeout(() => { el.classList.add('hidden'); }, 6000);
}
function stopCaptions() {
  S.wantCaptions = false;
  const rec = S.captionRec;
  if (!rec) return;
  rec.onend = () => { if (S.captionRec === rec) S.captionRec = null; };
  try { rec.stop(); } catch { S.captionRec = null; }
}
function startCaptions(conv) {
  stopCaptions();
  const Ctor = speechEngine();
  if (!Ctor || !conv) return;
  S.wantCaptions = true;
  S.captionConv = conv;
  const rec = new Ctor();
  rec.lang = 'zh-TW';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = '', finalTxt = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalTxt += piece;
      else interim += piece;
    }
    if (interim) {
      showCaptionLive({ text: interim, interim: true, from: S.myId });
      if (Date.now() - (S.lastCaptionSent || 0) > 250) {
        S.lastCaptionSent = Date.now();
        wsSend({ t: 'caption', conv, text: interim, interim: true });
      }
    }
    if (finalTxt.trim()) {
      const text = finalTxt.trim();
      showCaptionLive({ text, interim: false, from: S.myId });
      wsSend({ t: 'caption', conv, text, interim: false });
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      const el = $('#sttHint');
      if (el) el.textContent = '瀏覽器沒有允許語音辨識，因此沒有即時字幕。對講功能不受影響。';
    }
  };
  rec.onend = () => {
    if (S.wantCaptions && S.captionRec === rec) {
      try { rec.start(); } catch {}
    } else if (S.captionRec === rec) S.captionRec = null;
  };
  S.captionRec = rec;
  try { rec.start(); } catch { S.captionRec = null; S.wantCaptions = false; }
}

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
function myRoleHere() { if (!S.target || S.target.type === 'dm') return 'member'; const c = S.channels.find(x => x.id === S.target.id); return c ? c.myRole : null; }
function myAlert() { for (const a of S.alerts.values()) if (a.userId === S.myId) return a; return null; }
async function pttDown(e) {
  e.preventDefault();
  if (S.pressing || btn.disabled) return;
  if (!S.connected) return toast('尚未連線');
  unlockAudio();
  const t = S.target; if (!t) return;
  if (myRoleHere() === 'listener' && !myAlert()) { toast('你在這個頻道是「只聽」角色，不能發話'); return; }
  const conv = t.type === 'dm' ? t.conv : t.id;
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
  wsSend({ t: 'ptt_stop' });
  S.granted = false; S.pending = [];
  stopCaptions();
  btn.classList.remove('pressing', 'talking'); $('#meterBar').style.width = '0';
  releaseMicLater(); updateTalkStatus();
}
btn.addEventListener('pointerdown', (e) => { btn.setPointerCapture && btn.setPointerCapture(e.pointerId); pttDown(e); });
btn.addEventListener('pointerup', pttUp);
btn.addEventListener('pointercancel', pttUp);
btn.addEventListener('lostpointercapture', pttUp);
btn.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !$('#main').classList.contains('hidden')) pttDown(e); });
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) pttUp(e); });
window.addEventListener('blur', () => pttUp());
function flashBusy(name) {
  btn.classList.add('busy'); $('#pttText').textContent = `${name || '有人'} 正在說話`;
  if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  setTimeout(() => { btn.classList.remove('busy'); if (!S.pressing) updateTalkStatus(); }, 1500);
}

// ---------- 緊急警報按鈕（長按 2 秒，防誤觸）----------
const sos = $('#sos'); let sosTimer = null;
function sosDown(e) {
  e.preventDefault(); if (!S.connected) return toast('尚未連線');
  unlockAudio(); sos.setPointerCapture && e.pointerId !== undefined && sos.setPointerCapture(e.pointerId);
  sos.classList.add('holding'); sos.querySelector('.sos-text').textContent = '繼續按住… 放開取消';
  sosTimer = setTimeout(() => { sosTimer = null; sos.classList.remove('holding'); sos.querySelector('.sos-text').textContent = '🚨 警報已發出'; fireAlert(); setTimeout(resetSos, 2500); }, 2000);
}
function sosUp() { if (sosTimer) { clearTimeout(sosTimer); sosTimer = null; resetSos(); toast('已取消（需長按 2 秒）'); } }
function resetSos() { sos.classList.remove('holding'); sos.querySelector('.sos-text').textContent = myAlert() ? '🚨 警報進行中（點此查看）' : '🚨 長按 2 秒發出緊急警報'; }
sos.addEventListener('pointerdown', sosDown);
sos.addEventListener('pointerup', sosUp); sos.addEventListener('pointercancel', sosUp); sos.addEventListener('lostpointercapture', sosUp);
sos.addEventListener('contextmenu', (e) => e.preventDefault());
$('#callDispatch').addEventListener('click', () => {
  if (!S.connected) return toast('尚未連線');
  wsSend({ t: 'dispatch_call' });
});
function fireAlert() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  const sendIt = (pos) => wsSend({ t: 'alert_start', ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy } : {}) });
  if (navigator.geolocation) {
    let done = false; const t = setTimeout(() => { if (!done) { done = true; sendIt(null); } }, 4000);
    navigator.geolocation.getCurrentPosition((p) => { if (!done) { done = true; clearTimeout(t); sendIt(p); } }, () => { if (!done) { done = true; clearTimeout(t); sendIt(null); } }, { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 });
  } else sendIt(null);
}

// ---------- 警報顯示 ----------
let siren = null;
function startSiren() {
  if (siren) return;
  try {
    const c = audioCtx(); const o = c.createOscillator(); const g = c.createGain();
    o.type = 'square'; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start();
    let hi = false; const iv = setInterval(() => { hi = !hi; o.frequency.setValueAtTime(hi ? 960 : 640, c.currentTime); }, 450);
    siren = { stop() { clearInterval(iv); try { o.stop(); } catch {} } };
  } catch {}
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
}
function stopSiren() { if (siren) { siren.stop(); siren = null; } }
function mapUrl(a) { return a.lat != null ? `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}` : ''; }
function renderAlerts() {
  const list = [...S.alerts.values()];
  const banner = $('#alertBanner');
  if (!list.length) { banner.classList.add('hidden'); $('#alertOverlay').classList.add('hidden'); stopSiren(); resetSos(); return; }
  banner.classList.remove('hidden');
  banner.textContent = '🚨 ' + list.map(a => `${a.userId === S.myId ? '你' : a.name} 發出緊急警報${a.channelName ? '（' + a.channelName + '）' : ''}`).join('；') + ' — 點此查看';
  const un = list.find(a => !S.ackedAlerts.has(a.id)) || null;
  if (un) showAlert(un); else { $('#alertOverlay').classList.add('hidden'); stopSiren(); }
  resetSos();
}
function showAlert(a) {
  const mine = a.userId === S.myId;
  $('#alertWho').textContent = mine ? '你已發出緊急警報' : `${a.name} 發出緊急警報`;
  $('#alertWhere').textContent = (a.channelName ? `頻道：${a.channelName}　` : '') + (a.lat != null ? `位置：${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}${a.acc ? `（±${Math.round(a.acc)}m）` : ''}` : '位置：不明（未取得定位）');
  $('#alertWhen').textContent = '時間：' + fmtTime(a.ts) + (mine ? ' · 警報期間你擁有最高發話權' : '');
  const link = $('#alertMapLink'); const u = mapUrl(a);
  link.classList.toggle('hidden', !u); if (u) link.href = u;
  const canResolve = (S.me && S.me.role === 'admin') || mine;
  $('#alertResolve').classList.toggle('hidden', !canResolve);
  $('#alertResolve').textContent = mine && !(S.me && S.me.role === 'admin') ? '取消我的警報' : '解除警報';
  $('#alertResolve').dataset.id = a.id; $('#alertAck').dataset.id = a.id;
  $('#alertOverlay').classList.remove('hidden');
  if (!mine) startSiren();
}
$('#alertAck').addEventListener('click', () => { S.ackedAlerts.add($('#alertAck').dataset.id); stopSiren(); renderAlerts(); });
$('#alertResolve').addEventListener('click', () => { if (confirm('確定要解除這個警報？')) wsSend({ t: 'alert_resolve', id: $('#alertResolve').dataset.id }); });
$('#alertBanner').addEventListener('click', () => { const a = [...S.alerts.values()][0]; if (a) { S.ackedAlerts.delete(a.id); showAlert(a); } });

// ---------- 位置與電量 ----------
let geoWatch = null, lastSent = 0, lastPos = null, battery = null, locTimer = null;
async function initBattery() {
  if (battery !== null) return;
  try { battery = navigator.getBattery ? await navigator.getBattery() : false; } catch { battery = false; }
}
function sendLoc(force) {
  if (!lastPos || !S.connected) return;
  if (!force && Date.now() - lastSent < 15000) return;
  lastSent = Date.now();
  const b = battery ? { battery: battery.level, charging: battery.charging } : {};
  wsSend({ t: 'loc', lat: lastPos.coords.latitude, lng: lastPos.coords.longitude, acc: lastPos.coords.accuracy, ...b });
  $('#locStatus').textContent = `已回報 ${fmtTime(Date.now())}${battery ? ` · 電量 ${Math.round(battery.level * 100)}%` : ' · 電量不明'}`;
}
async function startLoc() {
  if (!navigator.geolocation) { toast('此瀏覽器不支援定位'); $('#shareLoc').checked = false; return; }
  await initBattery();
  geoWatch = navigator.geolocation.watchPosition((p) => { const first = !lastPos; lastPos = p; sendLoc(first); },
    (err) => { $('#locStatus').textContent = '無法取得定位：' + (err.code === 1 ? '未授權' : err.message); if (err.code === 1) { $('#shareLoc').checked = false; store.shareLoc = false; stopLoc(); } },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  clearInterval(locTimer); locTimer = setInterval(() => sendLoc(true), 30000); // 每 30 秒回報一次
  $('#locStatus').textContent = '定位中…';
}
function stopLoc() { if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; clearInterval(locTimer); lastPos = null; $('#locStatus').textContent = '未分享'; }
$('#shareLoc').addEventListener('change', (e) => {
  store.shareLoc = e.target.checked;
  if (e.target.checked) startLoc(); else { stopLoc(); wsSend({ t: 'loc_off' }); }
});

// ---------- 地圖（Leaflet + OpenStreetMap 圖磚）----------
let map = null; const markers = new Map();
function ensureMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: true }).setView([23.7, 121], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 貢獻者' }).addTo(map);
}
function ago(ts) { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分鐘前` : fmtTime(ts); }
function locLine(l) { return `${esc(l.name)}${l.id === S.myId ? '（你）' : ''} · 電量 ${l.battery == null ? '不明' : l.battery + '%' + (l.charging ? '⚡' : '')} · ${l.online ? '在線' : '離線'} · ${ago(l.ts)}`; }
function renderLocs() {
  const list = [...S.locs.values()].sort((a, b) => b.ts - a.ts);
  $('#locList').innerHTML = list.map(l => `<li data-loc="${esc(l.id)}"><span>📍 ${locLine(l)}</span><span class="meta">${l.channelName ? '#' + esc(l.channelName) : ''}</span></li>`).join('') || `<li class="muted">${S.me && S.me.role === 'admin' ? '還沒有人分享位置' : '同頻道還沒有人分享位置'}</li>`;
  if (!map) return;
  for (const [id, mk] of markers) if (!S.locs.has(id)) { map.removeLayer(mk); markers.delete(id); }
  for (const l of list) {
    let mk = markers.get(l.id);
    const html = locLine(l) + (l.acc ? `<br>誤差 ±${l.acc}m` : '');
    if (!mk) { mk = L.marker([l.lat, l.lng]).addTo(map); markers.set(l.id, mk); }
    mk.setLatLng([l.lat, l.lng]); mk.bindPopup(html); mk.bindTooltip(esc(l.name), { permanent: true, direction: 'top', offset: [0, -30] });
  }
}
function fitMap() { if (!map) return; const pts = [...S.locs.values()].map(l => [l.lat, l.lng]); if (pts.length === 1) map.setView(pts[0], 15); else if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 }); }
$('#locList').addEventListener('click', (e) => { const li = e.target.closest('li[data-loc]'); const l = li && S.locs.get(li.dataset.loc); if (l && map) { map.setView([l.lat, l.lng], 16); markers.get(l.id)?.openPopup(); } });
setInterval(() => { if (!$('#tab-map').classList.contains('hidden')) renderLocs(); }, 15000);

// ---------- WebSocket ----------
function wsSend(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function setConn(state, text) { $('#connDot').className = 'dot ' + state; $('#connText').textContent = text; S.connected = state === 'on'; updatePttEnabled(); }
function connect() {
  clearTimeout(connect.timer);
  if (!store.token) return showLogin();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer'; S.ws = ws;
  setConn('wait', S.retry ? `重新連線中…（第 ${S.retry} 次）` : '連線中…');
  ws.onopen = () => { S.retry = 0; ws.send(JSON.stringify({ t: 'hello', token: store.token })); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { const sid = new DataView(ev.data).getUint32(0); playPcm(sid, new Int16Array(ev.data.slice(4))); return; }
    handle(JSON.parse(ev.data));
  };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    if (S.pressing) pttUp();
    S.activeTalks.clear(); updateTalkStatus();
    if (ev.code === 4001 || ev.code === 4003 || S.authFailed) { S.authFailed = false; setConn('off', '請重新登入'); return; }
    const d = Math.min(10000, 1000 * Math.pow(1.6, S.retry++));
    setConn('off', `已斷線，${Math.round(d / 1000)} 秒後重連`);
    connect.timer = setTimeout(connect, d);
  };
  ws.onerror = () => {};
}
setInterval(() => {
  if (!S.ws || S.ws.readyState !== 1) return;
  const ts = Date.now(); wsSend({ t: 'ping', ts });
  setTimeout(() => { if (S.lastPong < ts && S.ws && S.ws.readyState === 1) { try { S.ws.close(); } catch {} } }, 8000);
}, 15000);
S.lastPong = Date.now();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.token && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; connect(); } });
window.addEventListener('online', () => { if (store.token && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; connect(); } });

function handle(m) {
  switch (m.t) {
    case 'auth_failed':
      S.authFailed = true; store.token = ''; showLogin(m.reason === 'revoked' ? '你的帳號已被停用或密碼已重設，請重新登入' : '登入已過期，請重新登入'); break;
    case 'welcome':
      S.me = m.user; S.myId = m.user.id; S.channels = m.channels; S.dms = m.dms || []; S.online = m.online || []; S.org = m.org || null;
      updateSttHint();
      const roleLabel = { admin: '平台管理員', org_admin: '公司管理員', dispatcher: '調度員' }[m.user.role];
      $('#meName').textContent = m.user.displayName + (roleLabel ? '（' + roleLabel + '）' : '');
      $('#adminLink').classList.toggle('hidden', m.user.role !== 'admin' && m.user.role !== 'org_admin');
      $('#dispatchLink').classList.toggle('hidden', m.user.role !== 'admin' && m.user.role !== 'org_admin' && m.user.role !== 'dispatcher');
      $('#callDispatch').classList.toggle('hidden', m.user.role === 'admin' || m.user.role === 'org_admin' || m.user.role === 'dispatcher');
      setConn('on', '已連線');
      S.alerts = new Map((m.alerts || []).map(a => [a.id, a])); renderAlerts();
      renderChannels(); renderDms(); renderOthers();
      { const want = S.channel || store.channel || 'lobby';
        const ok = S.channels.some(c => c.id === want) ? want : (S.channels[0] && S.channels[0].id);
        if (ok) wsSend({ t: 'join', channel: ok }); else { S.target = null; renderTarget(); } }
      if (store.shareLoc) { $('#shareLoc').checked = true; if (geoWatch === null) startLoc(); else sendLoc(true); }
      renderActivity();
      break;
    case 'pong': S.lastPong = Date.now(); break;
    case 'channels': S.channels = m.channels; renderChannels(); renderTarget(); break;
    case 'joined': {
      if (!m.channel) { S.channel = ''; S.target = null; renderTarget(); toast('你已沒有任何頻道的權限'); break; }
      if (m.reason === 'access_changed') toast('頻道權限已變更，已移回「大廳」');
      const changed = S.channel !== m.channel;
      S.channel = m.channel; store.channel = m.channel;
      const c = S.channels.find(x => x.id === m.channel);
      if (changed || !S.target || S.target.type === 'channel') { S.target = { type: 'channel', id: m.channel, name: c ? c.name : m.channel }; renderTarget(); renderActivity(); }
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
      try { startCaptions(m.conv); } catch (err) { console.warn("captions", err); }
      break;
    case 'floor_denied': {
      const was = S.pressing; S.pressing = false; S.granted = false; S.pending = []; btn.classList.remove('pressing', 'talking'); releaseMicLater();
      if (m.reason === 'busy') { if (was) flashBusy(m.byName); }
      else { updateTalkStatus(); toast(m.reason === 'offline' ? `${m.byName || '對方'} 目前不在線（不保存錄音，無法留言）` : m.reason === 'listen_only' ? '你在這個頻道是「只聽」角色，不能發話' : m.reason === 'no_access' ? '你沒有在這裡發話的權限' : '無法發話：' + m.reason); }
      break;
    }
    case 'floor_revoked':
      pttUp();
      if (m.reason === 'preempted') { toast(`⚠️ 你的發話被 ${m.byName} 中斷（優先權較高）`); if (navigator.vibrate) navigator.vibrate([100, 50, 100]); }
      else toast(m.reason === 'stalled' ? '網路不穩，語音中斷，已結束發話' : '已達單次發話上限 60 秒');
      break;
    case 'talk_start':
      S.activeTalks.set(m.conv, { from: m.from, fromName: m.fromName, streamId: m.streamId, prio: m.prio });
      S.liveStreams.set(m.streamId, { nextTime: 0, from: m.from, conv: m.conv });
      if (actx && actx.state !== 'running') actx.resume().catch(() => {});
      updateTalkStatus();
      if (m.conv.startsWith('dm:') && !(S.target && S.target.conv === m.conv)) toast(`📞 ${m.fromName} 私人對講中`);
      break;
    case 'talk_end': {
      const a = S.activeTalks.get(m.conv); if (a && a.streamId === m.streamId) S.activeTalks.delete(m.conv);
      S.liveStreams.delete(m.streamId);
      if (m.reason === 'preempted' && m.from !== S.myId) S.log.push({ conv: m.conv, note: `${nameById(m.from)} 被 ${m.byName} 中斷`, ts: Date.now() });
      if (m.lastTalk) {
        S.lastTalk[m.conv] = m.lastTalk;
        S.log.push({ conv: m.conv, ...m.lastTalk }); if (S.log.length > 200) S.log.shift();
        if (m.conv.startsWith('dm:')) upsertDm(m.conv, m.lastTalk);
      }
      if (m.conv === currentConv()) renderActivity();
      updateTalkStatus();
      break;
    }
    case 'channel_activity': { const c = S.channels.find(x => x.id === m.channel); if (c) { c.last = m.last; c.lastTalk = m.lastTalk; renderChannels(); } break; }
    case 'loc': S.locs.set(m.loc.id, m.loc); renderLocs(); break;
    case 'locs': S.locs = new Map(m.locs.map(l => [l.id, l])); renderLocs(); break;
    case 'loc_remove': S.locs.delete(m.id); renderLocs(); break;
    case 'alert': S.alerts.set(m.alert.id, m.alert); S.ackedAlerts.delete(m.alert.id); renderAlerts(); break;
    case 'alert_end': S.alerts.delete(m.id); renderAlerts(); toast(`✅ 警報已由 ${m.by} 解除`); break;
    case 'caption':
      if (m.conv === currentConv() || S.activeTalks.has(m.conv)) showCaptionLive(m);
      break;
    case 'chat':
      if (m.message && m.message.conv === currentConv()) {
        if (!S.chat.some(x => x.id === m.message.id)) { S.chat.push(m.message); renderChat(); }
      }
      break;
    case 'queue_self':
      S.dispatchCall = m.item;
      $('#dispatchStatus').classList.remove('hidden');
      $('#dispatchStatus').textContent = '已呼叫調度台，等候接聽…';
      $('#callDispatch').disabled = true;
      break;
    case 'dispatch_pickup':
      S.dispatchCall = m.item;
      $('#dispatchStatus').classList.remove('hidden');
      $('#dispatchStatus').textContent = (m.byName || '調度員') + ' 已接聽，現為一對一對講';
      $('#callDispatch').disabled = true;
      if (m.by) openDm(m.by, m.byName);
      break;
    case 'dispatch_transfer':
      S.dispatchCall = m.item;
      $('#dispatchStatus').classList.remove('hidden');
      $('#dispatchStatus').textContent = '已轉接給 ' + (m.toName || '另一位調度員');
      $('#callDispatch').disabled = true;
      if (m.to) openDm(m.to, m.toName);
      break;
    case 'dispatch_done':
      S.dispatchCall = null;
      $('#dispatchStatus').classList.add('hidden');
      $('#dispatchStatus').textContent = '';
      $('#callDispatch').disabled = false;
      toast('與調度台的通話已結束');
      break;
    case 'error': toast(m.msg); break;
  }
}
function nameById(id) { const u = S.online.find(x => x.id === id) || S.members.find(x => x.id === id); return u ? u.name : '某人'; }

// ---------- 畫面 ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3000); }
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
  const listen = myRoleHere() === 'listener' && !myAlert();
  btn.classList.toggle('listen', listen);
  if (!S.pressing) {
    const busy = S.activeTalks.get(currentConv());
    btn.classList.toggle('busy', !!(busy && busy.from !== S.myId));
    $('#pttText').textContent = listen ? '只聽（不能發話）' : busy && busy.from !== S.myId ? `${busy.fromName} 正在說話` : '按住講話';
  }
}
function renderTarget() {
  const t = S.target;
  $('#targetLabel').textContent = !t ? '尚未加入頻道' : t.type === 'dm' ? `🔒 私人對講：${t.peerName}` : `# ${t.name}`;
  const r = t && t.type === 'channel' ? myRoleHere() : null;
  const rb = $('#roleBadge'); rb.classList.toggle('hidden', !r); rb.className = 'role-badge ' + (r || '') + (r ? '' : ' hidden'); rb.textContent = r ? `我的角色：${ROLE_LABEL[r]}` : '';
  $('#backToChannel').classList.toggle('hidden', !(t && t.type === 'dm'));
  updatePttEnabled(); updateTalkStatus();
}
function renderChannels() {
  $('#channelList').innerHTML = S.channels.map(c => {
    if (c.lastTalk) S.lastTalk[c.id] = c.lastTalk;
    const lt = c.lastTalk ? ` · 最近：${esc(c.lastTalk.fromName)} ${fmtTime(c.lastTalk.ts)}` : '';
    return `<li data-ch="${esc(c.id)}" class="${c.id === S.channel ? 'active' : ''}"><span># ${esc(c.name)} <span class="role-badge ${c.myRole}">${ROLE_LABEL[c.myRole]}</span></span><span class="meta">${c.online} 人在線${lt}</span></li>`;
  }).join('') || '<li class="muted">你目前沒有任何頻道，請聯絡管理員</li>';
  const c = S.channels.find(x => x.id === S.channel); if (c && S.target && S.target.type === 'channel' && S.target.name !== c.name) { S.target.name = c.name; renderTarget(); }
}
function renderMembers() {
  $('#memberList').innerHTML = S.members.map(u => `<li data-uid="${esc(u.id)}" data-name="${esc(u.name)}"><span>🟢 ${esc(u.name)}${u.id === S.myId ? '（你）' : ''} <span class="role-badge ${u.role}">${ROLE_LABEL[u.role] || ''}</span></span>${u.id === S.myId ? '' : '<span class="meta">私人對講 ›</span>'}</li>`).join('') || '<li class="muted">（沒有人）</li>';
}
function renderOthers() {
  const ids = new Set(S.members.map(u => u.id));
  const others = S.online.filter(u => !ids.has(u.id) && u.id !== S.myId);
  $('#otherList').innerHTML = others.map(u => `<li data-uid="${esc(u.id)}" data-name="${esc(u.name)}"><span>🟢 ${esc(u.name)}</span><span class="meta">私人對講 ›</span></li>`).join('') || '<li class="muted">（沒有）</li>';
}
function upsertDm(conv, lt) {
  const peerId = conv.slice(3).split(':').find(x => x !== S.myId) || S.myId;
  let d = S.dms.find(x => x.conv === conv);
  const peerName = lt.from === peerId ? lt.fromName : (lt.toName || d?.peerName || '對方');
  if (!d) { d = { conv, peerId, peerName, last: lt.ts }; S.dms.push(d); }
  d.last = Math.max(d.last, lt.ts); d.peerName = peerName;
  renderDms();
}
function renderDms() {
  S.dms.sort((a, b) => b.last - a.last);
  $('#dmList').innerHTML = S.dms.map(d => { if (d.lastTalk) S.lastTalk[d.conv] = d.lastTalk; return `<li data-uid="${esc(d.peerId)}" data-name="${esc(d.peerName)}"><span>🔒 ${esc(d.peerName)}</span><span class="meta">最近 ${fmtTime(d.last)}</span></li>`; }).join('') || '<li class="muted">還沒有私人對講。到「成員」點一個人即可開始。</li>';
}
function openDm(peerId, peerName) {
  if (peerId === S.myId) return;
  const conv = 'dm:' + [S.myId, peerId].sort().join(':');
  S.target = { type: 'dm', peerId, peerName, conv }; renderTarget(); renderActivity(); renderDms();
}
function renderActivity() {
  const conv = currentConv(); const lt = S.lastTalk[conv];
  $('#lastTalk').textContent = lt ? `最近說話：${lt.from === S.myId ? '我' : lt.fromName} · ${fmtTime(lt.ts)} · ${(lt.durMs / 1000).toFixed(1)} 秒` : '這裡還沒有人說話';
  const items = S.log.filter(x => x.conv === conv).slice(-30).reverse();
  $('#activityList').innerHTML = items.map(x => x.note ? `<li class="muted"><span>⚠️ ${esc(x.note)}</span><span class="when">${fmtTime(x.ts)}</span></li>` : `<li class="${x.from === S.myId ? 'mine' : ''}"><span class="who">${esc(x.from === S.myId ? '我' : x.fromName)}</span><span class="when">${fmtTime(x.ts)} · ${(x.durMs / 1000).toFixed(1)} 秒</span></li>`).join('') || '<li class="muted">本次開啟後還沒有對講</li>';
  if (conv !== S.chatConv) loadChat(conv);
}

function authHeaders() { return { Authorization: 'Bearer ' + store.token }; }
async function loadChat(conv) {
  conv = conv || currentConv();
  S.chatConv = conv;
  if (!conv || !store.token) { S.chat = []; renderChat(); return; }
  try {
    const r = await fetch('/api/messages?conv=' + encodeURIComponent(conv) + '&limit=100', { headers: authHeaders(), cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (conv !== currentConv()) return;
    S.chat = j.messages || [];
    renderChat();
  } catch { if (conv === currentConv()) { S.chat = []; renderChat(); } }
}
const photoUrlCache = new Map();
async function photoSrc(id) {
  if (photoUrlCache.has(id)) return photoUrlCache.get(id);
  const r = await fetch('/api/photos/' + id, { headers: authHeaders() });
  if (!r.ok) return '';
  const url = URL.createObjectURL(await r.blob());
  photoUrlCache.set(id, url);
  return url;
}
function renderChat() {
  const el = $('#chatList'); if (!el) return;
  const conv = currentConv();
  if (!conv) { el.innerHTML = '<li class="muted">請先選擇頻道或私人對講</li>'; return; }
  el.innerHTML = S.chat.map(m => {
    const mine = m.from === S.myId;
    const who = `<div class="meta">${esc(mine ? '我' : m.fromName)} · ${fmtTime(m.ts)}</div>`;
    if (m.kind === 'photo') return `<li class="${mine ? 'mine' : ''}" data-mid="${esc(m.id)}">${who}<img data-photo="${esc(m.photoId)}" alt="照片"></li>`;
    if (m.kind === 'caption') return `<li class="${mine ? 'mine' : ''} caption" data-mid="${esc(m.id)}">${who}<div class="body"><span class="badge">字幕</span>${esc(m.text)}</div></li>`;
    return `<li class="${mine ? 'mine' : ''}" data-mid="${esc(m.id)}">${who}<div class="body">${esc(m.text)}</div></li>`;
  }).join('') || '<li class="muted">還沒有文字或照片。語音不會出現在這裡。</li>';
  el.querySelectorAll('img[data-photo]').forEach(img => {
    photoSrc(img.dataset.photo).then(src => { if (src) img.src = src; });
  });
  el.scrollTop = el.scrollHeight;
}
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const max = 1280;
  let w = bmp.width, h = bmp.height;
  if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const tryBlob = (type, q) => new Promise(res => canvas.toBlob(res, type, q));
  let type = 'image/webp', q = 0.82, blob = await tryBlob(type, q);
  if (!blob) { type = 'image/jpeg'; blob = await tryBlob(type, q); }
  while (blob && blob.size > 200 * 1024 && q > 0.4) { q -= 0.12; blob = await tryBlob(type, q); }
  if (!blob) throw new Error('無法壓縮圖片');
  if (blob.size > 220 * 1024) throw new Error('壓縮後仍超過 200KB');
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { mime: blob.type || type, data: btoa(bin), bytes: blob.size };
}
async function sendChatText(text) {
  const conv = currentConv(); if (!conv) return toast('請先選擇頻道');
  text = String(text || '').trim(); if (!text) return;
  const r = await fetch('/api/messages', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ conv, text }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.message || '送出失敗');
  if (j.message && !S.chat.some(x => x.id === j.message.id)) { S.chat.push(j.message); renderChat(); }
}
async function sendChatPhoto(file) {
  const conv = currentConv(); if (!conv) return toast('請先選擇頻道');
  toast('壓縮照片中…');
  let packed;
  try { packed = await compressImage(file); } catch (e) { return toast(e.message || '無法處理照片'); }
  const r = await fetch('/api/photos', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ conv, data: packed.data }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.message || '上傳失敗');
  if (j.message && !S.chat.some(x => x.id === j.message.id)) { S.chat.push(j.message); renderChat(); }
}



// ---------- 事件 ----------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  ['channels', 'members', 'dms', 'map'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'map') { ensureMap(); setTimeout(() => { map && map.invalidateSize(); renderLocs(); fitMap(); }, 50); wsSend({ t: 'get_locs' }); }
}));
$('#channelList').addEventListener('click', (e) => { const li = e.target.closest('li[data-ch]'); if (!li) return; if (li.dataset.ch === S.channel) { const c = S.channels.find(x => x.id === S.channel); S.target = { type: 'channel', id: S.channel, name: c ? c.name : '' }; renderTarget(); renderActivity(); } else wsSend({ t: 'join', channel: li.dataset.ch }); });
['#memberList', '#otherList', '#dmList'].forEach(sel => $(sel).addEventListener('click', (e) => { const li = e.target.closest('li[data-uid]'); if (li) openDm(li.dataset.uid, li.dataset.name); }));
$('#backToChannel').addEventListener('click', () => { const c = S.channels.find(x => x.id === S.channel); S.target = { type: 'channel', id: S.channel, name: c ? c.name : '' }; renderTarget(); renderActivity(); });
$('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#chatInput').value; $('#chatInput').value = ''; sendChatText(t).catch(err => toast(err.message)); });
$('#chatPhoto').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (f) sendChatPhoto(f).catch(err => toast(err.message));
});
$('#chatList').addEventListener('click', (e) => { if (e.target.tagName === 'IMG' && e.target.src) window.open(e.target.src, '_blank'); });
$('#logout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + store.token } }); } catch {}
  store.token = ''; stopLoc(); location.reload();
});

function showLogin(msg) {
  try { S.ws && S.ws.close(); } catch {}
  $('#main').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#loginErr').textContent = msg || '';
}
function showMain() { $('#login').classList.add('hidden'); $('#main').classList.remove('hidden'); connect(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); unlockAudio();
  const username = $('#username').value.trim(), password = $('#password').value, org = $('#org').value.trim();
  if (!org || !username || !password) { $('#loginErr').textContent = '請輸入公司代碼、帳號與密碼'; return; }
  store.org = org;
  $('#enter').disabled = true; $('#loginErr').textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, org }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('#loginErr').textContent = j.message || '登入失敗'; return; }
    store.token = j.token; $('#password').value = ''; S.retry = 0; showMain();
  } catch { $('#loginErr').textContent = '無法連線到伺服器（若剛喚醒請稍候再試）'; }
  finally { $('#enter').disabled = false; }
});
if (store.org && $('#org')) $('#org').value = store.org;
updateSttHint();
if (store.token) {
  showMain();
  toast('點一下畫面任一處以啟用聲音');
  document.addEventListener('pointerdown', function once() { unlockAudio(); document.removeEventListener('pointerdown', once); });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
