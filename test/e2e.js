// 端對端測試：模擬 3 個客戶端（A、B、C）。用法：node test/e2e.js [baseUrl] [--data-dir=路徑]
// 本版本伺服器「只即時轉發、不保存錄音」，最後會驗證伺服器沒有留下任何音訊或歷史。
const fs = require('fs'); const path = require('path');
const WebSocket = require('ws');
const BASE = (process.argv.find(a => /^https?:/.test(a)) || 'http://localhost:8800').replace(/\/$/, '');
const DATA_DIR = (process.argv.find(a => a.startsWith('--data-dir=')) || '').slice(11) || (/localhost|127\.0\.0\.1/.test(BASE) ? path.join(__dirname, '..', 'data') : '');
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
function walk(d) { let out = []; if (!fs.existsSync(d)) return out; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); out = out.concat(fs.statSync(p).isDirectory() ? walk(p) : [p]); } return out; }
(async () => {
  const sfx = Date.now().toString(36);
  const A = await client('testA' + sfx, '測試A'), B = await client('testB' + sfx, '測試B');
  ok('A、B 連線並收到 welcome', true);
  const chName = '測試頻道-' + sfx;
  A.send({ t: 'create_channel', name: chName });
  const ch = (await A.wait(m => m.t === 'channel_created')).channel;
  ok('建立頻道', !!ch, ch);
  A.send({ t: 'join', channel: ch }); B.send({ t: 'join', channel: ch });
  await A.wait(m => m.t === 'joined' && m.channel === ch); await B.wait(m => m.t === 'joined' && m.channel === ch);
  await sleep(300);
  const mem = [...A.msgs].reverse().find(m => m.t === 'members' && m.channel === ch);
  ok('頻道成員名單含 A、B', mem && mem.members.length === 2, mem && mem.members.map(x => x.name).join(','));

  A.send({ t: 'ptt_start', conv: ch });
  const g = await A.wait(m => m.t === 'floor_granted');
  ok('A 取得發言權', !!g, 'streamId=' + g.streamId);
  const ts = await B.wait(m => m.t === 'talk_start' && m.from === A.id);
  ok('B 收到 talk_start（顯示「測試A 正在說話」）', ts.fromName === '測試A');
  B.send({ t: 'ptt_start', conv: ch });
  const d = await B.wait(m => m.t === 'floor_denied');
  ok('B 同時按下被拒（floor control）', d.reason === 'busy' && d.byName === '測試A', JSON.stringify(d));
  const pcm = tone(1000);
  for (let i = 0; i < 10; i++) { A.ws.send(pcm.subarray(i * 3200, (i + 1) * 3200)); await sleep(100); }
  await sleep(500);
  const got = Buffer.concat(B.bin.map(b => b.subarray(4)));
  ok('B 即時收到轉發語音（內容一致）', B.bin.length === 10 && got.equals(pcm), `${B.bin.length} 包 / ${got.length} bytes`);
  ok('A 不會收到自己的語音', A.bin.length === 0);
  A.send({ t: 'ptt_stop' });
  const te = await B.wait(m => m.t === 'talk_end' && m.from === A.id);
  ok('放開後廣播 talk_end，只附文字狀態（誰／何時／幾秒），沒有音訊或檔案連結', te.lastTalk && te.lastTalk.fromName === '測試A' && te.lastTalk.durMs === 1000 && !('message' in te) && !JSON.stringify(te).match(/wav|audio|url|id":"[0-9a-f]{16}/i), JSON.stringify(te.lastTalk));
  B.send({ t: 'ptt_start', conv: ch }); const g2 = await B.wait(m => m.t === 'floor_granted');
  ok('A 放開後 B 可以取得發言權', !!g2);
  B.ws.send(tone(500, 660)); await sleep(150); B.send({ t: 'ptt_stop' });
  await A.wait(m => m.t === 'talk_end' && m.from === B.id);

  // 晚來的 C：只拿得到「最近說話者」文字，拿不到任何先前的音訊
  const C = await client('testC' + sfx, '測試C');
  C.send({ t: 'join', channel: ch }); await C.wait(m => m.t === 'joined'); await sleep(500);
  const chInfo = C.msgs.find(m => m.t === 'welcome').channels.find(x => x.id === ch);
  ok('晚加入的 C 只看到「最近說話：測試B」文字、收不到任何舊語音', C.bin.length === 0 && chInfo && chInfo.lastTalk && chInfo.lastTalk.fromName === '測試B', JSON.stringify(chInfo && chInfo.lastTalk));

  // 一對一私人對講：A -> B，C 不應收到
  C.bin = []; B.bin = [];
  A.send({ t: 'ptt_start', to: B.id }); const gd = await A.wait(m => m.t === 'floor_granted' && m.conv.startsWith('dm:'));
  await B.wait(m => m.t === 'talk_start' && m.conv === gd.conv);
  A.ws.send(tone(400, 300)); await sleep(300); A.send({ t: 'ptt_stop' });
  await B.wait(m => m.t === 'talk_end' && m.conv === gd.conv);
  await sleep(200);
  ok('私人對講：B 收到、C 收不到', B.bin.length === 1 && C.bin.length === 0 && !C.msgs.some(m => m.conv === gd.conv));
  // 私人對講對象不在線 → 直接拒絕（沒有留言功能）
  A.send({ t: 'ptt_start', to: 'nobody' + sfx });
  const off = await A.wait(m => m.t === 'floor_denied' && m.reason === 'offline');
  ok('私人對講對象不在線時拒絕發話（不留言）', !!off);

  // 斷線釋放發言權
  A.send({ t: 'ptt_start', conv: ch }); await A.wait(m => m.t === 'floor_granted' && m.conv === ch && m.streamId > gd.streamId);
  A.ws.terminate();
  const t1 = Date.now(); const te2 = await B.wait(m => m.t === 'talk_end' && (m.reason === 'disconnect' || m.reason === 'stalled'), 25000);
  B.send({ t: 'ptt_start', conv: ch }); const g3 = await B.wait(m => m.t === 'floor_granted' && m.streamId > gd.streamId);
  ok('講話者斷線時伺服器自動釋放發言權', !!te2 && !!g3, `原因=${te2.reason}，${Date.now() - t1}ms 內釋放`); B.send({ t: 'ptt_stop' });
  const A2 = await client(A.id, '測試A');
  const j = await A2.wait(m => m.t === 'joined');
  ok('A 用同一 id 重連後自動回到原頻道', j.channel === ch);

  // ===== 驗證伺服器沒有保存錄音 / 歷史 =====
  const hist = await fetch(`${BASE}/api/history?conv=${ch}&user=${B.id}`);
  const wav = await fetch(`${BASE}/audio/0123456789abcdef.wav`);
  const wavCt = wav.headers.get('content-type') || '';
  const health = await (await fetch(`${BASE}/api/health`)).json();
  let local = '（雲端：無法直接檢查磁碟）', localOk = true;
  if (DATA_DIR) {
    const files = walk(DATA_DIR).map(f => path.relative(DATA_DIR, f));
    const dbTxt = fs.existsSync(path.join(DATA_DIR, 'db.json')) ? fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8') : '{}';
    const db = JSON.parse(dbTxt);
    localOk = files.every(f => f === 'db.json') && Object.keys(db).join() === 'channels' && !/RIFF|wav|測試A.*1000/.test(dbTxt);
    local = `data/ 只有 [${files.join(', ')}]，db.json 欄位=${Object.keys(db).join(',')}`;
  }
  ok('講完後伺服器沒有留下音訊檔／歷史', hist.status === 404 && wav.status === 404 && !wavCt.includes('audio') && health.storesAudio === false && !('messages' in health) && localOk,
    `/api/history→${hist.status}、/audio/*.wav→${wav.status} ${wavCt.split(';')[0]}、health=${JSON.stringify(health)}；${local}`);

  const hp = await (await fetch(`${BASE}/`)).text();
  ok('網頁首頁可透過此網址開啟，且沒有歷史回放 UI', hp.includes('一鍵對講') && !hp.includes('playUnread') && !hp.includes('historyList'));
  [A2, B, C].forEach(c => c.ws.close());
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} 通過`); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
