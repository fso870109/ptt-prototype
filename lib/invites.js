'use strict';
const crypto = require('crypto');

function newCode() { return crypto.randomBytes(9).toString('base64url'); }

function publicInvite(inv, extras = {}) {
  if (!inv) return null;
  return {
    id: inv.id,
    code: inv.code,
    orgId: inv.orgId,
    orgCode: extras.orgCode || '',
    orgName: extras.orgName || '',
    channelId: inv.channelId,
    channelName: extras.channelName || '',
    kind: inv.kind,
    maxUses: inv.maxUses,
    uses: inv.uses || 0,
    expiresAt: inv.expiresAt,
    revoked: !!inv.revoked,
    createdAt: inv.createdAt,
    url: extras.url || ''
  };
}

function inviteStatus(inv, now) {
  if (!inv) return 'not_found';
  if (inv.revoked) return 'revoked';
  if (inv.expiresAt && inv.expiresAt < now) return 'expired';
  if (inv.maxUses && (inv.uses || 0) >= inv.maxUses) return 'exhausted';
  return 'ok';
}

module.exports = { newCode, publicInvite, inviteStatus };
