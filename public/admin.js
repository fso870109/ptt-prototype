'use strict';
// 管理後台：使用 /api/admin/*（需要管理員 token）
const $ = (s) => document.querySelector(s);
const ROLE_LABEL = { supervisor: '主管', member: '一般', listener: '只聽' };
const USER_ROLE_LABEL = { user: '使用者', dispatcher: '調度員', org_admin: '公司管理員', admin: '平台管理員' };
const SETTABLE_ROLES = { user: '使用者', dispatcher: '調度員', org_admin: '公司管理員' };
let token = localStorage.getItem('ptt_token') || '';
let me = null, users = [], channels = [];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3000); }
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
  if (me.role !== 'admin' && me.role !== 'org_admin') { $('#denied').classList.remove('hidden'); return; }
  const pl = $('#platformLink'); if (pl) pl.classList.toggle('hidden', me.role !== 'admin');
  $('#panels').classList.remove('hidden');
  await refresh();
}
async function refresh() {
  const [u, c, a, s] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/channels'), api('GET', '/api/admin/alerts'), api('GET', '/api/admin/settings').catch(() => ({ settings: { saveCaptions: false } }))]);
  users = u.users; channels = c.channels; renderUsers(); renderChannels(); renderAlerts(a.alerts);
  loadReports();
  loadCalls();
  loadInvites();
  const box = $('#saveCaptions');
  if (box) box.checked = !!(s.settings && s.settings.saveCaptions);
}
function renderAlerts(list) {
  $('#alertList').innerHTML = list.map(a => `<li><span>🚨 <b>${esc(a.name)}</b> ${a.channelName ? '#' + esc(a.channelName) : ''} · ${new Date(a.ts).toLocaleTimeString('zh-TW', { hour12: false })} ${a.lat != null ? `· <a href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}" target="_blank" rel="noopener">地圖</a>` : '· 位置不明'}</span><button class="danger" data-resolve="${esc(a.id)}">解除警報</button></li>`).join('') || '<li class="muted">目前沒有警報</li>';
}
function renderUsers() {
  $('#userRows').innerHTML = users.map(u => `<tr data-id="${esc(u.id)}">
    <td>${esc(u.username)}</td><td>${esc(u.displayName)}</td>
    <td>${u.id === me.id ? (USER_ROLE_LABEL[u.role] || u.role) : `<select data-act="setuserrole">${Object.entries(SETTABLE_ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</td>
    <td>${u.disabled ? '<span class="tag off">已停用</span>' : u.online ? '<span class="tag on">在線</span>' : '<span class="tag">離線</span>'}</td>
    <td>${u.id === me.id ? '<span class="muted small">（你）</span> <button data-act="pw">重設密碼</button>' : `
      <button data-act="rename">改名</button>
      <button data-act="pw">重設密碼</button>
      <button data-act="toggle" class="${u.disabled ? '' : 'danger'}">${u.disabled ? '啟用' : '停用'}</button>
      <button data-act="del" class="danger">刪除</button>`}</td></tr>`).join('');
}
function roleSelect(val, attrs) { return `<select ${attrs}>${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${v}</option>`).join('')}</select>`; }
function renderChannels() {
  $('#channelCards').innerHTML = channels.map(c => {
    const memberIds = new Set(c.members.map(m => m.id));
    const addable = users.filter(u => !memberIds.has(u.id) && !u.disabled);
    return `<div class="ch-card" data-ch="${esc(c.id)}">
      <div class="ch-head"><strong># ${esc(c.name)}</strong>
        <span><label class="chk"><input type="checkbox" data-act="open" ${c.open ? 'checked' : ''}> 開放</label></span>
        <span class="muted small">${c.online} 人在線</span>
        ${c.id === 'lobby' ? '<span class="muted small">大廳不可刪除</span>' : '<button class="danger" data-act="delch">刪除頻道</button>'}</div>
      <ul class="ch-members">${c.members.map(m => `<li data-uid="${esc(m.id)}"><span>${esc(m.name)}</span><span>${roleSelect(m.role, 'data-act="setrole"')} <button data-act="rm">移除</button></span></li>`).join('') || `<li class="muted small">${c.open ? '尚未個別指派；所有人以「一般」身分加入' : '尚未指派任何成員（只有管理員可進入）'}</li>`}</ul>
      <div class="ch-add"><select data-role="adduser"><option value="">＋ 指派成員…</option>${addable.map(u => `<option value="${esc(u.id)}">${esc(u.displayName)}（${esc(u.username)}）</option>`).join('')}</select>${roleSelect('member', 'data-role="addrole"')}<button data-act="add">指派</button></div>
    </div>`;
  }).join('');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const org = ($('#org') && $('#org').value.trim()) || localStorage.getItem('ptt_org') || '';
  if (org) localStorage.setItem('ptt_org', org);
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value, org }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#loginErr').textContent = j.message || '登入失敗'; return; }
  token = j.token; localStorage.setItem('ptt_token', token); $('#password').value = ''; if ($('#org') && localStorage.getItem('ptt_org')) $('#org').value = localStorage.getItem('ptt_org');
boot();
});
if ($('#saveCaptions')) $('#saveCaptions').addEventListener('change', async () => {
  try {
    const j = await api('PATCH', '/api/admin/settings', { saveCaptions: $('#saveCaptions').checked });
    toast(j.settings && j.settings.saveCaptions ? '已開啟：最終字幕會存成文字' : '已關閉：字幕只即時顯示、不存檔');
  } catch {}
});
$('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch {} localStorage.removeItem('ptt_token'); token = ''; location.reload(); });
$('#newUser').addEventListener('submit', async (e) => {
  e.preventDefault();
  const j = await api('POST', '/api/admin/users', { username: $('#nuUsername').value.trim(), displayName: $('#nuName').value.trim(), password: $('#nuPassword').value, role: $('#nuRole').value });
  $('#newUser').reset();
  const np = $('#newPw'); np.classList.remove('hidden');
  np.textContent = j.password ? `已建立 ${j.user.username}，自動產生的密碼：${j.password}（只顯示這一次，請交給使用者）` : `已建立 ${j.user.username}`;
  refresh();
});
$('#userRows').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-act="setuserrole"]'); if (!sel) return;
  const id = sel.closest('tr').dataset.id;
  if (id === me.id) return;
  await api('PATCH', `/api/admin/users/${id}`, { role: sel.value });
  toast('已更新身分'); refresh();
});
$('#userRows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('tr').dataset.id; const u = users.find(x => x.id === id);
  const act = b.dataset.act;
  if (act === 'rename') { const n = prompt('新的顯示名稱', u.displayName); if (!n) return; await api('PATCH', `/api/admin/users/${id}`, { displayName: n }); }
  if (act === 'pw') {
    const pw = prompt(`重設 ${u.username} 的密碼：輸入新密碼（至少 8 字元），或留空自動產生`, '');
    if (pw === null) return;
    const j = await api('PATCH', `/api/admin/users/${id}`, pw ? { password: pw } : { resetPassword: true });
    const np = $('#newPw'); np.classList.remove('hidden'); np.textContent = j.password ? `${u.username} 的新密碼：${j.password}（只顯示這一次）` : `${u.username} 的密碼已更新`;
    if (id === me.id) { toast('你的密碼已變更，請重新登入'); setTimeout(() => location.reload(), 1500); return; }
  }
  if (act === 'toggle') { if (!u.disabled && !confirm(`確定停用 ${u.username}？對方會立即被登出。`)) return; await api('PATCH', `/api/admin/users/${id}`, { disabled: !u.disabled }); }
  if (act === 'del') { if (!confirm(`確定刪除 ${u.username}？此動作無法復原。`)) return; await api('DELETE', `/api/admin/users/${id}`); }
  toast('已更新'); refresh();
});
$('#newChannel').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/admin/channels', { name: $('#ncName').value.trim(), open: $('#ncOpen').checked });
  $('#newChannel').reset(); toast('已建立頻道'); refresh();
});
$('#channelCards').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const card = b.closest('.ch-card'); const ch = card.dataset.ch;
  if (b.dataset.act === 'delch') { if (!confirm('確定刪除這個頻道？')) return; await api('DELETE', `/api/admin/channels/${ch}`); }
  if (b.dataset.act === 'rm') await api('DELETE', `/api/admin/channels/${ch}/members/${b.closest('li').dataset.uid}`);
  if (b.dataset.act === 'add') {
    const uidv = card.querySelector('[data-role="adduser"]').value; if (!uidv) return toast('請先選擇使用者');
    await api('PUT', `/api/admin/channels/${ch}/members/${uidv}`, { role: card.querySelector('[data-role="addrole"]').value });
  }
  toast('已更新'); refresh();
});
$('#channelCards').addEventListener('change', async (e) => {
  const card = e.target.closest('.ch-card'); if (!card) return; const ch = card.dataset.ch;
  if (e.target.dataset.act === 'setrole') { await api('PUT', `/api/admin/channels/${ch}/members/${e.target.closest('li').dataset.uid}`, { role: e.target.value }); toast('角色已更新'); refresh(); }
  if (e.target.dataset.act === 'open') { await api('PATCH', `/api/admin/channels/${ch}`, { open: e.target.checked }); toast('已更新'); refresh(); }
});
$('#alertList').addEventListener('click', async (e) => { const b = e.target.closest('button[data-resolve]'); if (!b) return; if (!confirm('確定解除這個警報？')) return; await api('POST', `/api/admin/alerts/${b.dataset.resolve}/resolve`); toast('警報已解除'); refresh(); });
setInterval(() => { if (me && me.role === 'admin' && !document.hidden) api('GET', '/api/admin/alerts').then(a => renderAlerts(a.alerts)).catch(() => {}); }, 5000);
if ($('#org') && localStorage.getItem('ptt_org')) $('#org').value = localStorage.getItem('ptt_org');
boot();

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : ''; }
async function shotUrl(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return '';
  return URL.createObjectURL(await r.blob());
}
function renderReports(list, shotBase) {
  const el = $('#rptList'); if (!el) return;
  el.innerHTML = (list || []).map(r => {
    const meta = r.meta || {};
    const log = (r.log || []).join('\n');
    return `<div class="rpt-item" data-id="${esc(r.id)}">
      <div><b>${esc(r.displayName || r.username || '使用者')}</b> · ${esc(r.username || '')} · ${esc(fmtTs(r.ts))}
        <span class="tag ${r.status === 'handled' ? 'on' : ''}">${r.status === 'handled' ? '已處理' : '未處理'}</span>
        ${r.hasScreenshot ? '<span class="tag">有截圖</span>' : ''}</div>
      <p>${esc(r.text)}</p>
      <p class="muted small">${esc([meta.platform, meta.device, meta.os, meta.appVersion, meta.browser].filter(Boolean).join(' · '))}</p>
      ${r.note ? `<p class="muted small">備註：${esc(r.note)}</p>` : ''}
      ${log ? `<details><summary>連線事件日誌</summary><pre>${esc(log)}</pre></details>` : ''}
      ${r.hasScreenshot ? `<img alt="截圖" data-shot="${esc(shotBase + '/' + r.id + '/screenshot')}">` : ''}
      <div class="ch-add" style="margin-top:8px">
        ${r.status === 'handled' ? `<button data-rpt="open">標為未處理</button>` : `<button data-rpt="handled">標記已處理</button>`}
      </div>
    </div>`;
  }).join('') || '<p class="muted">目前沒有回報</p>';
  el.querySelectorAll('img[data-shot]').forEach(img => { shotUrl(img.dataset.shot).then(src => { if (src) img.src = src; }); });
}
async function loadReports() {
  if (!$('#rptList')) return;
  const st = ($('#rptFilter') && $('#rptFilter').value) || '';
  const q = st ? ('?status=' + encodeURIComponent(st)) : '';
  try {
    const j = await api('GET', '/api/admin/reports' + q);
    renderReports(j.reports, '/api/admin/reports');
  } catch {}
}
if ($('#rptRefresh')) $('#rptRefresh').addEventListener('click', loadReports);
if ($('#rptFilter')) $('#rptFilter').addEventListener('change', loadReports);
if ($('#rptList')) $('#rptList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-rpt]'); if (!b) return;
  const id = b.closest('.rpt-item').dataset.id;
  await api('PATCH', '/api/admin/reports/' + id, { status: b.dataset.rpt });
  toast('已更新回報狀態'); loadReports();
});

