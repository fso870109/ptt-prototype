'use strict';

const SECRET = /(token|password|passwd|passhash|authorization|bearer|cookie|secret|apns[_-]?key|private[_-]?key)/i;

function redact(s) {
  let out = String(s ?? '');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  out = out.replace(/"(token|password|oldPassword|newPassword|passHash|authorization|cookie)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
  out = out.replace(/'(token|password|oldPassword|newPassword|passHash|authorization|cookie)'\s*:\s*'[^']*'/gi, "'$1':'***'");
  out = out.replace(/\b(token|password|authorization|orgCode)=([^\s&]+)/gi, '$1=***');
  out = out.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***jwt***');
  return out;
}

function sanitizeLog(lines, maxLines = 200, maxLen = 400) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(-maxLines).map((line) => {
    const s = redact(String(line ?? '')).slice(0, maxLen);
    return s;
  }).filter(Boolean);
}

function sanitizeMeta(meta) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const pick = (k, n = 120) => String(src[k] || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
  return {
    platform: pick('platform', 20),
    device: pick('device', 80),
    os: pick('os', 80),
    appVersion: pick('appVersion', 40),
    browser: pick('browser', 120),
    userAgent: pick('userAgent', 240)
  };
}

module.exports = { redact, sanitizeLog, sanitizeMeta };
