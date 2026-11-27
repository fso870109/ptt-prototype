// 一次性搬資料庫：把 src（舊 DATABASE_URL）的三張表完整複製到 dst（NEXT_DATABASE_URL）。
// dst 已有 ptt_state 就跳過（代表搬過了），所以重開機不會重複搬、也不會覆蓋新資料。
'use strict';
const { Pool } = require('pg');

function sslFor(url) {
  const need = /sslmode=require/.test(url) || /\.render\.com|neon\.tech/.test(url) || process.env.PGSSL === '1';
  return need ? { rejectUnauthorized: false } : undefined;
}
function mkPool(url) {
  // 自己處理 SSL，避免連線字串裡的 sslmode 覆蓋設定
  const cs = url.replace(/([?&])(sslmode|channel_binding)=[^&]*&?/g, '$1').replace(/[?&]$/, '');
  return new Pool({ connectionString: cs, ssl: sslFor(url), max: 2 });
}

const DDL = [
  'CREATE TABLE IF NOT EXISTS ptt_state (id INT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  `CREATE TABLE IF NOT EXISTS ptt_call_logs (id TEXT PRIMARY KEY, org_id TEXT, conv TEXT NOT NULL, kind TEXT NOT NULL, channel_id TEXT, channel_name TEXT,
    peer_id TEXT, peer_name TEXT, from_id TEXT, from_name TEXT, started_at BIGINT NOT NULL, dur_ms INT NOT NULL, preempted BOOLEAN NOT NULL DEFAULT FALSE, ts BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ptt_reports (id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, username TEXT, display_name TEXT, body TEXT NOT NULL, meta JSONB, log JSONB,
    screenshot BYTEA, screenshot_mime TEXT, status TEXT NOT NULL DEFAULT 'open', note TEXT, handled_at BIGINT, handled_by TEXT, handled_by_name TEXT, ts BIGINT NOT NULL)`,
];
const TABLES = ['ptt_call_logs', 'ptt_reports', 'ptt_state']; // ptt_state 最後寫，當作「搬完」的記號
const JSONB = { ptt_state: ['doc'], ptt_reports: ['meta', 'log'] };

async function migrateDb(srcUrl, dstUrl, log = console.log) {
  const src = mkPool(srcUrl), dst = mkPool(dstUrl);
  const counts = {};
  try {
    for (const q of DDL) await dst.query(q);
    const done = await dst.query('SELECT 1 FROM ptt_state WHERE id = 1');
    if (done.rows.length) { log('[dbmigrate] 目標已有資料，跳過'); return { skipped: true }; }
    const client = await dst.connect();
    try {
      await client.query('BEGIN');
      for (const t of TABLES) {
        const exists = await src.query('SELECT to_regclass($1) AS r', [t]);
        if (!exists.rows[0].r) { counts[t] = 0; continue; }
        const { rows } = await src.query(`SELECT * FROM ${t}`);
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map(c => (JSONB[t] || []).includes(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]);
          const ph = cols.map((c, i) => (JSONB[t] || []).includes(c) ? `$${i + 1}::jsonb` : `$${i + 1}`);
          await client.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${ph.join(',')}) ON CONFLICT (id) DO NOTHING`, vals);
        }
        counts[t] = rows.length;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    log('[dbmigrate] 搬移完成 ' + JSON.stringify(counts));
    return { counts };
  } finally { await src.end().catch(() => {}); await dst.end().catch(() => {}); }
}
module.exports = { migrateDb };
