// Estate Landscapers — admin SPA (v7: logins, vendors, recipes, costing, jobs, FY close)
const $ = (s, r = document) => r.querySelector(s);
const api = (p, opts) => fetch('/api' + p, opts).then(async r => {
  if (r.status === 401) { location.href = '/admin/login.html'; return {}; }
  const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return {}; }
});
const money = n => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('en-AU');
const money2 = n => '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIERS = ['Basic', 'Standard', 'Premium'];
const BEHAV = { none: '', remeasurable: 'Remeasurable', rate_only: 'Rate only', optional: 'Optional', allowance: 'Allowance' };
let USER = null;
let state = { tab: 'leads', incGst: false, editorSub: 'surcharges', matCat: 'all', recipeCode: null, recipeVariant: null, selQuoteId: null, quoteId: null, poId: null, showSuperseded: false, scrollY: 0, jobsFy: 'all' };

function toast(msg) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
const LOGO = `<img src="/assets/logo-icon.png" alt="Estate Landscapers" style="height:34px;width:auto;display:block;">`;
const isAdmin = () => USER && USER.role === 'admin';

async function boot() {
  USER = await api('/auth/me');
  if (!USER || !USER.role) return; // redirected
  shell();
}
function shell() {
  // Order: Leads | Quotes Pricing Recipes Vendors Editor | Projects Purchase Orders
  const all = [['leads', 'Leads'], ['quotes', 'Quotes'], ['pricing', 'Pricing'], ['materials', 'Materials & Plant'],
               ['recipes', 'Recipes'], ['vendors', 'Vendors'], ['editor', 'Editor'],
               ['jobs', 'Projects'], ['selections', 'Selections'], ['po', 'Purchase Orders']];
  const adminOnlyTabs = ['editor', 'jobs', 'selections', 'po'];
  const tabs = all.filter(t => isAdmin() || !adminOnlyTabs.includes(t[0]));
  if (!tabs.find(t => t[0] === state.tab)) state.tab = 'leads';
  $('#app').innerHTML = `
    <div class="top">
      <div class="brand">${LOGO}<div><b>ESTATE LANDSCAPERS</b><span>Quote Tool</span></div></div>
      <div class="nav">${tabs.map((t, i) => `${(t[0] === 'quotes' || t[0] === 'jobs') && i > 0 ? '<span class="navsep"></span>' : ''}<button data-tab="${t[0]}" class="${state.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
      <div class="spacer"></div>
      <span class="tag ${isAdmin() ? 'tag-accepted' : 'tag-draft'}">${esc(USER.name)} · ${isAdmin() ? 'Admin' : 'Estimator'}</span>
      <button class="btn btn-ghost btn-sm" id="signout">Sign out</button>
    </div>
    <div class="wrap" id="view"></div>`;
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.quoteId = null; state.poId = null; state.selQuoteId = null; route(); }));
  $('#signout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/admin/login.html'; });
  route();
}
function route() {
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const v = $('#view');
  if (state.tab === 'leads') return leadsTab(v);
  if (state.tab === 'quotes') return state.quoteId ? quoteEditor(v) : quotesList(v);
  if (state.tab === 'jobs') return jobsTab(v);
  if (state.tab === 'po') return state.poId ? poEditor(v) : poList(v);
  if (state.tab === 'vendors') return vendorsTab(v);
  if (state.tab === 'materials') return materialsTab(v);
  if (state.tab === 'recipes') return recipesTab(v);
  if (state.tab === 'selections') return state.selQuoteId ? selectionDetail(v) : selectionsTab(v);
  if (state.tab === 'pricing') return pricingSheet(v);
  if (state.tab === 'editor') return editorTab(v);
}

// ---------------- LEADS (enquiries + figures) ----------------
const LEAD_STATUS = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];
async function leadsTab(v) {
  v.innerHTML = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><h2>Leads &amp; enquiries</h2><div class="sub">Log every enquiry, then convert it straight into a quote. A website form can feed this list later.</div></div>
        <button class="btn btn-blue" id="addLead">+ New enquiry</button></div>
      <div class="rule"></div><div id="leadTable">Loading…</div></div>
    <div class="card"><h2>Figures</h2><div class="sub">Secured = accepted &amp; signed. FY = 1 Jul – 30 Jun. All margins in this tool are GROSS margin.</div><div class="rule"></div><div id="dashcards">Loading…</div></div>`;
  $('#addLead').addEventListener('click', () => editLead(null, v));
  const data = await api('/leads');
  const rows = data.leads || [];
  $('#leadTable').innerHTML = rows.length ? `<table><thead><tr><th>Name</th><th>Contact</th><th>Site</th><th>Source</th><th>Age</th><th>Status</th><th>Quote</th><th></th></tr></thead><tbody>
    ${rows.map(l => `<tr><td><b>${esc(l.name || '—')}</b>${l.notes ? `<br><span class="muted" style="font-size:10.5px;">${esc(l.notes.slice(0, 60))}</span>` : ''}</td>
      <td>${esc(l.phone || '')}${l.email ? '<br><span class="muted" style="font-size:10.5px;">' + esc(l.email) + '</span>' : ''}</td>
      <td>${esc(l.address || '')}</td><td>${esc(l.source || '')}</td>
      <td><span class="tag ${l.ageDays >= 7 ? 'age-flag' : 'age-fresh'}">${l.ageDays}d</span></td>
      <td><select data-ls="${l.id}" style="width:110px;font-size:10.5px;">${LEAD_STATUS.map(s => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td>${l.quoteNumber ? `<button class="btn btn-ghost btn-sm" data-lq="${l.quoteId}">${esc(l.quoteNumber)}</button>` : `<button class="btn btn-blue btn-sm" data-lc="${l.id}">→ Quote</button>`}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-le="${l.id}">Edit</button> <button class="btn btn-danger btn-sm" data-ld="${l.id}">✕</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No enquiries logged yet.</p>';
  v.querySelectorAll('[data-ls]').forEach(s => s.addEventListener('change', async () => { await api('/leads/' + s.dataset.ls, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s.value }) }); toast('Status updated'); }));
  v.querySelectorAll('[data-lc]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('/leads/' + b.dataset.lc + '/convert', { method: 'POST' });
    if (r.error) return toast(r.error);
    toast('Quote ' + r.quoteNumber + ' created'); state.tab = 'quotes'; state.quoteId = r.quoteId; shell();
  }));
  v.querySelectorAll('[data-lq]').forEach(b => b.addEventListener('click', () => { state.tab = 'quotes'; state.quoteId = b.dataset.lq; shell(); }));
  v.querySelectorAll('[data-le]').forEach(b => b.addEventListener('click', () => editLead(rows.find(x => x.id === b.dataset.le), v)));
  v.querySelectorAll('[data-ld]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this enquiry?')) { await api('/leads/' + b.dataset.ld, { method: 'DELETE' }); leadsTab(v); } }));
  const d = await api('/dashboard');
  $('#dashcards').innerHTML = `
    <div class="grid4">
      <div class="stat hero"><div class="k">Secured — week</div><div class="v">${money(d.securedWeek)}</div></div>
      <div class="stat hero"><div class="k">Secured — month</div><div class="v">${money(d.securedMonth)}</div></div>
      <div class="stat hero"><div class="k">Secured — FY</div><div class="v">${money(d.securedFY)}</div></div>
      <div class="stat"><div class="k">Open enquiries</div><div class="v">${data.openCount || 0}</div></div>
    </div>
    <div class="grid4" style="margin-top:10px;">
      <div class="stat"><div class="k">Quotes built (30d)</div><div class="v">${d.builtMonth || 0}</div></div>
      <div class="stat"><div class="k">Value quoted (30d)</div><div class="v">${money(d.quotedValueMonth)}</div></div>
      <div class="stat"><div class="k">Win rate (value, FY)</div><div class="v">${d.winRateValue || 0}%</div></div>
      <div class="stat"><div class="k">Avg quote value</div><div class="v">${money(d.avgQuote)}</div></div>
    </div>`;
}
function editLead(l, v) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${l ? 'Edit' : 'New'} enquiry</h2>
    <div class="grid2">
      <div class="field"><label>Name</label><input id="l_name" value="${esc(l?.name || '')}"></div>
      <div class="field"><label>Phone</label><input id="l_phone" value="${esc(l?.phone || '')}"></div>
      <div class="field"><label>Email</label><input id="l_email" value="${esc(l?.email || '')}"></div>
      <div class="field"><label>Site address</label><input id="l_address" value="${esc(l?.address || '')}"></div>
      <div class="field"><label>Source</label><select id="l_source">${['Phone', 'Email', 'Website', 'Referral', 'Walk-in', 'Repeat client'].map(s => `<option ${l?.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select id="l_status">${LEAD_STATUS.map(s => `<option ${l?.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Notes — what they asked for</label><textarea id="l_notes" rows="3">${esc(l?.notes || '')}</textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="l_cancel">Cancel</button><button class="btn btn-blue" id="l_save">Save</button></div></div>`;
  document.body.appendChild(bg);
  $('#l_cancel').addEventListener('click', () => bg.remove());
  $('#l_save').addEventListener('click', async () => {
    const body = { name: $('#l_name').value, phone: $('#l_phone').value, email: $('#l_email').value,
      address: $('#l_address').value, source: $('#l_source').value, status: $('#l_status').value, notes: $('#l_notes').value };
    if (l) await api('/leads/' + l.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); leadsTab(v);
  });
}

// ---------------- EDITOR (surcharges + checklist + settings merged) ----------------
async function editorTab(v) {
  const sub = state.editorSub || 'surcharges';
  v.innerHTML = `<div class="card" style="padding:10px 12px;">
      <div class="seg" id="edSeg">
        <button data-v="surcharges" class="${sub === 'surcharges' ? 'on' : ''}">Surcharges</button>
        <button data-v="checklist" class="${sub === 'checklist' ? 'on' : ''}">Checklist</button>
        <button data-v="settings" class="${sub === 'settings' ? 'on' : ''}">Settings</button>
      </div></div><div id="edBody"></div>`;
  $('#edSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.editorSub = b.dataset.v; editorTab(v); }));
  const body = $('#edBody');
  if (sub === 'surcharges') return surchargesTab(body);
  if (sub === 'checklist') return checklistTab(body);
  return settingsTab(body);
}

// ---------------- QUOTES ----------------
const AGE = { fresh: ['age-fresh', d => d + 'd'], flag: ['age-flag', d => d + 'd — follow up'], chase: ['age-chase', d => d + 'd — chase'], dead: ['age-dead', d => d + 'd — dead'] };
async function quotesList(v) {
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div><h2>Quotes</h2><div class="sub">Colour = quote age (thresholds in Settings). Latest revision is the live link.</div></div>
    <div style="display:flex;gap:10px;align-items:center;"><label style="font-size:10.5px;color:var(--grey);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="showSup" ${state.showSuperseded ? 'checked' : ''} style="width:auto;"> Show superseded</label><button class="btn btn-blue" id="newQuote">+ New quote</button></div></div>
    <div class="rule"></div><div id="qtable">Loading…</div></div>`;
  $('#newQuote').addEventListener('click', async () => { const q = await api('/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: '', projectTitle: 'Landscape Works' }) }); state.quoteId = q.id; state.scrollY = 0; route(); });
  $('#showSup').addEventListener('change', e => { state.showSuperseded = e.target.checked; quotesList(v); });
  let list = await api('/quotes');
  if (!state.showSuperseded) list = list.filter(q => q.status !== 'superseded');
  $('#qtable').innerHTML = list.length ? `<table><thead><tr><th>Quote</th><th>Client</th><th>Tier</th><th>Value</th><th>Status</th><th>Age</th><th>Views</th><th></th></tr></thead><tbody>
    ${list.map(q => { const a = AGE[q.ageBand] || AGE.fresh; return `<tr><td><b>${esc(q.quoteNumber)}</b></td><td>${esc(q.client || '—')}</td><td><span class="tag tag-tier">${esc(q.customerTier || 'Silver')}</span></td><td>${q.value ? money(q.value) : '—'}</td>
      <td><span class="tag tag-${q.status}">${q.status}${q.acceptedPackage ? ' · ' + esc(q.acceptedPackage) : ''}</span></td>
      <td>${q.status === 'accepted' ? '—' : `<span class="tag ${a[0]}">${a[1](q.ageDays)}</span>`}</td><td>${q.views}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-open="${q.id}">Open</button> <button class="btn btn-danger btn-sm" data-del="${q.id}">✕</button></td></tr>`; }).join('')}
    </tbody></table>` : '<p class="muted">No quotes yet.</p>';
  v.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.quoteId = b.dataset.open; state.scrollY = 0; route(); }));
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this quote?')) { await api('/quotes/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); quotesList(v); } }));
}

