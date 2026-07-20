// Estate Landscapers — admin SPA (vanilla JS, no build step)
const $ = (s, r = document) => r.querySelector(s);
const api = (p, opts) => fetch('/api' + p, opts).then(async r => { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return {}; } });
const money = n => '$' + Math.round(n || 0).toLocaleString('en-AU');
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIERS = ['Basic', 'Standard', 'Premium'];
const BEHAV = { none: '', remeasurable: 'Remeasurable', rate_only: 'Rate only', optional: 'Optional', allowance: 'Allowance' };
let state = { tab: 'quotes', quoteId: null, mgmtUnlocked: false };

function toast(msg) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
const LOGO = `<svg width="28" height="28" viewBox="0 0 100 100" fill="none"><path d="M50 8 L92 62 L50 62 L50 8" stroke="#1E5BFF" stroke-width="6" stroke-linejoin="round"/><path d="M50 8 L8 62 L50 62" stroke="#1E5BFF" stroke-width="6" stroke-linejoin="round"/><line x1="50" y1="30" x2="50" y2="62" stroke="#1E5BFF" stroke-width="6"/><line x1="30" y1="62" x2="30" y2="92" stroke="#1E5BFF" stroke-width="6"/><line x1="70" y1="62" x2="70" y2="92" stroke="#1E5BFF" stroke-width="6"/><circle cx="65" cy="24" r="4" stroke="#1E5BFF" stroke-width="6"/></svg>`;

