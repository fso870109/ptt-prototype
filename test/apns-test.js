'use strict';
// 本機假 APNs HTTP/2 伺服器，驗證 pushtotalk 請求格式（不連上 Apple）
const http2 = require('http2');
const crypto = require('crypto');
const { Apns, enabled, normalizeToken, makeJwt } = require('../lib/apns');

function ok(name, cond, extra) {
  console.log(cond ? 'PASS' : 'FAIL', name, extra || '');
  if (!cond) process.exitCode = 1;
}

function startFake() {
  const received = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      let body = raw;
      try { body = JSON.parse(raw || '{}'); } catch {}
      const rec = { headers, body, raw };
      received.push(rec);
      const path = String(headers[':path'] || '');
      if (path.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: 'Unregistered' }));
      } else {
        stream.respond({ ':status': 200 });
        stream.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

(async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.APNS_KEY_P8 = pem;
  process.env.APNS_KEY_ID = 'KEYID01';
  process.env.APNS_TEAM_ID = 'TEAMID01';
  process.env.APNS_BUNDLE_ID = 'app.ptt.mobile';
  process.env.APNS_ENV = 'sandbox';
  delete process.env.APNS_PRODUCTION;

  ok('設定金鑰後 APNs 視為啟用', enabled() === true);
  const jwt = makeJwt();
  const [h, p] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  ok('JWT 為 ES256 且含 kid、iss', header.alg === 'ES256' && header.kid === 'KEYID01' && payload.iss === 'TEAMID01' && typeof payload.iat === 'number');

  const fake = await startFake();
  process.env.APNS_HOST = 'http://127.0.0.1:' + fake.port;
  const apns = new Apns();
  const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const r = await apns.send({
    token: hex,
    payload: { activeSpeaker: '小明', conv: 'lobby', from: 'u1', fromName: '小明', streamId: 9 }
  });
  ok('假 APNs 回 200', r.status === 200, JSON.stringify(r));
  const rec = fake.received[0];
  ok('路徑為 /3/device/<token>', rec && rec.headers[':path'] === '/3/device/' + hex);
  ok('方法為 POST', rec && rec.headers[':method'] === 'POST');
  ok('apns-push-type 為 pushtotalk', rec && rec.headers['apns-push-type'] === 'pushtotalk');
  ok('topic 為 bundle.voip-ptt', rec && rec.headers['apns-topic'] === 'app.ptt.mobile.voip-ptt');
  ok('priority 10、expiration 0', rec && String(rec.headers['apns-priority']) === '10' && String(rec.headers['apns-expiration']) === '0');
  ok('authorization 為 bearer JWT', rec && String(rec.headers.authorization || rec.headers.Authorization || '').startsWith('bearer '));
  ok('payload 含 activeSpeaker', rec && rec.body.activeSpeaker === '小明' && rec.body.conv === 'lobby');

  const dead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const r2 = await apns.send({ token: dead, payload: { activeSpeaker: '測' } });
  ok('token 失效時回 410 並標 unregistered', r2.status === 410 && r2.unregistered === true, JSON.stringify(r2));
  ok('normalizeToken 接受 hex', normalizeToken(hex) === hex);

  // 未設定金鑰時安靜停用
  delete process.env.APNS_KEY_P8;
  delete process.env.APNS_P8;
  ok('未設定金鑰時停用', enabled() === false);
  const off = new Apns();
  const skip = await off.send({ token: hex, payload: { activeSpeaker: 'x' } });
  ok('停用時 send 會 skipped', skip.skipped === true && skip.reason === 'disabled');

  apns.close();
  fake.server.close();
  const fails = process.exitCode ? 1 : 0;
  console.log(fails ? 'apns-test 失敗' : 'apns-test 全部通過');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