// ---------------- QUOTE EDITOR ----------------
async function quoteEditor(v) {
  v.innerHTML = `<p class="muted">Loading quote…</p>`;
  const [q, priceItems, surcharges, checklist, costing] = await Promise.all([
    api('/quotes/' + state.quoteId), api('/price-list'), api('/price-list/surcharges/all'),
    api('/checklist/quote/' + state.quoteId), api('/quotes/' + state.quoteId + '/costing')]);
  const link = location.origin + '/q/' + q.token;
  const applied = q.appliedSurcharges || [];
  const isApplied = id => applied.some(s => s.id === id);
  const uncheckedCritical = (checklist || []).filter(c => c.critical && !c.checked).length;
  const commonCodes = ['PL', 'EW', 'GT', 'GM', 'FC', 'CP', 'RW', 'PW', 'AL', 'AC'];
  const usedItemIds = new Set([...(q.items.scope1 || []), ...(q.items.scope2 || [])].map(i => i.priceItemId).filter(Boolean));

  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Quote ${esc(q.quoteNumber)}</h2><div class="sub" id="saveStatus">Auto-saves. Client can only sign — changes create a new revision.</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-ghost" id="backList">← All quotes</button><button class="btn btn-ghost" id="newRev">+ New revision</button><a class="btn btn-ghost" href="/api/quotes/${q.id}/signed-preview" target="_blank">Preview signed contract</a><span class="tag tag-${q.status === 'accepted' ? 'accepted' : 'draft'}">${q.status}</span></div>
    </div>
    <div class="rule"></div>
    ${q.emailStatus ? `<div class="emailbar ${q.emailStatus}"><b>Signed-contract email: ${q.emailStatus.toUpperCase()}</b><br><span style="font-size:11px;">${esc(q.emailDetail || '')}</span></div>` : ''}
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
      <div class="field"><label>Base package</label><div class="seg" id="segPkg">${TIERS.map(t => `<button data-v="${t}" class="${q.defaultPackage === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Customer tier ${isAdmin() ? '(margin target)' : ''}</label><select id="f_ctier">${['Bronze', 'Silver', 'Gold'].map(t => `<option ${q.customerTier === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Crew size (site time)</label><input id="f_crew" type="number" min="1" max="10" value="${q.crewSize || 2}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Payment schedule</label><div class="seg" id="segPay"><button data-v="standard" class="${q.paymentSchedule === 'standard' ? 'on' : ''}">10/20/30/30/10</button><button data-v="small" class="${q.paymentSchedule === 'small' ? 'on' : ''}">50/40/10</button></div></div>
      <div class="field"><label>Validity (days)</label><input id="f_validity" type="number" value="${q.validityDays || 14}"></div>
      <div></div>
    </div>
    <div class="field"><label>Site-specific notes (shown to client)</label><textarea id="f_notes" rows="2">${esc(q.siteNotes || '')}</textarea></div>
  </div>

  <div class="card">
    <h2>Add deliverables</h2><div class="sub">Tick common items or pick from the full sheet. Keeps your place on the page.</div><div class="rule"></div>
    <div id="pickList">${priceItems.map(pi => { const on = usedItemIds.has(pi.id); const common = commonCodes.includes(pi.code);
        return `<span class="pickitem ${on ? 'have' : ''} ${common ? '' : 'more'}" data-pick="${pi.id}" ${on ? 'title="Already on this quote"' : ''}>${on ? '✓ ' : ''}${esc(pi.code)} ${esc(pi.name.split(' ').slice(0, 3).join(' '))}</span>`; }).join('')}</div>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-blue" id="addSelected" disabled style="opacity:.5;">Add selected</button>
      <a href="#" id="showMore" style="font-size:11px;">Show all deliverables</a>
      <button class="btn btn-ghost btn-sm" id="addCustom">+ Custom line</button>
      <span class="muted" style="font-size:11px;" id="pickCount">Tick the ones you need, then Add selected.</span>
    </div>
  </div>

  <div class="card">
    <h2>Deliverables — pick the tier per line</h2>
    <div class="sub">Click a tier cell to upgrade/downgrade just that line (mix & match). ↑↓ badges show lines that differ from the base package.</div><div class="rule"></div>
    <div class="scope-box"><div class="scope-title">Scope 1 — Landscaping Works Deliverables</div><div id="scope1"></div></div>
    <div class="scope-box s2"><div class="scope-title">Scope 2 — Disposal / remeasurable (cost + 15%)</div><div id="scope2"></div></div>
    <div id="changesBar"></div>
  </div>

  <div class="card" id="costCard"></div>

  <div class="card">
    <h2>Site surcharges <span class="reqbadge">Required</span></h2><div class="rule"></div>
    <div id="surChips">${surcharges.map(s => `<span class="chip ${isApplied(s.id) ? 'on' : ''}" data-sur="${s.id}">${esc(s.name)} ${s.kind === 'percent' ? '+' + s.rate + '%' : '+' + money(s.rate)}</span>`).join('')}
      <span class="chip ${q.surchargesNa ? 'on' : ''}" data-sur-na="1">N/A — no site surcharges</span></div>
  </div>

  <div class="card">
    <h2>Structural checklist <span class="reqbadge">Blocks save if critical unticked</span></h2><div class="rule"></div>
    <div id="qchecklist"></div>
  </div>

  <div class="card">
    <h2>Site plan / drawing <span class="reqbadge">Required</span></h2><div class="rule"></div>
    <div id="siteplanArea">${q.hasSiteplan ? `<img src="/api/public/quote/${q.token}/siteplan?t=${Date.now()}" style="max-width:100%;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;">` : '<p class="muted">No drawing uploaded.</p>'}</div>
    <div class="row" style="gap:14px;flex-wrap:wrap;">
      <input type="file" id="planFile" accept="image/png,image/jpeg" style="max-width:300px;width:auto;">
      ${q.hasSiteplan ? '<button class="btn btn-ghost btn-sm" id="removePlan">Remove</button>' : ''}
      <label style="font-size:11px;display:flex;align-items:center;gap:7px;"><input type="checkbox" id="planNa" ${q.siteplanNa ? 'checked' : ''} style="width:auto;"> Mark N/A</label>
    </div>
  </div>

  <div class="savebar">
    <div style="font-size:11.5px;color:var(--grey);" id="saveMsg">${uncheckedCritical > 0 ? `<span style="color:var(--red);font-weight:700;">${uncheckedCritical} critical checklist item(s) unticked — Save & Send blocked</span>` : '✓ Ready to send'}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="saveDraft">Save draft</button><button class="btn btn-blue" id="saveSend" ${uncheckedCritical > 0 ? 'disabled style="opacity:.55;cursor:not-allowed;"' : ''}>Save & get live link</button></div>
  </div>`;

  renderItemsTiered(q, costing);
  renderCostPanel(costing);
  renderChecklist(checklist);
  window.scrollTo(0, state.scrollY);
  const reload = () => { state.scrollY = window.scrollY; quoteEditor(v); };
  // Re-fetch costing and repaint only the cost panel + tier prices — keeps focus and scroll.
  async function refreshCosting() {
    const c2 = await api('/quotes/' + q.id + '/costing');
    renderCostPanel(c2);
    (c2.perLine || []).forEach(l => {
      TIERS.forEach(t => {
        const cell = v.querySelector(`[data-tier-pick="${l.id}"][data-t="${t}"]`);
        if (cell) { const pr = cell.querySelector('.pr'); if (pr) pr.textContent = money(l.tiers[t].sell); }
      });
    });
    const cb = $('#changesBar');
    if (cb && !c2.mixed) cb.innerHTML = '';
  }


  const autosave = async () => {
    const body = { client: $('#f_client').value, clientEmail: $('#f_email').value, projectTitle: $('#f_title').value, address: $('#f_address').value, validityDays: parseInt($('#f_validity').value) || 14, defaultPackage: $('#segPkg .on').dataset.v, paymentSchedule: $('#segPay .on').dataset.v, siteNotes: $('#f_notes').value, customerTier: $('#f_ctier').value, crewSize: parseInt($('#f_crew').value) || 2 };
    await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#saveStatus').textContent = 'Auto-saved just now.';
  };
  ['f_client', 'f_email', 'f_title', 'f_address', 'f_validity', 'f_notes'].forEach(id => $('#' + id).addEventListener('change', autosave));
  ['f_ctier', 'f_crew'].forEach(id => $('#' + id).addEventListener('change', () => autosave().then(refreshCosting)));
  $('#segPkg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPkg').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave().then(reload); }));
  $('#segPay').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPay').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave(); }));

  $('#backList').addEventListener('click', () => { state.quoteId = null; route(); });
  $('#copyLink').addEventListener('click', () => { $('#linkInput').select(); navigator.clipboard?.writeText(link); toast('Link copied'); });
  $('#newRev').addEventListener('click', async () => { const r = await api('/quotes/' + q.id + '/revision', { method: 'POST' }); state.quoteId = r.id; state.scrollY = 0; toast('Revision ' + r.quoteNumber + ' created — old link superseded'); route(); });
  $('#saveDraft').addEventListener('click', async () => { await autosave(); toast('Draft saved'); });
  $('#saveSend').addEventListener('click', async () => { await autosave(); toast('Saved — live link ready'); });

  // tick to stage, one Save to add them all — no page reload per click
  const staged = new Set();
  const refreshPickBar = () => {
    const b = $('#addSelected'); const n = staged.size;
    b.disabled = n === 0; b.style.opacity = n ? '1' : '.5';
    b.textContent = n ? `Add ${n} deliverable${n > 1 ? 's' : ''}` : 'Add selected';
    $('#pickCount').textContent = n ? 'Then continue building below.' : 'Tick the ones you need, then Add selected.';
  };
  v.querySelectorAll('[data-pick]').forEach(chip => chip.addEventListener('click', () => {
    if (chip.classList.contains('have')) return; // already on the quote — remove it in the table below
    const pid = chip.dataset.pick;
    if (staged.has(pid)) { staged.delete(pid); chip.classList.remove('on'); }
    else { staged.add(pid); chip.classList.add('on'); }
    refreshPickBar();
  }));
  $('#showMore').addEventListener('click', e => { e.preventDefault(); v.querySelectorAll('.pickitem.more').forEach(c => c.classList.add('show')); e.target.style.display = 'none'; });
  $('#addSelected').addEventListener('click', async () => {
    state.scrollY = window.scrollY;
    for (const pid of staged) {
      const pi = priceItems.find(p => p.id === pid);
      await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: pi.code === 'SC2' ? 2 : 1, priceItemId: pid, qty: 1 }) });
    }
    toast(staged.size + ' deliverable(s) added'); reload();
  });
  $('#addCustom').addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 1, customCode: 'XX', customName: 'Custom line', customUnit: 'ea', customRate: 0, qty: 1 }) }); reload(); });
  v.querySelectorAll('[data-sur]').forEach(c => c.addEventListener('click', async () => {
    state.scrollY = window.scrollY;
    const id = c.dataset.sur; const s = surcharges.find(x => x.id === id);
    let next = applied.filter(a => a.id !== id);
    if (!isApplied(id)) next.push({ id: s.id, name: s.name, kind: s.kind, rate: s.rate });
    await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedSurcharges: next, surchargesNa: false }) });
    reload();
  }));
  const naChip = v.querySelector('[data-sur-na]'); if (naChip) naChip.addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedSurcharges: [], surchargesNa: !q.surchargesNa }) }); reload(); });
  $('#planFile').addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; state.scrollY = window.scrollY; const rd = new FileReader(); rd.onload = async () => { await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: rd.result.split(',')[1], mime: file.type }) }); toast('Drawing uploaded'); reload(); }; rd.readAsDataURL(file); });
  const rmPlan = $('#removePlan'); if (rmPlan) rmPlan.addEventListener('click', async () => { state.scrollY = window.scrollY; await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: null, mime: null }) }); reload(); });
  $('#planNa').addEventListener('change', async e => { await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteplanNa: e.target.checked }) }); });

  function renderItemsTiered(q, c) {
    const lineMap = {}; (c.perLine || []).forEach(l => lineMap[l.id] = l);
    const row = it => {
      const cl = lineMap[it.id];
      const behav = BEHAV[it.behaviour] || '';
      let tierCells = '';
      if (cl) {
        TIERS.forEach(t => {
          const tv = cl.tiers[t];
          const on = cl.selected === t;
          tierCells += `<td class="center"><div class="tcell ${on ? 'sel' : ''} ${cl.tiered ? '' : 'na'}" data-tier-pick="${it.id}" data-t="${t}">
            <span class="sp">${esc(tv.spec || '')}</span><span class="pr">${money(tv.sell)}</span></div></td>`;
        });
      } else tierCells = `<td class="center muted" colspan="3">—</td>`;
      const diff = cl && cl.selected !== c.base;
      const up = diff && TIERS.indexOf(cl.selected) > TIERS.indexOf(c.base);
      return `<tr>
        <td><b>${esc(it.code)}</b><br>${diff ? `<span class="tag ${up ? 't-up' : 't-down'}">${up ? '↑' : '↓'}</span>` : ''}</td>
        <td>${esc(it.name)}
          ${behav ? `<br><span class="tag tag-${it.behaviour === 'remeasurable' ? 'rem' : 'opt'}">${behav}</span>` : ''}
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;align-items:center;">
            <select data-method="${it.id}" style="width:104px;font-size:10.5px;" title="How this deliverable is done">
              <option value="" ${!it.method ? 'selected' : ''}>Default</option>
              <option value="in" ${it.method === 'in' ? 'selected' : ''}>In-house</option>
              <option value="sub" ${it.method === 'sub' ? 'selected' : ''}>Subcontract</option>
              <option value="mixed" ${it.method === 'mixed' ? 'selected' : ''}>Mixed</option></select>
            <input data-waste="${it.id}" type="number" step="0.5" placeholder="waste%" value="${it.wastageOverride ?? ''}" style="width:66px;font-size:10.5px;" title="Site-specific wastage % — overrides the recipe default (odd-shaped sites)">
            ${(it.method === 'sub' || it.method === 'mixed') ? `<input data-subdays="${it.id}" type="number" step="0.5" placeholder="sub days" value="${it.subDays ?? ''}" style="width:74px;font-size:10.5px;" title="Days the subcontractor needs on site">` : ''}
          </div>
        </td>
        <td><input type="number" step="0.01" value="${it.qty}" data-qty="${it.id}" style="width:70px;"> ${esc(it.unit)}</td>
        ${tierCells}
        <td class="right"><button class="btn btn-danger btn-sm" data-del="${it.id}">✕</button></td></tr>`;
    };
    const head = `<table><thead><tr><th>Code</th><th>Deliverable</th><th>Qty</th><th class="center">Basic</th><th class="center">Standard</th><th class="center">Premium</th><th></th></tr></thead><tbody>`;
    $('#scope1').innerHTML = q.items.scope1.length ? head + q.items.scope1.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 1 items yet.</p>';
    $('#scope2').innerHTML = q.items.scope2.length ? head + q.items.scope2.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 2 items yet.</p>';
    if (c.mixed) {
      const up = c.changes.filter(x => x.up).reduce((a, x) => a + x.delta, 0);
      const dn = c.changes.filter(x => !x.up).reduce((a, x) => a + x.delta, 0);
      $('#changesBar').innerHTML = `<div class="changesbar"><b>${c.changes.length} change(s) from ${c.base}:</b>
        ${c.changes.map(x => `<span class="tag ${x.up ? 't-up' : 't-down'}">${x.up ? '↑' : '↓'} ${esc(x.code)} → ${esc(x.to)} ${x.delta >= 0 ? '+' : ''}${money(x.delta)}</span>`).join(' ')}
        <span style="margin-left:auto;">Upgrades <b class="delta-up">+${money(up)}</b> · Downgrades <b class="delta-down">${money(dn)}</b></span></div>`;
    } else $('#changesBar').innerHTML = '';
    v.querySelectorAll('[data-tier-pick]').forEach(cell => cell.addEventListener('click', async () => {
      const l = lineMap[cell.dataset.tierPick]; if (!l || !l.tiered) return;
      state.scrollY = window.scrollY;
      const t = cell.dataset.t;
      await api(`/quotes/${q.id}/items/${cell.dataset.tierPick}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tierOverride: t === c.base ? null : t }) });
      reload();
    }));
    v.querySelectorAll('[data-qty]').forEach(i => i.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${i.dataset.qty}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: parseFloat(i.value) || 0 }) }); refreshCosting(); }));
    v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${b.dataset.del}`, { method: 'DELETE' }); reload(); }));
    v.querySelectorAll('[data-method]').forEach(s => s.addEventListener('change', async () => { state.scrollY = window.scrollY; await api(`/quotes/${q.id}/items/${s.dataset.method}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: s.value || null }) }); reload(); }));
    v.querySelectorAll('[data-waste]').forEach(i => i.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${i.dataset.waste}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wastageOverride: i.value === '' ? null : parseFloat(i.value) }) }); refreshCosting(); toast('Wastage updated'); }));
    v.querySelectorAll('[data-subdays]').forEach(i => i.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${i.dataset.subdays}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subDays: i.value === '' ? null : parseFloat(i.value) }) }); refreshCosting(); }));
  }

  function renderCostPanel(c) {
    const s = c.selected || {};
    if (isAdmin()) {
      const ok = !c.belowTarget;
      $('#costCard').innerHTML = `<h2>Cost, gross margin & site time ${c.mixed ? '<span class="tag t-up">Mixed selection</span>' : ''}</h2>
        <div class="sub">Gross margin only — overheads come off at year-end (Jobs tab). Sell = pricing sheet; guide = cost + ${c.target}% (${esc($('#f_ctier') ? $('#f_ctier').value : '')} target). GST is added at the very end.</div><div class="rule"></div>
        <div class="grid4">
          <div class="stat"><div class="k">Materials + delivery + plant</div><div class="v">${money((s.matCost || 0) + (s.delivery || 0) + (s.plant || 0))}</div></div>
          <div class="stat"><div class="k">Own labour</div><div class="v">${money(s.labCost)}</div></div>
          <div class="stat"><div class="k">Subcontract</div><div class="v">${money(s.subCost)}</div></div>
          <div class="stat hero"><div class="k">Total cost</div><div class="v">${money(s.cost)}</div></div>
        </div>
        <div class="grid4" style="margin-top:10px;">
          <div class="stat"><div class="k">Sell (ex GST)</div><div class="v">${money(s.sell)}</div></div>
          <div class="admin-only"><div class="k">🔒 Gross margin</div><div class="v" style="color:${ok ? 'var(--green)' : 'var(--red)'};">${money(c.grossMargin)} · ${c.grossMarginPct}%</div><div style="font-size:10px;color:${ok ? 'var(--green)' : 'var(--red)'};font-weight:700;">${ok ? 'Above' : 'BELOW'} ${c.target}% target</div></div>
          <div class="stat"><div class="k">Cost-plus guide (${c.target}%)</div><div class="v">${money(c.guidePrice)}</div><div style="font-size:10px;color:var(--grey);">Guide only — sheet sets sell</div></div>
          <div class="stat time"><div class="k">Total site duration</div><div class="v">${c.days} days</div>
            <div style="font-size:10px;color:#e0d0f5;line-height:1.5;">Our crew ${c.crewDays}d (${c.hours} person-hrs, crew ${c.crew})<br>Subcontractors ${c.subDays}d<br><b>Total ${c.days}d = crew + subbies</b></div></div>
        </div>
        <div class="legend">GST on the final client total: sell ${money(s.sell)} + GST ${money(s.sell * 0.1)} = <b>${money(s.sell * 1.1)}</b> inc. GST (before surcharges/Scope 2).</div>`;
    } else {
      $('#costCard').innerHTML = `<h2>Costing</h2><div class="rule"></div>
        <div class="grid3">
          <div class="stat"><div class="k">Total cost</div><div class="v">${money(s.cost)}</div></div>
          <div class="stat"><div class="k">Sell (ex GST)</div><div class="v">${money(s.sell)}</div></div>
          <div class="stat time"><div class="k">Total site duration</div><div class="v">${c.days} days</div>
            <div style="font-size:10px;color:#e0d0f5;line-height:1.5;">Our crew ${c.crewDays}d · Subcontractors ${c.subDays}d</div></div>
        </div>`;
    }
  }
}