function shell() {
  const tabs = [['quotes', 'Quotes'], ['pricing', 'Pricing Sheet'], ['surcharges', 'Surcharges'], ['checklist', 'Checklist'], ['settings', 'Settings']];
  $('#app').innerHTML = `
    <div class="top">
      <div class="brand">${LOGO}<div><b>ESTATE LANDSCAPERS</b><span>Quote Tool</span></div></div>
      <div class="nav">${tabs.map(t => `<button data-tab="${t[0]}" class="${state.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
      <div class="spacer"></div>
      <span class="tag ${state.mgmtUnlocked ? 'tag-accepted' : 'tag-draft'}">${state.mgmtUnlocked ? '🔓 Management' : '🔒 Team view'}</span>
    </div>
    <div class="wrap" id="view"></div>`;
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.quoteId = null; route(); }));
  route();
}
function route() {
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const v = $('#view');
  if (state.tab === 'quotes') return state.quoteId ? quoteEditor(v) : quotesList(v);
  if (state.tab === 'pricing') return pricingSheet(v);
  if (state.tab === 'surcharges') return surchargesTab(v);
  if (state.tab === 'checklist') return checklistTab(v);
  if (state.tab === 'settings') return settingsTab(v);
}

// ---------------- QUOTES LIST ----------------
async function quotesList(v) {
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;">
    <div><h2>Quotes</h2><div class="sub">Every quote and its revisions. Only the latest revision is the live client link.</div></div>
    <button class="btn btn-blue" id="newQuote">+ New quote</button></div>
    <div class="rule"></div><div id="qtable">Loading…</div></div>`;
  $('#newQuote').addEventListener('click', newQuote);
  const list = await api('/quotes');
  if (!list.length) { $('#qtable').innerHTML = `<p class="muted">No quotes yet. Create your first one.</p>`; return; }
  $('#qtable').innerHTML = `<table><thead><tr><th>Quote</th><th>Client</th><th>Project</th><th>Status</th><th>Views</th><th>Updated</th><th></th></tr></thead><tbody>
    ${list.map(q => `<tr>
      <td><b>${esc(q.quoteNumber)}</b></td><td>${esc(q.client || '—')}</td><td>${esc(q.projectTitle || '')}</td>
      <td><span class="tag tag-${q.status}">${q.status}${q.acceptedPackage ? ' · ' + esc(q.acceptedPackage) : ''}</span></td>
      <td>${q.views}</td><td class="muted">${new Date(q.updatedAt + 'Z').toLocaleDateString('en-AU')}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-open="${q.id}">Open</button></td>
    </tr>`).join('')}</tbody></table>`;
  v.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.quoteId = b.dataset.open; route(); }));
}
async function newQuote() {
  const q = await api('/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: '', projectTitle: 'Landscape Works' }) });
  state.quoteId = q.id; route();
}

// ---------------- QUOTE EDITOR ----------------
async function quoteEditor(v) {
  v.innerHTML = `<p class="muted">Loading quote…</p>`;
  const [q, priceItems, surcharges] = await Promise.all([api('/quotes/' + state.quoteId), api('/price-list'), api('/price-list/surcharges/all')]);
  const link = location.origin + '/q/' + q.token;
  const applied = q.appliedSurcharges || [];
  const isApplied = id => applied.some(s => s.id === id);

  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div><h2>Quote ${esc(q.quoteNumber)}</h2><div class="sub">${esc(q.client || 'New client')} · ${esc(q.address || 'no address yet')}</div></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" id="backList">← All quotes</button>
        <button class="btn btn-ghost" id="newRev">+ New revision</button>
        <span class="tag tag-${q.status}">${q.status}</span>
      </div>
    </div>
    <div class="rule"></div>
    <div class="linkbar"><span>🔗 Live client link:</span><input id="linkInput" readonly value="${esc(link)}"><button class="btn btn-blue btn-sm" id="copyLink">Copy</button><a class="btn btn-ghost btn-sm" href="${esc(link)}" target="_blank">Preview</a></div>
  </div>

  <div class="card">
    <h2>Details</h2><div class="rule"></div>
    <div class="grid2">
      <div class="field"><label>Client name</label><input id="f_client" value="${esc(q.client || '')}"></div>
      <div class="field"><label>Client email</label><input id="f_email" value="${esc(q.clientEmail || '')}"></div>
      <div class="field"><label>Project title</label><input id="f_title" value="${esc(q.projectTitle || '')}"></div>
      <div class="field"><label>Site address</label><input id="f_address" value="${esc(q.address || '')}"></div>
      <div class="field"><label>Quote date</label><input id="f_date" type="date" value="${esc(q.date || '')}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Default package (shown to client)</label>
        <div class="seg" id="segPkg">${TIERS.map(t => `<button data-v="${t}" class="${q.defaultPackage === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Payment schedule</label>
        <div class="seg" id="segPay"><button data-v="standard" class="${q.paymentSchedule === 'standard' ? 'on' : ''}">Standard 10/20/30/30/10</button><button data-v="small" class="${q.paymentSchedule === 'small' ? 'on' : ''}">Small 50/40/10</button></div></div>
      <div class="field"><label>Validity (days)</label><input id="f_validity" type="number" value="${q.validityDays || 14}"></div>
    </div>
    <div class="field"><label>Site-specific notes (shown to client)</label><textarea id="f_notes" rows="3">${esc(q.siteNotes || '')}</textarea></div>
    <button class="btn btn-blue" id="saveDetails">Save details</button>
  </div>

  <div class="card">
    <h2>Site plan / drawing</h2><div class="sub">Upload the marked-up drawing — it shows on the client link and in the PDF. JPG or PNG.</div><div class="rule"></div>
    <div id="siteplanArea">
      ${q.hasSiteplan ? `<img src="/api/public/quote/${q.token}/siteplan?t=${Date.now()}" style="max-width:100%;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;">` : '<p class="muted">No drawing uploaded yet.</p>'}
    </div>
    <input type="file" id="planFile" accept="image/png,image/jpeg" style="max-width:340px;display:inline-block;width:auto;">
    ${q.hasSiteplan ? '<button class="btn btn-ghost btn-sm" id="removePlan">Remove</button>' : ''}
  </div>

  <div class="card">
    <h2>Site surcharges</h2><div class="sub">Toggle any that apply to this site. % applies to the Scope 1 subtotal.</div><div class="rule"></div>
    <div id="surChips">${surcharges.map(s => `<span class="chip ${isApplied(s.id) ? 'on' : ''}" data-sur="${s.id}">${esc(s.name)} ${s.kind === 'percent' ? '+' + s.rate + '%' : '+' + money(s.rate)} <span class="tag ${isApplied(s.id) ? 'tag-accepted' : 'tag-draft'}">${isApplied(s.id) ? 'On' : 'Off'}</span></span>`).join('')}</div>
  </div>

  <div class="card">
    <h2>Deliverables</h2><div class="sub">Add from the pricing sheet, or a custom line. Override the tier per item if needed.</div><div class="rule"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <select id="addPick" style="max-width:420px;"><option value="">+ Add deliverable from pricing sheet…</option>${priceItems.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select>
      <button class="btn btn-ghost btn-sm" id="addCustom">+ Custom line</button>
    </div>
    <div class="scope-box"><div class="scope-title">Scope 1 — Landscaping Works Deliverables</div><div id="scope1"></div></div>
    <div class="scope-box s2"><div class="scope-title">Scope 2 — Disposal / remeasurable (cost + 15%)</div><div id="scope2"></div></div>
  </div>

  <div class="card">
    <h2>Summary</h2><div class="rule"></div>
    <div class="grid4">
      <div class="stat"><div class="k">Scope 1 (${esc(q.defaultPackage)})</div><div class="v">${money(q.scope1TierTotals[q.defaultPackage])}</div></div>
      <div class="stat"><div class="k">Surcharge</div><div class="v">${money(q.surcharge)}</div></div>
      <div class="stat"><div class="k">Total inc. GST</div><div class="v">${money(q.grandIncGst)}</div></div>
      ${state.mgmtUnlocked ? `<div class="mgmt"><div class="k">🔓 Tier compare</div><div style="font-size:12px;">B ${money(q.scope1TierTotals.Basic)} · S ${money(q.scope1TierTotals.Standard)} · P ${money(q.scope1TierTotals.Premium)}</div></div>`
        : `<div class="mgmt"><div class="k">🔒 Margin</div><div style="font-size:12px;"><a href="#" id="unlock">Unlock with PIN</a></div></div>`}
    </div>
  </div>`;

  renderItems(q);
  $('#backList').addEventListener('click', () => { state.quoteId = null; route(); });
  $('#copyLink').addEventListener('click', () => { $('#linkInput').select(); navigator.clipboard?.writeText(link); toast('Link copied'); });
  $('#newRev').addEventListener('click', async () => { const r = await api('/quotes/' + q.id + '/revision', { method: 'POST' }); state.quoteId = r.id; toast('Revision ' + r.quoteNumber + ' created'); route(); });
  $('#saveDetails').addEventListener('click', () => saveDetails(q));
  $('#segPkg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPkg').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); }));
  $('#segPay').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPay').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); }));
  const unlockA = $('#unlock'); if (unlockA) unlockA.addEventListener('click', e => { e.preventDefault(); pinPrompt(() => quoteEditor(v)); });
  // surcharge toggles
  v.querySelectorAll('[data-sur]').forEach(c => c.addEventListener('click', async () => {
    const id = c.dataset.sur; const s = surcharges.find(x => x.id === id);
    let next = applied.filter(a => a.id !== id);
    if (!isApplied(id)) next.push({ id: s.id, name: s.name, kind: s.kind, rate: s.rate });
    await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedSurcharges: next }) });
    quoteEditor(v);
  }));
  // add item
  $('#addPick').addEventListener('change', async e => { if (!e.target.value) return; const pi = priceItems.find(p => p.id === e.target.value); await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: pi.code === 'SC2' ? 2 : 1, priceItemId: pi.id, qty: 1 }) }); quoteEditor(v); });
  $('#addCustom').addEventListener('click', async () => { await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 1, customCode: 'XX', customName: 'Custom line', customUnit: 'ea', customRate: 0, qty: 1 }) }); quoteEditor(v); });
  // siteplan upload
  $('#planFile').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => { const b64 = rd.result.split(',')[1]; await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: b64, mime: file.type }) }); toast('Drawing uploaded'); quoteEditor(v); };
    rd.readAsDataURL(file);
  });
  const rmPlan = $('#removePlan'); if (rmPlan) rmPlan.addEventListener('click', async () => { await api('/quotes/' + q.id + '/siteplan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: null, mime: null }) }); toast('Drawing removed'); quoteEditor(v); });
}

function renderItems(q) {
  const row = it => {
    const pt = it.perTier[it.effectiveTier];
    const behav = BEHAV[it.behaviour] || '';
    return `<tr>
      <td><b>${esc(it.code)}</b></td>
      <td>${esc(it.name)}<br><span class="muted" style="font-size:11px;">${esc(it.effectiveSpec || '')}</span>
        ${it.behaviour === 'remeasurable' ? `<label style="font-size:10.5px;display:inline-flex;align-items:center;gap:5px;margin-top:4px;"><input type="checkbox" style="width:auto;" ${it.sharedEnabled ? 'checked' : ''} data-shared="${it.id}"> shared</label>${it.sharedEnabled ? `<input style="width:60px;display:inline-block;margin-left:6px;" type="number" value="${it.sharedPct}" data-sharedpct="${it.id}"> %` : ''}` : ''}</td>
      <td>${behav ? `<span class="tag tag-${it.behaviour === 'remeasurable' ? 'rem' : it.behaviour === 'allowance' ? 'allow' : it.behaviour === 'rate_only' ? 'rate' : 'opt'}">${behav}</span>` : ''}</td>
      <td><select data-tier="${it.id}" style="width:110px;"><option value="">Default (${esc(q.defaultPackage)})</option>${TIERS.map(t => `<option value="${t}" ${it.tierOverride === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input type="number" step="0.01" value="${it.qty}" data-qty="${it.id}" style="width:80px;"></td>
      <td>${esc(it.unit)}</td>
      <td class="right">${money(it.effectiveRate)}</td>
      <td class="right"><b>${money(it.effectiveTotal)}</b></td>
      <td class="right"><button class="btn btn-danger btn-sm" data-del="${it.id}">✕</button></td>
    </tr>`;
  };
  const head = `<table><thead><tr><th>Code</th><th>Deliverable</th><th>Flag</th><th>Tier</th><th>Qty</th><th>Unit</th><th class="right">Rate</th><th class="right">Total</th><th></th></tr></thead><tbody>`;
  $('#scope1').innerHTML = q.items.scope1.length ? head + q.items.scope1.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 1 items yet.</p>';
  $('#scope2').innerHTML = q.items.scope2.length ? head + q.items.scope2.map(row).join('') + '</tbody></table>' : '<p class="muted">No Scope 2 items yet.</p>';

  const v = $('#view');
  v.querySelectorAll('[data-qty]').forEach(i => i.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${i.dataset.qty}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: parseFloat(i.value) || 0 }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-tier]').forEach(s => s.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${s.dataset.tier}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tierOverride: s.value || null }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { await api(`/quotes/${q.id}/items/${b.dataset.del}`, { method: 'DELETE' }); quoteEditor(v); }));
  v.querySelectorAll('[data-shared]').forEach(c => c.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${c.dataset.shared}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedEnabled: c.checked }) }); quoteEditor(v); }));
  v.querySelectorAll('[data-sharedpct]').forEach(i => i.addEventListener('change', async () => { await api(`/quotes/${q.id}/items/${i.dataset.sharedpct}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedPct: parseFloat(i.value) || 50 }) }); quoteEditor(v); }));
}

