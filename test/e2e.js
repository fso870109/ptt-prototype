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
const login = async (u, p) => (await http('POST', '/api/login', { username: u, password: p })).body?.token;
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
async function waitClosed(c, ms = 8000) { const t0 = Date.now(); while (c.closed === null && Date.now() - t0 < ms) await sleep(50); return c.closed; }
async function talk(c, conv, ms = 300, extra = {}) {
  c.send({ t: 'ptt_start', conv, ...extra });
  const g = await c.wait(m => (m.t === 'floor_granted' || m.t === 'floor_denied') && !m._seen); g._seen = true; return g;
}
function walk(d) { let out = []; if (!fs.existsSync(d)) return out; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); out = out.concat(fs.statSync(p).isDirectory() ? walk(p) : [p]); } return out; }

(async () => {
  const sfx = Date.now().toString(36).slice(-5);
  const created = { users: [], channels: [] };
  let adminTok;
  try {
    const h = await http('GET', '/api/health');
    ok('健康檢查', h.status === 200 && h.body.ok && h.body.storesAudio === false, JSON.stringify(h.body));

    // ===== 未登入 =====
    const anon = await client('not-a-token', 'anon');
    ok('未登入（無效 token）的 WebSocket 被拒絕', anon.has(m => m.t === 'auth_failed') && !anon.has(m => m.t === 'welcome'));
    ok('未登入呼叫 API 回 401', (await http('GET', '/api/admin/users')).status === 401 && (await http('GET', '/api/locations')).status === 401 && (await http('GET', '/api/me')).status === 401);
    ok('錯誤密碼登入失敗', (await http('POST', '/api/login', { username: ADMIN_U, password: ADMIN_P + 'x' })).status === 401);
    adminTok = await login(ADMIN_U, ADMIN_P);
    ok('管理員登入成功', !!adminTok);
    const meA = await http('GET', '/api/me', null, adminTok);
    ok('管理員身分為 admin', meA.body?.user?.role === 'admin');

    // ===== 後台：建立使用者與頻道、指派角色 =====
    const mk = async (key, name, password) => {
      const r = await http('POST', '/api/admin/users', { username: `t_${key}_${sfx}`, displayName: name, password }, adminTok);
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

    // ===== 後台操作即時生效 =====
    await http('DELETE', `/api/admin/channels/${CH}/members/${lis.id}`, null, adminTok);
    const moved = await C[lis.id].wait(m => m.t === 'joined' && m.reason === 'access_changed');
    ok('移除頻道成員 → 立即被移回大廳', moved.channel === 'lobby');
    const dis = await http('PATCH', `/api/admin/users/${m2.id}`, { disabled: true }, adminTok);
    const cl2 = await waitClosed(C[m2.id]); const lg2 = (await http('POST', '/api/login', { username: m2.username, password: m2.password })).status;
    ok('停用使用者 → 立即斷線，且無法再登入', dis.status === 200 && C[m2.id].has(m => m.t === 'auth_failed') && cl2 !== null && lg2 === 403, `close=${cl2} login=${lg2}`);
    const offDm = await talk(C[m1.id], undefined, 0, { to: m2.id });
    ok('對不在線（已停用）的人私人對講被拒', offDm.t === 'floor_denied');
    const rp = await http('PATCH', `/api/admin/users/${m1.id}`, { resetPassword: true }, adminTok);
    const cl1 = await waitClosed(C[m1.id]);
    const oldTokOk = (await http('GET', '/api/me', null, tok[m1.id])).status;
    const newOk = !!(await login(m1.username, rp.body.password)), oldPwOk = !!(await login(m1.username, m1.password));
    ok('重設密碼 → 產生新密碼、舊登入失效、新密碼可登入', rp.body.password && oldTokOk === 401 && cl1 !== null && newOk && !oldPwOk, `close=${cl1} oldToken=${oldTokOk} new=${newOk} oldPw=${oldPwOk}`);
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

    // ===== 不保存錄音 =====
    const hist = await http('GET', '/api/history?conv=lobby', null, adminTok), wav = await fetch(BASE + '/audio/0123456789abcdef.wav');
    const h2 = await http('GET', '/api/health');
    let local = '（雲端：無法直接檢查磁碟）', localOk = true;
    if (DATA_DIR) {
      const files = walk(DATA_DIR).map(f => path.relative(DATA_DIR, f));
      const txt = fs.existsSync(path.join(DATA_DIR, 'db.json')) ? fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8') : '';
      localOk = files.every(f => f === 'db.json') && !/RIFF|"lat"|"battery"|alert/.test(txt);
      local = `data/ 只有 [${files.join(', ')}]，且沒有位置/警報/音訊`;
    }
    ok('講完後伺服器沒有留下音訊檔／歷史（也不存位置與警報）', hist.status === 404 && wav.status === 404 && h2.body.storesAudio === false && localOk, `history→${hist.status}、audio→${wav.status}；${local}`);
    for (const c of [...Object.values(C), ADM, anon]) try { c.ws.close(); } catch {}
  } catch (e) {
    console.error('ERROR', e); results.push(['FAIL', 'exception']);
  } finally {
    // ===== 清理測試資料 =====
    if (adminTok) {
      for (const id of created.channels) await http('DELETE', `/api/admin/channels/${id}`, null, adminTok);
      for (const id of created.users) await http('DELETE', `/api/admin/users/${id}`, null, adminTok);
      const us = await http('GET', '/api/admin/users', null, adminTok), cs = await http('GET', '/api/admin/channels', null, adminTok);
      const left = us.body.users.filter(u => u.username.startsWith('t_') && u.username.endsWith(sfx)), leftC = cs.body.channels.filter(c => c.name.endsWith(sfx));
      await http('POST', '/api/logout', {}, adminTok);
      ok('清理：本次測試帳號與頻道已刪除', !left.length && !leftC.length, `剩下使用者 ${us.body.users.map(u => u.username).join(',')}；頻道 ${cs.body.channels.map(c => c.name).join(',')}`);
    }
    const fails = results.filter(r => r[0] === 'FAIL').length;
    console.log(`\n${results.length - fails}/${results.length} 通過`); process.exit(fails ? 1 : 0);
  }
})();
