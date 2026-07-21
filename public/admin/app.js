// Estate Landscapers — admin SPA
const $ = (s, r = document) => r.querySelector(s);
const api = (p, opts) => fetch('/api' + p, opts).then(async r => { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return {}; } });
const money = n => '$' + Math.round(n || 0).toLocaleString('en-AU');
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIERS = ['Basic', 'Standard', 'Premium'];
const BEHAV = { none: '', remeasurable: 'Remeasurable', rate_only: 'Rate only', optional: 'Optional', allowance: 'Allowance' };
let state = { tab: 'dash', quoteId: null, poId: null, mgmtUnlocked: false, showSuperseded: false, scrollY: 0 };

function toast(msg) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
const LOGO = `<img src="/assets/logo-icon.png" alt="Estate Landscapers" style="height:34px;width:auto;display:block;">`;

function shell() {
  const tabs = [['dash', 'Dashboard'], ['quotes', 'Quotes'], ['po', 'Purchase Orders'], ['pricing', 'Pricing Sheet'], ['surcharges', 'Surcharges'], ['checklist', 'Checklist'], ['settings', 'Settings']];
  $('#app').innerHTML = `
    <div class="top">
      <div class="brand">${LOGO}<div><b>ESTATE LANDSCAPERS</b><span>Quote Tool</span></div></div>
      <div class="nav">${tabs.map(t => `<button data-tab="${t[0]}" class="${state.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
      <div class="spacer"></div>
      <span class="tag ${state.mgmtUnlocked ? 'tag-accepted' : 'tag-draft'}">${state.mgmtUnlocked ? '\u{1F513} Management' : '\u{1F512} Team view'}</span>
    </div>
    <div class="wrap" id="view"></div>`;
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.quoteId = null; state.poId = null; route(); }));
  route();
}
function route() {
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const v = $('#view');
  if (state.tab === 'dash') return dashboard(v);
  if (state.tab === 'quotes') return state.quoteId ? quoteEditor(v) : quotesList(v);
  if (state.tab === 'po') return state.poId ? poEditor(v) : poList(v);
  if (state.tab === 'pricing') return pricingSheet(v);
  if (state.tab === 'surcharges') return surchargesTab(v);
  if (state.tab === 'checklist') return checklistTab(v);
  if (state.tab === 'settings') return settingsTab(v);
}

// ---------------- DASHBOARD ----------------
async function dashboard(v) {
  v.innerHTML = `<div class="card"><h2>Dashboard</h2><div class="sub">Value secured = quotes accepted & signed. Year = Australian FY (1 Jul – 30 Jun).</div><div class="rule"></div><div id="dashcards">Loading…</div></div><div class="card"><h2>Recent activity</h2><div class="rule"></div><div id="dashrecent"></div></div>`;
  const d = await api('/dashboard');
  $('#dashcards').innerHTML = `
    <div class="grid4">
      <div class="stat hero"><div class="k">Secured — this week</div><div class="v">${money(d.securedWeek)}</div></div>
      <div class="stat hero"><div class="k">Secured — this month</div><div class="v">${money(d.securedMonth)}</div></div>
      <div class="stat hero"><div class="k">Secured — FY</div><div class="v">${money(d.securedFY)}</div></div>
      <div class="stat"><div class="k">Quotes built (30d)</div><div class="v">${d.builtMonth || 0}</div></div>
    </div>
    <div class="grid3" style="margin-top:10px;">
      <div class="stat"><div class="k">Value quoted (30d)</div><div class="v">${money(d.quotedValueMonth)}</div></div>
      <div class="stat"><div class="k">Win rate (value, FY)</div><div class="v">${d.winRateValue || 0}%</div></div>
      <div class="stat"><div class="k">Avg quote value</div><div class="v">${money(d.avgQuote)}</div></div>
    </div>`;
  const recent = d.recent || [];
  $('#dashrecent').innerHTML = recent.length ? `<table><thead><tr><th>Quote</th><th>Client</th><th>Value</th><th>Status</th><th>When</th></tr></thead><tbody>
    ${recent.map(r => `<tr><td><b>${esc(r.quoteNumber)}</b></td><td>${esc(r.client || '—')}</td><td>${r.value ? money(r.value) : '—'}</td><td><span class="tag tag-${r.status}">${esc(r.status)}</span></td><td class="muted">${r.updatedAt ? new Date(r.updatedAt + 'Z').toLocaleDateString('en-AU') : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No activity yet.</p>';
}

// ---------------- QUOTES LIST ----------------
async function quotesList(v) {
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div><h2>Quotes</h2><div class="sub">Latest revision is the live link. Superseded revisions hidden by default.</div></div>
    <div style="display:flex;gap:10px;align-items:center;"><label style="font-size:10.5px;color:var(--grey);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="showSup" ${state.showSuperseded ? 'checked' : ''} style="width:auto;"> Show superseded</label><button class="btn btn-blue" id="newQuote">+ New quote</button></div></div>
    <div class="rule"></div><div id="qtable">Loading…</div></div>`;
  $('#newQuote').addEventListener('click', newQuote);
  $('#showSup').addEventListener('change', e => { state.showSuperseded = e.target.checked; quotesList(v); });
  let list = await api('/quotes');
  if (!state.showSuperseded) list = list.filter(q => q.status !== 'superseded');
  $('#qtable').innerHTML = list.length ? `<table><thead><tr><th>Quote</th><th>Client</th><th>Project</th><th>Value</th><th>Status</th><th>Views</th><th></th></tr></thead><tbody>
    ${list.map(q => `<tr><td><b>${esc(q.quoteNumber)}</b></td><td>${esc(q.client || '—')}</td><td>${esc(q.projectTitle || '')}</td><td>${q.value ? money(q.value) : '—'}</td>
      <td><span class="tag tag-${q.status}">${q.status}${q.acceptedPackage ? ' · ' + esc(q.acceptedPackage) : ''}</span></td><td>${q.views}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-open="${q.id}">Open</button> <button class="btn btn-danger btn-sm" data-del="${q.id}" title="Delete">✕</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No quotes yet.</p>';
  v.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.quoteId = b.dataset.open; state.scrollY = 0; route(); }));
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this quote? This cannot be undone.')) { await api('/quotes/' + b.dataset.del, { method: 'DELETE' }); toast('Quote deleted'); quotesList(v); } }));
}
async function newQuote() {
  const q = await api('/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: '', projectTitle: 'Landscape Works' }) });
  state.quoteId = q.id; state.scrollY = 0; route();
}

// ---------------- QUOTE EDITOR (reordered) ----------------
async function quoteEditor(v) {
  v.innerHTML = `<p class="muted">Loading quote…</p>`;
  const [q, priceItems, surcharges, checklist] = await Promise.all([
    api('/quotes/' + state.quoteId), api('/price-list'), api('/price-list/surcharges/all'), api('/checklist/quote/' + state.quoteId)]);
  const link = location.origin + '/q/' + q.token;
  const applied = q.appliedSurcharges || [];
  const isApplied = id => applied.some(s => s.id === id);
  const uncheckedCritical = (checklist || []).filter(c => c.critical && !c.checked).length;
  const commonCodes = ['PL', 'EW', 'GT', 'GM', 'FC', 'CP', 'RW', 'PW', 'AL', 'AC'];
  const usedItemIds = new Set([...(q.items.scope1 || []), ...(q.items.scope2 || [])].map(i => i.priceItemId).filter(Boolean));

  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Quote ${esc(q.quoteNumber)}</h2><div class="sub" id="saveStatus">Auto-saves as you go. Client can only sign — upgrades create a new revision.</div></div>
      <div style="display:flex;gap:6px;"><button class="btn btn-ghost" id="backList">← All quotes</button><button class="btn btn-ghost" id="newRev">+ New revision</button><span class="tag tag-${q.status === 'accepted' ? 'accepted' : 'draft'}">${q.status}</span></div>
    </div>
    <div class="rule"></div>
    <div class="linkbar"><span>🔗 Live link:</span><input id="linkInput" readonly value="${esc(link)}"><button class="btn btn-blue btn-sm" id="copyLink">Copy</button><a class="btn btn-ghost btn-sm" href="${esc(link)}" target="_blank">Preview</a></div>
  </div>

  <div class="card">
    <h2>Details</h2><div class="rule"></div>
    <div class="grid2">
      <div class="field"><label>Client name</label><input id="f_client" value="${esc(q.client || '')}"></div>
      <div class="field"><label>Client email</label><input id="f_email" value="${esc(q.clientEmail || '')}"></div>
      <div class="field"><label>Project title</label><input id="f_title" value="${esc(q.projectTitle || '')}"></div>
      <div class="field"><label>Site address</label><input id="f_address" value="${esc(q.address || '')}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Default package</label><div class="seg" id="segPkg">${TIERS.map(t => `<button data-v="${t}" class="${q.defaultPackage === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Payment schedule</label><div class="seg" id="segPay"><button data-v="standard" class="${q.paymentSchedule === 'standard' ? 'on' : ''}">10/20/30/30/10</button><button data-v="small" class="${q.paymentSchedule === 'small' ? 'on' : ''}">50/40/10</button></div></div>
      <div class="field"><label>Validity (days)</label><input id="f_validity" type="number" value="${q.validityDays || 14}"></div>
    </div>
    <div class="field"><label>Site-specific notes (shown to client)</label><textarea id="f_notes" rows="2">${esc(q.siteNotes || '')}</textarea></div>
  </div>

  <div class="card">
    <h2>Add deliverables</h2><div class="sub">Tick common items, or pick from the full sheet. Adding keeps your place on the page.</div><div class="rule"></div>
    <div id="pickList">${commonCodes.map(code => { const pi = priceItems.find(p => p.code === code); if (!pi) return ''; const on = usedItemIds.has(pi.id); return `<span class="pickitem ${on ? 'on' : ''}" data-pick="${pi.id}">${on ? '✓ ' : ''}${esc(pi.code)} ${esc(pi.name.split(' ').slice(0, 2).join(' '))}</span>`; }).join('')}</div>
    <div style="margin-top:8px;"><select id="addPick" style="max-width:360px;"><option value="">+ Add any deliverable from full pricing sheet…</option>${priceItems.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select> <button class="btn btn-ghost btn-sm" id="addCustom">+ Custom line</button></div>
  </div>

  <div class="card">
    <h2>Deliverables</h2><div class="rule"></div>
    <div class="scope-box"><div class="scope-title">Scope 1 — Landscaping Works Deliverables</div><div id="scope1"></div></div>
    <div class="scope-box s2"><div class="scope-title">Scope 2 — Disposal / remeasurable (cost + 15%)</div><div id="scope2"></div></div>
  </div>

  <div class="card">
    <h2>Site surcharges <span class="reqbadge">Required</span></h2><div class="sub">Tick any that apply, or mark N/A.</div><div class="rule"></div>
    <div id="surChips">${surcharges.map(s => `<span class="chip ${isApplied(s.id) ? 'on' : ''}" data-sur="${s.id}">${esc(s.name)} ${s.kind === 'percent' ? '+' + s.rate + '%' : '+' + money(s.rate)}</span>`).join('')}
      <span class="chip ${q.surchargesNa ? 'on' : ''}" data-sur-na="1">N/A — no site surcharges</span></div>
  </div>

  <div class="card">
    <h2>Structural checklist <span class="reqbadge">Blocks save if critical unticked</span></h2><div class="sub">Editable. Critical items must be ticked before saving/sending.</div><div class="rule"></div>
    <div id="qchecklist"></div>
    <div style="margin-top:8px;"><a href="#" id="editChecklist" style="font-size:11px;">Edit checklist items →</a></div>
  </div>

  <div class="card">
    <h2>Site plan / drawing <span class="reqbadge">Required</span></h2><div class="sub">Upload the marked-up drawing (shown to client), or mark N/A.</div><div class="rule"></div>
    <div id="siteplanArea">${q.hasSiteplan ? `<img src="/api/public/quote/${q.token}/siteplan?t=${Date.now()}" style="max-width:100%;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;">` : '<p class="muted">No drawing uploaded.</p>'}</div>
    <div class="row" style="gap:14px;flex-wrap:wrap;">
      <input type="file" id="planFile" accept="image/png,image/jpeg" style="max-width:300px;width:auto;">
      ${q.hasSiteplan ? '<button class="btn btn-ghost btn-sm" id="removePlan">Remove</button>' : ''}
      <label style="font-size:11px;display:flex;align-items:center;gap:7px;"><input type="checkbox" id="planNa" ${q.siteplanNa ? 'checked' : ''} style="width:auto;"> Mark N/A — no drawing for this job</label>
    </div>
  </div>

  <div class="savebar">
    <div style="font-size:11.5px;color:var(--grey);" id="saveMsg">${uncheckedCritical > 0 ? `<span style="color:var(--red);font-weight:700;">${uncheckedCritical} critical checklist item(s) unticked — Save & Send blocked</span>` : '✓ Ready to send'}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="saveDraft">Save draft</button><button class="btn btn-blue" id="saveSend" ${uncheckedCritical > 0 ? 'disabled style="opacity:.55;cursor:not-allowed;"' : ''}>Save & get live link</button></div>
  </div>`;

  renderItems(q);
  renderChecklist(checklist);
  window.scrollTo(0, state.scrollY);

  const autosave = async () => {
    const body = { client: $('#f_client').value, clientEmail: $('#f_email').value, projectTitle: $('#f_title').value, address: $('#f_address').value, validityDays: parseInt($('#f_validity').value) || 14, defaultPackage: $('#segPkg .on').dataset.v, paymentSchedule: $('#segPay .on').dataset.v, siteNotes: $('#f_notes').value };
    await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#saveStatus').textContent = 'Auto-saved just now.';
  };
  ['f_client', 'f_email', 'f_title', 'f_address', 'f_validity', 'f_notes'].forEach(id => $('#' + id).addEventListener('change', autosave));
  $('#segPkg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPkg').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave().then(() => reload()); }));
  $('#segPay').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPay').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave(); }));

  function reload() { state.scrollY = window.scrollY; quoteEditor(v); }

  $('#backList').addEventListener('click', () => { state.quoteId = null; route(); });
  $('#copyLink').addEventListener('click', () => { $('#linkInput').select(); navigator.clipboard?.writeText(link); toast('Link copied'); });
  $('#newRev').addEventListener('click', async () => { const r = await api('/quotes/' + q.id + '/revision', { method: 'POST' }); state.quoteId = r.id; state.scrollY = 0; toast('Revision ' + r.quoteNumber + ' created'); route(); });
  $('#saveDraft').addEventListener('click', async () => { await autosave(); toast('Draft saved'); });
  $('#saveSend').addEventListener('click', async () => { await autosave(); toast('Saved — live link ready'); });
  $('#editChecklist').addEventListener('click', e => { e.preventDefault(); state.tab = 'checklist'; state.quoteId = null; route(); });

  // pick-list toggles (keep scroll)
  v.querySelectorAll('[data-pick]').forEach(chip => chip.addEventListener('click', async () => {
    state.scrollY = window.scrollY;
    const pid = chip.dataset.pick;
    const existing = [...q.items.scope1, ...q.items.scope2].find(i => i.priceItemId === pid);
    if (existing) { await api(`/quotes/${q.id}/items/${existing.id}`, { method: 'DELETE' }); }
    else { const pi = priceItems.find(p => p.id === pid); await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: pi.code === 'SC2' ? 2 : 1, priceItemId: pid, qty: 1 }) }); }
    reload();
  }));
  $('#addPick').addEventListener('change', async e => { if (!e.target.value) return; state.scrollY = window.scrollY; const pi = priceItems.find(p => p.id === e.target.value); await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: pi.code === 'SC2' ? 2 : 1, priceItemId: pi.id, qty: 1 }) }); reload(); });
  $('#addCustom').addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 1, customCode: 'XX', customName: 'Custom line', customUnit: 'ea', customRate: 0, qty: 1 }) }); reload(); });

  // surcharges
  v.querySelectorAll('[data-sur]').forEach(c => c.addEventListener('click', async () => {
    state.scrollY = window.scrollY;
    const id = c.dataset.sur; const s = surcharges.find(x => x.id === id);
    let next = applied.filter(a => a.id !== id);
    if (!isApplied(id)) next.push({ id: s.id, name: s.name, kind: s.kind, rate: s.rate });
    await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedSurcharges: next, surchargesNa: false }) });
    reload();
  }));
  const naChip = v.querySelector('[data-sur-na]'); if (naChip) naChip.addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedSurcharges: [], surchargesNa: !q.surchargesNa }) }); reload(); });

  // siteplan
  $('#planFile').addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; state.scrollY = window.scrollY; const rd = new FileReader(); rd.onload = async () => { const b64 = rd.result.split(',')[1]; await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: b64, mime: file.type }) }); toast('Drawing uploaded'); reload(); }; rd.readAsDataURL(file); });
  const rmPlan = $('#removePlan'); if (rmPlan) rmPlan.addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: null, mime: null }) }); toast('Drawing removed'); reload(); });
  $('#planNa').addEventListener('change', async e => { await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteplanNa: e.target.checked }) }); });
}

function renderChecklist(checklist) {
  const host = $('#qchecklist'); if (!host) return;
  const cats = {}; (checklist || []).forEach(c => { (cats[c.category] = cats[c.category] || []).push(c); });
  host.innerHTML = Object.entries(cats).map(([cat, items]) => `<div style="margin-bottom:8px;"><div style="font-weight:800;font-size:11px;text-transform:uppercase;color:var(--grey);margin-bottom:4px;">${esc(cat)}</div>
    ${items.map(c => `<div class="check-row"><input type="checkbox" data-chk="${c.id}" ${c.checked ? 'checked' : ''}> ${esc(c.label)} ${c.critical ? '<span class="tag tag-rem">Critical</span>' : ''}</div>`).join('')}</div>`).join('');
  host.querySelectorAll('[data-chk]').forEach(cb => cb.addEventListener('change', async () => {
    state.scrollY = window.scrollY;
    await api(`/checklist/quote/${state.quoteId}/item/${cb.dataset.chk}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked: cb.checked, checkedBy: 'Estimator' }) });
    quoteEditor($('#view'));
  }));
}

