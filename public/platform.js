'use strict';
const $ = (s) => document.querySelector(s);
let token = localStorage.getItem('ptt_token') || '';
let me = null, orgs = [], plans = {};
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3500); }
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '無到期日'; }
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin('請重新登入'); throw new Error('unauthorized'); }
  if (!r.ok) { toast(j.message || ('錯誤 ' + r.status)); throw new Error(j.error || r.status); }
  return j;
}
function showLogin(msg) { $('#loginBox').classList.remove('hidden'); $('#panels').classList.add('hidden'); $('#denied').classList.add('hidden'); $('#loginErr').textContent = msg || ''; }
async function boot() {
  if (!token) return showLogin();
  let j; try { j = await api('GET', '/api/me'); } catch { return; }
  me = j.user; $('#who').textContent = `${me.displayName}（${me.username}）`;
  $('#loginBox').classList.add('hidden');
  if (me.role !== 'admin') { $('#denied').classList.remove('hidden'); return; }
  $('#panels').classList.remove('hidden');
  await refresh();
}
async function refresh() {
  const d = await api('GET', '/api/platform/orgs');
  orgs = d.orgs; plans = d.plans;
  renderPlans(); renderOrgs();
  loadReports();
}
function renderPlans() {
  $('#planBox').innerHTML = Object.values(plans).map(p => `<div class="ch-card"><strong>${esc(p.label)}</strong>（${esc(p.id)}）
    · 人數上限 ${p.seats}
    · 月費 <b>${p.priceMonthly}</b> ${esc(p.currency)}
    · 年費 <b>${p.priceYearly}</b> ${esc(p.currency)}
    <div class="muted small">${esc(p.note || '')} · 標示為範例</div></div>`).join('');
}
function renderOrgs() {
  $('#orgCards').innerHTML = orgs.map(o => `<div class="ch-card" data-id="${esc(o.id)}">
    <div class="ch-head"><strong>${esc(o.name)}</strong> <span class="tag">${esc(o.code)}</span>
      <span class="tag ${o.status === 'active' ? 'on' : 'off'}">${esc(o.status)}</span>
      ${o.disabled ? '<span class="tag off">已停用</span>' : ''}
      ${o.id === 'odefault' ? '<span class="muted small">預設公司</span>' : ''}</div>
    <p>方案 ${esc(o.plan)} · 座位 ${o.seatsUsed}/${o.seatLimit} · 到期 ${esc(fmt(o.expiresAt))}</p>
    <p class="muted small">金額為範例佔位值；標記已付款不會向任何金流請款。</p>
    <div class="ch-add">
      <select data-act="plan"><option value="free" ${o.plan==='free'?'selected':''}>免費</option><option value="standard" ${o.plan==='standard'?'selected':''}>標準</option><option value="pro" ${o.plan==='pro'?'selected':''}>專業</option></select>
      <input data-act="seats" type="number" min="1" value="${o.seatLimit}" style="width:5em" title="座位數">
      <button data-act="save">儲存方案／座位</button>
      <button data-act="paid">標記已付款（+30 天）</button>
      <button data-act="toggle" class="${o.disabled ? '' : 'danger'}">${o.disabled ? '啟用公司' : '停用公司'}</button>
      ${o.id === 'odefault' ? '' : '<button data-act="del" class="danger">刪除公司</button>'}
    </div>
  </div>`).join('') || '<p class="muted">尚未建立公司</p>';
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const org = $('#org').value.trim() || 'PLATFORM';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value, org }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#loginErr').textContent = j.message || '登入失敗'; return; }
  token = j.token; localStorage.setItem('ptt_token', token); $('#password').value = ''; boot();
});
$('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch {} localStorage.removeItem('ptt_token'); token = ''; location.reload(); });
$('#newOrg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const j = await api('POST', '/api/platform/orgs', {
    code: $('#noCode').value.trim(), name: $('#noName').value.trim(), plan: $('#noPlan').value,
    adminUsername: $('#noAdmin').value.trim(), adminDisplayName: $('#noAdminName').value.trim(), adminPassword: $('#noAdminPw').value
  });
  $('#newOrg').reset();
  const np = $('#newPw'); np.classList.remove('hidden');
  np.textContent = j.password ? `已建立 ${j.org.code}，公司管理員 ${j.admin.username} 的一次性密碼：${j.password}` : `已建立 ${j.org.code}`;
  refresh();
});
$('#orgCards').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const card = b.closest('.ch-card'); const id = card.dataset.id; const o = orgs.find(x => x.id === id);
  const act = b.dataset.act;
  if (act === 'save') {
    const plan = card.querySelector('[data-act="plan"]').value;
    const seatLimit = +card.querySelector('[data-act="seats"]').value;
    await api('PATCH', `/api/platform/orgs/${id}`, { plan, seatLimit });
  }
  if (act === 'paid') await api('POST', `/api/platform/orgs/${id}/mark-paid`, { days: 30, note: '平台管理員手動標記（範例佔位）' });
  if (act === 'toggle') { if (!o.disabled && !confirm(`確定停用 ${o.name}？該公司使用者會立即被登出。`)) return; await api('PATCH', `/api/platform/orgs/${id}`, { disabled: !o.disabled }); }
  if (act === 'del') { if (!confirm(`確定刪除 ${o.name}？使用者、頻道與該公司訊息都會刪除，無法復原。`)) return; await api('DELETE', `/api/platform/orgs/${id}`); }
  toast('已更新'); refresh();
});
if ($('#org') && ! $('#org').value) $('#org').value = 'PLATFORM';
boot();

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : ''; }
async function shotUrl(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return '';
  return URL.createObjectURL(await r.blob());
}
async function loadReports() {
  if (!$('#rptList')) return;
  const st = ($('#rptFilter') && $('#rptFilter').value) || '';
  const q = st ? ('?status=' + encodeURIComponent(st)) : '';
  try {
    const j = await api('GET', '/api/platform/reports' + q);
    $('#rptList').innerHTML = (j.reports || []).map(r => {
      const meta = r.meta || {};
      const log = (r.log || []).join('\n');
      return `<div class="rpt-item" data-id="${esc(r.id)}">
        <div><b>${esc(r.displayName || r.username || '')}</b> · ${esc(r.username || '')} · 公司 ${esc(r.orgCode || r.orgId || '')} · ${esc(fmtTs(r.ts))}
          <span class="tag ${r.status === 'handled' ? 'on' : ''}">${r.status === 'handled' ? '已處理' : '未處理'}</span>
          ${r.hasScreenshot ? '<span class="tag">有截圖</span>' : ''}</div>
        <p>${esc(r.text)}</p>
        <p class="muted small">${esc([meta.platform, meta.device, meta.os, meta.appVersion, meta.browser].filter(Boolean).join(' · '))}</p>
        ${r.note ? `<p class="muted small">備註：${esc(r.note)}</p>` : ''}
        ${log ? `<details><summary>連線事件日誌</summary><pre>${esc(log)}</pre></details>` : ''}
        ${r.hasScreenshot ? `<img alt="截圖" data-shot="${esc('/api/platform/reports/' + r.id + '/screenshot')}">` : ''}
        <div class="ch-add" style="margin-top:8px">
          ${r.status === 'handled' ? `<button data-rpt="open">標為未處理</button>` : `<button data-rpt="handled">標記已處理</button>`}
        </div>
      </div>`;
    }).join('') || '<p class="muted">目前沒有回報</p>';
    $('#rptList').querySelectorAll('img[data-shot]').forEach(img => { shotUrl(img.dataset.shot).then(src => { if (src) img.src = src; }); });
  } catch {}
}
if ($('#rptRefresh')) $('#rptRefresh').addEventListener('click', loadReports);
if ($('#rptFilter')) $('#rptFilter').addEventListener('change', loadReports);
if ($('#rptExport')) $('#rptExport').addEventListener('click', async () => {
  const j = await api('GET', '/api/platform/reports/export');
  const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'geelo-reports.json'; a.click();
});
if ($('#rptList')) $('#rptList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-rpt]'); if (!b) return;
  const id = b.closest('.rpt-item').dataset.id;
  await api('PATCH', '/api/platform/reports/' + id, { status: b.dataset.rpt });
  toast('已更新回報狀態'); loadReports();
});