async function saveDetails(q) {
  const body = {
    client: $('#f_client').value, clientEmail: $('#f_email').value, projectTitle: $('#f_title').value,
    address: $('#f_address').value, date: $('#f_date').value, validityDays: parseInt($('#f_validity').value) || 14,
    defaultPackage: $('#segPkg .on').dataset.v, paymentSchedule: $('#segPay .on').dataset.v, siteNotes: $('#f_notes').value,
  };
  await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toast('Saved'); quoteEditor($('#view'));
}

// ---------------- PRICING SHEET ----------------
async function pricingSheet(v) {
  const items = await api('/price-list');
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div><h2>Standard Pricing Sheet</h2><div class="sub">The single source of rates. Add or edit deliverables any time.</div></div>
      <button class="btn btn-blue" id="addItem">+ Add deliverable</button>
    </div><div class="rule"></div>
    <table><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th>Basic</th><th>Standard</th><th>Premium</th><th>Flag</th><th></th></tr></thead><tbody>
    ${items.map(p => `<tr>
      <td><b>${esc(p.code)}</b></td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Basic.spec)}</span><br>${money(p.tiers.Basic.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Standard.spec)}</span><br>${money(p.tiers.Standard.sell)}</td>
      <td><span class="muted" style="font-size:10.5px;">${esc(p.tiers.Premium.spec)}</span><br>${money(p.tiers.Premium.sell)}</td>
      <td>${p.behaviour !== 'none' ? `<span class="tag tag-${p.behaviour === 'remeasurable' ? 'rem' : p.behaviour === 'allowance' ? 'allow' : 'opt'}">${BEHAV[p.behaviour]}</span>` : ''}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button></td>
    </tr>`).join('')}
    </tbody></table></div>`;
  $('#addItem').addEventListener('click', () => editPriceItem(null));
  v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editPriceItem(items.find(p => p.id === b.dataset.edit))));
}
function editPriceItem(item) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const t = item ? item.tiers : { Basic: {}, Standard: {}, Premium: {} };
  bg.innerHTML = `<div class="modal">
    <h2 style="margin:0 0 12px;">${item ? 'Edit' : 'Add'} deliverable</h2>
    <div class="grid3">
      <div class="field"><label>Code</label><input id="p_code" value="${esc(item?.code || '')}"></div>
      <div class="field"><label>Unit</label><input id="p_unit" value="${esc(item?.unit || 'ea')}"></div>
      <div class="field"><label>Behaviour</label><select id="p_behav">${Object.entries(BEHAV).map(([k, val]) => `<option value="${k}" ${item?.behaviour === k ? 'selected' : ''}>${val || 'Standard'}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Name</label><input id="p_name" value="${esc(item?.name || '')}"></div>
    ${TIERS.map(tt => `<div class="grid2"><div class="field"><label>${tt} spec</label><input id="p_${tt}_spec" value="${esc(t[tt].spec || '')}"></div><div class="field"><label>${tt} sell rate $</label><input id="p_${tt}_sell" type="number" value="${t[tt].sell || 0}"></div></div>`).join('')}
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:8px;">
      ${item ? '<button class="btn btn-danger" id="p_del">Delete</button>' : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="p_cancel">Cancel</button><button class="btn btn-blue" id="p_save">Save</button></div>
    </div></div>`;
  document.body.appendChild(bg);
  $('#p_cancel').addEventListener('click', () => bg.remove());
  $('#p_save').addEventListener('click', async () => {
    const body = { code: $('#p_code').value, name: $('#p_name').value, unit: $('#p_unit').value, behaviour: $('#p_behav').value,
      tiers: { Basic: { spec: $('#p_Basic_spec').value, sell: +$('#p_Basic_sell').value }, Standard: { spec: $('#p_Standard_spec').value, sell: +$('#p_Standard_sell').value }, Premium: { spec: $('#p_Premium_spec').value, sell: +$('#p_Premium_sell').value } } };
    if (item) await api('/price-list/' + item.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/price-list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); pricingSheet($('#view'));
  });
  const del = $('#p_del'); if (del) del.addEventListener('click', async () => { if (confirm('Delete this deliverable?')) { await api('/price-list/' + item.id, { method: 'DELETE' }); bg.remove(); pricingSheet($('#view')); } });
}

// ---------------- SURCHARGES ----------------
async function surchargesTab(v) {
  const surs = await api('/price-list/surcharges/all');
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div><h2>Site-Specific Surcharges</h2><div class="sub">Access, slope and similar conditions. Applied per quote.</div></div>
      <button class="btn btn-blue" id="addSur">+ Add surcharge</button></div><div class="rule"></div>
    <table><thead><tr><th>Name</th><th>Trigger</th><th>Type</th><th>Rate</th><th></th></tr></thead><tbody>
    ${surs.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.trigger_note || '')}</td><td>${s.kind === 'percent' ? '% of Scope 1' : 'Fixed $'}</td><td>${s.kind === 'percent' ? s.rate + '%' : money(s.rate)}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-es="${s.id}">Edit</button> <button class="btn btn-danger btn-sm" data-ds="${s.id}">✕</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#addSur').addEventListener('click', () => editSur(null));
  v.querySelectorAll('[data-es]').forEach(b => b.addEventListener('click', () => editSur(surs.find(s => s.id === b.dataset.es))));
  v.querySelectorAll('[data-ds]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete surcharge?')) { await api('/price-list/surcharges/' + b.dataset.ds, { method: 'DELETE' }); surchargesTab(v); } }));
}
function editSur(s) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${s ? 'Edit' : 'Add'} surcharge</h2>
    <div class="field"><label>Name</label><input id="s_name" value="${esc(s?.name || '')}"></div>
    <div class="field"><label>Trigger note</label><input id="s_note" value="${esc(s?.trigger_note || '')}"></div>
    <div class="grid2"><div class="field"><label>Type</label><select id="s_kind"><option value="percent" ${s?.kind === 'percent' ? 'selected' : ''}>% of Scope 1</option><option value="fixed" ${s?.kind === 'fixed' ? 'selected' : ''}>Fixed $</option></select></div>
    <div class="field"><label>Rate</label><input id="s_rate" type="number" value="${s?.rate || 0}"></div></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="s_cancel">Cancel</button><button class="btn btn-blue" id="s_save">Save</button></div></div>`;
  document.body.appendChild(bg);
  $('#s_cancel').addEventListener('click', () => bg.remove());
  $('#s_save').addEventListener('click', async () => {
    const body = { name: $('#s_name').value, triggerNote: $('#s_note').value, kind: $('#s_kind').value, rate: +$('#s_rate').value };
    if (s) await api('/price-list/surcharges/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/price-list/surcharges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); surchargesTab($('#view'));
  });
}

// ---------------- CHECKLIST ----------------
async function checklistTab(v) {
  const tpl = await api('/checklist/template');
  const cats = {}; tpl.forEach(i => { (cats[i.category] = cats[i.category] || []).push(i); });
  v.innerHTML = `<div class="card"><h2>Structural Checklist Template</h2><div class="sub">The master checklist. Each quote gets its own copy with audited sign-offs.</div><div class="rule"></div>
    ${Object.entries(cats).map(([cat, items]) => `<div style="margin-bottom:14px;"><div style="font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">${esc(cat)}</div>
      ${items.map(i => `<div style="padding:5px 0;font-size:12.5px;">☐ ${esc(i.label)} ${i.critical ? '<span class="tag tag-rem">Critical</span>' : ''}</div>`).join('')}</div>`).join('')}
  </div>`;
}

// ---------------- SETTINGS ----------------
async function settingsTab(v) {
  const s = await api('/settings');
  v.innerHTML = `<div class="card"><h2>Company</h2><div class="rule"></div>
    <div class="grid2">
      <div class="field"><label>Company name</label><input id="set_company_name" value="${esc(s.company_name)}"></div>
      <div class="field"><label>ABN</label><input id="set_company_abn" value="${esc(s.company_abn)}"></div>
      <div class="field"><label>Licence</label><input id="set_company_lic" value="${esc(s.company_lic)}"></div>
      <div class="field"><label>Phone</label><input id="set_company_phone" value="${esc(s.company_phone)}"></div>
      <div class="field"><label>Email (sends via Zoho)</label><input id="set_company_email" value="${esc(s.company_email)}"></div>
      <div class="field"><label>Association line</label><input id="set_association_line" value="${esc(s.association_line)}"></div>
      <div class="field"><label>Address</label><input id="set_company_address" value="${esc(s.company_address)}"></div>
      <div class="field"><label>Tagline</label><input id="set_tagline" value="${esc(s.tagline)}"></div>
    </div>
    <div style="font-size:11.5px;margin:6px 0 12px;">Email sending: ${s.smtpConfigured ? '<span class="tag tag-accepted">Zoho connected</span>' : '<span class="tag tag-superseded">Not configured — set SMTP_USER / SMTP_PASS on the host</span>'}</div>
    <button class="btn btn-blue" id="saveCompany">Save company</button>
  </div>

  <div class="card"><h2>Package descriptions (shown to client)</h2><div class="rule"></div>
    ${TIERS.map(t => `<div class="field"><label>${t}</label><textarea id="set_pkg_desc_${t.toLowerCase()}" rows="2">${esc(s['pkg_desc_' + t.toLowerCase()])}</textarea></div>`).join('')}
    <button class="btn btn-blue" id="savePkg">Save descriptions</button>
  </div>

  <div class="card"><h2>Contract text</h2><div class="sub">Standard conditions, special clauses default, warranty, and protections. Protections: one per line as "Title|Detail".</div><div class="rule"></div>
    <div class="field"><label>Default special clauses</label><textarea id="set_default_special_clauses" rows="3">${esc(s.default_special_clauses)}</textarea></div>
    <div class="field"><label>Warranty</label><textarea id="set_warranty_text" rows="5">${esc(s.warranty_text)}</textarea></div>
    <div class="field"><label>Your Protections (Title|Detail per line)</label><textarea id="set_protections_text" rows="6">${esc(s.protections_text)}</textarea></div>
    <div class="field"><label>Standard conditions (31 clauses)</label><textarea id="set_standard_conditions" rows="8">${esc(s.standard_conditions)}</textarea></div>
    <button class="btn btn-blue" id="saveContract">Save contract text</button>
  </div>

  <div class="card"><h2>Management PIN</h2><div class="sub">Gates the margin view. Default is 1234 — change it now.</div><div class="rule"></div>
    <div class="pin-note">The PIN is a light deterrent, not strong security. Don't rely on it to protect against determined access.</div>
    <div class="grid3" style="margin-top:12px;"><div class="field"><label>Current PIN</label><input id="pin_cur" type="password"></div><div class="field"><label>New PIN</label><input id="pin_new" type="password"></div><div class="field" style="display:flex;align-items:flex-end;"><button class="btn btn-blue" id="savePin">Change PIN</button></div></div>
  </div>`;

  const save = (keys, msg) => async () => { const body = {}; keys.forEach(k => body[k] = $('#set_' + k).value); await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(msg); };
  $('#saveCompany').addEventListener('click', save(['company_name', 'company_abn', 'company_lic', 'company_phone', 'company_email', 'association_line', 'company_address', 'tagline'], 'Company saved'));
  $('#savePkg').addEventListener('click', save(['pkg_desc_basic', 'pkg_desc_standard', 'pkg_desc_premium'], 'Descriptions saved'));
  $('#saveContract').addEventListener('click', save(['default_special_clauses', 'warranty_text', 'protections_text', 'standard_conditions'], 'Contract text saved'));
  $('#savePin').addEventListener('click', async () => { const r = await api('/settings/management/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPin: $('#pin_cur').value, newPin: $('#pin_new').value }) }); if (r.ok) { toast('PIN changed'); $('#pin_cur').value = ''; $('#pin_new').value = ''; } else toast(r.error || 'Failed'); });
}

function pinPrompt(onOk) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">Management PIN</h2><div class="field"><input id="pin_in" type="password" placeholder="Enter PIN" autofocus></div><div class="err" id="pin_err" style="color:var(--red);font-size:12px;display:none;margin-bottom:8px;">Incorrect PIN</div><div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn btn-ghost" id="pin_cancel">Cancel</button><button class="btn btn-blue" id="pin_ok">Unlock</button></div></div>`;
  document.body.appendChild(bg);
  $('#pin_in').focus();
  $('#pin_cancel').addEventListener('click', () => bg.remove());
  const go = async () => { const r = await api('/settings/management/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('#pin_in').value }) }); if (r.ok) { state.mgmtUnlocked = true; bg.remove(); shell(); onOk && onOk(); } else $('#pin_err').style.display = 'block'; };
  $('#pin_ok').addEventListener('click', go);
  $('#pin_in').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

shell();
