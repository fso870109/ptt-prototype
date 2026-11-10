'use strict';
const { sanitizeMeta, sanitizeLog } = require('./sanitize');
const { REPORT_TEXT_MAX, REPORT_SHOT_MAX } = require('./reports');
const { sniffMime, ALLOWED_MIME } = require('./media');
const Inv = require('./invites');

module.exports = function createExtra(X) {
  const {
    json, readBody, cors, uid, now, store, reports, callLog, media,
    D, userById, userByName, orgById, orgByCode, chById, orgIdOf,
    publicUser, nameOf, roleIn, canAccess, isOrgManager, isPlatform, isDispatcher,
    seatCount, seatLimit, orgUsable, validUsername, cleanName, A, Orgs,
    revokeSessions, kick, locations, online, broadcastOnline, pushChannelsAll,
    upsertPttPush, removePttPush, inviteAbsUrl, qrSvg
  } = X;

  function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  }

  async function findInvite(code) {
    return (D().invites || []).find((i) => i.code === code);
  }

  function inviteView(inv, req) {
    const org = orgById(inv.orgId);
    const ch = chById(inv.channelId);
    return Inv.publicInvite(inv, {
      orgCode: org ? org.code : '',
      orgName: org ? org.name : '',
      channelName: ch ? ch.name : '',
      url: inviteAbsUrl(req, inv.code)
    });
  }

  async function publicApi(req, res, p, method) {
    const invGet = p.match(/^\/api\/invites\/([A-Za-z0-9_-]{8,24})$/);
    if (invGet && method === 'GET') {
      const inv = await findInvite(invGet[1]);
      const st = Inv.inviteStatus(inv, now());
      if (st === 'not_found') return json(res, 404, { error: 'not_found', message: '邀請不存在或已失效' });
      if (st !== 'ok') return json(res, 410, { error: st, message: st === 'revoked' ? '此邀請已撤銷' : st === 'expired' ? '此邀請已過期' : '此邀請已達使用次數上限', invite: inviteView(inv, req) });
      return json(res, 200, { invite: inviteView(inv, req), status: 'ok' });
    }
    const invQr = p.match(/^\/api\/invites\/([A-Za-z0-9_-]{8,24})\/qr$/);
    if (invQr && method === 'GET') {
      const inv = await findInvite(invQr[1]);
      if (Inv.inviteStatus(inv, now()) === 'not_found') return json(res, 404, { error: 'not_found' });
      const svg = await qrSvg(inviteAbsUrl(req, inv.code));
      cors(res);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(svg);
    }
    const invReg = p.match(/^\/api\/invites\/([A-Za-z0-9_-]{8,24})\/register$/);
    if (invReg && method === 'POST') {
      const inv = await findInvite(invReg[1]);
      const st = Inv.inviteStatus(inv, now());
      if (st !== 'ok') return json(res, 410, { error: st || 'not_found', message: '邀請無效' });
      if (inv.kind !== 'register') return json(res, 400, { error: 'not_register', message: '此邀請不能用來註冊新帳號' });
      const b = await readBody(req);
      if (!b) return json(res, 400, { error: 'bad_request' });
      const org = orgById(inv.orgId);
      if (!org || !orgUsable(org)) return json(res, 403, { error: 'org_inactive', message: '此公司目前無法加入' });
      const username = String(b.username || '').trim();
      if (!validUsername(username)) return json(res, 400, { error: 'bad_username', message: '帳號需 3–32 個英數字或 _ . -' });
      if (userByName(username, org.id)) return json(res, 409, { error: 'exists', message: '帳號已存在' });
      if (seatCount(org.id) >= seatLimit(org)) return json(res, 403, { error: 'seat_limit', message: '已達此公司方案的人數上限' });
      const password = String(b.password || '');
      if (password.length < 8) return json(res, 400, { error: 'weak_password', message: '密碼至少 8 個字元' });
      const u = {
        id: 'u' + uid(6), username,
        displayName: cleanName(b.displayName) || username,
        role: 'user', orgId: org.id, passHash: A.hashPassword(password), createdAt: now()
      };
      D().users.push(u);
      const ch = chById(inv.channelId);
      if (ch && !ch.open) ch.members[u.id] = 'member';
      inv.uses = (inv.uses || 0) + 1;
      await store.save();
      return json(res, 201, { user: publicUser(u), org: { id: org.id, code: org.code, name: org.name }, channelId: inv.channelId });
    }
    return false;
  }

  async function userApi(req, res, p, method, me, url) {
    if (p === '/api/reports' && method === 'POST') {
      const b = await readBody(req, 500000);
      if (!b) return json(res, 400, { error: 'bad_request', message: '請求太大或格式不對' });
      const text = String(b.text || '').replace(/\u0000/g, '').trim();
      if (!text) return json(res, 400, { error: 'empty', message: '請填寫問題說明' });
      if (text.length > REPORT_TEXT_MAX) return json(res, 400, { error: 'too_long', message: '說明最多 ' + REPORT_TEXT_MAX + ' 字' });
      let shot = null, mime = null;
      if (b.screenshot) {
        try { shot = Buffer.from(String(b.screenshot), 'base64'); } catch { return json(res, 400, { error: 'bad_data' }); }
        if (shot.length > REPORT_SHOT_MAX) return json(res, 413, { error: 'too_large', message: '截圖請壓縮到約 300KB 以內' });
        mime = sniffMime(shot);
        if (!mime || !ALLOWED_MIME.has(mime)) return json(res, 400, { error: 'bad_type', message: '截圖只接受 JPEG、WebP 或 PNG' });
      }
      const limited = reports.rateCheck(me.id, clientIp(req));
      if (limited) return json(res, 429, { error: 'too_many', message: '回報過於頻繁，請一小時後再試' });
      let rec;
      try {
        rec = await reports.add({
          id: 'r' + uid(8),
          orgId: orgIdOf(me),
          userId: me.id,
          username: me.username,
          displayName: me.displayName,
          text,
          meta: Object.assign({ platform: 'web' }, b.meta || {}),
          log: b.log,
          screenshot: shot,
          screenshotMime: mime,
          ts: now()
        });
      } catch (e) {
        console.error('[reports] add', e && e.message);
        return json(res, 500, { error: 'save_failed', message: '無法儲存回報' });
      }
      return json(res, 201, { report: rec });
    }

    if (p === '/api/me/delete' && method === 'POST') {
      const b = await readBody(req) || {};
      const raw = userById(me.id);
      if (!raw || !A.verifyPassword(b.password || '', raw.passHash)) return json(res, 400, { error: 'wrong_password', message: '密碼錯誤' });
      if (raw.role === 'admin') return json(res, 400, { error: 'platform_admin', message: '平台管理員請聯絡營運者處理帳號' });
      if (raw.role === 'org_admin') {
        const others = D().users.filter((u) => u.orgId === raw.orgId && u.role === 'org_admin' && !u.disabled && u.id !== raw.id);
        if (!others.length) return json(res, 400, { error: 'last_admin', message: '你是此公司最後一位管理員，請先指定其他管理員，或聯絡平台刪除公司' });
      }
      await media.anonymizeFrom(raw.id).catch((e) => console.error('[media] anon', e.message));
      await reports.anonymizeUser(raw.id).catch((e) => console.error('[reports] anon', e.message));
      await callLog.anonymizeUser(raw.id).catch((e) => console.error('[calllog] anon', e.message));
      for (const c of D().channels) delete c.members[raw.id];
      D().invites = (D().invites || []).filter(() => true);
      D().pttPush = (D().pttPush || []).filter((x) => x.userId !== raw.id);
      revokeSessions(raw.id);
      locations.delete(raw.id);
      kick(raw.id);
      online.delete(raw.id);
      D().users = D().users.filter((u) => u.id !== raw.id);
      await store.save();
      broadcastOnline();
      pushChannelsAll();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/me/ptt-push' && method === 'POST') {
      const b = await readBody(req) || {};
      if (b.channelId === null || b.token === '') {
        removePttPush(me.id, b.channelId || null);
        await store.save();
        return json(res, 200, { ok: true, cleared: true });
      }
      if (b.platform && b.platform !== 'ios') return json(res, 400, { error: 'bad_platform' });
      const token = String(b.token || '').trim();
      if (!token || token.length < 16) return json(res, 400, { error: 'bad_token', message: '缺少有效的 PTT token' });
      upsertPttPush({
        userId: me.id,
        channelId: b.channelId ? String(b.channelId) : null,
        token,
        bundleId: String(b.bundleId || process.env.APNS_BUNDLE_ID || 'app.ptt.mobile').slice(0, 80),
        channelUUID: String(b.channelUUID || '').slice(0, 80),
        kind: 'voip-ptt',
        updatedAt: now()
      });
      await store.save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/me/ptt-push' && method === 'DELETE') {
      removePttPush(me.id, null);
      await store.save();
      return json(res, 200, { ok: true });
    }

    if ((p === '/api/calls' || p === '/api/call-logs') && method === 'GET') {
      const since = +url.searchParams.get('since') || 0;
      const limit = +url.searchParams.get('limit') || 200;
      const conv = url.searchParams.get('conv') || '';
      const wantCsv = url.searchParams.get('format') === 'csv' || p.endsWith('.csv');
      let rows;
      if (isOrgManager(me) || isDispatcher(me)) {
        rows = await callLog.list({ orgId: orgIdOf(me), conv: conv || undefined, since, limit });
      } else {
        rows = await callLog.list({ userId: me.id, since, limit });
        if (conv) rows = rows.filter((r) => r.conv === conv);
        rows = rows.filter((r) => r.from === me.id || r.peerId === me.id || canAccess(me, r.conv));
      }
      if (wantCsv) {
        const csv = callLog.toCsv(rows);
        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="geelo-calls.csv"', 'Cache-Control': 'no-store' });
        return res.end('\uFEFF' + csv);
      }
      return json(res, 200, { calls: rows });
    }

    if (p === '/api/invites' && method === 'GET') {
      const list = (D().invites || []).filter((i) => {
        if (i.orgId !== orgIdOf(me)) return false;
        if (isOrgManager(me)) return true;
        const ch = chById(i.channelId);
        return !!(ch && roleIn(me, ch) === 'supervisor');
      }).map((i) => inviteView(i, req));
      return json(res, 200, { invites: list });
    }
    if (p === '/api/invites' && method === 'POST') {
      const b = await readBody(req) || {};
      const ch = chById(b.channelId);
      if (!ch || ch.orgId !== orgIdOf(me)) return json(res, 404, { error: 'no_channel', message: '頻道不存在' });
      if (!isOrgManager(me) && roleIn(me, ch) !== 'supervisor') {
        return json(res, 403, { error: 'forbidden', message: '只有頻道主管或公司管理員可以產生邀請' });
      }
      const kind = b.kind === 'register' ? 'register' : 'join';
      const maxUses = b.maxUses == null || b.maxUses === '' ? 0 : Math.max(0, Math.min(10000, +b.maxUses || 0));
      let expiresAt = null;
      if (b.expiresAt) expiresAt = +b.expiresAt;
      else if (b.expiresInHours) expiresAt = now() + Math.max(1, +b.expiresInHours) * 3600e3;
      const inv = {
        id: 'i' + uid(6),
        code: Inv.newCode(),
        orgId: orgIdOf(me),
        channelId: ch.id,
        kind,
        maxUses,
        uses: 0,
        expiresAt,
        revoked: false,
        createdBy: me.id,
        createdAt: now()
      };
      D().invites = D().invites || [];
      D().invites.push(inv);
      await store.save();
      return json(res, 201, { invite: inviteView(inv, req) });
    }
    const invRev = p.match(/^\/api\/invites\/([A-Za-z0-9_-]{8,24})\/revoke$/);
    if (invRev && method === 'POST') {
      const inv = (D().invites || []).find((i) => i.id === invRev[1] || i.code === invRev[1]);
      if (!inv || inv.orgId !== orgIdOf(me)) return json(res, 404, { error: 'not_found' });
      const ch = chById(inv.channelId);
      if (!isOrgManager(me) && !(ch && roleIn(me, ch) === 'supervisor')) {
        return json(res, 403, { error: 'forbidden', message: '沒有權限撤銷此邀請' });
      }
      inv.revoked = true;
      await store.save();
      return json(res, 200, { invite: inviteView(inv, req) });
    }

    const acc = p.match(/^\/api\/invites\/([A-Za-z0-9_-]{8,24})\/accept$/);
    if (acc && method === 'POST') {
      const inv = await findInvite(acc[1]);
      const st = Inv.inviteStatus(inv, now());
      if (st !== 'ok') return json(res, 410, { error: st || 'not_found', message: '邀請無效' });
      if (orgIdOf(me) !== inv.orgId) return json(res, 403, { error: 'wrong_org', message: '此邀請屬於另一家公司' });
      const ch = chById(inv.channelId);
      if (!ch) return json(res, 404, { error: 'no_channel', message: '頻道不存在' });
      if (!roleIn(me, ch)) ch.members[me.id] = 'member';
      inv.uses = (inv.uses || 0) + 1;
      await store.save();
      return json(res, 200, { ok: true, channel: { id: ch.id, name: ch.name } });
    }
    return false;
  }

  async function platformExtra(req, res, seg, method, me, b) {
    if (seg[0] !== 'reports') return false;
    if (!seg[1] && method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const rows = await reports.list({
        orgId: url.searchParams.get('orgId') || undefined,
        status: url.searchParams.get('status') || undefined,
        since: +url.searchParams.get('since') || 0,
        limit: +url.searchParams.get('limit') || 200
      });
      const orgs = Object.fromEntries((D().orgs || []).map((o) => [o.id, o.code]));
      return json(res, 200, { reports: rows.map((r) => Object.assign({}, r, { orgCode: orgs[r.orgId] || '' })) });
    }
    if (seg[1] === 'export' && method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const rows = await reports.list({ since: +url.searchParams.get('since') || 0, limit: 1000 });
      return json(res, 200, { reports: rows, exportedAt: now() });
    }
    const rec = await reports.get(seg[1]);
    if (!rec) return json(res, 404, { error: 'not_found' });
    if (seg[2] === 'screenshot' && method === 'GET') {
      const shot = await reports.getScreenshot(rec.id);
      if (!shot) return json(res, 404, { error: 'not_found' });
      cors(res);
      res.writeHead(200, { 'Content-Type': shot.mime, 'Content-Length': shot.buf.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(shot.buf);
    }
    if (!seg[2] && method === 'GET') return json(res, 200, { report: rec });
    if (!seg[2] && method === 'PATCH') {
      b = b || {};
      const upd = await reports.update(rec.id, { status: b.status, note: b.note, handledBy: me.id, handledByName: me.displayName });
      return json(res, 200, { report: upd });
    }
    if (!seg[2] && method === 'DELETE') {
      await reports.remove(rec.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function adminExtra(req, res, seg, method, me, scopeOrg, b) {
    if (seg[0] === 'reports') {
      if (!seg[1] && method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const rows = await reports.list({
          orgId: scopeOrg.id,
          status: url.searchParams.get('status') || undefined,
          since: +url.searchParams.get('since') || 0,
          limit: +url.searchParams.get('limit') || 200
        });
        return json(res, 200, { reports: rows });
      }
      const rec = await reports.get(seg[1]);
      if (!rec || rec.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' });
      if (seg[2] === 'screenshot' && method === 'GET') {
        const shot = await reports.getScreenshot(rec.id);
        if (!shot) return json(res, 404, { error: 'not_found' });
        cors(res);
        res.writeHead(200, { 'Content-Type': shot.mime, 'Content-Length': shot.buf.length, 'Cache-Control': 'private, max-age=3600' });
        return res.end(shot.buf);
      }
      if (!seg[2] && method === 'GET') return json(res, 200, { report: rec });
      if (!seg[2] && method === 'PATCH') {
        b = b || {};
        const upd = await reports.update(rec.id, { status: b.status, note: b.note, handledBy: me.id, handledByName: me.displayName });
        return json(res, 200, { report: upd });
      }
      if (!seg[2] && method === 'DELETE') {
        await reports.remove(rec.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (seg[0] === 'messages' && seg[1] && method === 'DELETE') {
      const msg = await media.getMessage(seg[1]);
      if (!msg) return json(res, 404, { error: 'not_found' });
      const ch = chById(msg.conv);
      const lobbyId = 'lobby' + (scopeOrg.id === 'odefault' ? '' : '-' + scopeOrg.id);
      const allowed = (ch && ch.orgId === scopeOrg.id) || msg.conv === lobbyId || msg.conv === 'lobby-' + scopeOrg.id
        || (msg.conv === 'lobby' && (scopeOrg.code === 'DEMO' || scopeOrg.id === 'odefault'));
      if (!allowed) return json(res, 404, { error: 'not_found' });
      await media.removeMessage(msg.id);
      return json(res, 200, { ok: true });
    }
    if (seg[0] === 'calls' || seg[0] === 'call-logs') {
      if (seg[1] && method === 'DELETE') {
        const gone = await callLog.remove(seg[1], { orgId: scopeOrg.id });
        if (!gone) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true });
      }
      if (method !== 'GET') return json(res, 405, { error: 'method' });
      const url = new URL(req.url, 'http://x');
      const rows = await callLog.list({
        orgId: scopeOrg.id,
        conv: url.searchParams.get('conv') || undefined,
        since: +url.searchParams.get('since') || 0,
        limit: +url.searchParams.get('limit') || 500
      });
      if (url.searchParams.get('format') === 'csv') {
        const csv = callLog.toCsv(rows);
        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="geelo-calls.csv"', 'Cache-Control': 'no-store' });
        return res.end('\uFEFF' + csv);
      }
      return json(res, 200, { calls: rows });
    }
    if (seg[0] === 'invites') {
      D().invites = D().invites || [];
      if (!seg[1] && method === 'GET') {
        const list = D().invites.filter((i) => i.orgId === scopeOrg.id).map((i) => inviteView(i, req));
        return json(res, 200, { invites: list });
      }
      if (!seg[1] && method === 'POST') {
        b = b || {};
        const ch = chById(b.channelId);
        if (!ch || ch.orgId !== scopeOrg.id) return json(res, 404, { error: 'no_channel', message: '頻道不存在' });
        const kind = b.kind === 'register' ? 'register' : 'join';
        const maxUses = b.maxUses == null || b.maxUses === '' ? 0 : Math.max(0, Math.min(10000, +b.maxUses || 0));
        let expiresAt = null;
        if (b.expiresAt) expiresAt = +b.expiresAt;
        else if (b.expiresInHours) expiresAt = now() + Math.max(1, +b.expiresInHours) * 3600e3;
        const inv = {
          id: 'i' + uid(6),
          code: Inv.newCode(),
          orgId: scopeOrg.id,
          channelId: ch.id,
          kind,
          maxUses,
          uses: 0,
          expiresAt,
          revoked: false,
          createdBy: me.id,
          createdAt: now()
        };
        D().invites.push(inv);
        await store.save();
        return json(res, 201, { invite: inviteView(inv, req) });
      }
      const inv = D().invites.find((i) => i.id === seg[1] || i.code === seg[1]);
      if (!inv || inv.orgId !== scopeOrg.id) return json(res, 404, { error: 'not_found' });
      if (seg[2] === 'revoke' && method === 'POST') {
        inv.revoked = true; await store.save();
        return json(res, 200, { invite: inviteView(inv, req) });
      }
      if (seg[2] === 'qr' && method === 'GET') {
        const svg = await qrSvg(inviteAbsUrl(req, inv.code));
        cors(res);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (method === 'GET') return json(res, 200, { invite: inviteView(inv, req) });
      if (method === 'DELETE') {
        D().invites = D().invites.filter((i) => i.id !== inv.id);
        await store.save();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not_found' });
    }
    return false;
  }

  return { publicApi, userApi, platformExtra, adminExtra };
};
