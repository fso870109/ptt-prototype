// 第二階段端對端測試（協定層，模擬多個帳號）
// 用法：ADMIN_USERNAME=... ADMIN_PASSWORD=... node test/e2e.js [baseUrl] [--data-dir=路徑]
// 測試會自行建立 t_ 開頭的測試帳號與頻道，最後全部刪除。
const fs = require('fs'); const path = require('path');
const WebSocket = require('ws');
const BASE = (process.argv.find(a => /^https?:/.test(a)) || 'http://localhost:8800').replace(/\/$/, '');
const DATA_DIR = (process.argv.find(a => a.startsWith('--data-dir=')) || '').slice(11);
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';
const ADMIN_U = process.env.ADMIN_USERNAME, ADMIN_P = process.env.ADMIN_PASSWORD;
if (!ADMIN_U || !ADMIN_P) { console.error('請設定 ADMIN_USERNAME / ADMIN_PASSWORD'); process.exit(2); }
const results = []; const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name]); console.log(cond ? 'PASS' : 'FAIL', name, extra); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function http(method, p, body, token) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const login = async (u, p, org = 'DEMO') => (await http('POST', '/api/login', { username: u, password: p, org })).body?.token;
function client(token, label) {
  return new Promise((res) => {
    const ws = new WebSocket(WSURL); const c = { ws, label, msgs: [], bin: [], closed: null };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (pred, ms = 6000) => new Promise((r, j) => { const t0 = Date.now(); (function chk() { const m = c.msgs.find(pred); if (m) return r(m); if (Date.now() - t0 > ms) return j(new Error('timeout ' + label)); setTimeout(chk, 25); })(); });
    c.has = (pred) => c.msgs.some(pred);
    c.clear = () => { c.msgs = []; c.bin = []; };
    ws.on('message', (d, isBin) => { if (isBin) c.bin.push(Buffer.from(d)); else c.msgs.push(JSON.parse(d.toString())); });
    ws.on('close', (code) => { c.closed = code; });
    ws.on('error', () => {});
    ws.on('open', () => { c.send({ t: 'hello', token }); const t0 = Date.now(); (function chk() { if (c.msgs.some(m => m.t === 'welcome' || m.t === 'auth_failed') || c.closed) return res(c); if (Date.now() - t0 > 8000) return res(c); setTimeout(chk, 25); })(); });
  });
}
function tone(ms, f = 440) { const n = 16000 * ms / 1000; const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * i / 16000) * 8000), i * 2); return b; }
async function isOnlineAdm(tok, id) { const r = await http('GET', '/api/admin/users', null, tok); return r.body.users.find(u => u.id === id)?.online; }
// 經過 Render 代理時，伺服器端關閉的 WebSocket 不一定會即時傳到客戶端；前端收到 auth_failed 會自行關閉
async function waitClosed(c, ms = 4000) { const t0 = Date.now(); while (c.closed === null && Date.now() - t0 < ms) await sleep(50); return c.closed; }
async function talk(c, conv, ms = 300, extra = {}) {
  c.send({ t: 'ptt_start', conv, ...extra });
  const g = await c.wait(m => (m.t === 'floor_granted' || m.t === 'floor_denied') && !m._seen); g._seen = true; return g;
}
function walk(d) { let out = []; if (!fs.existsSync(d)) return out; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); out = out.concat(fs.statSync(p).isDirectory() ? walk(p) : [p]); } return out; }