function renderItems(q) {
  const row = it => {
    const behav = BEHAV[it.behaviour] || '';
    return `<tr>
      <td><b>${esc(it.code)}</b></td>
      <td>${esc(it.name)}<br><span class="muted" style="font-size:11px;">${esc(it.effectiveSpec || '')}</span>
        ${it.behaviour === 'remeasurable' ? `<label style="font-size:10.5px;display:inline-flex;align-items:center;gap:5px;margin-top:4px;"><input type="checkbox" style="width:auto;" ${it.sharedEnabled ? 'checked' : ''} data-shared="${it.id}"> shared</label>${it.sharedEnabled ? `<input style="width:56px;display:inline-block;margin-left:6px;" type="number" value="${it.sharedPct}" data-sharedpct="${it.id}"> %` : ''}` : ''}</td>
      <td>${behav ? `<span class="tag tag-${it.behaviour === 'remeasurable' ? 'rem' : it.behaviour === 'allowance' ? 'allow' : 'opt'}">${behav}</span>` : ''}</td>
      <td><select data-tier="${it.id}" style="width:105px;"><option value="">Default</option>${TIERS.map(t => `<option value="${t}" ${it.tierOverride === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input type="number" step="0.01" value="${it.qty}" data-qty="${it.id}" style="width:74px;"></td>
      <td>${esc(it.unit)}</td><td class="right">${money(it.effectiveRate)}</td><td class="right"><b>${money(it.effectiveTotal)}</b></td>
      <td class="right"><button class="btn btn-danger btn-sm" data-del="${it.id}">✕</button></td></tr>`;
  };
  const head = `<table><thead><tr><th>Code</th><th>Deliverable</th><th>Flag</th><th>Tier</th><th>Qty</th><th>Unit</th><th class="right">Rate</th><th class="right">Total</th><th></th></tr></thead><tbody>`;
  $('#scope1').innerHTML = q.items.scope1.length ? head + q.items.scope1.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 1 items yet.</p>';
  $('#scope2').innerHTML = q.items.scope2.length ? head + q.items.scope2.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 2 items yet.</p>';
  const v = $('#view');
  const save = window.scrollY;
  v.querySelectorAll('[data-qty]').forEach(i => i.addEventListener('change', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${i.dataset.qty}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: parseFloat(i.value) || 0 }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-tier]').forEach(s => s.addEventListener('change', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${s.dataset.tier}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tierOverride: s.value || null }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${b.dataset.del}`, { method: 'DELETE' }); quoteEditor(v); }));
  v.querySelectorAll('[data-shared]').forEach(c => c.addEventListener('change', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${c.dataset.shared}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedEnabled: c.checked }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-sharedpct]').forEach(i => i.addEventListener('change', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${i.dataset.sharedpct}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedPct: parseFloat(i.value) || 50 }) }); quoteEditor(v); }));
}

