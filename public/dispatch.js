(() => {
  const $ = (id) => document.getElementById(id);
  const SR = 16000, FRAME = 1600, MAX_BUF = 12;
  const WS_PATH = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  let token = localStorage.getItem('ptt_token') || '';
  let me = null, channels = [], online = [], alerts = [], queue = [], dispatchers = [];
  let listen = new Set();
  let selected = null; // {type:'ch'|'user', id}
  let held = null;
  let ws, wsTimer, pingTimer;
  let ctx, capture, processor, stream, speaking = false, streamId = null;
  const play = new Map();
  const mute = new Map();
  const vol = new Map();
  const markers = new Map();
  let map;

  function toast(m) { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2800); }
  function nameOf(id) { if (id === me?.id) return me.displayName; return online.find(o => o.id === id)?.name || id; }
  function fmtTime(ts) { try { return new Date(ts).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }); } catch { return ''; } }
  function dmKey(a, b) { return 'dm:' + [a, b].sort().join(':'); }

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  $('loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('loginErr').textContent = '';
    try {
      const j = await post('/api/login', { username: $('username').value.trim(), password: $('password').value });
      token = j.token; localStorage.setItem('ptt_token', token);
      if (j.user.role !== 'admin' && j.user.role !== 'dispatcher') { $('loginBox').classList.add('hidden'); $('denied').classList.remove('hidden'); return; }
      boot(j.user);
    } catch (err) { $('loginErr').textContent = err.message; }
  };
  $('logout').onclick = () => { localStorage.removeItem('ptt_token'); location.reload(); };
  $('xferBtn').onclick = () => { if (held && $('xferTo').value) send({ t: 'dispatch_transfer', id: held.id, to: $('xferTo').value }); };
  $('doneBtn').onclick = () => { if (held) send({ t: 'dispatch_done', id: held.id }); };

  if (token) {
    fetch('/api/me', { headers: { authorization: 'Bearer ' + token } }).then(r => r.ok ? r.json() : Promise.reject()).then(j => {
      if (j.user.role !== 'admin' && j.user.role !== 'dispatcher') { $('loginBox').classList.add('hidden'); $('denied').classList.remove('hidden'); return; }
      boot(j.user);
    }).catch(() => { token = ''; localStorage.removeItem('ptt_token'); });
  }

  function boot(user) {
    me = user;
    $('loginBox').classList.add('hidden');
    $('denied').classList.add('hidden');
    $('desk').classList.remove('hidden');
    $('who').textContent = user.displayName + ' · ' + user.role;
    if (user.role !== 'admin') $('adminLink').classList.add('hidden');
    if (!map) {
      map = L.map('map').setView([23.97, 120.98], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(map);
    }
    connect();
  }

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function setConn(on, text) { $('connDot').className = 'dot ' + (on ? 'on' : 'off'); $('connText').textContent = text; }

  function connect() {
    if (ws) try { ws.close(); } catch {}
    setConn(false, '連線中…');
    ws = new WebSocket(WS_PATH); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setConn(true, '已連線'); send({ t: 'hello', token }); clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: 'ping' }), 20000); };
    ws.onclose = () => { setConn(false, '已斷線'); clearInterval(pingTimer); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 1500); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { onAudio(ev.data); return; }
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case 'welcome':
          me = m.user; channels = m.channels || []; online = m.online || []; alerts = m.alerts || []; queue = m.queue || []; dispatchers = m.dispatchers || [];
          if (!listen.size) listen = new Set(channels.map(c => c.id));
          send({ t: 'listen', channels: [...listen] });
          send({ t: 'get_locs' });
          renderAll(); break;
        case 'channels': { const talking = Object.fromEntries(channels.map(c => [c.id, c.talking])); channels = (m.channels || []).map(c => ({ ...c, talking: talking[c.id] })); renderCh(); break; }
        case 'online': online = m.online || []; renderAll(); break;
        case 'dispatchers': dispatchers = m.list || []; renderDispatchers(); renderHeld(); break;
        case 'listening': listen = new Set(m.channels || []); renderCh(); break;
        case 'talk_start': onTalkStart(m); break;
        case 'talk_end': onTalkEnd(m); break;
        case 'floor_granted': streamId = m.streamId; $('talkStatus').textContent = '你正在講'; $('ptt').classList.add('live'); break;
        case 'floor_denied': toast('無法取得發言權：' + (m.reason || '')); stopTalk(true); break;
        case 'floor_revoked': toast(m.reason === 'preempted' ? ((m.byName || '') + ' 插話了') : '發話已結束'); stopTalk(true); break;
        case 'queue': queue = m.items || []; renderQueue(); break;
        case 'dispatch_pickup':
        case 'dispatch_transfer':
          if (m.pickup) { held = m.item; selected = { type: 'user', id: m.item.from }; }
          renderHeld(); renderQueue(); updateTarget(); break;
        case 'dispatch_done': held = null; selected = null; renderHeld(); renderQueue(); updateTarget(); break;
        case 'error': toast(m.msg || m.code); break;
        case 'loc': upsertLoc(m.loc); break;
        case 'locs': (m.locs || []).forEach(upsertLoc); break;
        case 'loc_remove': dropLoc(m.id); break;
        case 'alert': upsertAlert(m.alert); showAlert(m.alert); break;
        case 'alert_end': alerts = alerts.filter(a => a.id !== m.id); renderAlerts(); toast('警報已由 ' + (m.by || '系統') + ' 解除'); break;
        case 'kicked': toast(m.msg || '連線已結束'); localStorage.removeItem('ptt_token'); setTimeout(() => location.reload(), 800); break;
      }
    };
  }

  function renderAll() { renderCh(); renderQueue(); renderDispatchers(); renderAlerts(); renderLocList(); updateTarget(); }
  function renderCh() {
    $('chList').innerHTML = '';
    for (const c of channels) {
      const li = document.createElement('li');
      if (selected && selected.type === 'ch' && selected.id === c.id) li.classList.add('selected');
      const who = c.talking && c.talking !== me.id ? (nameOf(c.talking) + ' 正在講') : (c.talking === me.id ? '你正在講' : '');
      if (who) li.classList.add('talking-row');
      li.innerHTML = `<div class="ch-head"><label><input type="checkbox" data-listen="${c.id}" ${listen.has(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>
        <button data-sel="${c.id}">對講</button></div>
        <div class="ch-talk">${esc(who)}</div>
        <label class="small">靜音 <input type="checkbox" data-mute="${c.id}" ${mute.get(c.id) ? 'checked' : ''}></label>
        <label class="small">音量 <input type="range" min="0" max="200" value="${Math.round((vol.get(c.id) ?? 1) * 100)}" data-vol="${c.id}"></label>`;
      $('chList').appendChild(li);
    }
    $('chList').querySelectorAll('[data-listen]').forEach(el => el.onchange = () => {
      if (el.checked) listen.add(el.dataset.listen); else listen.delete(el.dataset.listen);
      send({ t: 'listen', channels: [...listen] });
    });
    $('chList').querySelectorAll('[data-sel]').forEach(el => el.onclick = () => { selected = { type: 'ch', id: el.dataset.sel }; updateTarget(); renderCh(); });
    $('chList').querySelectorAll('[data-mute]').forEach(el => el.onchange = () => mute.set(el.dataset.mute, el.checked));
    $('chList').querySelectorAll('[data-vol]').forEach(el => el.oninput = () => vol.set(el.dataset.vol, Number(el.value) / 100));
  }
  function renderQueue() {
    const waiting = queue.filter(q => q.status === 'waiting');
    $('queueList').innerHTML = waiting.length ? '' : '<li class="muted">目前沒有等候中的來電</li>';
    for (const q of waiting) {
      const li = document.createElement('li');
      li.innerHTML = `<div><b>${esc(q.fromName)}</b> <span class="muted">${esc(q.channelName || '')}</span></div><button data-pick="${q.id}">接聽</button>`;
      $('queueList').appendChild(li);
    }
    $('queueList').querySelectorAll('[data-pick]').forEach(el => el.onclick = () => send({ t: 'dispatch_pickup', id: el.dataset.pick }));
    held = queue.find(q => q.status === 'held' && q.heldBy === me?.id) || null;
    if (held) selected = { type: 'user', id: held.from };
    renderHeld();
  }
  function renderHeld() {
    if (!held) { $('heldBox').classList.add('hidden'); return; }
    $('heldBox').classList.remove('hidden');
    $('heldWho').textContent = held.fromName;
    const others = dispatchers.filter(d => d.id !== me.id);
    $('xferTo').innerHTML = others.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    $('xferBtn').disabled = !others.length;
  }
  function renderDispatchers() {
    const others = dispatchers.filter(d => d.id !== me.id);
    $('dispList').innerHTML = others.length ? others.map(d => `<li>${esc(d.name)}</li>`).join('') : '<li class="muted">沒有其他在線調度員</li>';
  }
  function updateTarget() {
    if (selected && selected.type === 'user') {
      $('targetLabel').textContent = '一對一：' + nameOf(selected.id);
      $('ptt').disabled = false;
    } else if (selected && selected.type === 'ch') {
      const c = channels.find(x => x.id === selected.id);
      $('targetLabel').textContent = '頻道：' + (c?.name || selected.id);
      $('ptt').disabled = false;
    } else {
      $('targetLabel').textContent = '請選一個頻道或從來電佇列接聽';
      $('ptt').disabled = true;
    }
  }

  function currentConv() {
    if (!selected) return null;
    return selected.type === 'ch' ? selected.id : dmKey(me.id, selected.id);
  }

  function onTalkStart(m) {
    play.set(m.streamId, { conv: m.conv, buf: [], next: 0, gain: 1, playing: false, src: null });
    const c = channels.find(x => x.id === m.conv);
    if (c) c.talking = m.from;
    $('talkStatus').textContent = (m.fromName || nameOf(m.from)) + ' 正在講';
    renderCh();
  }
  function onTalkEnd(m) {
    const st = play.get(m.streamId);
    if (st) { st.ended = true; if (!st.playing) play.delete(m.streamId); }
    const c = channels.find(x => x.id === m.conv);
    if (c && c.talking) delete c.talking;
    if (!speaking) $('talkStatus').textContent = '';
    renderCh();
  }

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function onAudio(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 6) return;
    const sid = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
    const pcm = new Int16Array(u8.buffer, u8.byteOffset + 4, (u8.byteLength - 4) >> 1);
    const st = play.get(sid); if (!st) return;
    if (mute.get(st.conv)) return;
    if (st.buf.length >= MAX_BUF) st.buf.shift();
    st.buf.push(pcm.slice());
    if (!st.playing) kick(st);
  }
  function kick(st) {
    if (!st.buf.length) { st.playing = false; if (st.ended) { for (const [k, v] of play) if (v === st) play.delete(k); } return; }
    ensureCtx();
    st.playing = true;
    const pcm = st.buf.shift();
    const f32 = new Float32Array(pcm.length);
    const g = vol.get(st.conv) ?? 1;
    for (let i = 0; i < pcm.length; i++) f32[i] = (pcm[i] / 32768) * g;
    const ab = ctx.createBuffer(1, f32.length, SR);
    ab.getChannelData(0).set(f32);
    const src = ctx.createBufferSource(); src.buffer = ab;
    const gn = ctx.createGain(); gn.gain.value = 1; src.connect(gn).connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, st.next || 0);
    src.start(startAt);
    st.next = startAt + ab.duration;
    src.onended = () => kick(st);
  }

  function startTalk() {
    if (speaking || !selected) return;
    const conv = currentConv();
    ensureCtx();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then(s => {
      stream = s;
      const src = ctx.createMediaStreamSource(s);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      const acc = [];
      processor.onaudioprocess = (ev) => {
        if (!speaking || !streamId) return;
        const input = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) acc.push(input[i]);
        while (acc.length >= FRAME) {
          const slice = acc.splice(0, FRAME);
          const pcm = new Int16Array(FRAME);
          for (let i = 0; i < FRAME; i++) { const x = Math.max(-1, Math.min(1, slice[i])); pcm[i] = x < 0 ? x * 32768 : x * 32767; }
          if (ws && ws.readyState === 1) ws.send(pcm.buffer);
        }
      };
      src.connect(processor); processor.connect(ctx.destination);
      speaking = true; send(selected.type === 'user' ? { t: 'ptt_start', to: selected.id } : { t: 'ptt_start', conv });
      $('pttText').textContent = '放開結束';
    }).catch(err => toast('無法使用麥克風：' + err.message));
  }
  function stopTalk(silent) {
    if (!speaking && !streamId) return;
    speaking = false; streamId = null;
    try { processor && processor.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    processor = null; stream = null;
    if (!silent) send({ t: 'ptt_stop' });
    $('ptt').classList.remove('live');
    $('pttText').textContent = '按住講話';
    $('talkStatus').textContent = '';
  }
  const ptt = $('ptt');
  ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); startTalk(); });
  window.addEventListener('pointerup', () => stopTalk());
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') { e.preventDefault(); startTalk(); } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); stopTalk(); } });

  function upsertLoc(m) {
    if (!map || !m || typeof m.lat !== 'number') return;
    const pos = [m.lat, m.lng];
    let mk = markers.get(m.id);
    if (!mk) { mk = L.marker(pos).addTo(map); markers.set(m.id, mk); }
    else mk.setLatLng(pos);
    mk.bindPopup(`${esc(m.name || nameOf(m.id))}<br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`);
    renderLocList();
  }
  function dropLoc(id) { const mk = markers.get(id); if (mk) { map.removeLayer(mk); markers.delete(id); } renderLocList(); }
  function renderLocList() {
    const items = [...markers.entries()].map(([id, mk]) => { const p = mk.getLatLng(); return `<li><b>${esc(nameOf(id))}</b> ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</li>`; });
    $('locList').innerHTML = items.join('') || '<li class="muted">還沒有人回報位置</li>';
  }
  function upsertAlert(a) { if (!a) return; const i = alerts.findIndex(x => x.id === a.id); if (i >= 0) alerts[i] = a; else alerts.unshift(a); renderAlerts(); }
  function renderAlerts() {
    const open = alerts.filter(a => a.status !== 'resolved');
    $('alertList').innerHTML = open.length ? open.map(a => `<li><b>${esc(a.fromName)}</b> ${esc(a.channelName || '')}<br><span class="muted">${fmtTime(a.ts)}</span> <button data-res="${a.id}">解除</button></li>`).join('') : '<li class="muted">目前沒有未解除的警報</li>';
    $('alertList').querySelectorAll('[data-res]').forEach(el => el.onclick = () => send({ t: 'alert_resolve', id: el.dataset.res }));
    $('alertBanner').classList.toggle('hidden', !open.length);
    $('alertBanner').textContent = open.length ? `🚨 ${open.length} 則未解除警報` : '';
  }
  function showAlert(a) {
    $('alertOverlay').classList.remove('hidden');
    $('alertWho').textContent = (a.fromName || '') + (a.channelName ? ' · ' + a.channelName : '');
    const hasFix = typeof a.lat === 'number' && typeof a.lng === 'number';
    $('alertWhere').textContent = hasFix ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : '當時沒有取得座標';
    $('alertWhen').textContent = fmtTime(a.ts);
    if (hasFix) { $('alertMapLink').href = `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=16/${a.lat}/${a.lng}`; $('alertMapLink').classList.remove('hidden'); }
    else $('alertMapLink').classList.add('hidden');
    $('alertAck').onclick = () => $('alertOverlay').classList.add('hidden');
    $('alertResolve').onclick = () => { send({ t: 'alert_resolve', id: a.id }); $('alertOverlay').classList.add('hidden'); };
  }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
