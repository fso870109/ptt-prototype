// 金流佔位介面。本原型不接綠界、Stripe 或其他需要商店帳號的真實付款服務。
'use strict';

function checkoutPlaceholder({ org, planId, period, plans }) {
  const p = (plans && plans[planId]) || (plans && plans.free) || { id: planId || 'free', priceMonthly: 0, priceYearly: 0, currency: 'TWD', note: '範例佔位金額' };
  const yearly = period === 'yearly';
  return {
    ok: false,
    error: 'not_connected',
    example: true,
    message: '尚未接上真實金流（綠界／Stripe 等需要你自己的商店帳號，本原型刻意不接入）。請由平台管理員在「平台後台」手動標記已付款。若要自行串接，請實作 createCheckout / handleWebhook 並取代此佔位回應。',
    provider: null,
    orgId: org ? org.id : null,
    orgCode: org ? org.code : null,
    plan: p.id,
    period: yearly ? 'yearly' : 'monthly',
    amount: yearly ? p.priceYearly : p.priceMonthly,
    currency: p.currency || 'TWD',
    note: p.note || '範例佔位金額，非正式報價'
  };
}

module.exports = { checkoutPlaceholder };