// ---------------- PURCHASE ORDERS ----------------
async function poList(v) {
  v.innerHTML = `<div class="card"><h2>Purchase Orders</h2><div class="sub">Created when a client accepts. PO # = quote number (revision ignored). Site copy — no pricing.</div><div class="rule"></div><div id="potable">Loading…</div></div>`;
  const list = await api('/purchase-orders');
  $('#potable').innerHTML = list.length ? `<table><thead><tr><th>PO #</th><th>Client / site</th><th>Status</th><th>Prints</th><th></th></tr></thead><tbody>
    ${list.map(po => `<tr><td><b>PO ${esc(po.poNumber)}</b></td><td>${esc(po.client || '')} · ${esc(po.address || '')}</td><td><span class="tag tag-${po.status === 'open' ? 'open' : 'closed'}">${po.status}</span></td><td>${po.prints}</td><td class="right"><button class="btn btn-ghost btn-sm" data-po="${po.id}">Open</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No purchase orders yet. They appear here when a client accepts a quote.</p>';
  v.querySelectorAll('[data-po]').forEach(b => b.addEventListener('click', () => { state.poId = b.dataset.po; route(); }));
}
async function poEditor(v) {
  const po = await api('/purchase-orders/' + state.poId);
  const canEdit = state.mgmtUnlocked;
  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>PO ${esc(po.poNumber)} — ${esc(po.client)}</h2><div class="sub">Site copy. Quantities & specs only — no pricing.</div></div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="btn btn-ghost btn-sm" id="backPo">← All POs</button>
        ${canEdit ? '' : '<a href="#" id="unlockPo" class="pill">🔒 Owner: unlock to edit</a>'}
        <button class="btn btn-blue btn-sm" id="printPo">🖨 Print to PDF</button>
      </div>
    </div>
    <div class="rule"></div>
    <div class="split-po">
      <div>
        <div class="scope-title">Approved deliverables & quantities</div>
        <table><thead><tr><th>Code</th><th>Item / spec</th><th>Qty</th>${canEdit ? '<th></th>' : ''}</tr></thead><tbody>
          ${po.items.filter(i => !i.removed).map(i => `<tr><td><b>${esc(i.code)}</b></td><td>${esc(i.name)}${i.spec ? '<br><span class="muted" style="font-size:11px;">' + esc(i.spec) + '</span>' : ''}</td><td>${esc(String(i.qty))} ${esc(i.unit)}</td>${canEdit ? `<td class="right"><button class="btn btn-danger btn-sm" data-rm="${i.id}">Remove</button></td>` : ''}</tr>`).join('')}
        </tbody></table>
        ${canEdit ? `<div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" id="resetPo">↺ Reset to default</button> ${po.status === 'open' ? '<button class="btn btn-danger btn-sm" id="closePo">Close PO (site complete)</button>' : '<button class="btn btn-ghost btn-sm" id="reopenPo">Reopen PO</button>'}</div>` : ''}
      </div>
      <div>
        <div class="scope-title">Approved drawing</div>
        ${po.hasSiteplan ? `<img src="/api/purchase-orders/${po.id}/siteplan" style="width:100%;border:1px solid var(--line);border-radius:9px;">` : '<p class="muted">No drawing.</p>'}
        <div class="scope-title" style="margin-top:12px;">Site challenges (no $)</div>
        ${(po.siteChallenges && po.siteChallenges.length) ? po.siteChallenges.map(c => `<span class="chip on">${esc(c)}</span>`).join('') : '<span class="muted">None recorded.</span>'}
      </div>
    </div>
    <div class="legend" style="margin-top:10px;"><b>Print log:</b> ${po.prints.length ? po.prints.map(p => `${new Date(p.at + 'Z').toLocaleString('en-AU')} by ${esc(p.by || 'Owner')}`).join(' · ') : 'Not printed yet.'}</div>
  </div>`;
  $('#backPo').addEventListener('click', () => { state.poId = null; route(); });
  const unlock = $('#unlockPo'); if (unlock) unlock.addEventListener('click', e => { e.preventDefault(); pinPrompt(() => poEditor(v)); });
  $('#printPo').addEventListener('click', async () => { await api('/purchase-orders/' + po.id + '/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: state.mgmtUnlocked ? 'Owner' : 'Site' }) }); window.print(); poEditor(v); });
  v.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => { await api(`/purchase-orders/${po.id}/items/${b.dataset.rm}`, { method: 'DELETE' }); toast('Item removed'); poEditor(v); }));
  const reset = $('#resetPo'); if (reset) reset.addEventListener('click', async () => { if (confirm('Reset PO to the default from the accepted quote?')) { await api('/purchase-orders/' + po.id + '/reset', { method: 'POST' }); toast('PO reset'); poEditor(v); } });
  const close = $('#closePo'); if (close) close.addEventListener('click', async () => { if (confirm('Close this PO?')) { await api('/purchase-orders/' + po.id + '/close', { method: 'POST' }); toast('PO closed'); poEditor(v); } });
  const reopen = $('#reopenPo'); if (reopen) reopen.addEventListener('click', async () => { await api('/purchase-orders/' + po.id + '/reopen', { method: 'POST' }); toast('PO reopened'); poEditor(v); });
}

// ---------------- PRICING ----------------
async function pricingSheet(v) {
  const items = await api('/price-list');
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Standard Pricing Sheet</h2><div class="sub">Single source of rates. Editing here won't change quotes already built.</div></div><button class="btn btn-blue" id="addItem">+ Add deliverable</button></div><div class="rule"></div>
    <table><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th>Basic</th><th>Standard</th><th>Premium</th><th>Flag</th><th></th></tr></thead><tbody>
    ${items.map(p => `<tr><td><b>${esc(p.code)}</b></td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Basic.spec)}</span><br>${money(p.tiers.Basic.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Standard.spec)}</span><br>${money(p.tiers.Standard.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Premium.spec)}</span><br>${money(p.tiers.Premium.sell)}</td>
      <td>${p.behaviour !== 'none' ? `<span class="tag tag-${p.behaviour === 'remeasurable' ? 'rem' : p.behaviour === 'allowance' ? 'allow' : 'opt'}">${BEHAV[p.behaviour]}</span>` : ''}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addItem').addEventListener('click', () => editPriceItem(null));
  v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editPriceItem(items.find(p => p.id === b.dataset.edit))));
}
function editPriceItem(item) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const t = item ? item.tiers : { Basic: {}, Standard: {}, Premium: {} };
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${item ? 'Edit' : 'Add'} deliverable</h2>
    <div class="grid3"><div class="field"><label>Code</label><input id="p_code" value="${esc(item?.code || '')}"></div><div class="field"><label>Unit</label><input id="p_unit" value="${esc(item?.unit || 'ea')}"></div><div class="field"><label>Behaviour</label><select id="p_behav">${Object.entries(BEHAV).map(([k, val]) => `<option value="${k}" ${item?.behaviour === k ? 'selected' : ''}>${val || 'Standard'}</option>`).join('')}</select></div></div>
    <div class="field"><label>Name</label><input id="p_name" value="${esc(item?.name || '')}"></div>
    ${TIERS.map(tt => `<div class="grid2"><div class="field"><label>${tt} spec</label><input id="p_${tt}_spec" value="${esc(t[tt].spec || '')}"></div><div class="field"><label>${tt} sell $</label><input id="p_${tt}_sell" type="number" value="${t[tt].sell || 0}"></div></div>`).join('')}
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:8px;">${item ? '<button class="btn btn-danger" id="p_del">Delete</button>' : '<span></span>'}<div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="p_cancel">Cancel</button><button class="btn btn-blue" id="p_save">Save</button></div></div></div>`;
  document.body.appendChild(bg);
  $('#p_cancel').addEventListener('click', () => bg.remove());
  $('#p_save').addEventListener('click', async () => {
    const body = { code: $('#p_code').value, name: $('#p_name').value, unit: $('#p_unit').value, behaviour: $('#p_behav').value, tiers: { Basic: { spec: $('#p_Basic_spec').value, sell: +$('#p_Basic_sell').value }, Standard: { spec: $('#p_Standard_spec').value, sell: +$('#p_Standard_sell').value }, Premium: { spec: $('#p_Premium_spec').value, sell: +$('#p_Premium_sell').value } } };
    if (item) await api('/price-list/' + item.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); else await api('/price-list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); pricingSheet($('#view'));
  });
  const del = $('#p_del'); if (del) del.addEventListener('click', async () => { if (confirm('Delete this deliverable?')) { await api('/price-list/' + item.id, { method: 'DELETE' }); bg.remove(); pricingSheet($('#view')); } });
}