(async () => {
  const sfx = Date.now().toString(36).slice(-5);
  const created = { users: [], channels: [], orgs: [] };
  let adminTok;
  try {
    const h = await http('GET', '/api/health');
    ok('健康檢查', h.status === 200 && h.body.ok && h.body.storesAudio === false, JSON.stringify(h.body));

    // ===== 未登入 =====
    const anon = await client('not-a-token', 'anon');
    ok('未登入（無效 token）的 WebSocket 被拒絕', anon.has(m => m.t === 'auth_failed') && !anon.has(m => m.t === 'welcome'));
    ok('未登入呼叫 API 回 401', (await http('GET', '/api/admin/users')).status === 401 && (await http('GET', '/api/locations')).status === 401 && (await http('GET', '/api/me')).status === 401);
    ok('錯誤密碼登入失敗', (await http('POST', '/api/login', { username: ADMIN_U, password: ADMIN_P + 'x', org: 'DEMO' })).status === 401);
    adminTok = await login(ADMIN_U, ADMIN_P);
    ok('管理員登入成功', !!adminTok);
    const meA = await http('GET', '/api/me', null, adminTok);
    ok('管理員身分為 admin', meA.body?.user?.role === 'admin');
    ok('管理員以 DEMO 登入會帶公司資料', meA.body?.org?.code === 'DEMO');

    // ===== 後台：建立使用者與頻道、指派角色 =====
    const mk = async (key, name, password, role) => {
      const r = await http('POST', '/api/admin/users', { username: `t_${key}_${sfx}`, displayName: name, password, role }, adminTok);
      if (r.status !== 201) throw new Error('create user failed ' + JSON.stringify(r.body));
      created.users.push(r.body.user.id); return { ...r.body.user, password: password || r.body.password };
    };
    const sup = await mk('sup', '主管王', 'Sup-pass-123'), m1 = await mk('m1', '一般李', 'M1-pass-123'), m2 = await mk('m2', '一般陳', 'M2-pass-123');
    const lis = await mk('lis', '只聽林', 'Lis-pass-123'), outs = await mk('out', '局外張', '');
    ok('後台建立 5 個使用者（未給密碼時自動產生）', created.users.length === 5 && outs.password && outs.password.length >= 12);
    ok('重複帳號被拒絕', (await http('POST', '/api/admin/users', { username: `t_sup_${sfx}`, password: 'xxxxxxxx1' }, adminTok)).status === 409);
    const chR = await http('POST', '/api/admin/channels', { name: `測試頻道-${sfx}`, open: false }, adminTok);
    const CH = chR.body.channel.id; created.channels.push(CH);
    ok('後台建立封閉頻道', chR.status === 201 && chR.body.channel.open === false);
    for (const [u, role] of [[sup, 'supervisor'], [m1, 'member'], [m2, 'member'], [lis, 'listener']]) await http('PUT', `/api/admin/channels/${CH}/members/${u.id}`, { role }, adminTok);
    const chs = await http('GET', '/api/admin/channels', null, adminTok);
    const roles = Object.fromEntries(chs.body.channels.find(c => c.id === CH).members.map(m => [m.name, m.role]));
    ok('後台指派頻道角色（主管/一般/只聽）', roles['主管王'] === 'supervisor' && roles['一般李'] === 'member' && roles['只聽林'] === 'listener', JSON.stringify(roles));

    // ===== 非管理員進不了後台 =====
    const tok = {}; for (const u of [sup, m1, m2, lis, outs]) tok[u.id] = await login(u.username, u.password);
    ok('一般使用者可以登入', Object.values(tok).every(Boolean));
    const r403 = await http('GET', '/api/admin/users', null, tok[m1.id]);
    const r403b = await http('POST', '/api/admin/channels', { name: 'x' }, tok[m1.id]);
    ok('非管理員呼叫後台 API 回 403', r403.status === 403 && r403b.status === 403);

    // ===== 連線、頻道權限 =====
    const C = {}; for (const u of [sup, m1, m2, lis, outs]) C[u.id] = await client(tok[u.id], u.displayName);
    const ADM = await client(adminTok, 'admin');
    ok('所有帳號 WebSocket 登入成功', [...Object.values(C), ADM].every(c => c.has(m => m.t === 'welcome')));
    const outWelcome = C[outs.id].msgs.find(m => m.t === 'welcome');
    ok('局外人的頻道清單看不到封閉頻道', !outWelcome.channels.some(c => c.id === CH) && outWelcome.channels.some(c => c.id === 'lobby'));
    C[outs.id].send({ t: 'join', channel: CH });
    ok('局外人加入封閉頻道被拒', !!(await C[outs.id].wait(m => m.t === 'error' && m.code === 'no_access')));
    C[outs.id].send({ t: 'join', channel: 'lobby' }); ADM.send({ t: 'join', channel: 'lobby' });
    for (const u of [sup, m1, m2, lis]) C[u.id].send({ t: 'join', channel: CH });
    for (const u of [sup, m1, m2, lis]) await C[u.id].wait(m => m.t === 'joined' && m.channel === CH);
    await sleep(400);
    const mem = [...C[m1.id].msgs].reverse().find(m => m.t === 'members' && m.channel === CH);
    ok('頻道成員名單含 4 人與角色', mem && mem.members.length === 4 && mem.members.find(x => x.id === lis.id).role === 'listener', mem && mem.members.map(x => x.name + ':' + x.role).join(','));

    // ===== 對講 + floor control（原有功能）=====
    const g1 = await talk(C[m1.id], CH);
    ok('一般成員取得發言權', g1.t === 'floor_granted');
    await C[m2.id].wait(m => m.t === 'talk_start' && m.from === m1.id);
    const b1 = await talk(C[m2.id], CH);
    ok('同優先權的另一位一般成員被擋（busy）', b1.t === 'floor_denied' && b1.reason === 'busy' && b1.byName === '一般李');
    const pcm = tone(500); for (let i = 0; i < 5; i++) { C[m1.id].ws.send(pcm.subarray(i * 3200, (i + 1) * 3200)); await sleep(60); }
    await sleep(500);
    const got = (c) => Buffer.concat(c.bin.map(b => b.subarray(4)));
    ok('語音即時轉發給同頻道（含只聽者），內容一致', got(C[m2.id]).equals(pcm) && got(C[lis.id]).equals(pcm) && got(C[sup.id]).equals(pcm), `${C[m2.id].bin.length} 包`);
    ok('其他頻道的人收不到', C[outs.id].bin.length === 0 && ADM.bin.length === 0 && C[m1.id].bin.length === 0);
    const lisTry = await talk(C[lis.id], CH);
    ok('只聽者按講被拒（listen_only）', lisTry.t === 'floor_denied' && lisTry.reason === 'listen_only');

    // ===== 優先搶話 =====
    const gs = await talk(C[sup.id], CH);
    const rev = await C[m1.id].wait(m => m.t === 'floor_revoked' && m.reason === 'preempted');
    const te = await C[m2.id].wait(m => m.t === 'talk_end' && m.reason === 'preempted');
    ok('主管按下可中斷一般成員，被中斷者收到提示', gs.t === 'floor_granted' && rev.byName === '主管王' && te.byName === '主管王');
    const back = await talk(C[m1.id], CH);
    ok('主管說話時一般成員無法搶回（busy）', back.t === 'floor_denied' && back.reason === 'busy' && back.byName === '主管王');
    C[sup.id].ws.send(tone(200)); await sleep(150); C[sup.id].send({ t: 'ptt_stop' });
    await C[m2.id].wait(m => m.t === 'talk_end' && m.from === sup.id && m.reason === 'released');

    // ===== 位置與可見範圍 =====
    for (const c of [...Object.values(C), ADM]) c.clear();
    C[m1.id].send({ t: 'loc', lat: 25.0330, lng: 121.5654, acc: 15, battery: 0.82, charging: false });
    const l2 = await C[m2.id].wait(m => m.t === 'loc' && m.loc.id === m1.id);
    const la = await ADM.wait(m => m.t === 'loc' && m.loc.id === m1.id);
    await sleep(400);
    ok('同頻道成員收到位置與電量', l2.loc.lat === 25.033 && l2.loc.battery === 82 && l2.loc.charging === false && l2.loc.online === true);
    ok('管理員（在別的頻道）也看得到', la.loc.lng === 121.5654);
    ok('其他頻道的一般成員看不到', !C[outs.id].has(m => m.t === 'loc' && m.loc.id === m1.id));
    const apiOut = await http('GET', '/api/locations', null, tok[outs.id]);
    const apiAdm = await http('GET', '/api/locations', null, adminTok);
    const apiM2 = await http('GET', '/api/locations', null, tok[m2.id]);
    ok('位置 API 可見範圍：管理員全體、同頻道可見、他頻道不可見', !apiOut.body.locations.some(l => l.id === m1.id) && apiAdm.body.locations.some(l => l.id === m1.id) && apiM2.body.locations.some(l => l.id === m1.id));
    C[lis.id].send({ t: 'loc', lat: 25.04, lng: 121.56 }); // 不支援電量
    const l3 = await C[m2.id].wait(m => m.t === 'loc' && m.loc.id === lis.id);
    ok('沒有電量資訊時為 null（畫面顯示「不明」）', l3.loc.battery === null);
    const locKeys = Object.keys(apiAdm.body.locations.find(l => l.id === m1.id));
    ok('位置只有最新一筆（沒有軌跡欄位）', !locKeys.some(k => /track|history|points/i.test(k)), locKeys.join(','));

    // ===== 緊急警報 =====
    for (const c of [...Object.values(C), ADM]) c.clear();
    const gsup = await talk(C[sup.id], CH); // 主管先講話
    C[lis.id].send({ t: 'alert_start', lat: 25.0478, lng: 121.5170, acc: 8 });
    const aM2 = await C[m2.id].wait(m => m.t === 'alert');
    const aAdm = await ADM.wait(m => m.t === 'alert');
    const aSelf = await C[lis.id].wait(m => m.t === 'alert');
    await sleep(300);
    ok('警報廣播給同頻道成員與管理員（含姓名與位置）', aM2.alert.name === '只聽林' && aM2.alert.lat === 25.0478 && aAdm.alert.id === aM2.alert.id && aSelf.alert.userId === lis.id && aM2.alert.channelName === `測試頻道-${sfx}`);
    ok('其他頻道的一般成員收不到警報', !C[outs.id].has(m => m.t === 'alert'));
    const galert = await talk(C[lis.id], CH);
    const revSup = await C[sup.id].wait(m => m.t === 'floor_revoked' && m.reason === 'preempted');
    ok('警報期間發送者（即使是只聽）取得最高發話權，可中斷主管', gsup.t === 'floor_granted' && galert.t === 'floor_granted' && galert.prio === 100 && revSup.byName === '只聽林');
    C[lis.id].ws.send(tone(200)); await sleep(100); C[lis.id].send({ t: 'ptt_stop' });
    C[m2.id].send({ t: 'alert_resolve', id: aM2.alert.id });
    ok('非管理員（非發送者）不能解除警報', !!(await C[m2.id].wait(m => m.t === 'error' && m.code === 'forbidden')));
    const lateAlerts = await http('GET', '/api/alerts', null, tok[m2.id]);
    ok('進行中的警報可查詢', lateAlerts.body.alerts.length === 1);
    const res = await http('POST', `/api/admin/alerts/${aM2.alert.id}/resolve`, {}, adminTok);
    const e1 = await C[lis.id].wait(m => m.t === 'alert_end'), e2 = await C[m2.id].wait(m => m.t === 'alert_end');
    ok('管理員解除警報，所有人收到解除通知', res.status === 200 && e1.id === aM2.alert.id && e2.by && (await ADM.wait(m => m.t === 'alert_end')).id === aM2.alert.id);
    const after = await talk(C[lis.id], CH);
    ok('警報解除後只聽者又不能講', after.t === 'floor_denied' && after.reason === 'listen_only');

    // ===== 一對一私人對講 =====
    for (const c of Object.values(C)) c.clear();
    const gd = await talk(C[m1.id], undefined, 0, { to: outs.id });
    await C[outs.id].wait(m => m.t === 'talk_start' && m.conv === gd.conv);
    C[m1.id].ws.send(tone(300)); await sleep(300); C[m1.id].send({ t: 'ptt_stop' });
    await C[outs.id].wait(m => m.t === 'talk_end' && m.conv === gd.conv); await sleep(200);
    ok('私人對講（跨頻道）只有對方收到', gd.t === 'floor_granted' && C[outs.id].bin.length === 1 && C[m2.id].bin.length === 0 && C[sup.id].bin.length === 0);
    ok('私人對講以帳號身分識別', gd.conv === 'dm:' + [m1.id, outs.id].sort().join(':'));

    // ===== 文字與照片 =====
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    C[m2.id].clear();
    const txt = await http('POST', '/api/messages', { conv: CH, text: '你好，這是頻道文字' }, tok[m1.id]);
    const wsChat = await C[m2.id].wait(m => m.t === 'chat' && m.message && m.message.text === '你好，這是頻道文字');
    ok('頻道文字訊息：HTTP 建立且同頻道成員即時收到', txt.status === 201 && txt.body.message.kind === 'text' && wsChat.message.from === m1.id);
    const chatHist = await http('GET', `/api/messages?conv=${CH}`, null, tok[lis.id]);
    ok('只聽者可以讀取頻道文字紀錄', chatHist.status === 200 && chatHist.body.messages.some(x => x.text === '你好，這是頻道文字'));
    const noAuth = await http('GET', `/api/messages?conv=${CH}`);
    const outHist = await http('GET', `/api/messages?conv=${CH}`, null, tok[outs.id]);
    ok('未登入與局外人不能讀頻道訊息', noAuth.status === 401 && outHist.status === 403);
    const ph = await http('POST', '/api/photos', { conv: CH, data: jpeg.toString('base64') }, tok[m1.id]);
    ok('頻道照片上傳成功', ph.status === 201 && ph.body.message.kind === 'photo' && ph.body.message.photoId, JSON.stringify(ph.body && ph.body.message));
    const pid = ph.body.message.photoId;
    const imgOk = await fetch(BASE + '/api/photos/' + pid, { headers: { Authorization: 'Bearer ' + tok[m2.id] } });
    const imgNo = await fetch(BASE + '/api/photos/' + pid);
    const imgOut = await fetch(BASE + '/api/photos/' + pid, { headers: { Authorization: 'Bearer ' + tok[outs.id] } });
    ok('照片網址驗證登入與頻道權限（同頻道可、未登入 401、局外人 403）', imgOk.status === 200 && (imgOk.headers.get('content-type') || '').includes('jpeg') && imgNo.status === 401 && imgOut.status === 403);
    const tooBig = await http('POST', '/api/photos', { conv: CH, data: Buffer.alloc(230 * 1024, 0xff).toString('base64') }, tok[m1.id]);
    ok('超過約 200KB 的照片被拒絕', tooBig.status === 413 || tooBig.status === 400, 'status=' + tooBig.status);
    const dmConv = 'dm:' + [m1.id, outs.id].sort().join(':');
    const dmT = await http('POST', '/api/messages', { conv: dmConv, text: '私人文字' }, tok[m1.id]);
    const dmSee = await http('GET', `/api/messages?conv=${encodeURIComponent(dmConv)}`, null, tok[outs.id]);
    const dmHide = await http('GET', `/api/messages?conv=${encodeURIComponent(dmConv)}`, null, tok[m2.id]);
    ok('一對一文字只有雙方能讀', dmT.status === 201 && dmSee.body.messages.some(x => x.text === '私人文字') && dmHide.status === 403);
    const empty = await http('POST', '/api/messages', { conv: CH, text: '   ' }, tok[m1.id]);
    ok('空白文字被拒絕', empty.status === 400);

    // ===== 調度台 =====
    const dispHtml = await fetch(BASE + '/dispatch');
    ok('/dispatch 頁面可開啟', dispHtml.status === 200 && (await dispHtml.text()).includes('調度台'));
    const dsp = await mk('dsp', '調度甲', 'Dsp-pass-123', 'dispatcher');
    const dsp2 = await mk('dsp2', '調度乙', 'Dsp2-pass-123', 'dispatcher');
    ok('後台可建立調度員角色', dsp.role === 'dispatcher' && dsp2.role === 'dispatcher');
    const rolePatch = await http('PATCH', `/api/admin/users/${dsp.id}`, { role: 'dispatcher' }, adminTok);
    ok('後台可把身分設為調度員', rolePatch.status === 200 && rolePatch.body.user.role === 'dispatcher');
    const dspTok = await login(dsp.username, dsp.password);
    const dsp2Tok = await login(dsp2.username, dsp2.password);
    ok('調度員可以登入', !!dspTok && !!dsp2Tok);
    const D1 = await client(dspTok, 'dsp1'), D2 = await client(dsp2Tok, 'dsp2');
    ok('調度員 welcome 含佇列與調度員名單', D1.has(m => m.t === 'welcome' && Array.isArray(m.queue) && Array.isArray(m.dispatchers)));
    C[m1.id].clear(); C[m1.id].send({ t: 'listen', channels: [CH] });
    ok('一般使用者不能同時監聽多頻道', !!(await C[m1.id].wait(m => m.t === 'error' && m.code === 'forbidden')));
    D1.send({ t: 'listen', channels: [CH, 'lobby'] });
    const listening = await D1.wait(m => m.t === 'listening');
    ok('調度員可同時監聽多個頻道', listening.channels.includes(CH) && listening.channels.includes('lobby'), JSON.stringify(listening.channels));
    C[m1.id].clear(); D1.clear(); C[m2.id].clear();
    const gLis = await talk(C[m1.id], CH);
    C[m1.id].ws.send(tone(250, 660));
    const tsLis = await D1.wait(m => m.t === 'talk_start' && m.from === m1.id && m.conv === CH);
    await sleep(300);
    ok('調度員監聽時可收到頻道誰在講與語音', gLis.t === 'floor_granted' && !!tsLis && D1.bin.length > 0, `frames=${D1.bin.length}`);
    C[m1.id].send({ t: 'ptt_stop' });
    await D1.wait(m => m.t === 'talk_end' && m.from === m1.id);
    D1.clear(); C[m2.id].clear();
    const gDispTalk = await talk(D1, CH);
    D1.ws.send(tone(200, 330));
    await C[m2.id].wait(m => m.t === 'talk_start' && m.from === dsp.id && m.conv === CH);
    await sleep(250);
    ok('調度員可對監聽中的頻道發話，成員聽得到', gDispTalk.t === 'floor_granted' && C[m2.id].bin.length > 0, `frames=${C[m2.id].bin.length}`);
    D1.send({ t: 'ptt_stop' });
    await C[m2.id].wait(m => m.t === 'talk_end' && m.from === dsp.id);
    D1.clear(); C[m1.id].clear();
    C[m1.id].send({ t: 'dispatch_call' });
    const qSelf = await C[m1.id].wait(m => m.t === 'queue_self');
    const qD = await D1.wait(m => m.t === 'queue' && (m.items || []).some(i => i.from === m1.id && i.status === 'waiting'));
    ok('個人呼叫調度台會進入共用佇列', qSelf.item && qSelf.item.status === 'waiting' && !!qD, qSelf.item && qSelf.item.id);
    D1.send({ t: 'dispatch_call' });
    ok('調度員不能呼叫調度台', !!(await D1.wait(m => m.t === 'error' && m.code === 'forbidden')));
    D1.send({ t: 'dispatch_pickup', id: qSelf.item.id });
    const pkUser = await C[m1.id].wait(m => m.t === 'dispatch_pickup');
    const pkD = await D1.wait(m => m.t === 'dispatch_pickup' && m.pickup);
    ok('調度員接聽後轉成一對一', pkUser.conv && pkUser.conv.startsWith('dm:') && pkD.conv === pkUser.conv && pkUser.conv.includes(dsp.id));
    D1.clear(); C[m1.id].clear();
    const gCall = await talk(D1, pkD.conv);
    D1.ws.send(tone(180, 440));
    await C[m1.id].wait(m => m.t === 'talk_start' && m.conv === pkD.conv);
    D1.send({ t: 'ptt_stop' });
    ok('接聽後雙方可一對一對講', gCall.t === 'floor_granted');
    D2.clear(); C[m1.id].clear();
    D1.send({ t: 'dispatch_transfer', id: qSelf.item.id, to: dsp2.id });
    const xfUser = await C[m1.id].wait(m => m.t === 'dispatch_transfer');
    const xf2 = await D2.wait(m => m.t === 'dispatch_transfer' && m.pickup);
    ok('可把通話轉接給其他在線調度員', xfUser.to === dsp2.id && xf2.conv && xf2.conv.includes(dsp2.id) && xf2.conv.includes(m1.id));
    D2.send({ t: 'dispatch_done', id: qSelf.item.id });
    ok('結束呼叫後雙方收到通知', !!(await C[m1.id].wait(m => m.t === 'dispatch_done')) && !!(await D2.wait(m => m.t === 'dispatch_done')));
    for (const c of [D1, D2]) try { c.ws.close(); } catch {}


    // ===== 即時語音轉文字 =====
    const homeHtml = await (await fetch(BASE + '/')).text();
    ok('對講頁面含即時字幕區塊與說明', homeHtml.includes('id="captionLive"') && homeHtml.includes('id="sttHint"'));
    const set0 = await http('GET', '/api/admin/settings', null, adminTok);
    ok('公司預設不儲存字幕', set0.status === 200 && set0.body.settings && set0.body.settings.saveCaptions === false);
    C[m1.id].clear(); C[m2.id].clear();
    const gCap = await talk(C[m1.id], CH);
    C[m1.id].send({ t: 'caption', conv: CH, text: '臨時字幕一二', interim: true });
    const capI = await C[m2.id].wait(m => m.t === 'caption' && m.text === '臨時字幕一二');
    ok('發言中的即時字幕會轉發給同頻道', gCap.t === 'floor_granted' && capI.interim === true && capI.from === m1.id);
    C[m2.id].send({ t: 'caption', conv: CH, text: '不該出現', interim: false });
    await sleep(250);
    ok('非發言者不能送字幕', !C[m1.id].has(m => m.t === 'caption' && m.text === '不該出現'));
    C[m1.id].send({ t: 'caption', conv: CH, text: '最終字幕甲', interim: false });
    await C[m2.id].wait(m => m.t === 'caption' && m.text === '最終字幕甲' && m.interim === false);
    const histOff = await http('GET', `/api/messages?conv=${CH}`, null, tok[m2.id]);
    ok('未開啟存檔時最終字幕不會寫入文字紀錄', !(histOff.body.messages || []).some(x => x.text === '最終字幕甲'));
    const onSave = await http('PATCH', '/api/admin/settings', { saveCaptions: true }, adminTok);
    ok('公司管理員可開啟儲存字幕', onSave.status === 200 && onSave.body.settings.saveCaptions === true);
    C[m2.id].clear();
    C[m1.id].send({ t: 'caption', conv: CH, text: '存檔字幕乙', interim: false });
    const capChat = await C[m2.id].wait(m => m.t === 'chat' && m.message && m.message.kind === 'caption' && m.message.text === '存檔字幕乙');
    const histOn = await http('GET', `/api/messages?conv=${CH}`, null, tok[m2.id]);
    ok('開啟存檔後最終字幕以文字保存（不存語音）', !!capChat && (histOn.body.messages || []).some(x => x.kind === 'caption' && x.text === '存檔字幕乙'));
    C[m1.id].send({ t: 'ptt_stop' });
    await http('PATCH', '/api/admin/settings', { saveCaptions: false }, adminTok);

    // ===== 後台操作即時生效 =====
    await http('DELETE', `/api/admin/channels/${CH}/members/${lis.id}`, null, adminTok);
    const moved = await C[lis.id].wait(m => m.t === 'joined' && m.reason === 'access_changed');
    ok('移除頻道成員 → 立即被移回大廳', moved.channel === 'lobby');
    const dis = await http('PATCH', `/api/admin/users/${m2.id}`, { disabled: true }, adminTok);
    const cl2 = await waitClosed(C[m2.id]); const lg2 = (await http('POST', '/api/login', { username: m2.username, password: m2.password, org: 'DEMO' })).status;
    const on2 = await isOnlineAdm(adminTok, m2.id);
    ok('停用使用者 → 立即被踢下線（收到 auth_failed、伺服器標為離線），且無法再登入', dis.status === 200 && C[m2.id].has(m => m.t === 'auth_failed') && on2 === false && lg2 === 403, `auth_failed=${C[m2.id].has(m => m.t === 'auth_failed')} 伺服器在線=${on2} close=${cl2} login=${lg2}`);
    const offDm = await talk(C[m1.id], undefined, 0, { to: m2.id });
    ok('對不在線（已停用）的人私人對講被拒', offDm.t === 'floor_denied');
    const rp = await http('PATCH', `/api/admin/users/${m1.id}`, { resetPassword: true }, adminTok);
    const cl1 = await waitClosed(C[m1.id]);
    const oldTokOk = (await http('GET', '/api/me', null, tok[m1.id])).status;
    const newOk = !!(await login(m1.username, rp.body.password)), oldPwOk = !!(await login(m1.username, m1.password));
    const on1 = await isOnlineAdm(adminTok, m1.id);
    ok('重設密碼 → 產生新密碼、舊登入與連線失效、新密碼可登入', rp.body.password && oldTokOk === 401 && C[m1.id].has(m => m.t === 'auth_failed') && on1 === false && newOk && !oldPwOk, `伺服器在線=${on1} close=${cl1} oldToken=${oldTokOk} new=${newOk} oldPw=${oldPwOk}`);
    ok('管理員不能停用自己', (await http('PATCH', `/api/admin/users/${meA.body.user.id}`, { disabled: true }, adminTok)).status === 400);
    const supC = C[sup.id]; supC.clear();
    const del = await http('DELETE', `/api/admin/channels/${CH}`, null, adminTok);
    const mv2 = await supC.wait(m => m.t === 'joined' && m.reason === 'access_changed');
    ok('刪除頻道 → 成員被移回大廳；大廳不能刪', del.status === 200 && mv2.channel === 'lobby' && (await http('DELETE', '/api/admin/channels/lobby', null, adminTok)).status === 400);
    created.channels = [];

    // ===== 斷線釋放發言權 =====
    supC.clear(); C[outs.id].clear();
    const gl = await talk(C[outs.id], 'lobby');
    supC.ws.readyState === 1 && await supC.wait(m => m.t === 'talk_start' && m.from === outs.id);
    C[outs.id].ws.terminate();
    const t1 = Date.now(); const rel = await supC.wait(m => m.t === 'talk_end' && (m.reason === 'disconnect' || m.reason === 'stalled'), 25000);
    ok('講話者斷線時伺服器自動釋放發言權', gl.t === 'floor_granted' && !!rel, `原因=${rel.reason}，${Date.now() - t1}ms`);


    // ===== 多公司隔離與收費佔位 =====
    const platHtml = await fetch(BASE + '/platform');
    ok('/platform 頁面可開啟', platHtml.status === 200 && (await platHtml.text()).includes('平台後台'));
    const noOrg = await http('POST', '/api/login', { username: ADMIN_U, password: ADMIN_P });
    ok('登入未帶公司代碼回 400 need_org', noOrg.status === 400 && noOrg.body.error === 'need_org');
    const platLogin = await http('POST', '/api/login', { username: ADMIN_U, password: ADMIN_P, org: 'PLATFORM' });
    ok('平台管理員可用 PLATFORM 代碼登入', platLogin.status === 200 && platLogin.body.user.role === 'admin' && !platLogin.body.org);
    const platTok = platLogin.body.token;
    ok('PLATFORM 範圍不能直接呼叫公司後台', (await http('GET', '/api/admin/users', null, platTok)).status === 400);
    const plans = await http('GET', '/api/platform/plans', null, adminTok);
    ok('方案金額標示為範例佔位', plans.status === 200 && plans.body.example === true && plans.body.plans.standard.example === true && plans.body.plans.standard.priceMonthly === 990);
    const orgCode = ('T' + sfx).toUpperCase();
    const orgC = await http('POST', '/api/platform/orgs', { code: orgCode, name: `測試公司-${sfx}`, plan: 'standard', seatLimit: 1, adminUsername: `t_oa_${sfx}`, adminDisplayName: '公司管甲', adminPassword: 'Oa-pass-123' }, adminTok);
    if (orgC.body && orgC.body.org) created.orgs.push(orgC.body.org.id);
    ok('平台可建立公司並指定公司管理員', orgC.status === 201 && orgC.body.org && orgC.body.org.code === orgCode && orgC.body.admin.role === 'org_admin', JSON.stringify(orgC.body && orgC.body.org));
    const ORG = orgC.body && orgC.body.org;
    const oaTok = ORG ? await login(`t_oa_${sfx}`, 'Oa-pass-123', orgCode) : null;
    ok('公司管理員用該公司代碼登入', !!oaTok);
    ok('公司管理員不能進平台後台 API', oaTok ? (await http('GET', '/api/platform/orgs', null, oaTok)).status === 403 : false);
    const seatDenied = oaTok ? await http('POST', '/api/admin/users', { username: `t_x2_${sfx}`, password: 'Xx-pass-123' }, oaTok) : { status: 0, body: {} };
    ok('超過座位數不能再建立帳號', seatDenied.status === 403 && seatDenied.body.error === 'seat_limit');
    const seatUp = ORG ? await http('PATCH', `/api/platform/orgs/${ORG.id}`, { seatLimit: 5 }, adminTok) : { status: 0, body: {} };
    ok('平台可調整公司座位數', seatUp.status === 200 && seatUp.body.org && seatUp.body.org.seatLimit === 5);
    const sameName = `t_same_${sfx}`;
    const demoTwin = await http('POST', '/api/admin/users', { username: sameName, displayName: '同名甲', password: 'Same-pass-123' }, adminTok);
    if (demoTwin.body && demoTwin.body.user) created.users.push(demoTwin.body.user.id);
    const otherTwin = oaTok ? await http('POST', '/api/admin/users', { username: sameName, displayName: '同名乙', password: 'Othr-pass-123' }, oaTok) : { status: 0, body: {} };
    ok('不同公司可以使用相同帳號名稱', demoTwin.status === 201 && otherTwin.status === 201 && demoTwin.body.user.id !== otherTwin.body.user.id);
    const tokDemoSame = await login(sameName, 'Same-pass-123', 'DEMO');
    const tokOtherSame = otherTwin.status === 201 ? await login(sameName, 'Othr-pass-123', orgCode) : null;
    const crossLogin = await http('POST', '/api/login', { username: sameName, password: 'Same-pass-123', org: orgCode });
    ok('同名帳號在錯誤公司代碼下無法登入', !!tokDemoSame && !!tokOtherSame && crossLogin.status === 401);
    const otherLobby = ORG ? ('lobby-' + ORG.id) : 'lobby-missing';
    const leakChat = tokDemoSame ? await http('POST', '/api/messages', { conv: otherLobby, text: '不該送到別家' }, tokDemoSame) : { status: 0 };
    const leakRead = tokDemoSame ? await http('GET', `/api/messages?conv=${encodeURIComponent(otherLobby)}`, null, tokDemoSame) : { status: 0 };
    ok('不能對另一家公司的大廳傳訊或讀取', leakChat.status === 403 && leakRead.status === 403);
    const demoLobbyRead = tokOtherSame ? await http('GET', '/api/messages?conv=lobby', null, tokOtherSame) : { status: 0 };
    ok('另一家公司讀不到預設公司大廳訊息', demoLobbyRead.status === 403);
    const Cdemo = tokDemoSame ? await client(tokDemoSame, 'demoSame') : { has: () => false, msgs: [], ws: { close() {} } };
    const Coth = tokOtherSame ? await client(tokOtherSame, 'otherSame') : { has: () => false, msgs: [], ws: { close() {} } };
    ok('兩家公司的同名帳號各自 WebSocket 登入', Cdemo.has(m => m.t === 'welcome' && m.org && m.org.code === 'DEMO') && Coth.has(m => m.t === 'welcome' && m.org && m.org.code === orgCode));
    const crossDm = tokDemoSame && otherTwin.body && otherTwin.body.user ? await talk(Cdemo, undefined, 0, { to: otherTwin.body.user.id }) : { t: 'nope' };
    ok('跨公司一對一對講被拒', crossDm.t === 'floor_denied');
    const onlineDemo = ((Cdemo.msgs || []).find(m => m.t === 'welcome') || {}).online || [];
    ok('線上名單不含另一家公司的人', !onlineDemo.some(x => otherTwin.body && otherTwin.body.user && x.id === otherTwin.body.user.id));
    const checkout = oaTok ? await http('POST', '/api/billing/checkout', { plan: 'standard', period: 'monthly' }, oaTok) : { status: 0, body: {} };
    ok('結帳為未接金流的佔位回應', checkout.status === 200 && checkout.body.ok === false && checkout.body.error === 'not_connected' && checkout.body.example === true && checkout.body.amount === 990);
    const expire = ORG ? await http('PATCH', `/api/platform/orgs/${ORG.id}`, { expiresAt: Date.now() - 1000 }, adminTok) : { status: 0 };
    const expLogin = await http('POST', '/api/login', { username: `t_oa_${sfx}`, password: 'Oa-pass-123', org: orgCode });
    ok('方案到期後無法登入', expire.status === 200 && expLogin.status === 403 && expLogin.body.error === 'org_expired');
    const paid = ORG ? await http('POST', `/api/platform/orgs/${ORG.id}/mark-paid`, { days: 30, note: 'e2e 佔位' }, adminTok) : { status: 0, body: {} };
    const paidLogin = await http('POST', '/api/login', { username: `t_oa_${sfx}`, password: 'Oa-pass-123', org: orgCode });
    ok('標記已付款後可再登入（未經過真實金流）', paid.status === 200 && paid.body.org && paid.body.org.billing && paid.body.org.billing.example === true && paidLogin.status === 200);
    const disOrg = ORG ? await http('PATCH', `/api/platform/orgs/${ORG.id}`, { disabled: true }, adminTok) : { status: 0 };
    const disLogin = await http('POST', '/api/login', { username: `t_oa_${sfx}`, password: 'Oa-pass-123', org: orgCode });
    ok('停用公司後無法登入', disOrg.status === 200 && disLogin.status === 403 && disLogin.body.error === 'org_disabled');
    ok('預設公司不能刪除', (await http('DELETE', '/api/platform/orgs/odefault', null, adminTok)).status === 400);
    try { Cdemo.ws.close(); Coth.ws.close(); } catch {}

    // ===== 不保存錄音 =====
    const hist = await http('GET', '/api/history?conv=lobby', null, adminTok), wav = await fetch(BASE + '/audio/0123456789abcdef.wav');
    const h2 = await http('GET', '/api/health');
    let local = '（雲端：無法直接檢查磁碟）', localOk = true;
    if (DATA_DIR) {
      const files = walk(DATA_DIR).map(f => path.relative(DATA_DIR, f));
      const txt = fs.existsSync(path.join(DATA_DIR, 'db.json')) ? fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8') : '';
      localOk = files.every(f => f === 'db.json' || f === 'chat.json' || f.startsWith('photos' + require('path').sep) || f === 'photos') && !/RIFF|WAVE/.test(txt);
      local = `data/ 檔案 [${files.join(', ')}]，且 db.json 沒有音訊`;
    }
    ok('講完後伺服器沒有留下音訊檔／歷史（也不存位置與警報）', hist.status === 404 && wav.status === 404 && h2.body.storesAudio === false && localOk, `history→${hist.status}、audio→${wav.status}；${local}`);
    for (const c of [...Object.values(C), ADM, anon]) try { c.ws.close(); } catch {}
  } catch (e) {
    console.error('ERROR', e); results.push(['FAIL', 'exception']);
  } finally {
    // ===== 清理測試資料 =====
    if (adminTok) {
      await http('PATCH', '/api/admin/settings', { saveCaptions: false }, adminTok);
      for (const id of created.channels) await http('DELETE', `/api/admin/channels/${id}`, null, adminTok);
      for (const id of created.users) await http('DELETE', `/api/admin/users/${id}`, null, adminTok);
      for (const id of created.orgs) await http('DELETE', `/api/platform/orgs/${id}`, null, adminTok);
      const us = await http('GET', '/api/admin/users', null, adminTok), cs = await http('GET', '/api/admin/channels', null, adminTok);
      const og = await http('GET', '/api/platform/orgs', null, adminTok);
      const left = us.body.users.filter(u => u.username.startsWith('t_') && u.username.endsWith(sfx)), leftC = cs.body.channels.filter(c => c.name.endsWith(sfx));
      const leftO = (og.body.orgs || []).filter(o => (o.code || '').includes(sfx.toUpperCase()) || (o.name || '').includes(sfx));
      for (const o of leftO) await http('DELETE', `/api/platform/orgs/${o.id}`, null, adminTok);
      const og2 = await http('GET', '/api/platform/orgs', null, adminTok);
      const leftO2 = (og2.body.orgs || []).filter(o => (o.code || '').includes(sfx.toUpperCase()) || (o.name || '').includes(sfx));
      await http('POST', '/api/logout', {}, adminTok);
      ok('清理：本次測試帳號、頻道與公司已刪除', !left.length && !leftC.length && !leftO2.length, `剩下使用者 ${us.body.users.map(u => u.username).join(',')}；頻道 ${cs.body.channels.map(c => c.name).join(',')}；公司 ${(og2.body.orgs || []).map(o => o.code).join(',')}`);
    }
    const fails = results.filter(r => r[0] === 'FAIL').length;
    console.log(`\n${results.length - fails}/${results.length} 通過`); process.exit(fails ? 1 : 0);
  }
})();