function renderChecklist(checklist) {
  const host = $('#qchecklist'); if (!host) return;
  const cats = {}; (checklist || []).forEach(c => { (cats[c.category] = cats[c.category] || []).push(c); });
  host.innerHTML = Object.entries(cats).map(([cat, items]) => `<div style="margin-bottom:8px;"><div style="font-weight:800;font-size:11px;text-transform:uppercase;color:var(--grey);margin-bottom:4px;">${esc(cat)}</div>
    ${items.map(c => `<div class="check-row"><input type="checkbox" data-chk="${c.id}" ${c.checked ? 'checked' : ''}> ${esc(c.label)} ${c.critical ? '<span class="tag tag-rem">Critical</span>' : ''}</div>`).join('')}</div>`).join('');
  host.querySelectorAll('[data-chk]').forEach(cb => cb.addEventListener('change', async () => {
    state.scrollY = window.scrollY;
    await api(`/checklist/quote/${state.quoteId}/item/${cb.dataset.chk}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked: cb.checked, checkedBy: USER ? USER.name : 'Estimator' }) });
    quoteEditor($('#view'));
  }));
}

// ---------------- JOBS (won register + FY close) ----------------
async function jobsTab(v) {
  const data = await api('/jobs?fy=' + state.jobsFy);
  const fys = data.fys || [];
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Jobs won — register</h2><div class="sub">Quoted vs ACTUAL gross margin. Actuals come from the final (edited) PO for each job. Net margin is a year-end figure after overheads.</div></div>
      <div style="display:flex;gap:10px;align-items:flex-end;">
        <label style="font-size:11px;display:flex;align-items:center;gap:7px;padding-bottom:8px;"><input type="checkbox" id="gstTog" ${state.incGst ? 'checked' : ''} style="width:auto;"> Show inc. GST</label>
        <div class="field" style="margin:0;"><label>Financial year</label><select id="fySel"><option value="all">All years</option>${fys.map(f => `<option value="${f}" ${state.jobsFy === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="rule"></div>
    <div class="legend" style="margin-bottom:6px;">Showing <b>${state.incGst ? 'INCLUDING' : 'EXCLUDING'} GST</b>. Margins are calculated ex-GST either way.</div>
    <table><thead><tr><th>Quote</th><th>Client</th><th>FY</th><th>Package</th><th class="right">Sell ${state.incGst ? 'inc' : 'ex'} GST</th><th class="right">Quoted cost</th><th class="right">Quoted GM</th><th class="right">Actual cost (final PO)</th><th class="right">Actual GM</th><th>Status</th><th></th></tr></thead><tbody>
    ${(data.jobs || []).map(jb => {
      const aC = jb.actualGMPct == null ? 'var(--grey)' : (jb.actualGMPct >= jb.quotedGMPct ? 'var(--green)' : 'var(--red)');
      return `<tr><td><b>${esc(jb.quoteNumber)}</b></td><td>${esc(jb.client || '')}</td><td>${esc(jb.fy || '')}</td><td>${esc(jb.tier || '')}${jb.mixed ? ' <span class="tag t-up">mixed</span>' : ''}</td>
      <td class="right">${money(jb.sellExGst * (state.incGst ? 1.1 : 1))}</td><td class="right">${money(jb.quotedCost * (state.incGst ? 1.1 : 1))}</td>
      <td class="right"><b>${money(jb.quotedGM)} · ${jb.quotedGMPct}%</b></td>
      <td class="right">${jb.actualCost != null ? money(jb.actualCost * (state.incGst ? 1.1 : 1)) : '—'}</td>
      <td class="right"><b style="color:${aC};">${jb.actualGM != null ? money(jb.actualGM) + ' · ' + jb.actualGMPct + '%' : '—'}</b></td>
      <td><span class="tag ${jb.jobStatus === 'complete' ? 'tag-closed' : 'tag-open'}">${jb.jobStatus}</span></td>
      <td class="right">${jb.poId ? `<button class="btn btn-ghost btn-sm" data-po="${jb.poId}">PO</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="11" class="muted">No jobs won yet.</td></tr>'}</tbody></table>
    <div class="legend">All figures here are <b>GROSS margin</b> (before overheads). Edit a job's PO to update its actual cost.</div>
  </div>
  <div class="card"><h2>Year-end close — net margin</h2><div class="sub">Enter the year's overheads (office, insurance, vehicles…) once actual costs are known, then close the year.</div><div class="rule"></div>
    <div id="yearend">${fys.length ? '' : '<p class="muted">No completed financial years yet.</p>'}</div></div>`;
  $('#fySel').addEventListener('change', e => { state.jobsFy = e.target.value; jobsTab(v); });
  $('#gstTog').addEventListener('change', e => { state.incGst = e.target.checked; jobsTab(v); });
  v.querySelectorAll('[data-po]').forEach(b => b.addEventListener('click', () => { state.tab = 'po'; state.poId = b.dataset.po; shell(); }));
  if (fys.length) {
    const fy = state.jobsFy !== 'all' ? state.jobsFy : fys[0];
    const y = await api('/jobs/yearend/' + fy);
    const oh = y.overheads || {};
    $('#yearend').innerHTML = `
      <div class="grid4">
        <div class="stat"><div class="k">${fy} revenue (won jobs)</div><div class="v">${money(y.revenue * (state.incGst ? 1.1 : 1))}</div></div>
        <div class="stat"><div class="k">Actual cost</div><div class="v">${money(y.actualCost * (state.incGst ? 1.1 : 1))}</div></div>
        <div class="stat"><div class="k">Gross margin</div><div class="v">${money(y.grossMargin)} · ${y.grossMarginPct}%</div></div>
        <div class="stat ${y.netMargin >= 0 ? 'goodbox' : 'warnbox'}"><div class="k">NET margin (after overheads)</div><div class="v" style="color:${y.netMargin >= 0 ? 'var(--green)' : 'var(--red)'};">${money(y.netMargin)} · ${y.netMarginPct}%</div></div>
      </div>
      <div class="grid4" style="margin-top:12px;">
        ${['office', 'insurance', 'vehicles', 'other'].map(k => `<div class="field"><label>Overheads — ${k}</label><input data-oh="${k}" type="number" value="${oh[k] || ''}" ${y.closed ? 'disabled' : ''}></div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${y.closed ? `<span class="tag tag-closed">Year closed ${y.closedAt ? new Date(y.closedAt + 'Z').toLocaleDateString('en-AU') : ''}</span><button class="btn btn-ghost btn-sm" id="reopenFy">Reopen</button>`
        : `<button class="btn btn-ghost" id="saveOh">Save overheads</button><button class="btn btn-blue" id="closeFy">Close ${fy}</button>`}
        <span class="muted" style="font-size:11px;">Overheads total: <b>${money(y.overheadsTotal)}</b> · ${y.jobs} job(s), ${y.jobsWithActuals} with PO actuals</span>
      </div>`;
    const saveOh = $('#saveOh'); if (saveOh) saveOh.addEventListener('click', async () => {
      const body = {}; v.querySelectorAll('[data-oh]').forEach(i => body[i.dataset.oh] = parseFloat(i.value) || 0);
      await api('/jobs/yearend/' + fy + '/overheads', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('Overheads saved'); jobsTab(v);
    });
    const closeFy = $('#closeFy'); if (closeFy) closeFy.addEventListener('click', async () => {
      const body = {}; v.querySelectorAll('[data-oh]').forEach(i => body[i.dataset.oh] = parseFloat(i.value) || 0);
      await api('/jobs/yearend/' + fy + '/overheads', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (confirm('Close ' + fy + '? Overheads lock until reopened.')) { await api('/jobs/yearend/' + fy + '/close', { method: 'POST' }); toast(fy + ' closed'); jobsTab(v); }
    });
    const reopenFy = $('#reopenFy'); if (reopenFy) reopenFy.addEventListener('click', async () => { await api('/jobs/yearend/' + fy + '/reopen', { method: 'POST' }); jobsTab(v); });
  }
}

// ---------------- PURCHASE ORDERS ----------------
async function poList(v) {
  v.innerHTML = `<div class="card"><h2>Purchase Orders</h2><div class="sub">Created on acceptance. PO # = quote number. Edit lines to match the site — the final PO drives actual margin in Jobs.</div><div class="rule"></div><div id="potable">Loading…</div></div>`;
  const list = await api('/purchase-orders');
  $('#potable').innerHTML = list.length ? `<table><thead><tr><th>PO #</th><th>Client / site</th><th>Status</th>${isAdmin() ? '<th class="right">Actual cost</th>' : ''}<th>Prints</th><th></th></tr></thead><tbody>
    ${list.map(po => `<tr><td><b>PO ${esc(po.poNumber)}</b></td><td>${esc(po.client || '')} · ${esc(po.address || '')}</td><td><span class="tag tag-${po.status === 'open' ? 'open' : 'closed'}">${po.status}</span></td>${isAdmin() ? `<td class="right">${money(po.actualCost)}</td>` : ''}<td>${po.prints}</td><td class="right"><button class="btn btn-ghost btn-sm" data-po="${po.id}">Open</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No purchase orders yet — they appear when a client accepts a quote.</p>';
  v.querySelectorAll('[data-po]').forEach(b => b.addEventListener('click', () => { state.poId = b.dataset.po; route(); }));
}
async function poEditor(v) {
  const po = await api('/purchase-orders/' + state.poId);
  const admin = isAdmin();
  const VSTAT = { ordered: 't-ordered', delivered: 't-delivered', invoiced: 't-invoiced' };
  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>PO ${esc(po.poNumber)} — ${esc(po.client)}</h2><div class="sub">${esc(po.address || '')}</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" id="backPo">← All POs</button>
        <a class="btn btn-blue btn-sm" href="/api/purchase-orders/${po.id}/print/site" target="_blank">🖨 Print SITE copy (no $)</a>
        ${admin ? (po.status === 'open' ? '<button class="btn btn-danger btn-sm" id="closePo">Close PO (site complete)</button>' : '<button class="btn btn-ghost btn-sm" id="reopenPo">Reopen</button>') : ''}
        ${admin ? '<button class="btn btn-ghost btn-sm" id="resetPo">↺ Reset to quote</button>' : ''}
        ${admin ? '<button class="btn btn-ghost btn-sm" id="supersedePo">⇪ Job changed — new PO revision</button>' : ''}
      </div>
    </div>
    <div class="rule"></div>
    <div class="grid3">
      <div class="stat time"><div class="k">Total site duration</div><div class="v">${po.siteDays} days</div><div style="font-size:10px;color:#e0d0f5;">crew ${po.crewDays}d + subbies ${po.subDays}d</div></div>
      <div class="stat"><div class="k">Crew size</div><div class="v">${po.crewSize} people</div></div>
      <div class="stat"><div class="k">PO revision</div><div class="v">R${po.revision}${po.superseded ? ' (superseded)' : ''}</div></div>
    </div>
  </div>

  <div class="card">
    <div class="grid2">
      <div>
        <div class="scope-title">Site copy — approved deliverables (no $)</div>
        <table><thead><tr><th>Code</th><th>Item / spec + hrs</th><th>Qty</th></tr></thead><tbody>
          ${po.siteItems.map(i => `<tr><td><b>${esc(i.code || '')}</b></td><td>${esc(i.name)}${i.spec ? `<br><span class="muted" style="font-size:11px;">${esc(i.spec)}</span>` : ''}</td><td>${i.qty} ${esc(i.unit || '')}</td></tr>`).join('')}
        </tbody></table>
        ${po.siteChallenges.length ? `<div style="margin-top:8px;">${po.siteChallenges.map(c => `<span class="chip on">${esc(c)}</span>`).join('')}</div>` : ''}
      </div>
      <div>
        <div class="scope-title">Approved drawing</div>
        ${po.hasSiteplan ? `<img src="/api/purchase-orders/${po.id}/siteplan" style="width:100%;border:1px solid var(--line);border-radius:9px;">` : '<p class="muted">No drawing.</p>'}
      </div>
    </div>
    <div class="legend"><b>Print log:</b> ${po.prints.length ? po.prints.slice(0, 6).map(p => `${new Date(p.at + 'Z').toLocaleString('en-AU')} — ${esc(p.by || '')}`).join(' · ') : 'Not printed yet.'}</div>
  </div>

  ${admin ? `<div class="card">
    <h2>Vendor orders & ACTUAL cost <span class="tag t-up">drives Jobs register</span></h2>
    <div class="sub">Edit quantities, rates and vendors to match what actually happens on site. Print a Vendor PO per supplier. Status: Ordered → Delivered → Invoiced.</div><div class="rule"></div>
    ${(po.vendors || []).map(vd => {
      const lines = (po.costItems || []).filter(i => i.vendor === vd.name);
      return `<div class="recipe-box"><div class="recipe-title"><span>${esc(vd.name)} <span class="muted" style="font-weight:400;">— PO ${esc(po.poNumber)}-${esc(vd.suffix)}</span></span>
        <span style="display:flex;gap:6px;align-items:center;">
          <select data-vstat="${vd.id}" style="width:110px;font-size:10.5px;">${['ordered', 'delivered', 'invoiced'].map(s => `<option ${vd.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <a class="btn btn-ghost btn-sm" href="/api/purchase-orders/${po.id}/print/vendor/${vd.id}" target="_blank">🖨 Vendor PO</a>
        </span></div>
        <table><thead><tr><th>Item</th><th>Qty</th><th>Unit $</th><th class="right">Total</th><th></th></tr></thead><tbody>
        ${lines.map(i => `<tr><td><input value="${esc(i.name)}" data-pn="${i.id}" style="min-width:160px;"></td>
          <td><input type="number" step="0.01" value="${i.qty}" data-pq="${i.id}" style="width:78px;"> ${esc(i.unit || '')}</td>
          <td><input type="number" step="0.01" value="${i.unitCost}" data-pc="${i.id}" style="width:86px;"></td>
          <td class="right"><b>${money2(i.total)}</b></td>
          <td class="right"><button class="btn btn-danger btn-sm" data-prm="${i.id}">✕</button></td></tr>`).join('')}
        <tr><td colspan="3"><b>Vendor subtotal</b></td><td class="right"><b>${money2(vd.total)}</b></td><td></td></tr>
        </tbody></table></div>`;
    }).join('')}
    <div style="margin-top:10px;"><button class="btn btn-ghost btn-sm" id="addPoLine">+ Add cost line</button></div>
    <div class="grid4" style="margin-top:14px;">
      <div class="stat"><div class="k">Sell ex GST</div><div class="v">${po.sellExGst != null ? money(po.sellExGst) : '—'}</div></div>
      <div class="stat"><div class="k">Quoted cost</div><div class="v">${po.quotedCost != null ? money(po.quotedCost) : '—'}</div></div>
      <div class="stat hero"><div class="k">ACTUAL cost (this PO)</div><div class="v">${money(po.actualCost)}</div></div>
      <div class="admin-only"><div class="k">🔒 Actual gross margin</div><div class="v" style="color:${(po.actualGMPct || 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${po.actualGM != null ? money(po.actualGM) + ' · ' + po.actualGMPct + '%' : '—'}</div></div>
    </div>
  </div>` : ''}`;
  $('#backPo').addEventListener('click', () => { state.poId = null; route(); });
  const closeBtn = $('#closePo'); if (closeBtn) closeBtn.addEventListener('click', async () => { if (confirm('Close this PO? Its final lines become the job\'s actual cost.')) { await api('/purchase-orders/' + po.id + '/close', { method: 'POST' }); toast('PO closed'); poEditor(v); } });
  const reopenBtn = $('#reopenPo'); if (reopenBtn) reopenBtn.addEventListener('click', async () => { await api('/purchase-orders/' + po.id + '/reopen', { method: 'POST' }); poEditor(v); });
  const resetBtn = $('#resetPo'); if (resetBtn) resetBtn.addEventListener('click', async () => { if (confirm('Reset this PO back to the accepted quote? All site edits are lost.')) { const r = await api('/purchase-orders/' + po.id + '/reset', { method: 'POST' }); state.poId = r.id; toast('PO reset'); poEditor(v); } });
  const upd = (id, body) => api(`/purchase-orders/${po.id}/items/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => poEditor(v));
  v.querySelectorAll('[data-pq]').forEach(i => i.addEventListener('change', () => upd(i.dataset.pq, { qty: parseFloat(i.value) || 0 })));
  v.querySelectorAll('[data-pc]').forEach(i => i.addEventListener('change', () => upd(i.dataset.pc, { unitCost: parseFloat(i.value) || 0 })));
  v.querySelectorAll('[data-pn]').forEach(i => i.addEventListener('change', () => upd(i.dataset.pn, { name: i.value })));
  v.querySelectorAll('[data-prm]').forEach(b => b.addEventListener('click', async () => { await api(`/purchase-orders/${po.id}/items/${b.dataset.prm}`, { method: 'DELETE' }); poEditor(v); }));
  v.querySelectorAll('[data-vstat]').forEach(s => s.addEventListener('change', async () => { await api(`/purchase-orders/${po.id}/vendor-status/${s.dataset.vstat}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s.value }) }); toast('Status updated'); poEditor(v); }));
  const sup = $('#supersedePo'); if (sup) sup.addEventListener('click', async () => {
    if (!confirm('Job details changed?\n\nThis supersedes PO ' + po.poNumber + ' and creates the next revision.\nLines already Ordered or Delivered are carried forward.')) return;
    const r = await api('/purchase-orders/' + po.id + '/supersede', { method: 'POST' });
    if (r.error) return toast(r.error);
    state.poId = r.id; toast('New revision created — ' + r.carried + ' line(s) carried forward'); poEditor(v);
  });
  const addLine = $('#addPoLine'); if (addLine) addLine.addEventListener('click', async () => {
    const opts = await api('/purchase-orders/vendor-options');
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">Add cost line</h2>
      <div class="field"><label>Vendor / category</label><select id="cl_vendor">
        <optgroup label="Vendors">${(opts.vendors || []).map(x => `<option>${esc(x)}</option>`).join('')}</optgroup>
        <optgroup label="Other costs">${(opts.misc || []).map(x => `<option>${esc(x)}</option>`).join('')}</optgroup></select></div>
      <div class="field"><label>Description</label><input id="cl_name" placeholder="e.g. Repair to damaged fence panel"></div>
      <div class="grid3">
        <div class="field"><label>Qty</label><input id="cl_qty" type="number" step="0.01" value="1"></div>
        <div class="field"><label>Unit</label><input id="cl_unit" value="ea"></div>
        <div class="field"><label>Unit cost $</label><input id="cl_cost" type="number" step="0.01" value="0"></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="cl_cancel">Cancel</button><button class="btn btn-blue" id="cl_save">Add line</button></div></div>`;
    document.body.appendChild(bg);
    $('#cl_cancel').addEventListener('click', () => bg.remove());
    $('#cl_save').addEventListener('click', async () => {
      await api(`/purchase-orders/${po.id}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('#cl_name').value || 'Cost line', qty: parseFloat($('#cl_qty').value) || 1,
          unit: $('#cl_unit').value, unitCost: parseFloat($('#cl_cost').value) || 0, vendor: $('#cl_vendor').value, kind: 'material' }) });
      bg.remove(); toast('Line added'); poEditor(v);
    });
  });
}

