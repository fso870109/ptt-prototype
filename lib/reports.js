'use strict';
const fs = require('fs');
const path = require('path');
const { sanitizeLog, sanitizeMeta } = require('./sanitize');

const REPORT_TEXT_MAX = 2000;
const REPORT_SHOT_MAX = 300 * 1024;
const REPORT_RETENTION_MS = 90 * 864e5;
const REPORT_RATE_USER = 5;
const REPORT_RATE_IP = 15;
const REPORT_RATE_WINDOW = 3600e3;

class Reports {
  constructor(store) {
    this.store = store;
    this.hits = new Map();
  }
  get kind() { return this.store.kind; }

  async init() {
    if (this.kind === 'postgres') {
      await this.store.pool.query(`
        CREATE TABLE IF NOT EXISTS ptt_reports (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          user_id TEXT,
          username TEXT,
          display_name TEXT,
          body TEXT NOT NULL,
          meta JSONB,
          log JSONB,
          screenshot BYTEA,
          screenshot_mime TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          note TEXT,
          handled_at BIGINT,
          handled_by TEXT,
          handled_by_name TEXT,
          ts BIGINT NOT NULL
        )`);
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_reports_org_ts ON ptt_reports (org_id, ts DESC)');
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_reports_status_ts ON ptt_reports (status, ts DESC)');
    } else {
      this.dir = path.join(this.store.dataDir, 'report-shots');
      this.file = path.join(this.store.dataDir, 'reports.json');
      fs.mkdirSync(this.dir, { recursive: true });
      try { this.rows = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.rows = []; }
      if (!Array.isArray(this.rows)) this.rows = [];
    }
  }

