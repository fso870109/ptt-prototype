// 端對端測試：模擬 3 個客戶端（A、B、C）。用法：node test/e2e.js [baseUrl]
const WebSocket = require('ws');
const BASE = process.argv[2] || 'http://localhost:8800';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';
const results = []; const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); console.log(cond ? 'PASS' : 'FAIL', name, extra); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function client(id, name) {
  return new Promise((res) => {
    const ws = new WebSocket(WSURL); const c = { ws, id, name, msgs: [], bin: [] };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (pred, ms = 5000) => new Promise((r, j) => { const t0 = Date.now(); (function chk() { const m = c.msgs.find(pred); if (m) return r(m); if (Date.now() - t0 > ms) return j(new Error('timeout ' + name)); setTimeout(chk, 30); })(); });
    ws.on('message', (d, isBin) => { if (isBin) c.bin.push(Buffer.from(d)); else c.msgs.push(JSON.parse(d.toString())); });
    ws.on('open', () => { c.send({ t: 'hello', id, name }); c.wait(m => m.t === 'welcome').then(() => res(c)); });
  });
}
function tone(ms, f = 440) { const n = 16000 * ms / 1000; const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * i / 16000) * 8000), i * 2); return b; }
(async () => {
  const sfx = Date.now().toString(36);
  const A = await client('testA' + sfx, '測試A'), B = await client('testB' + sfx, '測試B');
  ok('A、B 連線並收到 welcome', true);
  const chName = '測試頻道-' + sfx;
  A.send({ t: 'create_channel', name: chName });
  const cc = await A.wait(m => m.t === 'channel_created'); const ch = cc.channel;
  ok('建立頻道', !!ch, ch);
  A.send({ t: 'join', channel: ch }); B.send({ t: 'join', channel: ch });
  await A.wait(m => m.t === 'joined' && m.channel === ch); await B.wait(m => m.t === 'joined' && m.channel === ch);
  await sleep(300);
  const mem = [...A.msgs].reverse().find(m => m.t === 'members' && m.channel === ch);
  ok('頻道成員名單含 A、B', mem && mem.members.length === 2, mem && mem.members.map(x => x.name).join(','));

  // A 取得發言權
  A.send({ t: 'ptt_start', conv: ch });
  const g = await A.wait(m => m.t === 'floor_granted');
  ok('A 取得發言權', !!g, 'streamId=' + g.streamId);
  const ts = await B.wait(m => m.t === 'talk_start' && m.from === A.id);
  ok('B 收到 talk_start（顯示「測試A 正在說話」）', ts.fromName === '測試A');
  // B 搶話 -> 應被拒
  B.send({ t: 'ptt_start', conv: ch });
  const d = await B.wait(m => m.t === 'floor_denied');
  ok('B 同時按下被拒（floor control）', d.reason === 'busy' && d.byName === '測試A', JSON.stringify(d));
  // A 傳 1 秒音訊（10 包 x 100ms）
  const pcm = tone(1000); const t0 = Date.now();
  for (let i = 0; i < 10; i++) { A.ws.send(pcm.subarray(i * 3200, (i + 1) * 3200)); await sleep(100); }
  await sleep(500);
  const total = B.bin.reduce((s, b) => s + b.length - 4, 0);
  ok('B 收到轉發語音資料', B.bin.length === 10 && total === pcm.length, `${B.bin.length} 包 / ${total} bytes，streamId=${B.bin[0] && B.bin[0].readUInt32BE(0)}`);
  ok('A 不會收到自己的語音', A.bin.length === 0);
  A.send({ t: 'ptt_stop' });
  const te = await B.wait(m => m.t === 'talk_end' && m.from === A.id);
  ok('放開後廣播 talk_end 並產生留言', !!te.message, te.message && `${te.message.durMs}ms id=${te.message.id}`);
  // 放開後 B 可取得發言權
  B.send({ t: 'ptt_start', conv: ch }); const g2 = await B.wait(m => m.t === 'floor_granted');
  ok('A 放開後 B 可以取得發言權', !!g2);
  B.ws.send(tone(500, 660)); await sleep(150); B.send({ t: 'ptt_stop' });
  await A.wait(m => m.t === 'talk_end' && m.from === B.id);

  // 歷史 API
  const h = await (await fetch(`${BASE}/api/history?conv=${ch}&user=${A.id}`)).json();
  ok('歷史 API 回傳 2 則', h.length === 2, h.map(m => m.fromName + ' ' + m.durMs + 'ms').join(' | '));
  const r = await fetch(`${BASE}/audio/${h[0].id}.wav`); const wav = Buffer.from(await r.arrayBuffer());
  ok('回放 WAV 可下載且內容正確', r.status === 200 && wav.slice(0, 4).toString() === 'RIFF' && wav.length === 44 + pcm.length && wav.slice(44).equals(pcm), `${r.headers.get('content-type')} ${wav.length} bytes`);
  const rr = await fetch(`${BASE}/audio/${h[0].id}.wav`, { headers: { Range: 'bytes=0-99' } });
  ok('Range 請求（iOS Safari 需要）', rr.status === 206 && (await rr.arrayBuffer()).byteLength === 100);

  // 離線留言：C 不在線時 A 說話，C 上線後拉歷史
  A.send({ t: 'ptt_start', conv: ch }); await A.wait(m => m.t === 'floor_granted' && m.streamId !== g.streamId);
  for (let i = 0; i < 5; i++) A.ws.send(tone(100, 523));
  await sleep(200); A.send({ t: 'ptt_stop' }); await B.wait(m => m.t === 'talk_end' && m.message && m.message.durMs === 500 && m.from === A.id);
  const C = await client('testC' + sfx, '測試C');
  C.send({ t: 'join', channel: ch }); await C.wait(m => m.t === 'joined');
  const hc = await (await fetch(`${BASE}/api/history?conv=${ch}&user=${C.id}`)).json();
  ok('離線的 C 上線後可拿到錯過的 3 則留言', hc.length === 3);

  // 一對一私人對講：A -> B，C 不應收到
  C.bin = []; B.bin = [];
  A.send({ t: 'ptt_start', to: B.id }); const gd = await A.wait(m => m.t === 'floor_granted' && m.conv.startsWith('dm:'));
  const tsd = await B.wait(m => m.t === 'talk_start' && m.conv === gd.conv);
  A.ws.send(tone(400, 300)); await sleep(300); A.send({ t: 'ptt_stop' });
  await B.wait(m => m.t === 'talk_end' && m.conv === gd.conv);
  await sleep(200);
  ok('私人對講：B 收到、C 收不到', B.bin.length === 1 && C.bin.length === 0 && !C.msgs.some(m => m.conv === gd.conv));
  // 私訊期間頻道仍可同時有人講（不同 floor）
  const hdm = await (await fetch(`${BASE}/api/history?conv=${encodeURIComponent(gd.conv)}&user=${B.id}`)).json();
  const hdmC = await fetch(`${BASE}/api/history?conv=${encodeURIComponent(gd.conv)}&user=${C.id}`);
  ok('私訊歷史只有當事人可讀', hdm.length === 1 && hdmC.status === 403);

  // 斷線釋放發言權
  A.send({ t: 'ptt_start', conv: ch }); await A.wait(m => m.t === 'floor_granted' && m.conv === ch && m.streamId > gd.streamId);
  A.ws.terminate();
  const t1 = Date.now(); const te2 = await B.wait(m => m.t === 'talk_end' && (m.reason === 'disconnect' || m.reason === 'stalled'), 25000);
  B.send({ t: 'ptt_start', conv: ch }); const g3 = await B.wait(m => m.t === 'floor_granted' && m.streamId > gd.streamId);
  ok('講話者斷線時伺服器自動釋放發言權', !!te2 && !!g3, `原因=${te2.reason}，${Date.now() - t1}ms 內釋放`); B.send({ t: 'ptt_stop' });
  // 重新連線：同 id 回來，伺服器記得頻道
  const A2 = await client(A.id, '測試A');
  const j = await A2.wait(m => m.t === 'joined');
  ok('A 用同一 id 重連後自動回到原頻道', j.channel === ch);
  const hp = await (await fetch(`${BASE}/`)).text();
  ok('網頁首頁可透過此網址開啟', hp.includes('一鍵對講'));
  [A2, B, C].forEach(c => c.ws.close());
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} 通過`); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
