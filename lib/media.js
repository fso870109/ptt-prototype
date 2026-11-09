// 文字與照片儲存（不存音訊）。有 Postgres 時用獨立資料表；本機 JSON 模式用 data/chat.json + data/photos/。
'use strict';
const fs = require('fs');
const path = require('path');

const PHOTO_MAX_BYTES = 220 * 1024;          // 略大於「約 200KB」以容許編碼誤差
const PHOTO_RETENTION_MS = 7 * 864e5;        // 7 天
const PHOTO_QUOTA_BYTES = 300 * 1024 * 1024; // 300 MB（免費 Postgres 總容量 1GB）
const TEXT_MAX = 2000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/webp', 'image/png']);

function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

class Media {
  constructor(store) { this.store = store; }
  get kind() { return this.store.kind; }

  async init() {
    if (this.kind === 'postgres') {
      await this.store.pool.query(`
        CREATE TABLE IF NOT EXISTS ptt_chat (
          id TEXT PRIMARY KEY,
          conv TEXT NOT NULL,
          from_id TEXT NOT NULL,
          from_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          body TEXT,
          photo_id TEXT,
          mime TEXT,
          ts BIGINT NOT NULL
        )`);
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_chat_conv_ts ON ptt_chat (conv, ts)');
      await this.store.pool.query(`
        CREATE TABLE IF NOT EXISTS ptt_photos (
          id TEXT PRIMARY KEY,
          conv TEXT NOT NULL,
          mime TEXT NOT NULL,
          bytes BYTEA NOT NULL,
          nbytes INT NOT NULL,
          ts BIGINT NOT NULL
        )`);
      await this.store.pool.query('CREATE INDEX IF NOT EXISTS ptt_photos_ts ON ptt_photos (ts)');
    } else {
      this.dir = path.join(this.store.dataDir, 'photos');
      this.chatFile = path.join(this.store.dataDir, 'chat.json');
      fs.mkdirSync(this.dir, { recursive: true });
      try { this.chat = JSON.parse(fs.readFileSync(this.chatFile, 'utf8')); } catch { this.chat = []; }
      if (!Array.isArray(this.chat)) this.chat = [];
    }
  }

