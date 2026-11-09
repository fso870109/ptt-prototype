// 持久化：有 DATABASE_URL 用 Postgres（整份狀態存成一列 JSONB），否則用 data/db.json。
// 只存帳號、頻道、成員角色、登入 session；不存任何語音、位置或警報。
'use strict';
const fs = require('fs');
const path = require('path');

function emptyDoc() { return { version: 2, users: [], channels: [], sessions: {} }; }

class Store {
  constructor({ databaseUrl, dataDir }) {
    this.databaseUrl = databaseUrl; this.dataDir = dataDir;
    this.kind = databaseUrl ? 'postgres' : 'json';
    this.doc = emptyDoc(); this._timer = null; this._saving = null; this._dirty = false; this._waiters = [];
  }
  async init() {
    if (this.kind === 'postgres') {
      const { Pool } = require('pg');
      const needSsl = /sslmode=require/.test(this.databaseUrl) || /\.render\.com/.test(this.databaseUrl) || process.env.PGSSL === '1';
      this.pool = new Pool({ connectionString: this.databaseUrl, ssl: needSsl ? { rejectUnauthorized: false } : undefined, max: 3 });
      await this.pool.query('CREATE TABLE IF NOT EXISTS ptt_state (id INT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const r = await this.pool.query('SELECT doc FROM ptt_state WHERE id = 1');
      if (r.rows[0]) this.doc = r.rows[0].doc;
    } else {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.file = path.join(this.dataDir, 'db.json');
      try { this.doc = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    }
    const d = this.doc;
    d.users ||= []; d.channels ||= []; d.sessions ||= {};
    delete d.messages; // 舊版欄位：不保存錄音
    for (const c of d.channels) { c.members ||= {}; if (c.open === undefined) c.open = c.id === 'lobby'; }
    return this;
  }
  /** 標記變更；回傳的 Promise 在資料真正寫入後完成 */
  save() {
    this._dirty = true;
    const p = new Promise((res, rej) => this._waiters.push({ res, rej }));
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 150);
    return p;
  }
  async _flush() {
    if (this._saving) { await this._saving.catch(() => {}); }
    if (!this._dirty) return;
    this._dirty = false;
    const waiters = this._waiters.splice(0);
    const snapshot = JSON.stringify(this.doc);
    this._saving = (async () => {
      if (this.kind === 'postgres') {
        await this.pool.query('INSERT INTO ptt_state (id, doc, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()', [snapshot]);
      } else {
        const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, snapshot); fs.renameSync(tmp, this.file);
      }
    })();
    try { await this._saving; waiters.forEach(w => w.res()); }
    catch (e) { console.error('[store] save failed', e.message); this._dirty = true; waiters.forEach(w => w.rej(e)); setTimeout(() => this._flush(), 2000); }
    finally { this._saving = null; }
  }
  async close() { clearTimeout(this._timer); await this._flush(); if (this.pool) await this.pool.end(); }
}
module.exports = { Store };