function fmtCall(c) {
  const when = new Date(c.startedAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
  const dur = ((c.durMs || 0) / 1000).toFixed(1);
  const where = c.kind === 'dm' ? ('私訊 · ' + (c.peerName || '對方')) : ('#' + (c.channelName || ''));
  return `${c.fromName || '使用者'} → ${where} · ${when} · ${dur} 秒${c.preempted ? ' · 被插話' : ''}`;
}
async function loadCalls() {
  if (!$('#callList')) return;
  try {
    const j = await api('GET', '/api/admin/calls?limit=200');
    $('#callList').innerHTML = (j.calls || []).map(c => `<div class="call-item">${esc(fmtCall(c))}</div>`).join('') || '<p class="muted">目前沒有通話紀錄</p>';
    const sel = $('#invChannel');
    if (sel) sel.innerHTML = channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  } catch {}
}
async function exportCalls() {
  const r = await fetch('/api/admin/calls?format=csv', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { toast('無法匯出'); return; }
  const blob = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'geelo-calls.csv'; a.click();
}
async function loadInvites() {
  if (!$('#invList')) return;
  try {
    const j = await api('GET', '/api/admin/invites');
    $('#invList').innerHTML = (j.invites || []).map(i => {
      const st = i.revoked ? '已撤銷' : '有效';
      return `<div class="rpt-item" data-id="${esc(i.id)}">
        <div><b># ${esc(i.channelName)}</b> · ${i.kind === 'register' ? '邀請註冊' : '加入頻道'} · ${st} · ${i.uses || 0}${i.maxUses ? '/' + i.maxUses : ''} 次</div>
        <p class="muted small"><a class="link" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.url)}</a></p>
        <div class="qr-preview"><img alt="QR" src="/api/invites/${esc(i.code)}/qr"></div>
        ${i.revoked ? '' : '<button data-invrevoke="1">撤銷</button>'}
      </div>`;
    }).join('') || '<p class="muted">尚無邀請</p>';
  } catch {}
}
if ($('#callRefresh')) $('#callRefresh').addEventListener('click', loadCalls);
if ($('#callExport')) $('#callExport').addEventListener('click', exportCalls);
if ($('#newInvite')) $('#newInvite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { channelId: $('#invChannel').value, kind: $('#invKind').value };
  if ($('#invHours').value) body.expiresInHours = +$('#invHours').value;
  if ($('#invUses').value) body.maxUses = +$('#invUses').value;
  await api('POST', '/api/admin/invites', body);
  toast('已產生邀請'); loadInvites();
});
if ($('#invList')) $('#invList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-invrevoke]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  await api('POST', '/api/admin/invites/' + id + '/revoke');
  toast('已撤銷'); loadInvites();
});