// ---------------- SURCHARGES ----------------
async function surchargesTab(v) {
  const surs = await api('/price-list/surcharges/all');
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Site-Specific Surcharges</h2><div class="sub">Access, slope, etc. Applied per quote.</div></div><button class="btn btn-blue" id="addSur">+ Add surcharge</button></div><div class="rule"></div>
    <table><thead><tr><th>Name</th><th>Trigger</th><th>Type</th><th>Rate</th><th></th></tr></thead><tbody>
    ${surs.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.trigger_note || '')}</td><td>${s.kind === 'percent' ? '% of Scope 1' : 'Fixed $'}</td><td>${s.kind === 'percent' ? s.rate + '%' : money(s.rate)}</td><td class="right"><button class="btn btn-ghost btn-sm" data-es="${s.id}">Edit</button> <button class="btn btn-danger btn-sm" data-ds="${s.id}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addSur').addEventListener('click', () => editSur(null));
  v.querySelectorAll('[data-es]').forEach(b => b.addEventListener('click', () => editSur(surs.find(s => s.id === b.dataset.es))));
  v.querySelectorAll('[data-ds]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete surcharge?')) { await api('/price-list/surcharges/' + b.dataset.ds, { method: 'DELETE' }); surchargesTab(v); } }));
}
function editSur(s) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${s ? 'Edit' : 'Add'} surcharge</h2>
    <div class="field"><label>Name</label><input id="s_name" value="${esc(s?.name || '')}"></div><div class="field"><label>Trigger note</label><input id="s_note" value="${esc(s?.trigger_note || '')}"></div>
    <div class="grid2"><div class="field"><label>Type</label><select id="s_kind"><option value="percent" ${s?.kind === 'percent' ? 'selected' : ''}>% of Scope 1</option><option value="fixed" ${s?.kind === 'fixed' ? 'selected' : ''}>Fixed $</option></select></div><div class="field"><label>Rate</label><input id="s_rate" type="number" value="${s?.rate || 0}"></div></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="s_cancel">Cancel</button><button class="btn btn-blue" id="s_save">Save</button></div></div>`;
  document.body.appendChild(bg);
  $('#s_cancel').addEventListener('click', () => bg.remove());
  $('#s_save').addEventListener('click', async () => {
    const body = { name: $('#s_name').value, triggerNote: $('#s_note').value, kind: $('#s_kind').value, rate: +$('#s_rate').value };
    if (s) await api('/price-list/surcharges/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); else await api('/price-list/surcharges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); surchargesTab($('#view'));
  });
}

// ---------------- CHECKLIST (editable template) ----------------
async function checklistTab(v) {
  const tpl = await api('/checklist/template');
  const cats = {}; tpl.forEach(i => { (cats[i.category] = cats[i.category] || []).push(i); });
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Structural Checklist Template</h2><div class="sub">Editable master checklist. Each new quote gets a copy.</div></div><button class="btn btn-blue" id="addChk">+ Add item</button></div><div class="rule"></div>
    ${Object.entries(cats).map(([cat, items]) => `<div style="margin-bottom:14px;"><div style="font-weight:800;font-size:12px;text-transform:uppercase;margin-bottom:6px;">${esc(cat)}</div>
      ${items.map(i => `<div class="check-row" style="justify-content:space-between;"><div>${esc(i.label)} ${i.critical ? '<span class="tag tag-rem">Critical</span>' : ''}</div><div><button class="btn btn-ghost btn-sm" data-ec="${i.id}">Edit</button> <button class="btn btn-danger btn-sm" data-dc="${i.id}">✕</button></div></div>`).join('')}</div>`).join('')}
  </div>`;
  $('#addChk').addEventListener('click', () => editChk(null));
  v.querySelectorAll('[data-ec]').forEach(b => b.addEventListener('click', () => editChk(tpl.find(i => i.id === b.dataset.ec))));
  v.querySelectorAll('[data-dc]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete checklist item?')) { await api('/checklist/template/' + b.dataset.dc, { method: 'DELETE' }); checklistTab(v); } }));
}
function editChk(i) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${i ? 'Edit' : 'Add'} checklist item</h2>
    <div class="field"><label>Category</label><input id="c_cat" value="${esc(i?.category || 'General')}"></div>
    <div class="field"><label>Label</label><input id="c_label" value="${esc(i?.label || '')}"></div>
    <label style="font-size:12px;display:flex;align-items:center;gap:7px;margin-bottom:12px;"><input type="checkbox" id="c_crit" ${i?.critical ? 'checked' : ''} style="width:auto;"> Critical (blocks quote save if unticked)</label>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="c_cancel">Cancel</button><button class="btn btn-blue" id="c_save">Save</button></div></div>`;
  document.body.appendChild(bg);
  $('#c_cancel').addEventListener('click', () => bg.remove());
  $('#c_save').addEventListener('click', async () => {
    const body = { category: $('#c_cat').value, label: $('#c_label').value, critical: $('#c_crit').checked };
    if (i) await api('/checklist/template/' + i.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); else await api('/checklist/template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); checklistTab($('#view'));
  });
}

// ---------------- SETTINGS ----------------
async function settingsTab(v) {
  const s = await api('/settings');
  v.innerHTML = `<div class="card"><h2>Company</h2><div class="rule"></div><div class="grid2">
      ${[['company_name', 'Company name'], ['company_abn', 'ABN'], ['company_lic', 'Licence'], ['company_phone', 'Phone'], ['company_email', 'Email (Zoho)'], ['association_line', 'Association line'], ['company_address', 'Address'], ['tagline', 'Tagline']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" value="${esc(s[k])}"></div>`).join('')}
    </div><div style="font-size:11.5px;margin:6px 0 12px;">Email: ${s.smtpConfigured ? '<span class="tag tag-accepted">Zoho connected</span>' : '<span class="tag tag-superseded">Not configured</span>'}</div><button class="btn btn-blue" id="saveCompany">Save company</button></div>
  <div class="card"><h2>Package descriptions</h2><div class="rule"></div>${TIERS.map(t => `<div class="field"><label>${t}</label><textarea id="set_pkg_desc_${t.toLowerCase()}" rows="2">${esc(s['pkg_desc_' + t.toLowerCase()])}</textarea></div>`).join('')}<button class="btn btn-blue" id="savePkg">Save descriptions</button></div>
  <div class="card"><h2>Contract text</h2><div class="sub">Protections: one per line as "Title|Detail".</div><div class="rule"></div>
    <div class="field"><label>Default special clauses</label><textarea id="set_default_special_clauses" rows="3">${esc(s.default_special_clauses)}</textarea></div>
    <div class="field"><label>Warranty</label><textarea id="set_warranty_text" rows="4">${esc(s.warranty_text)}</textarea></div>
    <div class="field"><label>Your Protections</label><textarea id="set_protections_text" rows="5">${esc(s.protections_text)}</textarea></div>
    <div class="field"><label>Standard conditions</label><textarea id="set_standard_conditions" rows="6">${esc(s.standard_conditions)}</textarea></div>
    <button class="btn btn-blue" id="saveContract">Save contract text</button></div>
  <div class="card"><h2>Management PIN</h2><div class="sub">Gates margin & PO editing. Default 1234 — change it.</div><div class="rule"></div>
    <div class="pin-note">The PIN is a light deterrent, not strong security.</div>
    <div class="grid3" style="margin-top:12px;"><div class="field"><label>Current PIN</label><input id="pin_cur" type="password"></div><div class="field"><label>New PIN</label><input id="pin_new" type="password"></div><div class="field" style="display:flex;align-items:flex-end;"><button class="btn btn-blue" id="savePin">Change PIN</button></div></div></div>`;
  const save = (keys, msg) => async () => { const body = {}; keys.forEach(k => body[k] = $('#set_' + k).value); await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(msg); };
  $('#saveCompany').addEventListener('click', save(['company_name', 'company_abn', 'company_lic', 'company_phone', 'company_email', 'association_line', 'company_address', 'tagline'], 'Company saved'));
  $('#savePkg').addEventListener('click', save(['pkg_desc_basic', 'pkg_desc_standard', 'pkg_desc_premium'], 'Descriptions saved'));
  $('#saveContract').addEventListener('click', save(['default_special_clauses', 'warranty_text', 'protections_text', 'standard_conditions'], 'Contract text saved'));
  $('#savePin').addEventListener('click', async () => { const r = await api('/settings/management/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPin: $('#pin_cur').value, newPin: $('#pin_new').value }) }); if (r.ok) { toast('PIN changed'); $('#pin_cur').value = ''; $('#pin_new').value = ''; } else toast(r.error || 'Failed'); });
}

function pinPrompt(onOk) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">Management PIN</h2><div class="field"><input id="pin_in" type="password" placeholder="Enter PIN"></div><div id="pin_err" style="color:var(--red);font-size:12px;display:none;margin-bottom:8px;">Incorrect PIN</div><div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="pin_cancel">Cancel</button><button class="btn btn-blue" id="pin_ok">Unlock</button></div></div>`;
  document.body.appendChild(bg);
  $('#pin_in').focus();
  $('#pin_cancel').addEventListener('click', () => bg.remove());
  const go = async () => { const r = await api('/settings/management/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('#pin_in').value }) }); if (r.ok) { state.mgmtUnlocked = true; bg.remove(); shell(); onOk && onOk(); } else $('#pin_err').style.display = 'block'; };
  $('#pin_ok').addEventListener('click', go);
  $('#pin_in').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

shell();