  _save() {
    if (this.kind === 'postgres') return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.rows));
    fs.renameSync(tmp, this.file);
  }

  _hit(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < REPORT_RATE_WINDOW);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length;
  }

  rateCheck(userId, ip) {
    if (this._hit('u:' + userId) > REPORT_RATE_USER) return 'user';
    if (ip && this._hit('ip:' + ip) > REPORT_RATE_IP) return 'ip';
    return null;
  }

  _pub(r, { includeLog = true } = {}) {
    if (!r) return null;
    return {
      id: r.id,
      orgId: r.org_id || r.orgId || null,
      userId: r.user_id || r.userId || null,
      username: r.username || '',
      displayName: r.display_name || r.displayName || '',
      text: r.body || r.text || '',
      meta: r.meta || {},
      log: includeLog ? (r.log || []) : undefined,
      hasScreenshot: !!(r.screenshot || r.screenshot_mime || r.hasScreenshot || r.screenshotMime),
      status: r.status || 'open',
      note: r.note || '',
      handledAt: r.handled_at || r.handledAt || null,
      handledBy: r.handled_by || r.handledBy || null,
      handledByName: r.handled_by_name || r.handledByName || null,
      ts: +(r.ts)
    };
  }

  async add({ id, orgId, userId, username, displayName, text, meta, log, screenshot, screenshotMime, ts }) {
    const row = {
      id, orgId, userId, username, displayName,
      text, meta: sanitizeMeta(meta), log: sanitizeLog(log),
      hasScreenshot: !!(screenshot && screenshot.length),
      screenshotMime: screenshotMime || null,
      status: 'open', note: '', handledAt: null, handledBy: null, handledByName: null, ts
    };
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        `INSERT INTO ptt_reports (id, org_id, user_id, username, display_name, body, meta, log, screenshot, screenshot_mime, status, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11)`,
        [id, orgId, userId, username, displayName, text, row.meta, row.log,
          screenshot || null, screenshotMime || null, ts]
      );
    } else {
      const rec = { ...row, body: text, org_id: orgId, user_id: userId, display_name: displayName, screenshot_mime: screenshotMime };
      this.rows.push(rec);
      if (screenshot && screenshot.length) fs.writeFileSync(path.join(this.dir, id), screenshot);
      this._save();
    }
    return this._pub(row);
  }

  async get(id) {
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('SELECT id, org_id, user_id, username, display_name, body, meta, log, screenshot_mime, status, note, handled_at, handled_by, handled_by_name, ts, (screenshot IS NOT NULL) AS has_shot FROM ptt_reports WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      row.hasScreenshot = !!row.has_shot;
      return this._pub(row);
    }
    const rec = this.rows.find((x) => x.id === id);
    return rec ? this._pub(rec) : null;
  }

  async getScreenshot(id) {
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('SELECT screenshot, screenshot_mime FROM ptt_reports WHERE id = $1', [id]);
      if (!r.rows[0] || !r.rows[0].screenshot) return null;
      return { buf: r.rows[0].screenshot, mime: r.rows[0].screenshot_mime || 'image/jpeg' };
    }
    const rec = this.rows.find((x) => x.id === id);
    if (!rec) return null;
    const fp = path.join(this.dir, id);
    if (!fs.existsSync(fp)) return null;
    return { buf: fs.readFileSync(fp), mime: rec.screenshot_mime || rec.screenshotMime || 'image/jpeg' };
  }

  async list({ orgId, status, since, limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(500, +limit || 100));
    if (this.kind === 'postgres') {
      const cond = []; const args = [];
      if (orgId) { args.push(orgId); cond.push('org_id = $' + args.length); }
      if (status) { args.push(status); cond.push('status = $' + args.length); }
      if (since) { args.push(+since); cond.push('ts >= $' + args.length); }
      args.push(lim);
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const r = await this.store.pool.query(
        `SELECT id, org_id, user_id, username, display_name, body, meta, log, screenshot_mime, status, note, handled_at, handled_by, handled_by_name, ts, (screenshot IS NOT NULL) AS has_shot
         FROM ptt_reports ${where} ORDER BY ts DESC LIMIT $${args.length}`, args);
      return r.rows.map((row) => { row.hasScreenshot = !!row.has_shot; return this._pub(row); });
    }
    return this.rows
      .filter((r) => (!orgId || r.orgId === orgId || r.org_id === orgId) && (!status || r.status === status) && (!since || r.ts >= since))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, lim)
      .map((r) => this._pub(r));
  }

  async update(id, { status, note, handledBy, handledByName }) {
    const rec = await this.get(id);
    if (!rec) return null;
    if (status === 'handled' || status === 'open') rec.status = status;
    if (note !== undefined) rec.note = String(note || '').slice(0, 500);
    if (status === 'handled') {
      rec.handledAt = Date.now();
      rec.handledBy = handledBy || rec.handledBy;
      rec.handledByName = handledByName || rec.handledByName;
    }
    if (status === 'open') {
      rec.handledAt = null; rec.handledBy = null; rec.handledByName = null;
    }
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        'UPDATE ptt_reports SET status=$2, note=$3, handled_at=$4, handled_by=$5, handled_by_name=$6 WHERE id=$1',
        [id, rec.status, rec.note || '', rec.handledAt, rec.handledBy, rec.handledByName]
      );
    } else {
      const raw = this.rows.find((x) => x.id === id);
      if (raw) Object.assign(raw, {
        status: rec.status, note: rec.note,
        handled_at: rec.handledAt, handledAt: rec.handledAt,
        handled_by: rec.handledBy, handledBy: rec.handledBy,
        handled_by_name: rec.handledByName, handledByName: rec.handledByName
      });
      this._save();
    }
    return rec;
  }

  async remove(id) {
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('DELETE FROM ptt_reports WHERE id = $1', [id]);
      return (r.rowCount || 0) > 0;
    }
    const ix = this.rows.findIndex((x) => x.id === id);
    if (ix < 0) return false;
    try { fs.unlinkSync(path.join(this.dir, id)); } catch {}
    this.rows.splice(ix, 1);
    this._save();
    return true;
  }

  async anonymizeUser(userId) {
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        "UPDATE ptt_reports SET user_id=NULL, username='', display_name='已刪除的使用者' WHERE user_id=$1",
        [userId]
      );
    } else {
      for (const r of this.rows) {
        if (r.userId === userId || r.user_id === userId) {
          r.userId = r.user_id = null; r.username = ''; r.displayName = r.display_name = '已刪除的使用者';
        }
      }
      this._save();
    }
  }

  async deleteByOrg(orgId) {
    if (this.kind === 'postgres') {
      await this.store.pool.query('DELETE FROM ptt_reports WHERE org_id = $1', [orgId]);
    } else {
      const keep = [];
      for (const r of this.rows) {
        if (r.orgId === orgId || r.org_id === orgId) {
          const fp = path.join(this.dir, r.id);
          try { fs.unlinkSync(fp); } catch {}
        } else keep.push(r);
      }
      this.rows = keep; this._save();
    }
  }

  async cleanup() {
    const cut = Date.now() - REPORT_RETENTION_MS;
    let n = 0;
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('DELETE FROM ptt_reports WHERE ts < $1', [cut]);
      n = r.rowCount || 0;
    } else {
      const keep = [];
      for (const rec of this.rows) {
        if (rec.ts < cut) {
          n++;
          try { fs.unlinkSync(path.join(this.dir, rec.id)); } catch {}
        } else keep.push(rec);
      }
      this.rows = keep; this._save();
    }
    return { removed: n };
  }
}

module.exports = {
  Reports,
  REPORT_TEXT_MAX, REPORT_SHOT_MAX, REPORT_RETENTION_MS,
  REPORT_RATE_USER, REPORT_RATE_IP
};
