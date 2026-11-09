// 多租戶：公司（organization）、方案預設值、既有資料遷移。
'use strict';

const DEFAULT_ORG_ID = 'odefault';
const DEFAULT_ORG_CODE = 'DEMO';
const PLATFORM_CODE = String(process.env.PLATFORM_ORG_CODE || 'PLATFORM').trim().toUpperCase();

function defaultPlans() {
  return {
    free: { id: 'free', label: '免費', seats: 10, priceMonthly: 0, priceYearly: 0, currency: 'TWD', example: true, note: '範例佔位金額，未接真實金流' },
    standard: { id: 'standard', label: '標準', seats: 50, priceMonthly: 990, priceYearly: 9900, currency: 'TWD', example: true, note: '範例佔位金額（新台幣），非正式報價' },
    pro: { id: 'pro', label: '專業', seats: 200, priceMonthly: 2990, priceYearly: 29900, currency: 'TWD', example: true, note: '範例佔位金額（新台幣），非正式報價' }
  };
}

function validOrgCode(s) { return /^[A-Z0-9]{2,16}$/.test(String(s || '').trim().toUpperCase()); }
function normCode(s) { return String(s || '').trim().toUpperCase(); }
function lobbyId(orgId) { return orgId === DEFAULT_ORG_ID ? 'lobby' : 'lobby-' + orgId; }
function isLobbyChannel(c) { return !!c && (c.id === 'lobby' || String(c.id).startsWith('lobby-') || c.system === 'lobby'); }

function migrate(doc, now) {
  now = now || Date.now();
  const defaults = defaultPlans();
  doc.plans = (doc.plans && doc.plans.free) ? doc.plans : defaults;
  for (const [k, v] of Object.entries(defaults)) {
    if (!doc.plans[k]) doc.plans[k] = { ...v };
    doc.plans[k].example = true;
    doc.plans[k].id = k;
  }
  doc.orgs = Array.isArray(doc.orgs) ? doc.orgs : [];
  if (!doc.orgs.some(o => o.id === DEFAULT_ORG_ID)) {
    doc.orgs.unshift({
      id: DEFAULT_ORG_ID,
      code: DEFAULT_ORG_CODE,
      name: '預設公司',
      disabled: false,
      plan: 'free',
      seatLimit: doc.plans.free.seats,
      expiresAt: null,
      settings: { saveCaptions: false },
      billing: { status: 'active', lastMarkedPaidAt: null, lastMarkedPaidBy: null, note: '由既有資料遷移；金額為範例佔位值', example: true },
      createdAt: now
    });
  }
  const def = doc.orgs.find(o => o.id === DEFAULT_ORG_ID);
  for (const u of doc.users || []) {
    if (u.role === 'admin') { if (u.orgId === undefined) u.orgId = null; }
    else if (!u.orgId) u.orgId = def.id;
  }
  for (const c of doc.channels || []) {
    if (!c.orgId) c.orgId = def.id;
    if (c.id === 'lobby' || String(c.id).startsWith('lobby-')) c.system = 'lobby';
  }
  for (const o of doc.orgs) {
    o.code = normCode(o.code);
    o.settings = o.settings || { saveCaptions: false };
    if (o.settings.saveCaptions === undefined) o.settings.saveCaptions = false;
    o.billing = Object.assign({ status: 'active', example: true }, o.billing || {});
    o.billing.example = true;
    if (!o.seatLimit) o.seatLimit = (doc.plans[o.plan] || doc.plans.free).seats;
    if (o.disabled === undefined) o.disabled = false;
    if (o.expiresAt === undefined) o.expiresAt = null;
  }
  for (const o of doc.orgs) {
    const id = lobbyId(o.id);
    if (!doc.channels.some(c => c.id === id)) {
      doc.channels.unshift({ id, name: '大廳', open: true, members: {}, orgId: o.id, system: 'lobby', createdAt: now });
    }
  }
  return doc;
}

function publicOrg(o, extra) {
  if (!o) return null;
  return Object.assign({
    id: o.id,
    code: o.code,
    name: o.name,
    plan: o.plan,
    seatLimit: o.seatLimit,
    expiresAt: o.expiresAt || null,
    disabled: !!o.disabled,
    settings: { saveCaptions: !!(o.settings && o.settings.saveCaptions) }
  }, extra || {});
}

function orgStatus(o, now) {
  now = now || Date.now();
  if (!o) return 'missing';
  if (o.disabled) return 'disabled';
  if (o.expiresAt && o.expiresAt < now) return 'expired';
  return 'active';
}

module.exports = {
  DEFAULT_ORG_ID, DEFAULT_ORG_CODE, PLATFORM_CODE,
  defaultPlans, validOrgCode, normCode, lobbyId, isLobbyChannel, migrate, publicOrg, orgStatus
};
