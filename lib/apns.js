'use strict';
const http2 = require('http2');
const crypto = require('crypto');

function enabled() {
  const key = process.env.APNS_KEY_P8 || process.env.APNS_P8 || '';
  const keyId = process.env.APNS_KEY_ID || '';
  const team = process.env.APNS_TEAM_ID || '';
  return !!(key && keyId && team);
}

function envHost() {
  const env = String(process.env.APNS_ENV || '').toLowerCase();
  if (env === 'production' || env === 'prod' || process.env.APNS_PRODUCTION === '1') return 'https://api.push.apple.com';
  if (process.env.APNS_HOST) return process.env.APNS_HOST;
  return 'https://api.sandbox.push.apple.com';
}

function bundleId() { return process.env.APNS_BUNDLE_ID || 'app.ptt.mobile'; }

function normalizeToken(tok) {
  const s = String(tok || '').trim();
  if (/^[0-9a-fA-F]{16,}$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    const buf = Buffer.from(s, 'base64url');
    if (buf.length >= 8) return buf.toString('hex');
  } catch {}
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length >= 8) return buf.toString('hex');
  } catch {}
  return s.toLowerCase();
}

function makeJwt() {
  const raw = process.env.APNS_KEY_P8 || process.env.APNS_P8 || '';
  const pem = raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : raw.replace(/\\n/g, '\n');
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now })).toString('base64url');
  const sign = crypto.createSign('SHA256').update(header + '.' + payload).end()
    .sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  return header + '.' + payload + '.' + sign.toString('base64url');
}

class Apns {
  constructor() {
    this.client = null;
    this.jwt = '';
    this.jwtAt = 0;
    this.host = envHost();
  }

  _token() {
    if (!this.jwt || Date.now() - this.jwtAt > 50 * 60e3) {
      this.jwt = makeJwt();
      this.jwtAt = Date.now();
    }
    return this.jwt;
  }

  _client() {
    if (this.client && !this.client.closed && !this.client.destroyed) return this.client;
    this.client = http2.connect(this.host);
    this.client.on('error', (e) => console.error('[apns] conn', e.message));
    this.client.on('close', () => { this.client = null; });
    return this.client;
  }

  async send({ token, payload, bundle }) {
    if (!enabled()) return { skipped: true, reason: 'disabled' };
    const hex = normalizeToken(token);
    const topic = (bundle || bundleId()) + '.voip-ptt';
    const client = this._client();
    const body = JSON.stringify(payload);
    return await new Promise((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': '/3/device/' + hex,
        authorization: 'bearer ' + this._token(),
        'apns-push-type': 'pushtotalk',
        'apns-topic': topic,
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json'
      });
      let data = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
          const status = +(headers[':status'] || 0);
          resolve({ status, body: data, unregistered: status === 410 });
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.end(body);
    });
  }

  close() { try { if (this.client) this.client.close(); } catch {} this.client = null; }
}

module.exports = { Apns, enabled, envHost, bundleId, normalizeToken, makeJwt };
