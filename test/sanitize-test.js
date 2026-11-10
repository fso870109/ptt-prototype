'use strict';
const { redact, sanitizeLog, sanitizeMeta } = require('../lib/sanitize');
let fails = 0;
function ok(name, cond) { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) fails++; }
ok('redact bearer', !redact('Authorization Bearer abcdefghijklmnop.qrstuv').includes('abcdefghijklmnop'));
ok('redact json password', redact('{"password":"secret-value","x":1}').includes('"password":"***"') && !redact('{"password":"secret-value"}').includes('secret-value'));
ok('sanitizeLog truncates', sanitizeLog(['x'.repeat(800)])[0].length === 400);
ok('sanitizeLog caps at 200', sanitizeLog(Array.from({ length: 250 }, (_, i) => 'line ' + i)).length === 200);
ok('sanitizeLog redacts token field', !sanitizeLog(['hello {"token":"super-secret-token-value"}']).some(l => l.includes('super-secret-token-value')));
const meta = sanitizeMeta({ platform: 'android', device: 'Pixel 8', os: 'Android 14', appVersion: '0.4.0', browser: '', userAgent: 'x', password: 'nope', token: 'nope' });
ok('sanitizeMeta allowlist', meta.device === 'Pixel 8' && meta.password === undefined && meta.token === undefined);
process.exit(fails ? 1 : 0);