  _saveChatFile() {
    if (this.kind === 'postgres') return;
    const tmp = this.chatFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.chat));
    fs.renameSync(tmp, this.chatFile);
  }

  _rowToMsg(r) {
    return { id: r.id, conv: r.conv, from: r.from_id, fromName: r.from_name, kind: r.kind, text: r.body || undefined, photoId: r.photo_id || undefined, mime: r.mime || undefined, ts: +r.ts };
  }

  async addMessage(msg) {
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        'INSERT INTO ptt_chat (id, conv, from_id, from_name, kind, body, photo_id, mime, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [msg.id, msg.conv, msg.from, msg.fromName, msg.kind, msg.text || null, msg.photoId || null, msg.mime || null, msg.ts]
      );
    } else {
      this.chat.push(msg);
      if (this.chat.length > 20000) this.chat = this.chat.slice(-15000);
      this._saveChatFile();
    }
    return msg;
  }

  async listMessages(conv, { since = 0, limit = 100 } = {}) {
    limit = Math.min(200, Math.max(1, +limit || 100));
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query(
        'SELECT * FROM ptt_chat WHERE conv = $1 AND ts > $2 ORDER BY ts ASC LIMIT $3',
        [conv, since, limit]
      );
      return r.rows.map(row => this._rowToMsg(row));
    }
    return this.chat.filter(m => m.conv === conv && m.ts > since).slice(-limit);
  }

  async addPhoto({ id, conv, mime, buf, ts }) {
    if (this.kind === 'postgres') {
      await this.store.pool.query(
        'INSERT INTO ptt_photos (id, conv, mime, bytes, nbytes, ts) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, conv, mime, buf, buf.length, ts]
      );
    } else {
      fs.writeFileSync(path.join(this.dir, id), buf);
      // 中繼資料跟訊息走；檔名即 id
    }
  }

  async getPhoto(id) {
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query('SELECT conv, mime, bytes, nbytes, ts FROM ptt_photos WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      return { id, conv: row.conv, mime: row.mime, buf: row.bytes, size: row.nbytes, ts: +row.ts };
    }
    const file = path.join(this.dir, id);
    if (!fs.existsSync(file)) return null;
    const msg = this.chat.find(m => m.photoId === id);
    if (!msg) return null;
    const buf = fs.readFileSync(file);
    return { id, conv: msg.conv, mime: msg.mime || 'image/jpeg', buf, size: buf.length, ts: msg.ts };
  }

  async deleteConvs(convs) {
    if (!convs || !convs.length) return;
    const set = new Set(convs);
    if (this.kind === 'postgres') {
      await this.store.pool.query('DELETE FROM ptt_photos WHERE conv = ANY($1)', [convs]);
      await this.store.pool.query('DELETE FROM ptt_chat WHERE conv = ANY($1)', [convs]);
    } else {
      const gone = this.chat.filter(m => set.has(m.conv) && m.photoId);
      for (const m of gone) { try { fs.unlinkSync(path.join(this.dir, m.photoId)); } catch {} }
      this.chat = this.chat.filter(m => !set.has(m.conv));
      this._saveChatFile();
    }
  }
  async convsForUser(userId) {
    const isMine = (c) => c.startsWith('dm:') && c.slice(3).split(':').includes(userId);
    if (this.kind === 'postgres') {
      const r = await this.store.pool.query("SELECT DISTINCT conv FROM ptt_chat WHERE conv LIKE 'dm:%'");
      return r.rows.map(x => x.conv).filter(isMine);
    }
    return [...new Set(this.chat.map(m => m.conv).filter(isMine))];
  }

  async stats() {
    if (this.kind === 'postgres') {
      const p = await this.store.pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(nbytes),0)::bigint AS bytes FROM ptt_photos');
      const c = await this.store.pool.query('SELECT COUNT(*)::int AS n FROM ptt_chat');
      return { photos: p.rows[0].n, photoBytes: Number(p.rows[0].bytes), messages: c.rows[0].n };
    }
    let photoBytes = 0, photos = 0;
    if (fs.existsSync(this.dir)) {
      for (const f of fs.readdirSync(this.dir)) {
        try { photoBytes += fs.statSync(path.join(this.dir, f)).size; photos++; } catch {}
      }
    }
    return { photos, photoBytes, messages: this.chat.length };
  }

  async cleanup() {
    const cutoff = Date.now() - PHOTO_RETENTION_MS;
    let expired = 0, overflow = 0;
    if (this.kind === 'postgres') {
      const old = await this.store.pool.query('SELECT id FROM ptt_photos WHERE ts < $1', [cutoff]);
      if (old.rows.length) {
        const ids = old.rows.map(r => r.id);
        await this.store.pool.query('DELETE FROM ptt_photos WHERE id = ANY($1)', [ids]);
        await this.store.pool.query('DELETE FROM ptt_chat WHERE photo_id = ANY($1)', [ids]);
        expired = ids.length;
      }
      // 容量上限：由舊到新刪
      let st = await this.stats();
      while (st.photoBytes > PHOTO_QUOTA_BYTES && st.photos > 0) {
        const r = await this.store.pool.query('SELECT id FROM ptt_photos ORDER BY ts ASC LIMIT 20');
        if (!r.rows.length) break;
        const ids = r.rows.map(x => x.id);
        await this.store.pool.query('DELETE FROM ptt_photos WHERE id = ANY($1)', [ids]);
        await this.store.pool.query('DELETE FROM ptt_chat WHERE photo_id = ANY($1)', [ids]);
        overflow += ids.length;
        st = await this.stats();
      }
    } else {
      const keep = [];
      for (const m of this.chat) {
        if (m.kind === 'photo' && m.ts < cutoff && m.photoId) {
          try { fs.unlinkSync(path.join(this.dir, m.photoId)); } catch {}
          expired++;
        } else keep.push(m);
      }
      this.chat = keep;
      // 容量
      const photos = this.chat.filter(m => m.kind === 'photo' && m.photoId).sort((a, b) => a.ts - b.ts);
      let total = 0;
      const sizes = new Map();
      for (const m of photos) {
        try { const sz = fs.statSync(path.join(this.dir, m.photoId)).size; sizes.set(m.id, sz); total += sz; } catch { sizes.set(m.id, 0); }
      }
      const drop = new Set();
      for (const m of photos) {
        if (total <= PHOTO_QUOTA_BYTES) break;
        try { fs.unlinkSync(path.join(this.dir, m.photoId)); } catch {}
        total -= sizes.get(m.id) || 0;
        drop.add(m.id); overflow++;
      }
      if (drop.size) this.chat = this.chat.filter(m => !drop.has(m.id));
      this._saveChatFile();
    }
    return { expired, overflow, ...(await this.stats()) };
  }
}

module.exports = { Media, PHOTO_MAX_BYTES, PHOTO_RETENTION_MS, PHOTO_QUOTA_BYTES, TEXT_MAX, ALLOWED_MIME, sniffMime };