// ---------------- VENDORS ----------------
async function vendorsTab(v) {
  const list = await api('/vendors');
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Vendors</h2><div class="sub">One combined list — tag each Supplier, Subcontractor or both. Compliance fields appear for subcontractors.</div></div><button class="btn btn-blue" id="addV">+ Add vendor</button></div><div class="rule"></div>
  <table><thead><tr><th>Vendor</th><th>Type</th><th>Area</th><th>Contact</th><th>Terms</th><th>Compliance</th><th>Materials</th><th></th></tr></thead><tbody>
  ${list.map(x => `<tr><td><b>${esc(x.name)}</b></td>
    <td>${x.isSupplier ? '<span class="tag t-sup">Supplier</span>' : ''} ${x.isSubcontractor ? '<span class="tag t-subv">Subcontractor</span>' : ''}</td>
    <td>${esc(x.area || '')}</td><td>${esc(x.contact || '')} ${esc(x.phone || '')}</td><td>${esc(x.terms || '')}</td>
    <td>${x.isSubcontractor ? (x.insuranceExpiry && x.insuranceExpiry < new Date().toISOString().slice(0, 10) ? '<span class="tag tag-superseded">Insurance expired</span>' : '<span class="tag tag-accepted">OK</span>') : '—'}</td>
    <td>${(x.materials || []).length}</td>
    <td class="right"><button class="btn btn-ghost btn-sm" data-ev="${x.id}">Open</button> <button class="btn btn-danger btn-sm" data-dv="${x.id}">✕</button></td></tr>`).join('')}
  </tbody></table></div><div id="vDetail"></div>`;
  $('#addV').addEventListener('click', async () => { const r = await api('/vendors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New vendor' }) }); vendorsTab(v).then(() => openVendor(r.id)); });
  v.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => openVendor(b.dataset.ev)));
  v.querySelectorAll('[data-dv]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete vendor?')) { await api('/vendors/' + b.dataset.dv, { method: 'DELETE' }); vendorsTab(v); } }));
  async function openVendor(id) {
    const all = await api('/vendors'); const x = all.find(y => y.id === id); if (!x) return;
    $('#vDetail').innerHTML = `<div class="card"><h2>${esc(x.name)}</h2><div class="rule"></div>
      <div class="grid3">
        <div class="field"><label>Name</label><input id="v_name" value="${esc(x.name)}"></div>
        <div class="field"><label>Contact</label><input id="v_contact" value="${esc(x.contact || '')}"></div>
        <div class="field"><label>Phone</label><input id="v_phone" value="${esc(x.phone || '')}"></div>
        <div class="field"><label>Email</label><input id="v_email" value="${esc(x.email || '')}"></div>
        <div class="field"><label>Area / proximity</label><input id="v_area" value="${esc(x.area || '')}"></div>
        <div class="field"><label>Payment terms</label><input id="v_terms" value="${esc(x.terms || '')}"></div>
      </div>
      <div style="display:flex;gap:18px;margin:6px 0 10px;">
        <label style="font-size:12px;display:flex;gap:7px;align-items:center;"><input type="checkbox" id="v_sup" ${x.isSupplier ? 'checked' : ''} style="width:auto;"> Supplier</label>
        <label style="font-size:12px;display:flex;gap:7px;align-items:center;"><input type="checkbox" id="v_sub" ${x.isSubcontractor ? 'checked' : ''} style="width:auto;"> Subcontractor</label>
      </div>
      <div class="grid3" id="compliance" style="${x.isSubcontractor ? '' : 'display:none;'}">
        <div class="field"><label>Licence no.</label><input id="v_lic" value="${esc(x.licence || '')}"></div>
        <div class="field"><label>Insurance expiry</label><input id="v_ins" type="date" value="${esc(x.insuranceExpiry || '')}"></div>
        <div class="field" style="display:flex;align-items:flex-end;"><label style="font-size:12px;display:flex;gap:7px;align-items:center;text-transform:none;"><input type="checkbox" id="v_swms" ${x.swms ? 'checked' : ''} style="width:auto;"> SWMS on file</label></div>
      </div>
      <button class="btn btn-blue" id="v_save">Save vendor</button>
      <div class="rule" style="margin-top:16px;"></div>
      <h2 style="font-size:12px;">Materials & rates</h2>
      <table><thead><tr><th>Material</th><th>Unit</th><th>Cost $</th><th>Delivery rule</th><th>Review by</th><th></th></tr></thead><tbody>
      ${(x.materials || []).map(m => `<tr>
        <td><input value="${esc(m.name)}" data-mn="${m.id}"></td><td><input value="${esc(m.unit || '')}" data-mu="${m.id}" style="width:60px;"></td>
        <td><input type="number" step="0.01" value="${m.cost}" data-mc="${m.id}" style="width:86px;"></td>
        <td><input value="${esc(m.deliveryRule || '')}" data-md="${m.id}" placeholder="e.g. $180/load, free over $1k"></td>
        <td><input type="date" value="${esc(m.reviewBy || '')}" data-mr="${m.id}" style="width:130px;"> ${m.reviewBy && m.reviewBy < new Date().toISOString().slice(0, 10) ? '<span class="tag tag-superseded">Stale</span>' : ''}</td>
        <td class="right"><button class="btn btn-danger btn-sm" data-mdel="${m.id}">✕</button></td></tr>`).join('')}
      </tbody></table>
      <button class="btn btn-ghost btn-sm" id="v_addm" style="margin-top:8px;">+ Add material</button></div>`;
    $('#v_sub').addEventListener('change', e => { $('#compliance').style.display = e.target.checked ? '' : 'none'; });
    $('#v_save').addEventListener('click', async () => {
      await api('/vendors/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: $('#v_name').value, contact: $('#v_contact').value, phone: $('#v_phone').value, email: $('#v_email').value,
        area: $('#v_area').value, terms: $('#v_terms').value, isSupplier: $('#v_sup').checked, isSubcontractor: $('#v_sub').checked,
        licence: $('#v_lic') ? $('#v_lic').value : '', insuranceExpiry: $('#v_ins') ? $('#v_ins').value : '', swms: $('#v_swms') ? $('#v_swms').checked : false }) });
      toast('Vendor saved'); vendorsTab(v);
    });
    $('#v_addm').addEventListener('click', async () => { await api(`/vendors/${id}/materials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New material' }) }); openVendor(id); });
    const mupd = (mid, body) => api(`/vendors/${id}/materials/${mid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    v.querySelectorAll('[data-mn]').forEach(i => i.addEventListener('change', () => mupd(i.dataset.mn, { name: i.value })));
    v.querySelectorAll('[data-mu]').forEach(i => i.addEventListener('change', () => mupd(i.dataset.mu, { unit: i.value })));
    v.querySelectorAll('[data-mc]').forEach(i => i.addEventListener('change', () => mupd(i.dataset.mc, { cost: parseFloat(i.value) || 0 })));
    v.querySelectorAll('[data-md]').forEach(i => i.addEventListener('change', () => mupd(i.dataset.md, { deliveryRule: i.value })));
    v.querySelectorAll('[data-mr]').forEach(i => i.addEventListener('change', () => mupd(i.dataset.mr, { reviewBy: i.value })));
    v.querySelectorAll('[data-mdel]').forEach(b => b.addEventListener('click', async () => { await api(`/vendors/${id}/materials/${b.dataset.mdel}`, { method: 'DELETE' }); openVendor(id); }));
    $('#vDetail').scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------------- MATERIALS & PLANT ----------------
async function materialsTab(v) {
  const [mats, vendors] = await Promise.all([api('/materials'), api('/vendors')]);
  const cat = state.matCat || 'all';
  const rows = mats.filter(m => cat === 'all' || m.category === cat);
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Materials &amp; Plant</h2><div class="sub">The master list. Each item has a default vendor; recipes reference these items, so a price change flows everywhere at once.</div></div>
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="seg" id="matSeg"><button data-v="all" class="${cat === 'all' ? 'on' : ''}">All</button><button data-v="material" class="${cat === 'material' ? 'on' : ''}">Materials</button><button data-v="plant" class="${cat === 'plant' ? 'on' : ''}">Plant</button></div>
        ${isAdmin() ? '<button class="btn btn-blue" id="addMat">+ Add item</button>' : ''}</div>
    </div><div class="rule"></div>
    <table><thead><tr><th>Item</th><th>Type</th><th>Unit</th><th>Default vendor</th>${isAdmin() ? '<th class="right">Cost</th>' : ''}<th>Used in recipes</th><th></th></tr></thead><tbody>
    ${rows.map(m => `<tr><td><b>${esc(m.name)}</b></td>
      <td><span class="tag ${m.category === 'plant' ? 't-plantm' : 't-matm'}">${m.category}</span></td><td>${esc(m.unit || '')}</td>
      <td>${m.defaultVendor ? esc(m.defaultVendor) : '<span class="tag tag-superseded">none set</span>'}</td>
      ${isAdmin() ? `<td class="right">${money2(m.defaultCost || 0)}</td>` : ''}
      <td>${m.usedIn.length ? m.usedIn.map(u => `<span class="tag t-def">${esc(u)}</span>`).join(' ') : '<span class="muted">not used</span>'}</td>
      <td class="right">${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-em="${m.id}">Open</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No items.</td></tr>'}
    </tbody></table></div><div id="matDetail"></div>`;
  $('#matSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.matCat = b.dataset.v; materialsTab(v); }));
  const add = $('#addMat'); if (add) add.addEventListener('click', async () => {
    const r = await api('/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New item', category: cat === 'plant' ? 'plant' : 'material' }) });
    await materialsTab(v); openMat(r.id);
  });
  v.querySelectorAll('[data-em]').forEach(b => b.addEventListener('click', () => openMat(b.dataset.em)));
  async function openMat(id) {
    const all = await api('/materials'); const m = all.find(x => x.id === id); if (!m) return;
    $('#matDetail').innerHTML = `<div class="card"><h2>${esc(m.name)}</h2><div class="rule"></div>
      <div class="grid4">
        <div class="field"><label>Name</label><input id="m_name" value="${esc(m.name)}"></div>
        <div class="field"><label>Unit</label><input id="m_unit" value="${esc(m.unit || '')}"></div>
        <div class="field"><label>Type</label><select id="m_cat"><option value="material" ${m.category === 'material' ? 'selected' : ''}>Material</option><option value="plant" ${m.category === 'plant' ? 'selected' : ''}>Plant</option></select></div>
        <div class="field"><label>Default vendor</label><select id="m_def"><option value="">— none —</option>${(m.vendors || []).map(x => `<option value="${x.vendorId}" ${x.isDefault ? 'selected' : ''}>${esc(x.vendor)}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-blue" id="m_save">Save item</button>
      <div class="rule" style="margin-top:16px;"></div>
      <h2 style="font-size:12px;">Vendors &amp; prices</h2>
      <div class="sub">Add alternates so you can switch on proximity, price or availability — at quote time or at Selections.</div>
      <table><thead><tr><th>Vendor</th><th class="right">Cost</th><th>Delivery rule</th><th>Review by</th><th>Default</th><th></th></tr></thead><tbody>
      ${(m.vendors || []).map(x => `<tr><td><b>${esc(x.vendor)}</b></td>
        <td class="right"><input type="number" step="0.01" value="${x.cost}" data-mvc="${x.id}" style="width:90px;text-align:right;"></td>
        <td><input value="${esc(x.deliveryRule || '')}" data-mvd="${x.id}" placeholder="e.g. $180/load, free over $1k"></td>
        <td><input type="date" value="${esc(x.reviewBy || '')}" data-mvr="${x.id}" style="width:135px;"> ${x.reviewBy && x.reviewBy < new Date().toISOString().slice(0, 10) ? '<span class="tag tag-superseded">stale</span>' : ''}</td>
        <td>${x.isDefault ? '<span class="tag tag-accepted">Default</span>' : `<button class="btn btn-ghost btn-sm" data-mvdef="${x.id}">Make default</button>`}</td>
        <td class="right"><button class="btn btn-danger btn-sm" data-mvdel="${x.id}">✕</button></td></tr>`).join('')}
      </tbody></table>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <select id="m_newv" style="max-width:220px;"><option value="">+ Add a vendor for this item…</option>${vendors.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <input id="m_newc" type="number" step="0.01" placeholder="cost" style="width:100px;">
        <button class="btn btn-ghost btn-sm" id="m_addv">Add</button>
      </div>
      <div class="legend">Used in: ${m.usedIn.length ? m.usedIn.join(', ') : 'no recipes yet'}. Items in use can\'t be deleted.</div>
    </div>`;
    $('#m_save').addEventListener('click', async () => {
      await api('/materials/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('#m_name').value, unit: $('#m_unit').value, category: $('#m_cat').value, defaultVendorId: $('#m_def').value || null }) });
      toast('Saved'); materialsTab(v);
    });
    $('#m_addv').addEventListener('click', async () => {
      if (!$('#m_newv').value) return;
      await api(`/materials/${id}/vendors`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorId: $('#m_newv').value, cost: parseFloat($('#m_newc').value) || 0 }) });
      openMat(id);
    });
    const upd = (mvId, body) => api(`/materials/${id}/vendors/${mvId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    v.querySelectorAll('[data-mvc]').forEach(i => i.addEventListener('change', () => upd(i.dataset.mvc, { cost: parseFloat(i.value) || 0 }).then(() => toast('Price updated'))));
    v.querySelectorAll('[data-mvd]').forEach(i => i.addEventListener('change', () => upd(i.dataset.mvd, { deliveryRule: i.value })));
    v.querySelectorAll('[data-mvr]').forEach(i => i.addEventListener('change', () => upd(i.dataset.mvr, { reviewBy: i.value })));
    v.querySelectorAll('[data-mvdef]').forEach(b => b.addEventListener('click', async () => { await upd(b.dataset.mvdef, { makeDefault: true }); openMat(id); }));
    v.querySelectorAll('[data-mvdel]').forEach(b => b.addEventListener('click', async () => { await api(`/materials/${id}/vendors/${b.dataset.mvdel}`, { method: 'DELETE' }); openMat(id); }));
    $('#matDetail').scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------------- RECIPES (three variants) ----------------
const VNAME = { in: 'In-house', sub: 'Subcontract', mixed: 'Mixed' };
async function recipesTab(v) {
  const [recs, mats, vendors] = await Promise.all([api('/recipes'), api('/materials'), api('/vendors')]);
  const openCode = state.recipeCode || (recs.find(r => Object.keys(r.variants).length) || recs[0] || {}).code;
  const cur = recs.find(r => r.code === openCode) || recs[0];
  const variant = state.recipeVariant || (cur && cur.defaultVariant) || 'in';
  v.innerHTML = `<div class="card">
      <h2>Cost recipes</h2><div class="sub">Every deliverable has three: In-house, Subcontract and Mixed. One is the default — it can be changed on a quote, and again at Selections before the PO.</div><div class="rule"></div>
      <div id="recPick">${recs.map(r => `<span class="pickitem ${r.code === openCode ? 'on' : ''}" data-rc="${esc(r.code)}">${esc(r.code)} ${esc(r.name.split(' ').slice(0, 2).join(' '))}${r.defaultVariant ? ` <span class="muted">· ${VNAME[r.defaultVariant]}</span>` : ' <span class="tag tag-superseded">none</span>'}</span>`).join('')}</div>
    </div>${cur ? `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><h2>${esc(cur.code)} — ${esc(cur.name)}</h2><div class="sub">per ${esc(cur.unit)}${isAdmin() && cur.indicative ? ' · indicative cost per unit at Standard: ' + Object.entries(cur.indicative).map(([k, val]) => `${VNAME[k]} ${money(val)}`).join(' · ') : ''}</div></div>
        <div class="seg" id="varSeg">${['in', 'sub', 'mixed'].map(x => `<button data-v="${x}" class="${variant === x ? 'on' : ''}">${VNAME[x]}${cur.defaultVariant === x ? ' ★' : ''}</button>`).join('')}</div>
      </div><div class="rule"></div><div id="recBody"></div></div>` : ''}`;
  v.querySelectorAll('[data-rc]').forEach(c => c.addEventListener('click', () => { state.recipeCode = c.dataset.rc; state.recipeVariant = null; recipesTab(v); }));
  const vs = $('#varSeg'); if (vs) vs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.recipeVariant = b.dataset.v; recipesTab(v); }));
  if (!cur) return;
  const R = cur.variants[variant];
  const body = $('#recBody');
  if (!R) {
    body.innerHTML = `<p class="muted">No ${VNAME[variant]} recipe for ${esc(cur.code)} yet.</p>${isAdmin() ? '<button class="btn btn-blue" id="mkVar">+ Create ' + VNAME[variant] + ' recipe</button>' : ''}`;
    const mk = $('#mkVar'); if (mk) mk.addEventListener('click', async () => { await api('/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priceItemId: cur.priceItemId, variant }) }); recipesTab(v); });
    return;
  }
  const matOpts = (sel) => `<option value="">—</option>` + mats.map(m => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
      ${R.isDefault ? '<span class="tag tag-accepted">Default delivery method</span>' : (isAdmin() ? `<button class="btn btn-ghost btn-sm" id="mkDef">Make this the default</button>` : '')}
      ${isAdmin() ? `<span style="font-size:11px;">Delivery $ <input type="number" id="r_del" value="${R.deliveryCost || 0}" style="width:80px;display:inline-block;"></span>` : ''}
    </div>
    <table><thead><tr><th>Component</th><th>Item / vendor</th><th>Ratio</th><th>Waste %</th><th class="center">Basic</th><th class="center">Standard</th><th class="center">Premium</th><th>Days</th><th></th></tr></thead><tbody>
    ${R.components.map(c => {
      if (c.kind === 'labour') return `<tr><td><span class="tag t-in">Our labour</span></td><td class="muted">Own crew · person-hrs per ${esc(cur.unit)}</td><td>—</td><td>—</td>
        ${['Basic', 'Standard', 'Premium'].map(t => `<td class="center"><input type="number" step="0.01" value="${c.hrs[t] || 0}" data-rh="${R.id}|${c.id}|${t}" style="width:70px;text-align:center;"></td>`).join('')}
        <td>—</td><td class="right"><button class="btn btn-danger btn-sm" data-rcdel="${R.id}|${c.id}">✕</button></td></tr>`;
      if (c.kind === 'sub') return `<tr><td><span class="tag t-subv">Subcontractor</span></td>
        <td><input value="${esc(c.label || '')}" data-rl="${R.id}|${c.id}" style="min-width:130px;">
          <select data-rv="${R.id}|${c.id}" style="margin-top:3px;font-size:10.5px;"><option value="">— vendor —</option>${vendors.map(x => `<option value="${x.id}" ${c.vendorId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
        <td><select data-rb="${R.id}|${c.id}" style="width:78px;font-size:10.5px;"><option value="unit" ${c.subBasis === 'unit' ? 'selected' : ''}>per unit</option><option value="lump" ${c.subBasis === 'lump' ? 'selected' : ''}>lump</option></select></td><td>—</td>
        ${['Basic', 'Standard', 'Premium'].map(t => `<td class="center">${isAdmin() ? `<input type="number" step="0.01" value="${(c.sub || {})[t] || 0}" data-rs="${R.id}|${c.id}|${t}" style="width:76px;text-align:center;">` : '<span class="muted">—</span>'}</td>`).join('')}
        <td><input type="number" step="0.5" value="${c.subDays || 0}" data-rd="${R.id}|${c.id}" style="width:60px;"></td>
        <td class="right"><button class="btn btn-danger btn-sm" data-rcdel="${R.id}|${c.id}">✕</button></td></tr>`;
      const tag = c.kind === 'plant' ? '<span class="tag t-plantm">Plant</span>' : '<span class="tag t-matm">Material</span>';
      return `<tr><td>${tag}</td>
        <td>${c.tiered
          ? ['Basic', 'Standard', 'Premium'].map(t => `<select data-rm="${R.id}|${c.id}|${t}" style="font-size:10.5px;margin-bottom:2px;">${matOpts(c.mat[t])}</select>`).join('')
          : `<select data-rmm="${R.id}|${c.id}">${matOpts(c.materialId)}</select>`}
          <label style="font-size:10px;display:flex;align-items:center;gap:5px;margin-top:3px;"><input type="checkbox" data-rt="${R.id}|${c.id}" ${c.tiered ? 'checked' : ''} style="width:auto;"> different per tier</label>
          ${c.vendor ? `<span class="muted" style="font-size:10px;">via ${esc(c.vendor)}</span>` : ''}</td>
        <td><input type="number" step="0.001" value="${c.ratio}" data-rr="${R.id}|${c.id}" style="width:74px;"></td>
        <td><input type="number" step="0.5" value="${c.wastagePct}" data-rw="${R.id}|${c.id}" style="width:62px;"></td>
        ${isAdmin() && c.tierCost ? ['Basic', 'Standard', 'Premium'].map(t => `<td class="center muted">${money2(c.tierCost[t] || 0)}</td>`).join('')
          : `<td class="center muted" colspan="3">${isAdmin() ? money2(c.unitCost || 0) + ' — from library' : 'from library'}</td>`}
        <td>—</td><td class="right"><button class="btn btn-danger btn-sm" data-rcdel="${R.id}|${c.id}">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">No components yet.</td></tr>'}
    </tbody></table>
    ${isAdmin() ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" data-addc="material">+ Material</button>
      <button class="btn btn-ghost btn-sm" data-addc="plant">+ Plant</button>
      <button class="btn btn-ghost btn-sm" data-addc="labour">+ Our labour</button>
      <button class="btn btn-ghost btn-sm" data-addc="sub">+ Subcontractor</button>
      <button class="btn btn-danger btn-sm" id="delRec" style="margin-left:auto;">Delete this recipe</button></div>` : ''}
    <div class="legend">Material prices come from the library — change one there and every recipe using it follows. Wastage here is the standard; each quote can override it for odd-shaped sites.</div>`;
  const rput = (rid, body) => api('/recipes/' + rid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cput = (key, body) => { const [rid, cid] = key.split('|'); return api(`/recipes/${rid}/components/${cid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); };
  const md = $('#mkDef'); if (md) md.addEventListener('click', async () => { await rput(R.id, { makeDefault: true }); toast('Default set'); recipesTab(v); });
  const rd = $('#r_del'); if (rd) rd.addEventListener('change', () => rput(R.id, { deliveryCost: parseFloat(rd.value) || 0 }).then(() => toast('Saved')));
  const bind = (sel, fn) => v.querySelectorAll(sel).forEach(i => i.addEventListener('change', () => fn(i)));
  bind('[data-rr]', i => cput(i.dataset.rr, { ratio: parseFloat(i.value) || 0 }));
  bind('[data-rw]', i => cput(i.dataset.rw, { wastagePct: parseFloat(i.value) || 0 }));
  bind('[data-rd]', i => cput(i.dataset.rd, { subDays: parseFloat(i.value) || 0 }));
  bind('[data-rl]', i => cput(i.dataset.rl, { label: i.value }));
  bind('[data-rv]', i => cput(i.dataset.rv, { vendorId: i.value || null }));
  bind('[data-rb]', i => cput(i.dataset.rb, { subBasis: i.value }));
  bind('[data-rmm]', i => cput(i.dataset.rmm, { materialId: i.value || null }));
  bind('[data-rt]', i => { const [rid, cid] = i.dataset.rt.split('|'); cput(rid + '|' + cid, { tiered: i.checked }).then(() => recipesTab(v)); });
  bind('[data-rh]', i => { const [rid, cid, t] = i.dataset.rh.split('|'); cput(rid + '|' + cid, { hrs: { [t]: parseFloat(i.value) || 0 } }); });
  bind('[data-rs]', i => { const [rid, cid, t] = i.dataset.rs.split('|'); cput(rid + '|' + cid, { sub: { [t]: parseFloat(i.value) || 0 } }); });
  bind('[data-rm]', i => { const [rid, cid, t] = i.dataset.rm.split('|'); cput(rid + '|' + cid, { mat: { [t]: i.value || null } }); });
  v.querySelectorAll('[data-rcdel]').forEach(b => b.addEventListener('click', async () => { const [rid, cid] = b.dataset.rcdel.split('|'); await api(`/recipes/${rid}/components/${cid}`, { method: 'DELETE' }); recipesTab(v); }));
  v.querySelectorAll('[data-addc]').forEach(b => b.addEventListener('click', async () => {
    await api(`/recipes/${R.id}/components`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: b.dataset.addc, label: b.dataset.addc === 'sub' ? 'Subcontractor' : null }) });
    recipesTab(v);
  }));
  const dr = $('#delRec'); if (dr) dr.addEventListener('click', async () => { if (confirm('Delete the ' + VNAME[variant] + ' recipe for ' + cur.code + '?')) { await api('/recipes/' + R.id, { method: 'DELETE' }); state.recipeVariant = null; recipesTab(v); } });
}

