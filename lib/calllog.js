'use strict';
const fs = require('fs');
const path = require('path');

const CALLLOG_RETENTION_MS = 90 * 864e5;

class CallLog {
  constructor(store) { this.store = store; }
  get kind() { return this.store.kind; }

  async init() {
    if (this.kind === 'postgres') {
      await this.store.pool.query(`
        CREATE TABLE IF NOT EXISTS ptt_call_logs (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          conv TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          channel_name TEXT,
          peer_id TEXT,
          peer_name TEXT,
          from_id TEXT,
          from_name TEXT,
          started_at BIGINT NOT NULL,
          dur_ms INT NOT NULL,
          preempted BOOLEAN NOT NULL DEFAULT FALSE,
          ts BIGINT NOT NULL
        )`);
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_call_logs_org_ts ON ptt_call_logs (org_id, ts DESC)');
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_call_logs_from_ts ON ptt_call_logs (from_id, ts DESC)');
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_call_logs_conv_ts ON ptt_call_logs (conv, ts DESC)');
    } else {
      this.file = path.join(this.store.dataDir, 'call-logs.json');
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

  _pub(r) {
    return {
      id: r.id,
      orgId: r.org_id || r.orgId || null,
      conv: r.conv,
      kind: r.kind,
      channelId: r.channel_id || r.channelId || null,
      channelName: r.channel_name || r.channelName || '',
      peerId: r.peer_id || r.peerId || null,
      peerName: r.peer_name || r.peerName || '',
      from: r.from_id || r.from || r.fromId,
      fromName: r.from_name || r.fromName || '',
      startedAt: +(r.started_at || r.startedAt),
      durMs: +(r.dur_ms || r.durMs || 0),
      preempted: !!(r.preempted),
      ts: +(r.ts)
    };
  }

  async add(row) {
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        `INSERT INTO ptt_call_logs (id, org_id, conv, kind, channel_id, channel_name, peer_id, peer_name, from_id, from_name, started_at, dur_ms, preempted, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [row.id, row.orgId || null, row.conv, row.kind, row.channelId || null, row.channelName || '',
          row.peerId || null, row.peerName || '', row.from, row.fromName || '',
          row.startedAt, row.durMs, !!row.preempted, row.ts]
      );
    } else {
      this.rows.push({
        ...row, org_id: row.orgId, channel_id: row.channelId, channel_name: row.channelName,
        peer_id: row.peerId, peer_name: row.peerName, from_id: row.from, from_name: row.fromName,
        started_at: row.startedAt, dur_ms: row.durMs
      });
      if (this.rows.length > 50000) this.rows = this.rows.slice(-40000);
      this._save();
    }
    return this._pub(row);
  }

  async list({ orgId, userId, conv, since, limit = 200 } = {}) {
    const lim = Math.max(1, Math.min(1000, +limit || 200));
    if (this.kind === 'postgres') {
      const cond = []; const args = [];
      if (orgId) { args.push(orgId); cond.push('org_id = $' + args.length); }
      if (userId) { args.push(userId); cond.push('(from_id = $' + args.length + ' OR peer_id = $' + args.length + ')'); }
      if (conv) { args.push(conv); cond.push('conv = $' + args.length); }
      if (since) { args.push(+since); cond.push('ts >= $' + args.length); }
      args.push(lim);
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const r = await this.store.pool.query(`SELECT * FROM ptt_call_logs ${where} ORDER BY ts DESC LIMIT $${args.length}`, args);
      return r.rows.map((x) => this._pub(x));
    }
    return this.rows
      .filter((r) => {
        if (orgId && r.orgId !== orgId && r.org_id !== orgId) return false;
        if (userId && r.from !== userId && r.from_id !== userId && r.peerId !== userId && r.peer_id !== userId) return false;
        if (conv && r.conv !== conv) return false;
        if (since && r.ts < since) return false;
        return true;
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, lim)
      .map((r) => this._pub(r));
  }

  async anonymizeUser(userId) {
    if (this.kind === 'postgres') {
      await this.store.pool.query("UPDATE ptt_call_logs SET from_name='已刪除的使用者' WHERE from_id=$1", [userId]);
      await this.store.pool.query("UPDATE ptt_call_logs SET peer_name='已刪除的使用者' WHERE peer_id=$1", [userId]);
    } else {
      for (const r of this.rows) {
        if (r.from === userId || r.from_id === userId) r.fromName = r.from_name = '已刪除的使用者';
        if (r.peerId === userId || r.peer_id === userId) r.peerName = r.peer_name = '已刪除的使用者';
      }
      this._save();
    }
  }

  async deleteByOrg(orgId) {
    if (this.kind === 'postgres') await this.store.pool.query('DELETE FROM ptt_call_logs WHERE org_id=$1', [orgId]);
    else { this.rows = this.rows.filter((r) => r.orgId !== orgId && r.org_id !== orgId); this._save(); }
  }

  async cleanup() {
    const cut = Date.now() - CALLLOG_RETENTION_MS;
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('DELETE FROM ptt_call_logs WHERE ts < $1', [cut]);
      return { removed: r.rowCount || 0 };
    }
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.ts >= cut);
    this._save();
    return { removed: before - this.rows.length };
  }

  toCsv(rows) {
    const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const head = ['id', 'kind', 'channelName', 'peerName', 'fromName', 'startedAt', 'durMs', 'preempted'];
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push([r.id, r.kind, r.channelName, r.peerName, r.fromName, new Date(r.startedAt).toISOString(), r.durMs, r.preempted ? '1' : '0'].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { CallLog, CALLLOG_RETENTION_MS };