// ---------------- SELECTIONS ----------------
async function selectionsTab(v) {
  const rows = await api('/selections');
  v.innerHTML = `<div class="card"><h2>Selections</h2>
    <div class="sub">Every won job lands here first. Confirm how each deliverable will actually be done and who supplies it — then lock it and the PO is raised from those decisions.</div><div class="rule"></div>
    <table><thead><tr><th>Quote</th><th>Client / site</th><th>Package</th><th>Stage</th><th>PO</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r.quoteNumber)}</b></td><td>${esc(r.client || '')}<br><span class="muted" style="font-size:10.5px;">${esc(r.address || '')}</span></td>
      <td>${esc(r.acceptedPackage || '')}</td>
      <td><span class="tag ${r.locked ? 'tag-accepted' : 'tag-incomplete'}">${esc(r.stage)}</span></td>
      <td>${r.poNumber ? esc(r.poNumber) : '<span class="muted">—</span>'}</td>
      <td class="right"><button class="btn ${r.locked ? 'btn-ghost' : 'btn-blue'} btn-sm" data-sel="${r.id}">${r.locked ? 'View' : 'Make selections'}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No won jobs yet.</td></tr>'}
    </tbody></table></div>`;
  v.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => { state.selQuoteId = b.dataset.sel; route(); }));
}
async function selectionDetail(v) {
  const d = await api('/selections/' + state.selQuoteId);
  const dCost = d.final.cost - d.quoted.cost, dDays = Math.round((d.final.days - d.quoted.days) * 10) / 10;
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Selections — Quote ${esc(d.quoteNumber)} · ${esc(d.client || '')}</h2><div class="sub">${esc(d.address || '')}</div></div>
      <div style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" id="backSel">← All selections</button>
        ${d.locked ? '<button class="btn btn-ghost btn-sm" id="unlockSel">Unlock</button>' : ''}</div>
    </div><div class="rule"></div>
    <table><thead><tr><th>Code</th><th>Deliverable</th><th>Qty</th><th>Quoted as</th><th>Final method</th><th>Vendor</th><th>Sub days</th><th class="right">Cost impact</th></tr></thead><tbody>
    ${d.lines.map(l => `<tr ${l.delta !== 0 ? 'style="background:#FFFBF2;"' : ''}>
      <td><b>${esc(l.code)}</b></td><td>${esc(l.name)}<br><span class="muted" style="font-size:10.5px;">${esc(l.spec || '')}</span></td>
      <td>${l.qty} ${esc(l.unit || '')}</td>
      <td><span class="tag ${l.quotedMethod === 'in' ? 't-in' : l.quotedMethod === 'sub' ? 't-subv' : 't-mix'}">${VNAME[l.quotedMethod] || l.quotedMethod}</span></td>
      <td><select data-sm="${l.id}" ${d.locked ? 'disabled' : ''} style="width:118px;">
        ${['in', 'sub', 'mixed'].map(x => `<option value="${x}" ${l.finalMethod === x ? 'selected' : ''} ${l.availableVariants.includes(x) ? '' : 'disabled'}>${VNAME[x]}${l.variantCost[x] ? ' · ' + money(l.variantCost[x].cost) : ''}</option>`).join('')}</select></td>
      <td><select data-sv="${l.id}" ${d.locked ? 'disabled' : ''} style="width:140px;"><option value="">Default vendor</option>${d.vendors.map(x => `<option value="${x.id}" ${l.selVendorId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
      <td><input type="number" step="0.5" value="${l.subDays ?? ''}" data-sd="${l.id}" ${d.locked ? 'disabled' : ''} style="width:62px;"></td>
      <td class="right"><b style="color:${l.delta < 0 ? 'var(--green)' : l.delta > 0 ? 'var(--red)' : 'var(--grey)'};">${l.delta === 0 ? 'no change' : (l.delta > 0 ? '+' : '') + money(l.delta)}</b></td></tr>`).join('')}
    </tbody></table>
    <div class="grid4" style="margin-top:14px;">
      <div class="stat"><div class="k">Quoted cost</div><div class="v">${money(d.quoted.cost)}</div></div>
      <div class="stat hero"><div class="k">Selected cost</div><div class="v">${money(d.final.cost)}</div><div style="font-size:10px;color:#cfe0ff;">${dCost === 0 ? 'same as quoted' : (dCost > 0 ? '+' : '') + money(dCost)}</div></div>
      <div class="admin-only"><div class="k">🔒 Margin after selections</div><div class="v" style="color:${d.final.marginPct >= d.quoted.marginPct ? 'var(--green)' : 'var(--red)'};">${d.final.marginPct}%</div><div style="font-size:10px;">was ${d.quoted.marginPct}% at quote</div></div>
      <div class="stat time"><div class="k">Revised duration</div><div class="v">${d.final.days} days</div><div style="font-size:10px;color:#e0d0f5;">crew ${d.final.crewDays}d + subbies ${d.final.subDays}d${dDays !== 0 ? ` · ${dDays > 0 ? '+' : ''}${dDays}d vs quote` : ''}</div></div>
    </div>
    ${d.locked ? '<div class="legend" style="margin-top:12px;">Selections are locked and the PO has been raised. Unlock to change them — the PO will need superseding.</div>'
      : '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button class="btn btn-blue" id="lockSel">Lock selections &amp; create PO →</button></div>'}
  </div>`;
  $('#backSel').addEventListener('click', () => { state.selQuoteId = null; route(); });
  const put = (id, body) => api(`/selections/${state.selQuoteId}/line/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => selectionDetail(v));
  v.querySelectorAll('[data-sm]').forEach(s => s.addEventListener('change', () => put(s.dataset.sm, { method: s.value })));
  v.querySelectorAll('[data-sv]').forEach(s => s.addEventListener('change', () => put(s.dataset.sv, { vendorId: s.value || null })));
  v.querySelectorAll('[data-sd]').forEach(i => i.addEventListener('change', () => put(i.dataset.sd, { subDays: i.value === '' ? null : parseFloat(i.value) })));
  const lock = $('#lockSel'); if (lock) lock.addEventListener('click', async () => {
    if (!confirm('Lock these selections and raise the PO?')) return;
    const r = await api(`/selections/${state.selQuoteId}/lock`, { method: 'POST' });
    toast(r.poId ? 'Selections locked — PO raised' : 'Locked, but PO creation failed');
    if (r.poId) { state.tab = 'po'; state.poId = r.poId; state.selQuoteId = null; shell(); } else selectionDetail(v);
  });
  const un = $('#unlockSel'); if (un) un.addEventListener('click', async () => { await api(`/selections/${state.selQuoteId}/unlock`, { method: 'POST' }); selectionDetail(v); });
}

// ---------------- PRICING ----------------
async function pricingSheet(v) {
  const items = await api('/price-list');
  const canEdit = isAdmin();
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Standard Pricing Sheet</h2><div class="sub">Sell rates. Editing never changes quotes already built (rate-locked).</div></div>${canEdit ? '<button class="btn btn-blue" id="addItem">+ Add deliverable</button>' : ''}</div><div class="rule"></div>
    <table><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th>Basic</th><th>Standard</th><th>Premium</th><th>Flag</th><th></th></tr></thead><tbody>
    ${items.map(p => `<tr><td><b>${esc(p.code)}</b></td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Basic.spec)}</span><br>${money(p.tiers.Basic.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Standard.spec)}</span><br>${money(p.tiers.Standard.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Premium.spec)}</span><br>${money(p.tiers.Premium.sell)}</td>
      <td>${p.behaviour !== 'none' ? `<span class="tag tag-${p.behaviour === 'remeasurable' ? 'rem' : 'opt'}">${BEHAV[p.behaviour]}</span>` : ''}</td>
      <td class="right">${canEdit ? `<button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  if (canEdit) { $('#addItem').addEventListener('click', () => editPriceItem(null)); v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editPriceItem(items.find(p => p.id === b.dataset.edit)))); }
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
  const del = $('#p_del'); if (del) del.addEventListener('click', async () => { if (confirm('Delete?')) { await api('/price-list/' + item.id, { method: 'DELETE' }); bg.remove(); pricingSheet($('#view')); } });
}

// ---------------- SURCHARGES / CHECKLIST ----------------
async function surchargesTab(v) {
  const surs = await api('/price-list/surcharges/all');
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Site-Specific Surcharges</h2></div><button class="btn btn-blue" id="addSur">+ Add surcharge</button></div><div class="rule"></div>
    <table><thead><tr><th>Name</th><th>Trigger</th><th>Type</th><th>Rate</th><th></th></tr></thead><tbody>
    ${surs.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.trigger_note || '')}</td><td>${s.kind === 'percent' ? '% of Scope 1' : 'Fixed $'}</td><td>${s.kind === 'percent' ? s.rate + '%' : money(s.rate)}</td><td class="right"><button class="btn btn-ghost btn-sm" data-es="${s.id}">Edit</button> <button class="btn btn-danger btn-sm" data-ds="${s.id}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addSur').addEventListener('click', () => editSur(null));
  v.querySelectorAll('[data-es]').forEach(b => b.addEventListener('click', () => editSur(surs.find(s => s.id === b.dataset.es))));
  v.querySelectorAll('[data-ds]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete?')) { await api('/price-list/surcharges/' + b.dataset.ds, { method: 'DELETE' }); surchargesTab(v); } }));
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
    bg.remove(); toast('Saved'); surchargesTab($('#edBody') || $('#view'));
  });
}
async function checklistTab(v) {
  const tpl = await api('/checklist/template');
  const cats = {}; tpl.forEach(i => { (cats[i.category] = cats[i.category] || []).push(i); });
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;"><div><h2>Structural Checklist Template</h2><div class="sub">Each new quote copies this.</div></div><button class="btn btn-blue" id="addChk">+ Add item</button></div><div class="rule"></div>
    ${Object.entries(cats).map(([cat, items]) => `<div style="margin-bottom:14px;"><div style="font-weight:800;font-size:12px;text-transform:uppercase;margin-bottom:6px;">${esc(cat)}</div>
      ${items.map(i => `<div class="check-row" style="justify-content:space-between;"><div>${esc(i.label)} ${i.critical ? '<span class="tag tag-rem">Critical</span>' : ''}</div><div><button class="btn btn-ghost btn-sm" data-ec="${i.id}">Edit</button> <button class="btn btn-danger btn-sm" data-dc="${i.id}">✕</button></div></div>`).join('')}</div>`).join('')}</div>`;
  $('#addChk').addEventListener('click', () => editChk(null));
  v.querySelectorAll('[data-ec]').forEach(b => b.addEventListener('click', () => editChk(tpl.find(i => i.id === b.dataset.ec))));
  v.querySelectorAll('[data-dc]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete item?')) { await api('/checklist/template/' + b.dataset.dc, { method: 'DELETE' }); checklistTab(v); } }));
}
function editChk(i) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${i ? 'Edit' : 'Add'} checklist item</h2>
    <div class="field"><label>Category</label><input id="c_cat" value="${esc(i?.category || 'General')}"></div>
    <div class="field"><label>Label</label><input id="c_label" value="${esc(i?.label || '')}"></div>
    <label style="font-size:12px;display:flex;align-items:center;gap:7px;margin-bottom:12px;"><input type="checkbox" id="c_crit" ${i?.critical ? 'checked' : ''} style="width:auto;"> Critical</label>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="c_cancel">Cancel</button><button class="btn btn-blue" id="c_save">Save</button></div></div>`;
  document.body.appendChild(bg);
  $('#c_cancel').addEventListener('click', () => bg.remove());
  $('#c_save').addEventListener('click', async () => {
    const body = { category: $('#c_cat').value, label: $('#c_label').value, critical: $('#c_crit').checked };
    if (i) await api('/checklist/template/' + i.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); else await api('/checklist/template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); checklistTab($('#edBody') || $('#view'));
  });
}

// ---------------- SETTINGS ----------------
async function settingsTab(v) {
  const [s, users] = await Promise.all([api('/settings'), api('/auth/users')]);
  v.innerHTML = `
  <div class="card"><h2>Current settings</h2><div class="sub">What the tool is using right now.</div><div class="rule"></div>
    <div class="grid3">
      <div class="stat"><div class="k">Customer tiers — target gross margin</div>
        <div style="font-size:12.5px;line-height:1.9;margin-top:4px;"><b>Bronze</b> ${esc(s.tier_bronze || '15')}% · <b>Silver</b> ${esc(s.tier_silver || '25')}% · <b>Gold</b> ${esc(s.tier_gold || '35')}%</div></div>
      <div class="stat"><div class="k">Quote ageing</div>
        <div style="font-size:12.5px;line-height:1.9;margin-top:4px;">Follow up <b>${esc(s.age_flag || '7')}d</b> · Chase <b>${esc(s.age_chase || '14')}d</b> · Dead <b>${esc(s.age_dead || '30')}d</b></div></div>
      <div class="stat"><div class="k">Labour &amp; crew</div>
        <div style="font-size:12.5px;line-height:1.9;margin-top:4px;"><b>${money(parseFloat(s.crew_day_rate || 1150))}</b>/day for <b>${esc(s.crew_people || '2')}</b> people · <b>${esc(s.hours_per_day || '8')}</b> hrs/day<br>
        <span class="muted">= ${money2((parseFloat(s.crew_day_rate || 1150) / Math.max(1, parseFloat(s.crew_people || 2)) / Math.max(1, parseFloat(s.hours_per_day || 8))))} per person-hour</span></div></div>
    </div></div>
  <div class="card"><h2>Customer tiers — target gross margin</h2><div class="sub">Warns on quotes below target, and drives the cost-plus guide price.</div><div class="rule"></div>
    <div class="grid3">${[['tier_bronze', 'Bronze %'], ['tier_silver', 'Silver %'], ['tier_gold', 'Gold %']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <button class="btn btn-blue" id="saveTiers">Save tiers</button></div>
  <div class="card"><h2>Quote ageing (days)</h2><div class="rule"></div>
    <div class="grid3">${[['age_flag', 'Follow up from'], ['age_chase', 'Chase from'], ['age_dead', 'Dead from']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <button class="btn btn-blue" id="saveAge">Save ageing</button></div>
  <div class="card"><h2>Labour & crew rates</h2><div class="sub">Used by every recipe: crew day rate ÷ people ÷ hours = cost per person-hour. Site time uses crew size on each quote.</div><div class="rule"></div>
    <div class="grid4">${[['crew_day_rate', 'Crew day rate $'], ['crew_people', 'People in day rate'], ['extra_person_rate', 'Extra person $/day'], ['hours_per_day', 'Hours per day']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <button class="btn btn-blue" id="saveLab">Save rates</button></div>
  <div class="card"><h2>Logins</h2><div class="sub">Estimators see quotes, builder and cost totals only — no margin, vendors, recipes, surcharges, checklist or settings.</div><div class="rule"></div>
    <table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th></tr></thead><tbody>
    ${(users || []).map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td><span class="tag ${u.role === 'admin' ? 'tag-accepted' : 'tag-draft'}">${u.role}</span></td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-eu="${u.id}">Reset password</button> <button class="btn btn-danger btn-sm" data-du="${u.id}">✕</button></td></tr>`).join('')}</tbody></table>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;"><input id="nu_name" placeholder="Name" style="width:140px;"><input id="nu_user" placeholder="username" style="width:120px;"><input id="nu_pass" placeholder="password" style="width:130px;"><select id="nu_role" style="width:110px;"><option value="estimator">Estimator</option><option value="admin">Admin</option></select><button class="btn btn-blue btn-sm" id="addUser">+ Add login</button></div></div>
  <div class="card"><h2>Company</h2><div class="rule"></div><div class="grid2">
      ${[['company_name', 'Company name'], ['company_abn', 'ABN'], ['company_lic', 'Licence'], ['company_phone', 'Phone'], ['company_email', 'Email (Zoho)'], ['association_line', 'Association line'], ['company_address', 'Address'], ['tagline', 'Tagline']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" value="${esc(s[k])}"></div>`).join('')}
    </div>
    <div style="font-size:11.5px;margin:6px 0 10px;">Email provider: ${s.emailProvider ? `<span class="tag tag-accepted">${esc(s.emailProvider)}</span>` : '<span class="tag tag-superseded">none configured</span>'}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
      <input id="testTo" placeholder="send test to…" value="${esc(s.company_email || '')}" style="max-width:250px;">
      <button class="btn btn-ghost btn-sm" id="testEmail">Send test email</button>
      <span id="testResult" style="font-size:11.5px;"></span>
    </div>
    <button class="btn btn-blue" id="saveCompany">Save company</button></div>
  <div class="card"><h2>Package descriptions</h2><div class="rule"></div>${TIERS.map(t => `<div class="field"><label>${t}</label><textarea id="set_pkg_desc_${t.toLowerCase()}" rows="2">${esc(s['pkg_desc_' + t.toLowerCase()])}</textarea></div>`).join('')}<button class="btn btn-blue" id="savePkg">Save descriptions</button></div>
  <div class="card"><h2>Contract text</h2><div class="sub">Protections: one per line as "Title|Detail".</div><div class="rule"></div>
    <div class="field"><label>Default special clauses</label><textarea id="set_default_special_clauses" rows="3">${esc(s.default_special_clauses)}</textarea></div>
    <div class="field"><label>Warranty</label><textarea id="set_warranty_text" rows="4">${esc(s.warranty_text)}</textarea></div>
    <div class="field"><label>Your Protections</label><textarea id="set_protections_text" rows="5">${esc(s.protections_text)}</textarea></div>
    <div class="field"><label>Standard conditions</label><textarea id="set_standard_conditions" rows="6">${esc(s.standard_conditions)}</textarea></div>
    <button class="btn btn-blue" id="saveContract">Save contract text</button></div>`;
  const save = (keys, msg) => async () => { const body = {}; keys.forEach(k => body[k] = $('#set_' + k).value); await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(msg); };
  $('#saveTiers').addEventListener('click', save(['tier_bronze', 'tier_silver', 'tier_gold'], 'Tiers saved'));
  $('#saveAge').addEventListener('click', save(['age_flag', 'age_chase', 'age_dead'], 'Ageing saved'));
  $('#saveLab').addEventListener('click', save(['crew_day_rate', 'crew_people', 'extra_person_rate', 'hours_per_day'], 'Rates saved'));
  $('#testEmail').addEventListener('click', async () => {
    const el = $('#testResult'); el.innerHTML = '<span class="muted">Testing…</span>';
    const r = await api('/settings/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: $('#testTo').value }) });
    el.innerHTML = r.ok
      ? `<span style="color:var(--green);font-weight:700;">✓ Sent via ${esc(r.provider)} — check ${esc(r.to)}</span>`
      : `<span style="color:var(--red);font-weight:700;">✕ ${esc(r.error || 'failed')}</span><br><span class="muted">${esc(r.hint || '')}</span>`;
  });
  $('#saveCompany').addEventListener('click', save(['company_name', 'company_abn', 'company_lic', 'company_phone', 'company_email', 'association_line', 'company_address', 'tagline'], 'Company saved'));
  $('#savePkg').addEventListener('click', save(['pkg_desc_basic', 'pkg_desc_standard', 'pkg_desc_premium'], 'Descriptions saved'));
  $('#saveContract').addEventListener('click', save(['default_special_clauses', 'warranty_text', 'protections_text', 'standard_conditions'], 'Contract text saved'));
  $('#addUser').addEventListener('click', async () => {
    const r = await api('/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#nu_name').value, username: $('#nu_user').value, password: $('#nu_pass').value, role: $('#nu_role').value }) });
    if (r.error) toast(r.error); else { toast('Login added'); settingsTab(v); }
  });
  v.querySelectorAll('[data-eu]').forEach(b => b.addEventListener('click', async () => {
    const p = prompt('New password for this user:'); if (!p) return;
    await api('/auth/users/' + b.dataset.eu, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p }) });
    toast('Password reset');
  }));
  v.querySelectorAll('[data-du]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this login?')) { const r = await api('/auth/users/' + b.dataset.du, { method: 'DELETE' }); if (r.error) toast(r.error); settingsTab(v); } }));
}

boot();
