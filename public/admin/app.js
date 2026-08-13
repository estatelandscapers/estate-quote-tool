// Estate Landscapers — admin SPA (v7: logins, vendors, recipes, costing, jobs, FY close)
const $ = (s, r = document) => r.querySelector(s);
const api = (p, opts) => {
  // A stale click handler can fire after the view has changed and the id is gone.
  // Sending /quotes/null just produces noise and 404s, so drop it here.
  if (/\/(null|undefined)(\/|$)/.test(p)) return Promise.resolve({ error: 'stale request ignored', stale: true });
  return fetch('/api' + p, opts).then(async r => {
    if (r.status === 401) { location.href = '/admin/login.html'; return {}; }
    const t = await r.text();
    let d; try { d = t ? JSON.parse(t) : {}; } catch { d = {}; }
    if (!r.ok && !d.error) d.error = `Request failed (${r.status})`;
    return d;
  });
};
const money = n => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('en-AU');
const money2 = n => '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIERS = ['Basic', 'Standard', 'Premium'];
const BEHAV = { none: '', remeasurable: 'Remeasurable', rate_only: 'Rate only', optional: 'Optional', allowance: 'Allowance' };
let USER = null;
let state = { tab: 'leads', leadId: null, leadStage: null, leadPhase: null, showLost: false, pendingCheckedAt: 0, incGst: false, editorSub: 'surcharges', matCat: 'material', pricingSub: 'live', recipesSub: 'live', pendingCounts: { pricing: 0, recipes: 0 }, recipeCode: null, recipeVariant: null, selQuoteId: null, quoteId: null, poId: null, showSuperseded: false, scrollY: 0, jobsFy: 'all' };

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
  const pc = state.pendingCounts || {};
  const badge = t => (t === 'pricing' && pc.pricing) ? `<span class="navdot">${pc.pricing}</span>`
    : (t === 'recipes' && pc.recipes) ? `<span class="navdot">${pc.recipes}</span>` : '';
  const all = [['leads', 'Leads'], ['quotes', 'Quotes'], ['pricing', 'Pricing'], ['materials', 'Costs'],
               ['recipes', 'Recipes'], ['vendors', 'Vendors'], ['editor', 'Editor'],
               ['jobs', 'Projects'], ['selections', 'Selections'], ['po', 'Purchase Orders']];
  // Admin sees everything. Everyone else works the delivery side of the business:
  // Leads, Quotes, Costs, Projects, Selections and Purchase Orders — but not the
  // rate card, the recipes or the vendor terms, and no money in the delivery tabs.
  const adminOnlyTabs = ['editor', 'pricing', 'recipes', 'vendors'];
  const tabs = all.filter(t => isAdmin() || !adminOnlyTabs.includes(t[0]));
  if (!tabs.find(t => t[0] === state.tab)) state.tab = 'leads';
  $('#app').innerHTML = `
    <div class="top">
      <div class="brand">${LOGO}<div><b>ESTATE LANDSCAPERS</b><span>Business Management Tool</span></div></div>
      <div class="nav">${tabs.map((t, i) => `${(t[0] === 'quotes' || t[0] === 'jobs') && i > 0 ? '<span class="navsep"></span>' : ''}<button data-tab="${t[0]}" class="${state.tab === t[0] ? 'on' : ''}" style="position:relative;">${t[1]}${badge(t[0])}</button>`).join('')}</div>
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
  // Pending counts refresh at most once a minute. They were previously fetched on every
  // single render — two extra round-trips per click, which is what made the tool feel laggy.
  const PENDING_TTL = 60000;
  if (isAdmin() && Date.now() - (state.pendingCheckedAt || 0) > PENDING_TTL) {
    state.pendingCheckedAt = Date.now();
    Promise.all([api('/quotes/pending/price-items'), api('/recipes/pending')]).then(([p, r]) => {
      const next = { pricing: (p || []).length, recipes: (r || []).length };
      if (next.pricing !== (state.pendingCounts || {}).pricing || next.recipes !== (state.pendingCounts || {}).recipes) {
        state.pendingCounts = next;
        const nav = document.querySelector('.nav');
        if (nav) nav.querySelectorAll('button').forEach(b => {
          const t = b.dataset.tab; const n = t === 'pricing' ? next.pricing : t === 'recipes' ? next.recipes : 0;
          b.querySelectorAll('.navdot').forEach(d => d.remove());
          if (n) b.insertAdjacentHTML('beforeend', `<span class="navdot">${n}</span>`);
        });
      }
    }).catch(() => {});
  }
  if (state.tab === 'leads') return state.leadId ? leadConsole(v) : leadsTab(v);
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

const PHCOL = ['', '#1E5BFF', '#6A3E9C', '#B08D3E', '#2E7D46', '#888'];
async function leadsTab(v) {
  v.innerHTML = `<div class="card"><h2>Leads</h2><div class="sub">Loading…</div></div>`;
  const [board, data, stageData] = await Promise.all([api('/leads/board'), api('/leads'), api('/leads/stages')]);
  if (!STAGE_PHASE) { STAGE_PHASE = {}; (stageData.stages || []).forEach(s => STAGE_PHASE[s.id] = s.phase); }
  const rows = data.leads || [];
  const total = (board.overdue.length + board.dueToday.length);
  const line = (l, cls) => `<div class="today ${cls}">
      <div><b>${esc(l.name || '—')}</b>${l.suburb ? ' — ' + esc(l.suburb) : ''}${l.jobType ? ' · ' + esc(l.jobType) : ''}
        <br><span class="muted" style="font-size:11px;">Phase ${l.phase} · ${esc(l.stageLabel)} · <b>${esc(l.nextAction)}</b>${l.due ? ' · due ' + esc(l.due) : ''}${l.quoteNumber ? ' · quote ' + esc(l.quoteNumber) : ''}</span></div>
      <div style="display:flex;gap:6px;"><button class="btn btn-blue btn-sm" data-lopen="${l.id}">Open</button></div>
    </div>`;
  v.innerHTML = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><h2>What needs doing</h2><div class="sub">Clear this list and every enquiry has been chased properly today.</div></div>
        <button class="btn btn-blue" id="addLead">+ New enquiry</button></div>
      <div class="rule"></div>
      <div class="grid3" style="margin-bottom:12px;">
        <div class="stat" style="border-left:4px solid var(--red);"><div class="k">Overdue</div><div class="v" style="color:var(--red);">${board.overdue.length}</div></div>
        <div class="stat" style="border-left:4px solid #B5761E;"><div class="k">Due today</div><div class="v" style="color:#B5761E;">${board.dueToday.length}</div></div>
        <div class="stat" style="border-left:4px solid var(--green);"><div class="k">This week</div><div class="v" style="color:var(--green);">${board.thisWeek.length}</div></div>
      </div>
      ${board.overdue.length ? `<div class="wl">Overdue</div>${board.overdue.map(l => line(l, '')).join('')}` : ''}
      ${board.dueToday.length ? `<div class="wl" style="color:#B5761E;">Due today</div>${board.dueToday.map(l => line(l, 'soon')).join('')}` : ''}
      ${board.thisWeek.length ? `<div class="wl" style="color:var(--green);">Coming up this week</div>${board.thisWeek.map(l => line(l, 'ok')).join('')}` : ''}
      ${board.undated.length ? `<div class="wl" style="color:var(--grey);">No follow-up set</div>${board.undated.map(l => line(l, 'ok')).join('')}` : ''}
      ${!total && !board.thisWeek.length && !board.undated.length ? '<p class="muted">Nothing due. Every enquiry is up to date.</p>' : ''}
    </div>

    <div class="card"><h2>Pipeline</h2><div class="sub">Where every open enquiry is sitting.</div><div class="rule"></div>
      <div class="pipe">${board.phases.map(p => `<div class="ph ${state.leadPhase === p.id ? 'on' : ''}" data-phase="${p.id}">
        <div class="n">PHASE ${p.id}</div><div class="t">${esc(p.label)}</div>
        <div class="c">${board.phaseCounts[p.id] || 0}</div><div class="w">${esc(p.blurb)}${p.target ? ' · ' + esc(p.target) : ''}</div></div>`).join('')}</div>
      ${state.leadPhase ? '<div class="legend">Showing phase ' + state.leadPhase + ' only. <a href="#" id="clearPhase">Show all</a></div>' : ''}
    </div>

    <div class="card"><h2>All enquiries</h2><div class="rule"></div><div id="leadTable"></div></div>
    <div class="card"><h2>Figures</h2><div class="sub">All values exclude GST.</div><div class="rule"></div><div id="dashcards">Loading…</div></div>`;

  $('#addLead').addEventListener('click', () => editLead(null, v));
  v.querySelectorAll('[data-lopen]').forEach(b => b.addEventListener('click', () => { state.leadId = b.dataset.lopen; leadConsole(v); }));
  v.querySelectorAll('[data-phase]').forEach(b => b.addEventListener('click', () => {
    state.leadPhase = state.leadPhase === +b.dataset.phase ? null : +b.dataset.phase; leadsTab(v);
  }));
  const cp = $('#clearPhase'); if (cp) cp.addEventListener('click', e => { e.preventDefault(); state.leadPhase = null; leadsTab(v); });

  const shown = state.leadPhase ? rows.filter(r => (board.phaseCounts && true) && phaseOfStage(r.stage) === state.leadPhase) : rows;
  $('#leadTable').innerHTML = shown.length ? `<table class="resp"><thead><tr><th>Name</th><th>Contact</th><th>Site</th><th>Phase</th><th>Next</th><th>Quote</th><th></th></tr></thead><tbody>
    ${shown.map(l => `<tr><td data-l="Name"><b>${esc(l.name || '—')}</b>${l.jobType ? `<br><span class="muted" style="font-size:10.5px;">${esc(l.jobType)}</span>` : ''}</td>
      <td data-l="Contact">${esc(l.phone || '')}${l.email ? '<br><span class="muted" style="font-size:10.5px;">' + esc(l.email) + '</span>' : ''}</td>
      <td data-l="Site">${esc(l.suburb || l.address || '')}</td>
      <td data-l="Phase"><span class="tag" style="background:${PHCOL[phaseOfStage(l.stage)] || '#888'}22;color:${PHCOL[phaseOfStage(l.stage)] || '#888'};">P${phaseOfStage(l.stage)}</span></td>
      <td data-l="Next">${l.followupOverdue ? `<span class="tag age-flag">overdue</span> ` : ''}${esc(l.nextFollowup || '—')}${l.msgCount ? `<br><span class="muted" style="font-size:10px;">${l.msgCount} msg</span>` : ''}</td>
      <td data-l="Quote">${l.quoteNumber ? esc(l.quoteNumber) : '<span class="muted">—</span>'}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-lopen2="${l.id}">Open</button> <button class="btn btn-danger btn-sm" data-ld="${l.id}">✕</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No enquiries here.</p>';
  v.querySelectorAll('[data-lopen2]').forEach(b => b.addEventListener('click', () => { state.leadId = b.dataset.lopen2; leadConsole(v); }));
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
      <div class="stat"><div class="k">Value quoted (30d)</div><div class="v">${money(d.quotedValueMonth)}</div><div style="font-size:9.5px;color:var(--grey);">excl. GST</div></div>
      <div class="stat"><div class="k">Win rate (value, FY)</div><div class="v">${d.winRateValue || 0}%</div></div>
      <div class="stat"><div class="k">Lost this FY</div><div class="v">${money(d.lostValueFY || 0)}</div><div style="font-size:9.5px;color:var(--grey);">${d.lostFY || 0} quote(s)</div></div>
    </div>`;
}
let STAGE_PHASE = null;
function phaseOfStage(id) {
  if (!STAGE_PHASE) return 1;
  return STAGE_PHASE[id] || 1;
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



// ---------------- CUSTOM DELIVERABLE (create + edit) ----------------
// Sell is driven by qty x unit rate, and stays overridable. Our cost is the TOTAL for
// the line, not a unit rate — that's how a supplier quote actually arrives.
async function customDialog(q, existing, done) {
  const nc = existing ? { code: existing.code } : await api('/quotes/next-custom-code');
  const tiered = existing ? !!existing.customTiered : false;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:900px;">
    <h2 style="margin:0 0 3px;">${existing ? 'Edit' : 'New'} custom deliverable</h2>
    <div class="sub">${existing ? 'Changes apply to this quote.' : 'Effectively a new price item drafted on this job — fill it in once and you can add it to Pricing afterwards.'}</div>
    <div class="rule"></div>
    <div class="grid4">
      <div class="field"><label>Code</label><input id="cu_code" value="${esc(existing ? existing.code : (nc.code || 'C1'))}" style="font-weight:800;"><span class="muted" style="font-size:10px;">auto — editable</span></div>
      <div class="field"><label>Deliverable name</label><input id="cu_name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Feature sandstone boulder set"></div>
      <div class="field"><label>Unit</label><input id="cu_unit" value="${esc(existing ? existing.unit : 'ea')}"></div>
      <div class="field"><label>Behaviour</label><select id="cu_behav">
        ${[['none', 'Standard — qty × rate'], ['remeasurable', 'Remeasurable — measured on site'], ['rate_only', 'Rate only — no value in total'], ['allowance', 'Allowance — provisional sum'], ['optional', 'Optional — shown, not counted']]
          .map(([v, l]) => `<option value="${v}" ${existing && existing.customBehaviour === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Scope description — shown on the client link, contract and site PO</label>
      <textarea id="cu_desc" rows="2" placeholder="What this covers, in plain English for the client.">${esc(existing ? existing.customDesc || existing.description || '' : '')}</textarea></div>
    <div class="grid4">
      <div class="field"><label>Qty</label><input id="cu_qty" type="number" step="0.01" value="${existing ? existing.qty : 1}"></div>
    </div>
    <div style="display:flex;gap:16px;align-items:center;margin:6px 0 8px;flex-wrap:wrap;">
      <b style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Pricing</b>
      <label style="font-size:11.5px;display:flex;align-items:center;gap:6px;"><input type="radio" name="cutier" value="flat" ${tiered ? '' : 'checked'} style="width:auto;"> Same across all packages</label>
      <label style="font-size:11.5px;display:flex;align-items:center;gap:6px;"><input type="radio" name="cutier" value="tiered" ${tiered ? 'checked' : ''} style="width:auto;"> Different per package</label>
    </div>
    <table><thead><tr><th style="width:96px;">Package</th><th>Specification shown to client</th>
      <th class="right" style="width:110px;">Unit rate $</th><th class="right" style="width:120px;">Sell total $</th>
      <th class="right" style="width:120px;">Our cost (total) $</th><th class="right" style="width:74px;">Margin</th></tr></thead><tbody>
      ${TIERS.map(t => `<tr data-trow="${t}"><td><b class="tname">${t}</b></td>
        <td><input data-cs="${t}" value="${esc(existing && existing.customSpec ? (existing.customSpec[t] || '') : '')}"></td>
        <td class="right"><input data-cr="${t}" type="number" step="0.01" style="text-align:right;" placeholder="per unit"></td>
        <td class="right"><input data-cv="${t}" type="number" step="0.01" style="text-align:right;" value="${existing && existing.value && existing.value[t] != null ? existing.value[t] : ''}"></td>
        <td class="right"><input data-cc="${t}" type="number" step="0.01" style="text-align:right;" value="${existing && existing.lineCost && existing.lineCost[t] != null ? existing.lineCost[t] : ''}"></td>
        <td class="right" data-cm="${t}"><span class="muted">—</span></td></tr>`).join('')}
    </tbody></table>
    <div class="legend">Type a <b>unit rate</b> and the sell total fills in as qty × rate. Type over the sell total whenever the job isn't a neat multiple. <b>Our cost is the total for the line</b>, not per unit.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px;">
      ${existing ? '' : `<label style="font-size:11.5px;margin-right:auto;display:flex;align-items:center;gap:7px;"><input type="checkbox" id="cu_save2p" checked style="width:auto;"> Also offer it for the Pricing list afterwards</label>`}
      <button class="btn btn-ghost" id="cu_cancel">Cancel</button>
      <button class="btn btn-blue" id="cu_ok">${existing ? 'Save changes' : 'Add line'}</button></div></div>`;
  document.body.appendChild(bg);
  const qtyEl = $('#cu_qty');
  const applyTierMode = () => {
    const t = bg.querySelector('input[name=cutier]:checked').value === 'tiered';
    bg.querySelectorAll('[data-trow]').forEach(r => { if (r.dataset.trow !== 'Standard') r.style.display = t ? '' : 'none'; });
    bg.querySelector('[data-trow="Standard"] .tname').textContent = t ? 'Standard' : 'All packages';
  };
  const recalcMargin = () => TIERS.forEach(t => {
    const s = parseFloat(bg.querySelector(`[data-cv="${t}"]`).value) || 0;
    const c = parseFloat(bg.querySelector(`[data-cc="${t}"]`).value) || 0;
    const cell = bg.querySelector(`[data-cm="${t}"]`);
    cell.innerHTML = s > 0 ? `<b style="color:${(s - c) / s >= 0.25 ? 'var(--green)' : 'var(--red)'};">${Math.round((s - c) / s * 1000) / 10}%</b>` : '<span class="muted">—</span>';
  });
  const sellFromRate = t => {
    const rate = parseFloat(bg.querySelector(`[data-cr="${t}"]`).value);
    if (isNaN(rate)) return;
    const qty = parseFloat(qtyEl.value) || 0;
    bg.querySelector(`[data-cv="${t}"]`).value = Math.round(rate * qty * 100) / 100;
    recalcMargin();
  };
  TIERS.forEach(t => {
    bg.querySelector(`[data-cr="${t}"]`).addEventListener('input', () => sellFromRate(t));
    bg.querySelector(`[data-cv="${t}"]`).addEventListener('input', recalcMargin);
    bg.querySelector(`[data-cc="${t}"]`).addEventListener('input', recalcMargin);
  });
  qtyEl.addEventListener('input', () => TIERS.forEach(sellFromRate));
  bg.querySelectorAll('input[name=cutier]').forEach(r => r.addEventListener('change', applyTierMode));
  applyTierMode(); recalcMargin();
  $('#cu_cancel').addEventListener('click', () => bg.remove());
  $('#cu_ok').addEventListener('click', async () => {
    const isTiered = bg.querySelector('input[name=cutier]:checked').value === 'tiered';
    const grab = sel => { const o = {}; TIERS.forEach(t => { const val = bg.querySelector(`[${sel}="${t}"]`).value; o[t] = val === '' ? null : (sel === 'data-cs' ? val : Number(val)); }); return o; };
    const spec = grab('data-cs'), value = grab('data-cv'), cost = grab('data-cc');
    if (!isTiered) TIERS.forEach(t => { spec[t] = spec.Standard; value[t] = value.Standard; cost[t] = cost.Standard; });
    if (!$('#cu_name').value.trim()) return toast('Give it a name first');
    const body = { customCode: $('#cu_code').value, customName: $('#cu_name').value, customUnit: $('#cu_unit').value,
      customDesc: $('#cu_desc').value, customBehaviour: $('#cu_behav').value, customTiered: isTiered,
      customSpec: spec, value, cost, qty: parseFloat(qtyEl.value) || 1 };
    if (existing) await api(`/quotes/${q.id}/items/${existing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/quotes/' + q.id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 1, ...body, saveToPricing: $('#cu_save2p').checked }) });
    bg.remove(); state.pendingCheckedAt = 0; toast(existing ? 'Custom line updated' : 'Custom line added'); done();
  });
}

// ---------------- SEND QUOTE ----------------
async function openSendDialog(q) {
  const pv = await api('/quotes/' + q.id + '/send-preview');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:640px;">
    <h2 style="margin:0 0 3px;">${pv.alreadySent ? 'Resend' : 'Send'} quote ${esc(q.quoteNumber)}</h2>
    <div class="sub">${pv.alreadySent ? `Last sent ${esc(String(pv.sentAt || '').slice(0, 16))} to ${esc(pv.to)} · ${pv.sendCount}×. Resending does not reset the view count.` : 'The link and your signature are added automatically — you don\'t need to paste them in.'}</div>
    <div class="rule"></div>
    <div class="grid2">
      <div class="field"><label>To</label><input id="sd_to" value="${esc(pv.to)}" placeholder="client@example.com"></div>
      <div class="field"><label>Copy to</label><input id="sd_cc" value="${esc(pv.cc)}"></div>
    </div>
    <div class="field"><label>Subject</label><input id="sd_subj" value="${esc(pv.subject)}"></div>
    <div class="field"><label>Message</label><textarea id="sd_msg" rows="8">${esc(pv.message)}</textarea></div>
    <div class="legend">Quote <b>${esc(pv.quoteNumber)}</b> · valid until ${esc(pv.validUntil)} · link ${esc(pv.link)}</div>
    <div id="sd_result"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px;">
      <span class="muted" style="margin-right:auto;font-size:11px;">Sends from ${esc(pv.cc || 'the office address')}</span>
      <button class="btn btn-ghost" id="sd_cancel">Cancel</button>
      <button class="btn btn-blue" id="sd_send">${pv.alreadySent ? 'Resend now' : 'Send now'}</button></div></div>`;
  document.body.appendChild(bg);
  $('#sd_cancel').addEventListener('click', () => bg.remove());
  const looksLikeEmail = a => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(a || '').trim());
  const flag = (id, bad) => { const el = $(id); el.style.borderColor = bad ? 'var(--red)' : ''; };
  ['#sd_to', '#sd_cc'].forEach(id => $(id).addEventListener('blur', () => {
    const val = $(id).value.trim();
    flag(id, val && !looksLikeEmail(val));
  }));
  $('#sd_send').addEventListener('click', async () => {
    const btn = $('#sd_send'); const out = $('#sd_result');
    const toVal = $('#sd_to').value.trim(), ccVal = $('#sd_cc').value.trim();
    // Catch the typo here rather than round-tripping to the provider for a 401.
    if (!toVal || !looksLikeEmail(toVal)) {
      flag('#sd_to', true);
      out.innerHTML = `<div class="emailbar failed"><b>Check the email address</b><br>${toVal ? `"${esc(toVal)}" doesn't look right — a missing dot in the domain is the usual cause.` : 'Enter the client\'s email address.'}</div>`;
      $('#sd_to').focus(); return;
    }
    if (ccVal && !looksLikeEmail(ccVal)) { flag('#sd_cc', true); out.innerHTML = `<div class="emailbar failed"><b>Check the copy-to address</b><br>"${esc(ccVal)}" doesn't look right.</div>`; $('#sd_cc').focus(); return; }
    flag('#sd_to', false); flag('#sd_cc', false);
    btn.disabled = true; btn.textContent = 'Sending…';
    const r = await api('/quotes/' + q.id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: $('#sd_to').value.trim(), cc: $('#sd_cc').value.trim(), subject: $('#sd_subj').value, message: $('#sd_msg').value, validUntil: pv.validUntil }) });
    if (r.alreadySent) {
      out.innerHTML = `<div class="emailbar partial"><b>Already sent just now</b><br>${esc(r.error)}${r.sentTo ? ' — to ' + esc(r.sentTo) : ''}<br><span style="font-size:11px;">${esc(r.hint || '')}</span></div>`;
      btn.disabled = false; btn.textContent = 'Send anyway';
      btn.onclick = async () => {
        const r2 = await api('/quotes/' + q.id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: $('#sd_to').value.trim(), cc: $('#sd_cc').value.trim(), subject: $('#sd_subj').value, message: $('#sd_msg').value, validUntil: pv.validUntil, force: true }) });
        if (r2.error) { out.innerHTML = `<div class="emailbar failed">${esc(r2.error)}</div>`; return; }
        bg.remove(); toast('Quote sent'); state.tab = 'quotes'; shell();
      };
      return;
    }
    if (r.error) {
      if (r.field) { flag('#sd_' + r.field, true); $('#sd_' + r.field).focus(); }
      out.innerHTML = `<div class="emailbar failed"><b>Not sent</b><br>${esc(r.error)}${r.hint ? `<br><span style="font-size:11px;">${esc(r.hint)}</span>` : ''}</div>`;
      btn.disabled = false; btn.textContent = 'Try again'; return;
    }
    bg.remove(); toast('Quote sent to ' + $('#sd_to').value.trim());
    state.tab = 'quotes'; shell();
  });
}


// ---------------- LEAD FOLLOW-UP CONSOLE ----------------
const CHAN = { whatsapp: ['WhatsApp', '#25D366'], sms: ['SMS', '#888'], email: ['Email', '#143FB0'], call: ['Call', '#888'], note: ['Note', '#888'] };
async function leadConsole(v) {
  const [leadsData, stageData, history, st] = await Promise.all([
    api('/leads'), api('/leads/stages'), api(`/leads/${state.leadId}/history`), api(`/leads/${state.leadId}/state`)]);
  const stages = stageData.stages || stageData;
  if (!STAGE_PHASE) { STAGE_PHASE = {}; stages.forEach(s => STAGE_PHASE[s.id] = s.phase); }
  const l = (leadsData.leads || []).find(x => x.id === state.leadId);
  if (!l) { state.leadId = null; return leadsTab(v); }
  const stage = state.leadStage || l.stage || 'noanswer';
  const groups = [...new Set(stages.map(s => s.group))];
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>${esc(l.name || 'Lead')}</h2><div class="sub">${esc(l.suburb || l.address || '')}${l.jobType ? ' · ' + esc(l.jobType) : ''}</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" id="backLeads">← All leads</button>
        ${l.quoteNumber ? `<button class="btn btn-ghost btn-sm" id="goQuote">Quote ${esc(l.quoteNumber)}</button>`
          : '<button class="btn btn-blue btn-sm" id="toQuote">→ Convert to quote</button>'}
      </div></div>
    <div class="rule"></div>
    <div class="pipe" style="margin-bottom:14px;">
      ${(stageData.phases || []).map(p => `<div class="ph ${p.id === st.phase ? 'on' : ''}" style="${p.id < st.phase ? 'background:#F2F8F4;border-color:#CBE0D2;' : ''}">
        <div class="n">${p.id < st.phase ? '✓ DONE' : p.id === st.phase ? 'YOU ARE HERE' : 'PHASE ' + p.id}</div>
        <div class="t" style="font-size:11px;">${esc(p.label)}</div>
        ${p.id === st.phase ? `<div class="w">${esc(st.stageLabel)}</div>` : ''}</div>`).join('')}
    </div>
    <div class="grid2" style="margin-bottom:14px;">
      <div class="nextact">
        <div class="k">Next action${st.due ? (st.overdue ? ' — OVERDUE' : ' — due ' + esc(st.due)) : ''}</div>
        <div class="v">${esc(st.nextAction)}</div>
        ${st.gaps.length ? `<div style="font-size:11.5px;color:#f3c0b8;margin-top:7px;">Before ${esc(st.nextPhaseLabel)}: ${st.gaps.map(esc).join(', ')} still needed.</div>`
          : `<div style="font-size:11.5px;color:#9fd8a8;margin-top:7px;">Ready for ${esc(st.nextPhaseLabel || 'the next step')}.</div>`}
        ${st.suggestCloseout ? '<div style="font-size:11.5px;color:#f3d9a0;margin-top:7px;">Two follow-ups sent with no reply — worth closing this one out.</div>' : ''}
      </div>
      <div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" id="ld_snooze">😴 Snooze 3 days</button>
          <button class="btn btn-ghost btn-sm" id="ld_close">✕ Close this enquiry</button>
          ${st.phase < 4 ? '<button class="btn btn-ghost btn-sm" id="ld_skip">⏭ Skip ahead</button>' : ''}
        </div>
        <div class="legend">Skipping, snoozing and closing are always available — the steps guide you, they don't trap you.</div>
      </div>
    </div>
    <div class="grid2">
      <div>
        <div class="grid2">
          <div class="field"><label>Name</label><input id="ld_name" value="${esc(l.name || '')}"></div>
          <div class="field"><label>Mobile</label><input id="ld_phone" value="${esc(l.phone || '')}"></div>
          <div class="field"><label>Email</label><input id="ld_email" value="${esc(l.email || '')}"></div>
          <div class="field"><label>Suburb</label><input id="ld_suburb" value="${esc(l.suburb || '')}"></div>
          <div class="field"><label>Job type</label><input id="ld_job" value="${esc(l.jobType || '')}" placeholder="e.g. turf and driveway"></div>
          <div class="field"><label>Next follow-up</label><input id="ld_next" type="date" value="${esc(l.nextFollowup || '')}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea id="ld_notes" rows="2">${esc(l.notes || '')}</textarea></div>
        <button class="btn btn-ghost btn-sm" id="ld_save">Save details</button>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--grey);margin-bottom:6px;">Where you're up to</div>
        ${groups.map(g => `<div style="margin-bottom:7px;"><span class="muted" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;">${esc(g)}</span><br>
          ${stages.filter(s => s.group === g).map(s => `<span class="step ${s.id === stage ? 'on' : ''}" data-stage="${s.id}" title="${esc(s.when)}">${esc(s.label)}</span>`).join('')}</div>`).join('')}
      </div>
    </div>
    <div class="rule" style="margin-top:14px;"></div>
    <div class="grid2">
      <div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <div class="field" style="margin:0;flex:1;min-width:130px;"><label>Date (if needed)</label><input id="ms_date" type="date"></div>
          <div class="field" style="margin:0;flex:1;min-width:110px;"><label>Time</label><input id="ms_time" placeholder="9:00am"></div>
        </div>
        <div class="field"><label>Subject (email only)</label><input id="ms_subject"></div>
        <div class="field"><label>Message</label><textarea id="ms_body" rows="11"></textarea></div>
        <div id="ms_warn" class="legend"></div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--grey);margin-bottom:6px;">Send it</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px;">
          <button class="btn" id="ms_wa" style="background:#25D366;color:#fff;">WhatsApp</button>
          <button class="btn btn-blue" id="ms_email">Email</button>
          <button class="btn btn-ghost" id="ms_sms">SMS</button>
          <button class="btn btn-ghost" id="ms_call">📞 Log a call</button>
        </div>
        <div class="legend" style="margin-bottom:12px;">WhatsApp and SMS open on your phone with the message ready — press send there. The tool records it either way. Email is sent from here with your signature.</div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--grey);margin-bottom:6px;">History</div>
        <div class="timeline">
          ${history.length ? history.map(m => `<div class="tl" style="--c:${(CHAN[m.channel] || CHAN.note)[1]};">
            <b>${esc(String(m.at || '').slice(0, 16))}</b> — ${esc((CHAN[m.channel] || CHAN.note)[0])}${m.outcome === 'sent' ? ' sent' : ''}
            ${m.sentBy ? `<span class="muted"> · ${esc(m.sentBy)}</span>` : ''}
            ${m.body ? `<div class="muted" style="font-size:10.5px;margin-top:2px;">${esc(m.body.slice(0, 90))}${m.body.length > 90 ? '…' : ''}</div>` : ''}
            ${m.note ? `<div class="muted" style="font-size:10.5px;margin-top:2px;">${esc(m.note)}</div>` : ''}</div>`).join('')
            : '<div class="muted" style="font-size:11.5px;">Nothing sent yet.</div>'}
        </div>
      </div>
    </div></div>`;

  $('#backLeads').addEventListener('click', () => { state.leadId = null; state.leadStage = null; leadsTab(v); });
  const gq = $('#goQuote'); if (gq) gq.addEventListener('click', () => { state.tab = 'quotes'; state.quoteId = l.quoteId; state.leadId = null; shell(); });
  const tq = $('#toQuote'); if (tq) tq.addEventListener('click', async () => {
    const r = await api('/leads/' + l.id + '/convert', { method: 'POST' });
    if (r.error) return toast(r.error);
    state.leadId = null; state.tab = 'quotes'; state.quoteId = r.quoteId; toast('Quote ' + r.quoteNumber + ' created'); shell();
  });
  $('#ld_save').addEventListener('click', async () => {
    await api('/leads/' + l.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#ld_name').value, phone: $('#ld_phone').value, email: $('#ld_email').value,
        suburb: $('#ld_suburb').value, jobType: $('#ld_job').value, notes: $('#ld_notes').value,
        nextFollowup: $('#ld_next').value || null }) });
    toast('Saved'); leadConsole(v);
  });
  $('#ld_snooze').addEventListener('click', async () => {
    const r = await api(`/leads/${l.id}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 3 }) });
    toast('Snoozed until ' + r.until); leadConsole(v);
  });
  $('#ld_close').addEventListener('click', async () => {
    if (!confirm('Close this enquiry out? It stays on record and can be reopened.')) return;
    await api(`/leads/${l.id}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'closeout' }) });
    toast('Enquiry closed'); state.leadId = null; leadsTab(v);
  });
  const skip = $('#ld_skip'); if (skip) skip.addEventListener('click', async () => {
    const target = st.phase === 1 ? 'details' : st.phase === 2 ? 'propose' : 'aftervisit';
    await api(`/leads/${l.id}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: target }) });
    toast('Moved ahead'); leadConsole(v);
  });
  v.querySelectorAll('[data-stage]').forEach(b => b.addEventListener('click', () => { state.leadStage = b.dataset.stage; loadMsg(); paintStage(b.dataset.stage); }));
  function paintStage(id) { v.querySelectorAll('[data-stage]').forEach(x => x.classList.toggle('on', x.dataset.stage === id)); }

  let msg = {};
  async function loadMsg() {
    const qs = new URLSearchParams({ stage: state.leadStage || stage });
    if ($('#ms_date').value) qs.set('date', $('#ms_date').value);
    if ($('#ms_time').value) qs.set('time', $('#ms_time').value);
    msg = await api(`/leads/${l.id}/message?` + qs.toString());
    $('#ms_subject').value = msg.subject || '';
    $('#ms_body').value = msg.body || '';
    const w = [];
    if (!msg.phoneOk) w.push('No usable mobile number — WhatsApp and SMS are unavailable.');
    if (!msg.emailOk) w.push('No email address on this lead.');
    $('#ms_warn').innerHTML = w.length ? `<span style="color:var(--red);">${w.map(esc).join('<br>')}</span>` : '';
    $('#ms_wa').style.opacity = msg.phoneOk ? '1' : '.4';
    $('#ms_sms').style.opacity = msg.phoneOk ? '1' : '.4';
  }
  ['ms_date', 'ms_time'].forEach(id => $('#' + id).addEventListener('change', loadMsg));
  await loadMsg();

  const record = async (channel, extra) => {
    await api(`/leads/${l.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, stage: state.leadStage || stage, subject: $('#ms_subject').value,
        body: $('#ms_body').value, nextFollowup: $('#ld_next').value || null, ...extra }) });
  };
  $('#ms_wa').addEventListener('click', async () => {
    if (!msg.phoneOk) return toast('Add a mobile number first');
    // Rebuild the link from the edited text, not the original template.
    const intl = String(l.phone).replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^0/, '61');
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent($('#ms_body').value)}`, '_blank');
    await record('whatsapp'); toast('Opened WhatsApp — logged against this lead'); leadConsole(v);
  });
  $('#ms_sms').addEventListener('click', async () => {
    if (!msg.phoneOk) return toast('Add a mobile number first');
    window.open(`sms:${String(l.phone).replace(/[^\d+]/g, '')}?&body=${encodeURIComponent($('#ms_body').value)}`, '_self');
    await record('sms'); toast('Opened Messages — logged'); leadConsole(v);
  });
  $('#ms_email').addEventListener('click', async () => {
    const btn = $('#ms_email'); btn.disabled = true; btn.textContent = 'Sending…';
    const r = await api(`/leads/${l.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', stage: state.leadStage || stage, to: $('#ld_email').value,
        subject: $('#ms_subject').value, body: $('#ms_body').value, nextFollowup: $('#ld_next').value || null }) });
    btn.disabled = false; btn.textContent = 'Email';
    if (r.error) return toast(r.error);
    toast('Email sent'); leadConsole(v);
  });
  $('#ms_call').addEventListener('click', async () => {
    const note = prompt('What happened on the call?');
    if (note === null) return;
    await record('call', { note, body: null, subject: null });
    toast('Call logged'); leadConsole(v);
  });
}

// ---------------- QUOTES ----------------
const AGE = { fresh: ['age-fresh', d => d + 'd'], flag: ['age-flag', d => d + 'd — follow up'], chase: ['age-chase', d => d + 'd — chase'], dead: ['age-dead', d => d + 'd — dead'] };
async function quotesList(v) {
  v.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div><h2>Quotes</h2><div class="sub">Colour = quote age (thresholds in Settings). Latest revision is the live link.</div></div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <label style="font-size:10.5px;color:var(--grey);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="showSup" ${state.showSuperseded ? 'checked' : ''} style="width:auto;"> Show superseded <span id="supN" class="muted"></span></label>
      <label style="font-size:10.5px;color:var(--grey);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="showLost" ${state.showLost ? 'checked' : ''} style="width:auto;"> Show lost <span id="lostN" class="muted"></span></label>
      <button class="btn btn-blue" id="newQuote">+ New quote</button></div></div>
    <div class="rule"></div><div id="qtable">Loading…</div></div>`;
  $('#newQuote').addEventListener('click', async () => { const q = await api('/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: '', projectTitle: 'Landscape Works' }) }); state.quoteId = q.id; state.scrollY = 0; route(); });
  $('#showSup').addEventListener('change', e => { state.showSuperseded = e.target.checked; quotesList(v); });
  $('#showLost').addEventListener('change', e => { state.showLost = e.target.checked; quotesList(v); });
  const qs = [];
  if (state.showLost) qs.push('lost=1');
  if (state.showSuperseded) qs.push('superseded=1');
  const data = await api('/quotes' + (qs.length ? '?' + qs.join('&') : ''));
  const list = data.quotes || data;
  if (data.supersededCount) $('#supN').textContent = `(${data.supersededCount})`;
  if (data.lostCount) $('#lostN').textContent = `(${data.lostCount})`;
  $('#qtable').innerHTML = list.length ? `<table><thead><tr><th>Quote</th><th>Client</th><th>Tier</th><th>Value</th><th>Status</th><th>Age</th><th>Views</th><th></th></tr></thead><tbody>
    ${list.map(q => { const a = AGE[q.ageBand] || AGE.fresh; const isLost = q.status === 'lost'; const isSup = q.status === 'superseded';
      return `<tr class="${isLost ? 'row-lost' : ''}"><td><b>${esc(q.quoteNumber)}</b></td><td>${esc(q.client || '—')}</td><td><span class="tag tag-tier">${esc(q.customerTier || 'Silver')}</span></td><td>${q.value ? money(q.value) : '—'}</td>
      <td><span class="tag tag-${q.status}">${q.status}${q.acceptedPackage ? ' · ' + esc(q.acceptedPackage) : ''}</span>
        ${isLost && q.lostReason ? `<br><span class="muted" style="font-size:10px;">${esc(q.lostReason)}</span>` : ''}</td>
      <td>${q.status === 'accepted' || isLost ? '—' : `<span class="tag ${a[0]}">${a[1](q.ageDays)}</span>`}</td><td>${q.views}</td>
      <td class="right"><button class="btn btn-ghost btn-sm" data-open="${q.id}">Open</button>
        ${isLost ? `<button class="btn btn-ghost btn-sm" data-reopen="${q.id}">Reopen</button>`
          : (q.status === 'accepted' || isSup ? '' : `<button class="btn btn-ghost btn-sm" data-lost="${q.id}">Lost</button>`)}
        <button class="btn btn-danger btn-sm" data-del="${q.id}">✕</button></td></tr>`; }).join('')}
    </tbody></table>` : '<p class="muted">No quotes yet.</p>';
  v.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.quoteId = b.dataset.open; state.scrollY = 0; route(); }));
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this quote?')) { await api('/quotes/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); quotesList(v); } }));
  v.querySelectorAll('[data-lost]').forEach(b => b.addEventListener('click', () => markLost(b.dataset.lost, () => quotesList(v))));
  v.querySelectorAll('[data-reopen]').forEach(b => b.addEventListener('click', async () => {
    await api('/quotes/' + b.dataset.reopen + '/lost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lost: false }) });
    toast('Quote reopened'); quotesList(v);
  }));
}

// Marking a quote lost keeps everything — it just leaves the working list.
function markLost(quoteId, done) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:460px;">
    <h2 style="margin:0 0 3px;">Mark this quote as lost</h2>
    <div class="sub">It stays on record and still counts toward your win rate — it just won't clutter the working list. You can reopen it any time.</div>
    <div class="rule"></div>
    <div class="field"><label>Why was it lost? (optional)</label>
      <select id="lost_reason">
        <option value="">— not recorded —</option>
        <option>Price — went with a cheaper quote</option>
        <option>Price — client's budget changed</option>
        <option>Timing — client postponed the work</option>
        <option>Timing — we couldn't start soon enough</option>
        <option>Scope changed</option>
        <option>No response from client</option>
        <option>Went with another landscaper</option>
        <option>Client did it themselves</option>
        <option>Other</option>
      </select></div>
    <div class="field" id="lost_other_wrap" style="display:none;"><label>Details</label><input id="lost_other" placeholder="e.g. beaten by $3k on the driveway"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-ghost" id="lost_cancel">Cancel</button>
      <button class="btn btn-blue" id="lost_ok">Mark as lost</button></div></div>`;
  document.body.appendChild(bg);
  $('#lost_reason').addEventListener('change', e => { $('#lost_other_wrap').style.display = e.target.value === 'Other' ? '' : 'none'; });
  $('#lost_cancel').addEventListener('click', () => bg.remove());
  $('#lost_ok').addEventListener('click', async () => {
    let reason = $('#lost_reason').value;
    if (reason === 'Other') reason = $('#lost_other').value || 'Other';
    const r = await api('/quotes/' + quoteId + '/lost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lost: true, reason }) });
    if (r.error) { toast(r.error); return; }
    bg.remove(); toast('Marked as lost'); done();
  });
}

// ---------------- QUOTE EDITOR ----------------
async function quoteEditor(v) {
  // Guard: a stale async render can fire after the user has navigated away and cleared
  // the id. Without this we request /api/quotes/null, it 404s, and the screen is stuck
  // on "Loading quote…" forever.
  if (!state.quoteId) { state.tab = 'quotes'; return quotesList(v); }
  const myQuoteId = state.quoteId;
  v.innerHTML = `<p class="muted">Loading quote…</p>`;
  let q, priceItems, surcharges, checklist, costing;
  try {
    [q, priceItems, surcharges, checklist, costing] = await Promise.all([
      api('/quotes/' + myQuoteId), api('/price-list'), api('/price-list/surcharges/all'),
      api('/checklist/quote/' + myQuoteId), api('/quotes/' + myQuoteId + '/costing')]);
  } catch (e) {
    v.innerHTML = `<div class="card"><h2>Couldn't load this quote</h2>
      <div class="sub">${esc(e.message || 'The server did not respond.')}</div><div class="rule"></div>
      <button class="btn btn-blue" id="retryQ">Try again</button>
      <button class="btn btn-ghost" id="backQ">← All quotes</button></div>`;
    $('#retryQ').addEventListener('click', () => quoteEditor(v));
    $('#backQ').addEventListener('click', () => { state.quoteId = null; state.tab = 'quotes'; shell(); });
    return;
  }
  // The user moved on while we were loading — drop this render rather than painting stale data.
  if (state.quoteId !== myQuoteId) return;
  if (!q || q.error) { state.quoteId = null; state.tab = 'quotes'; return quotesList(v); }
  const link = location.origin + '/q/' + q.token;
  const applied = q.appliedSurcharges || [];
  const isApplied = id => applied.some(s => s.id === id);
  const uncheckedCritical = (checklist || []).filter(c => c.critical && !c.checked).length;
  const commonCodes = ['PL', 'EW', 'GT', 'GM', 'FC', 'CP', 'RW', 'PW', 'AL', 'AC'];
  const usedItemIds = new Set([...(q.items.scope1 || []), ...(q.items.scope2 || [])].map(i => i.priceItemId).filter(Boolean));

  v.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">Quote
        <input id="qNum" value="${esc(q.parentNumber || q.quoteNumber)}" ${isAdmin() ? '' : 'disabled'}
          style="width:104px;font-size:16px;font-weight:800;letter-spacing:.6px;padding:4px 8px;">
        ${String(q.quoteNumber).includes('.') ? `<span class="muted" style="font-size:12px;font-weight:500;">rev ${esc(String(q.quoteNumber).split('.')[1])}</span>` : ''}
        <span id="qNumMsg" style="font-size:11px;font-weight:600;"></span></h2>
        <div class="sub" id="saveStatus">Auto-saves. Client can only sign — changes create a new revision.</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-ghost" id="backList">← All quotes</button><button class="btn btn-ghost" id="newRev">+ New revision</button><a class="btn btn-ghost" href="/api/quotes/${q.id}/signed-preview" target="_blank">Preview signed contract</a>
      ${isAdmin() && q.status !== 'accepted' ? (q.lostAt
        ? `<button class="btn btn-ghost" id="reopenQuote">Reopen</button>`
        : `<button class="btn btn-ghost" id="lostQuote">Mark lost</button>`) : ''}
      ${isAdmin() ? `<button class="btn btn-blue" id="sendQuote" ${q.surchargesIncomplete || q.lostAt ? 'disabled title="' + (q.lostAt ? 'This quote is marked lost' : 'Finish the surcharge settings first') + '" style="opacity:.5;cursor:not-allowed;"' : ''}>${q.sendCount ? 'Resend to client' : 'Send to client'} →</button>` : ''}
      <span class="tag tag-${q.status === 'accepted' ? 'accepted' : 'draft'}">${esc(q.status)}</span></div>
    </div>
    <div class="rule"></div>
    ${q.lostAt ? `<div class="emailbar failed" style="background:#F6F6F6;border-color:#DDD;color:#666;">
      <b>This quote is marked as LOST</b>${q.lostReason ? ` — ${esc(q.lostReason)}` : ''}
      <br><span style="font-size:11px;">Hidden from the quotes list and can't be sent. Everything is kept — press Reopen to bring it back.</span></div>` : ''}
    ${q.emailStatus ? `<div class="emailbar ${q.emailStatus}"><b>Signed-contract email: ${q.emailStatus.toUpperCase()}</b><br><span style="font-size:11px;">${esc(q.emailDetail || '')}</span></div>` : ''}
    <div class="viewbar">
      <span><b>${q.clientViews || 0}</b> client view${q.clientViews === 1 ? '' : 's'}${q.clientVisitors > 1 ? ` from ${q.clientVisitors} visitors` : ''}</span>
      ${q.firstViewedAt ? `<span class="muted">first opened ${esc(String(q.firstViewedAt).slice(0, 16))}</span>` : '<span class="muted">not opened yet</span>'}
      ${q.internalViews ? `<span class="muted" title="Your own views and previews — never counted as client views">${q.internalViews} internal (not counted)</span>` : ''}
      ${q.legacyViews ? `<span class="muted" title="Recorded before views were attributed">${q.legacyViews} older views (unattributed)</span>` : ''}
      ${q.sentAt ? `<span class="muted">sent ${esc(String(q.sentAt).slice(0, 16))} to ${esc(q.sentTo || '')}${q.sentBy ? ' by ' + esc(q.sentBy) : ''}${q.sendCount > 1 ? ` · ${q.sendCount}×` : ''}</span>` : ''}
    </div>
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
    ${q.surchargesIncomplete ? `<div class="emailbar failed" style="margin-top:10px;"><b>Surcharge settings incomplete — this quote can't be sent</b><br>
      ${q.surchargeGaps.map(g => `${esc(g.code)} ${esc(g.name)}: no percentage set for ${g.missing.map(m => `<b>${esc(m.code)}</b>`).join(', ')}`).join('<br>')}
      <br><span style="font-size:11px;">Open the surcharge below and set a percentage (0% is fine) for each.</span></div>` : ''}
    ${(q.surchargeList || []).filter(s => s.kind === 'percent').map((s, i) => `
      <div class="surtarget" data-si="${i}">
        <div class="st-head">
          <b>${esc(s.code)} · ${esc(s.name)} — ${s.rate}%</b>
          <select data-smode="${i}" style="width:210px;font-size:11px;">
            <option value="whole" ${s.mode !== 'targeted' ? 'selected' : ''}>Across the whole job</option>
            <option value="targeted" ${s.mode === 'targeted' ? 'selected' : ''}>Only selected deliverables</option>
          </select>
          ${s.mode === 'targeted' ? `<select data-sbasis="${i}" style="width:210px;font-size:11px;">
            <option value="full" ${s.basis !== 'labour' ? 'selected' : ''}>On the full deliverable value</option>
            <option value="labour" ${s.basis === 'labour' ? 'selected' : ''}>On the labour within it</option></select>` : ''}
          <span class="st-amt">base ${money(s.base)} → <b>${money(s.amount)}</b></span>
        </div>
        ${s.mode === 'targeted' ? `<table class="st-tbl"><thead><tr><th>Deliverable</th><th class="right">Line value</th><th class="right">Labour in it</th><th style="width:120px;">% affected</th><th class="right">Charged on</th></tr></thead><tbody>
          ${(q.items.scope1 || []).map(it => {
            const lb = (q.lineBases || {})[it.id] || { full: 0, labour: 0 };
            const pct = (s.lines || {}).hasOwnProperty(it.id) ? s.lines[it.id] : null;
            const val = s.basis === 'labour' ? lb.labour : lb.full;
            return `<tr class="${pct === null ? 'st-missing' : ''}">
              <td><b>${esc(it.code)}</b> ${esc(it.name)}${pct === null ? ' <span class="tag tag-superseded">not set</span>' : ''}</td>
              <td class="right">${money(lb.full)}</td><td class="right muted">${money(lb.labour)}</td>
              <td><input type="number" min="0" max="100" step="5" value="${pct === null ? '' : pct}" placeholder="—" data-spct="${i}|${it.id}" style="width:78px;"> %</td>
              <td class="right">${pct === null ? '<span class="muted">—</span>' : money(val * (pct / 100))}</td></tr>`;
          }).join('')}
        </tbody></table>
        <div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" data-sall="${i}">All 100%</button>
          <button class="btn btn-ghost btn-sm" data-snone="${i}">All 0%</button>
        </div>` : ''}
      </div>`).join('')}
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
    body.seenRev = state.seenRev;   // detect a change made by someone else
    const r = await api('/quotes/' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r && r.conflict) {
      $('#saveStatus').innerHTML = '<span style="color:var(--red);font-weight:700;">Not saved — someone else changed this quote.</span>';
      showConflict(r);
      return false;
    }
    state.seenRev = (r && r.rev != null) ? r.rev : state.seenRev;
    $('#saveStatus').textContent = 'Auto-saved just now.';
    return true;
  };
  // Someone else edited the same quote. Don't silently overwrite them, and don't
  // silently lose what this person typed either — show both options.
  function showConflict(r) {
    if (document.getElementById('conflictBox')) return;
    const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'conflictBox';
    bg.innerHTML = `<div class="modal" style="max-width:480px;">
      <h2 style="margin:0 0 3px;">Someone else is editing this quote</h2>
      <div class="sub">${esc(r.error || '')}</div><div class="rule"></div>
      <p style="font-size:12.5px;line-height:1.7;">Your change was <b>not saved</b>, so nothing of theirs has been lost.</p>
      <p style="font-size:12.5px;line-height:1.7;">Reload to see their version, then make your change again. If you're both working on the same quote, it's worth a quick word first.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="btn btn-ghost" id="cf_stay">Stay (don't save)</button>
        <button class="btn btn-blue" id="cf_reload">Reload the quote</button></div></div>`;
    document.body.appendChild(bg);
    $('#cf_stay').addEventListener('click', () => bg.remove());
    $('#cf_reload').addEventListener('click', () => { bg.remove(); reload(); });
  }
  ['f_client', 'f_email', 'f_title', 'f_address', 'f_validity', 'f_notes'].forEach(id => $('#' + id).addEventListener('change', autosave));
  ['f_ctier', 'f_crew'].forEach(id => $('#' + id).addEventListener('change', () => autosave().then(refreshCosting)));
  $('#segPkg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPkg').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave().then(reload); }));
  $('#segPay').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('#segPay').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); autosave(); }));

  const lq = $('#lostQuote'); if (lq) lq.addEventListener('click', () => markLost(q.id, () => { state.quoteId = null; state.tab = 'quotes'; shell(); }));
  const rq = $('#reopenQuote'); if (rq) rq.addEventListener('click', async () => {
    await api('/quotes/' + q.id + '/lost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lost: false }) });
    toast('Quote reopened'); reload();
  });
  // Remember which version this screen was built from, so a save can detect that
  // someone else changed the quote in the meantime.
  state.seenRev = q.rev;
  const sq = $('#sendQuote'); if (sq) sq.addEventListener('click', () => openSendDialog(q));
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
  $('#addCustom').addEventListener('click', () => customDialog(q, null, reload));

  const surPut = (i, body) => api(`/quotes/${q.id}/surcharges/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => reload());
  v.querySelectorAll('[data-smode]').forEach(s => s.addEventListener('change', () => surPut(s.dataset.smode, { mode: s.value })));
  v.querySelectorAll('[data-sbasis]').forEach(s => s.addEventListener('change', () => surPut(s.dataset.sbasis, { basis: s.value })));
  v.querySelectorAll('[data-spct]').forEach(inp => inp.addEventListener('change', async () => {
    const [i, itemId] = inp.dataset.spct.split('|');
    const cur = (q.surchargeList[i].lines) || {};
    const next = { ...cur };
    if (inp.value === '') delete next[itemId]; else next[itemId] = Math.max(0, Math.min(100, parseFloat(inp.value) || 0));
    surPut(i, { lines: next });
  }));
  v.querySelectorAll('[data-sall]').forEach(b => b.addEventListener('click', () => {
    const lines = {}; (q.items.scope1 || []).forEach(it => lines[it.id] = 100);
    surPut(b.dataset.sall, { lines });
  }));
  v.querySelectorAll('[data-snone]').forEach(b => b.addEventListener('click', () => {
    const lines = {}; (q.items.scope1 || []).forEach(it => lines[it.id] = 0);
    surPut(b.dataset.snone, { lines });
  }));
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

  // Sticky footer: Save is quiet, Send is deliberate — the QuickBooks pattern.
  if (isAdmin() && !$('#builderBar')) {
    const bar = document.createElement('div');
    bar.id = 'builderBar'; bar.className = 'builderbar';
    bar.innerHTML = `<span class="muted" id="barStatus">Auto-saves as you work</span>
      <button class="btn btn-ghost" id="barSave">Save</button>
      <button class="btn btn-blue" id="barSend" ${q.surchargesIncomplete ? 'disabled title="Finish the surcharge settings first" style="opacity:.5;cursor:not-allowed;"' : ''}>${q.sendCount ? 'Resend to client' : 'Send to client'} →</button>`;
    v.appendChild(bar);
    $('#barSave').addEventListener('click', async () => {
      await autosave(); $('#barStatus').textContent = 'Saved just now';
      setTimeout(() => { const el = $('#barStatus'); if (el) el.textContent = 'Auto-saves as you work'; }, 2500);
    });
    $('#barSend').addEventListener('click', () => openSendDialog(q));
  }

  function renderItemsTiered(q, c) {
    const lineMap = {}; (c.perLine || []).forEach(l => lineMap[l.id] = l);
    const cTier = q.defaultPackage || 'Standard';   // the package the value fields edit
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
          <textarea data-desc="${it.id}" rows="2" placeholder="Scope description shown to the client…" style="font-size:10.5px;margin-top:4px;width:100%;">${esc(it.description || '')}</textarea>
          <label style="font-size:10px;display:flex;align-items:center;gap:6px;margin-top:4px;" title="Price this line from a supplier quote instead of the rate card">
            <input type="checkbox" data-vo="${it.id}" ${it.valueOverride ? 'checked' : ''} style="width:auto;"> site-specific value</label>
          <div class="vofields" id="vo_${it.id}" style="display:${it.valueOverride ? 'flex' : 'none'};gap:4px;margin-top:4px;flex-wrap:wrap;">
            <input data-val="${it.id}" type="number" step="0.01" value="${it.value && it.value[cTier] != null ? it.value[cTier] : ''}" placeholder="sell $" style="width:84px;font-size:10.5px;" title="What the client pays for this line">
            <input data-lcost="${it.id}" type="number" step="0.01" value="${it.lineCost && it.lineCost[cTier] != null ? it.lineCost[cTier] : ''}" placeholder="our cost $" style="width:84px;font-size:10.5px;" title="Total cost to us for this line">
            <span class="muted" style="font-size:9.5px;align-self:center;">rate card <s>${money(it.qty * (it.perTier[cTier] ? it.perTier[cTier].rate : 0))}</s></span></div>
          ${it.descIsCustom ? '<span class="muted" style="font-size:9.5px;">edited for this quote</span>' : ''}
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
        <td class="right">${it.isCustom ? `<button class="btn btn-ghost btn-sm" data-cedit="${it.id}" title="Edit this custom deliverable">Edit</button> ` : ''}<button class="btn btn-danger btn-sm" data-del="${it.id}">✕</button></td></tr>`;
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
    // Show/hide the fields in place. This used to call reload(), which re-fetched five
    // endpoints and rebuilt the whole quote — that was the freeze.
    v.querySelectorAll('[data-cedit]').forEach(b => b.addEventListener('click', () => {
      const line = [...(q.items.scope1 || []), ...(q.items.scope2 || [])].find(i => i.id === b.dataset.cedit);
      if (line) customDialog(q, line, reload);
    }));
    v.querySelectorAll('[data-vo]').forEach(c => c.addEventListener('change', async () => {
      const box = document.getElementById('vo_' + c.dataset.vo);
      if (box) box.style.display = c.checked ? 'flex' : 'none';
      if (c.checked) { const f = box && box.querySelector('[data-val]'); if (f) f.focus(); }
      await api(`/quotes/${q.id}/items/${c.dataset.vo}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valueOverride: c.checked }) });
      refreshCosting();
    }));
    v.querySelectorAll('[data-val]').forEach(i => i.addEventListener('change', async () => {
      await api(`/quotes/${q.id}/items/${i.dataset.val}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { [cTier]: i.value } }) });
      refreshCosting(); toast('Value updated');
    }));
    v.querySelectorAll('[data-lcost]').forEach(i => i.addEventListener('change', async () => {
      await api(`/quotes/${q.id}/items/${i.dataset.lcost}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cost: { [cTier]: i.value } }) });
      refreshCosting(); toast('Cost updated');
    }));
    v.querySelectorAll('[data-desc]').forEach(t => t.addEventListener('change', async () => {
      await api(`/quotes/${q.id}/items/${t.dataset.desc}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: t.value }) });
      toast('Description saved');
    }));
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
      <div><h2>Projects</h2><div class="sub"><b>Forecast</b> = the locked Selections plan. <b>Cost to date</b> = lines actually delivered or invoiced. <b>Projected final</b> = landed + committed + still-to-come at plan rates — the honest "where will this end up". Drift compares projected against forecast.</div></div>
      <div style="display:flex;gap:10px;align-items:flex-end;">
        <label style="font-size:11px;display:flex;align-items:center;gap:7px;padding-bottom:8px;"><input type="checkbox" id="gstTog" ${state.incGst ? 'checked' : ''} style="width:auto;"> Show inc. GST</label>
        <div class="field" style="margin:0;"><label>Financial year</label><select id="fySel"><option value="all">All years</option>${fys.map(f => `<option value="${f}" ${state.jobsFy === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="rule"></div>
    <div class="legend" style="margin-bottom:6px;">Showing <b>${state.incGst ? 'INCLUDING' : 'EXCLUDING'} GST</b>. Margins are calculated ex-GST either way.</div>
    <table class="resp"><thead><tr><th>Quote</th><th>Client</th><th>FY</th><th>Package</th>${isAdmin() ? `<th class="right">Sell ${state.incGst ? 'inc' : 'ex'} GST</th><th class="right">Forecast cost</th><th class="right">Forecast GM</th><th class="right">Cost to date</th><th class="right">Projected final</th><th class="right">Projected GM</th><th>Drift</th>` : ''}<th>Status</th><th></th></tr></thead><tbody>
    ${(data.jobs || []).map(jb => {
      return `<tr><td data-l="Quote"><b>${esc(jb.quoteNumber)}</b></td><td data-l="Client">${esc(jb.client || '')}</td><td data-l="FY">${esc(jb.fy || '')}</td><td>${esc(jb.tier || '')}${jb.mixed ? ' <span class="tag t-up">mixed</span>' : ''}</td>
      ${!isAdmin() ? '' : `<td class="right">${money(jb.sellExGst * (state.incGst ? 1.1 : 1))}</td>
      <td class="right">${jb.forecastCost != null ? money(jb.forecastCost * (state.incGst ? 1.1 : 1)) : '—'}</td>
      <td class="right"><b>${jb.forecastGMPct != null ? jb.forecastGMPct + '%' : '—'}</b></td>
      <td class="right">${jb.costToDate != null ? money(jb.costToDate * (state.incGst ? 1.1 : 1)) + (jb.spentPct ? ` <span class="muted">(${jb.spentPct}%)</span>` : '') : '—'}${jb.committed ? `<br><span class="muted" style="font-size:10px;" title="Ordered but not yet delivered">+${money(jb.committed)} committed</span>` : ''}</td>
      <td class="right">${jb.projectedCost != null ? money(jb.projectedCost * (state.incGst ? 1.1 : 1)) : '—'}</td>
      <td class="right"><b style="color:${jb.projectedGMPct == null ? 'var(--grey)' : jb.projectedGMPct >= (jb.forecastGMPct || 0) ? 'var(--green)' : 'var(--red)'};">${jb.projectedGMPct != null ? jb.projectedGMPct + '%' : '—'}</b></td>
      <td>${jb.driftPts == null ? '<span class="muted">—</span>' : `<span class="tag ${jb.driftPts >= 0 ? 'tag-accepted' : 'tag-superseded'}">${jb.driftPts > 0 ? '+' : ''}${jb.driftPts} pts</span>`}</td>`}
      <td><span class="tag ${jb.jobStatus === 'complete' ? 'tag-closed' : 'tag-open'}">${jb.jobStatus}</span></td>
      <td class="right">${jb.poId ? `<button class="btn btn-ghost btn-sm" data-po="${jb.poId}">PO</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="12" class="muted">No jobs won yet.</td></tr>'}</tbody></table>
    ${!isAdmin() ? '' : `<div class="grid4" style="margin-top:12px;">
      <div class="stat"><div class="k">Gross margin (before overheads)</div><div class="v">${(data.summary || {}).grossPct || 0}%</div></div>
      <div class="stat"><div class="k">Overhead allocated</div><div class="v">${money((data.summary || {}).overhead || 0)}</div><div style="font-size:10px;color:#999;">${money(data.overheadDailyRate || 0)} per crew-day</div></div>
      <div class="stat hero"><div class="k">Net-of-overhead margin</div><div class="v">${(data.summary || {}).netPct || 0}%</div></div>
      <div class="stat"><div class="k">Jobs shown</div><div class="v">${(data.jobs || []).length}</div></div>
    </div>
    </div>`}
    ${isAdmin() ? '<div class="legend">Gross margin is before overheads. The net figure allocates business overheads (supervisor, office, vehicles, insurances — not site labour) by crew-days. Year-end close still uses your real annual figures.</div>' : '<div class="legend">Job costs and margins are visible to admin only.</div>'}
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
  <table class="resp"><thead><tr><th>Vendor</th><th>Type</th><th>Area</th><th>Contact</th><th>Terms</th><th>Compliance</th><th>Materials</th><th></th></tr></thead><tbody>
  ${list.map(x => `<tr><td><b>${esc(x.name)}</b></td>
    <td>${x.isSupplier ? '<span class="tag t-sup">Supplier</span>' : ''} ${x.isSubcontractor ? '<span class="tag t-subv">Subcontractor</span>' : ''}</td>
    <td>${esc(x.area || '')}</td><td>${esc(x.contact || '')} ${esc(x.phone || '')}</td><td>${esc(x.terms || '')}</td>
    <td>${x.isSubcontractor ? (x.insuranceExpiry && x.insuranceExpiry < new Date().toISOString().slice(0, 10) ? '<span class="tag tag-superseded">Insurance expired</span>' : '<span class="tag tag-accepted">OK</span>') : '—'}</td>
    <td>${(x.supplies || []).length}</td>
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
      <h2 style="font-size:12px;">Supplies — from the Costs tab</h2>
      <div class="sub">Generated from the items linked to this vendor in Costs. Add or price items there, not here, so the two can never disagree.</div>
      ${(x.supplies || []).length ? `<table><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th class="right">Cost</th><th>Delivery rule</th><th>Review by</th><th>Default</th></tr></thead><tbody>
        ${x.supplies.map(s => `<tr><td><b>${esc(s.code)}</b></td><td>${esc(s.name)}</td><td>${esc(s.unit || '')}</td>
          <td class="right">${s.cost != null ? money2(s.cost) : '—'}</td><td>${esc(s.deliveryRule || '—')}</td>
          <td>${esc(s.reviewBy || '—')}${s.reviewBy && s.reviewBy < new Date().toISOString().slice(0, 10) ? ' <span class="tag tag-superseded">stale</span>' : ''}</td>
          <td>${s.isDefault ? '<span class="tag tag-accepted">Default</span>' : ''}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">Nothing linked yet.</p>'}
      ${(x.usedInRecipes || []).length ? `<div class="legend">Used in recipes: ${x.usedInRecipes.map(esc).join(', ')}</div>` : ''}
      <button class="btn btn-ghost btn-sm" id="v_gocosts" style="margin-top:8px;">Manage items in Costs →</button>
    </div>`;
    const gc = $('#v_gocosts'); if (gc) gc.addEventListener('click', () => { state.tab = 'materials'; state.matCat = 'material'; shell(); });
    $('#vDetail').scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------------- COSTS (Materials · Plant · Overheads) ----------------
async function materialsTab(v) {
  const [mats, vendors] = await Promise.all([api('/materials'), api('/vendors')]);
  const cat = state.matCat || 'material';
  const rows = mats.filter(m => m.category === cat);
  const isOh = cat === 'overhead';
  const wdm = 21;
  const ohTotal = mats.filter(m => m.category === 'overhead').reduce((a, m) => a + (m.monthlyCost || 0), 0);
  v.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><h2>Costs</h2><div class="sub">Materials, plant and business overheads. Every item is coded and linked to vendors and recipes — change a price once and it flows everywhere.</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${isAdmin() ? `<a class="btn btn-ghost btn-sm" href="/api/materials/export.xlsx" style="text-decoration:none;display:inline-block;">⬇ Excel</a>
        <button class="btn btn-ghost btn-sm" id="upXl">⬆ Upload Excel</button>
        <input type="file" id="xlFile" accept=".xlsx" style="display:none;">` : ''}
        ${isAdmin() ? '<button class="btn btn-blue btn-sm" id="addMat">+ Add item</button>' : ''}</div>
    </div>
    <div class="seg" id="matSeg" style="margin:4px 0 10px;">
      <button data-v="material" class="${cat === 'material' ? 'on' : ''}">Materials</button>
      <button data-v="plant" class="${cat === 'plant' ? 'on' : ''}">Plant</button>
      <button data-v="overhead" class="${cat === 'overhead' ? 'on' : ''}">Overheads</button>
    </div>
    <div class="rule"></div>
    ${isOh ? `<div class="legend" style="margin:0 0 10px;">Business overheads only — supervisor and office staff, vehicles, insurances and the like. <b>Not</b> direct site labour, which is already costed through crew hours in recipes. Enter the monthly figure; the tool spreads it across ${wdm} working days and allocates it to jobs by the days they take.</div>` : ''}
    <table class="resp"><thead><tr><th>Code</th><th>Item</th><th>Unit</th>${isOh ? '<th class="right">Monthly cost</th><th class="right">Per crew-day</th>' : `<th>Default vendor</th>${isAdmin() ? '<th class="right">Cost</th>' : ''}`}<th>Used in</th><th></th></tr></thead><tbody>
    ${rows.map(m => `<tr><td data-l="Code"><b>${esc(m.code)}</b></td><td data-l="Item">${esc(m.name)}</td><td data-l="Unit">${esc(m.unit || '')}</td>
      ${isOh ? `<td class="right">${isAdmin() ? `<input type="number" step="10" value="${m.monthlyCost || 0}" data-ohc="${m.id}" style="width:100px;text-align:right;">` : money(m.monthlyCost || 0)}</td>
                <td class="right muted">${money2((m.monthlyCost || 0) / wdm)}</td>`
             : `<td>${m.defaultVendor ? `<span class="muted">${esc(m.defaultVendorCode || '')}</span> ${esc(m.defaultVendor)}` : '<span class="tag tag-superseded">none set</span>'}</td>
                ${isAdmin() ? `<td class="right">${money2(m.defaultCost || 0)}</td>` : ''}`}
      <td>${m.usedIn.length ? m.usedIn.map(u => `<span class="tag t-def">${esc(u)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
      <td class="right">${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-em="${m.id}">Open</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">No ${cat} items yet.</td></tr>`}
    </tbody></table>
    ${isOh ? `<div class="grid3" style="margin-top:12px;">
      <div class="stat"><div class="k">Total monthly overheads</div><div class="v">${money(ohTotal)}</div></div>
      <div class="stat"><div class="k">Working days / month</div><div class="v">${wdm}</div></div>
      <div class="stat hero"><div class="k">Allocated per crew-day</div><div class="v">${money2(ohTotal / wdm)}</div></div>
    </div>
    <div class="legend">A job needing 6.8 crew-days carries ${money((ohTotal / wdm) * 6.8)} of overhead — that's what turns gross margin into the net-of-overhead figure in Projects. Items referenced directly by a recipe (like PL) are excluded from this pool so they aren't counted twice.</div>` : ''}
    </div><div id="matDetail"></div><div id="xlPreview"></div>`;
  $('#matSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.matCat = b.dataset.v; materialsTab(v); }));
  v.querySelectorAll('[data-ohc]').forEach(i => i.addEventListener('change', async () => {
    await api('/materials/' + i.dataset.ohc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthlyCost: parseFloat(i.value) || 0 }) });
    toast('Overhead updated'); materialsTab(v);
  }));
  const add = $('#addMat'); if (add) add.addEventListener('click', () => newItemForm());
  // New items open as a form and STAY OPEN — nothing is written until Save, so you can
  // fill in the vendors and prices in one pass instead of the tab reloading under you.
  function newItemForm() {
    const draftVendors = [];
    const paint = () => {
      $('#matDetail').innerHTML = `<div class="card"><h2>New ${cat === 'overhead' ? 'overhead' : cat}</h2>
        <div class="sub">Nothing is saved until you press Save at the bottom.</div><div class="rule"></div>
        <div class="grid4">
          <div class="field"><label>Item name</label><input id="n_name" value="${esc(state.draftName || '')}"></div>
          <div class="field"><label>Unit</label><input id="n_unit" value="${esc(state.draftUnit || (cat === 'overhead' ? 'month' : 'ea'))}"></div>
          <div class="field"><label>Type</label><select id="n_cat">${['material', 'plant', 'overhead'].map(x => `<option value="${x}" ${x === cat ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
          ${cat === 'overhead' ? `<div class="field"><label>Monthly cost $</label><input id="n_mc" type="number" step="10" value="${state.draftMc || 0}"></div>` : '<div></div>'}
        </div>
        ${cat !== 'overhead' ? `<b style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Vendors &amp; prices</b>
        <table style="margin-top:6px;"><thead><tr><th>Vendor</th><th class="right">Cost $</th><th>Delivery rule</th><th>Review by</th><th>Default</th><th></th></tr></thead><tbody>
        ${draftVendors.map((d, i) => `<tr><td><select data-dv="${i}">${vendors.map(x => `<option value="${x.id}" ${d.vendorId === x.id ? 'selected' : ''}>${esc(x.code || '')} ${esc(x.name)}</option>`).join('')}</select></td>
          <td class="right"><input data-dc="${i}" type="number" step="0.01" value="${d.cost}" style="text-align:right;"></td>
          <td><input data-dd="${i}" value="${esc(d.deliveryRule || '')}" placeholder="e.g. $180 / load · 80 per load"></td>
          <td><input data-dr="${i}" type="date" value="${esc(d.reviewBy || '')}"></td>
          <td class="center"><input type="radio" name="ndef" data-df="${i}" ${d.isDefault ? 'checked' : ''} style="width:auto;"></td>
          <td><button class="btn btn-ghost btn-sm" data-dx="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No vendors added yet.</td></tr>'}
        </tbody></table>
        <button class="btn btn-ghost btn-sm" id="n_addv" style="margin-top:8px;">+ Add a vendor</button>` : ''}
        <div class="savebar"><span class="muted" style="margin-right:auto;font-size:11px;">Nothing saved until you press Save.</span>
          <button class="btn btn-ghost" id="n_cancel">Cancel</button><button class="btn btn-blue" id="n_save">Save item</button></div></div>`;
      const keep = () => { state.draftName = $('#n_name').value; state.draftUnit = $('#n_unit').value; if ($('#n_mc')) state.draftMc = $('#n_mc').value; };
      ['#n_name', '#n_unit', '#n_mc'].forEach(s => { const el = $(s); if (el) el.addEventListener('input', keep); });
      const av = $('#n_addv'); if (av) av.addEventListener('click', () => { keep(); draftVendors.push({ vendorId: (vendors[0] || {}).id, cost: 0, deliveryRule: '', reviewBy: '', isDefault: draftVendors.length === 0 }); paint(); });
      v.querySelectorAll('[data-dv]').forEach(s => s.addEventListener('change', () => draftVendors[+s.dataset.dv].vendorId = s.value));
      v.querySelectorAll('[data-dc]').forEach(i => i.addEventListener('change', () => draftVendors[+i.dataset.dc].cost = parseFloat(i.value) || 0));
      v.querySelectorAll('[data-dd]').forEach(i => i.addEventListener('change', () => draftVendors[+i.dataset.dd].deliveryRule = i.value));
      v.querySelectorAll('[data-dr]').forEach(i => i.addEventListener('change', () => draftVendors[+i.dataset.dr].reviewBy = i.value));
      v.querySelectorAll('[data-df]').forEach(r => r.addEventListener('change', () => draftVendors.forEach((d, i) => d.isDefault = i === +r.dataset.df)));
      v.querySelectorAll('[data-dx]').forEach(b => b.addEventListener('click', () => { keep(); draftVendors.splice(+b.dataset.dx, 1); paint(); }));
      $('#n_cancel').addEventListener('click', () => { state.draftName = state.draftUnit = state.draftMc = null; $('#matDetail').innerHTML = ''; });
      $('#n_save').addEventListener('click', async () => {
        const name = $('#n_name').value.trim();
        if (!name) return toast('Give the item a name first');
        const body = { name, unit: $('#n_unit').value, category: $('#n_cat').value };
        if ($('#n_mc')) body.monthlyCost = parseFloat($('#n_mc').value) || 0;
        const r = await api('/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        for (const d of draftVendors) {
          if (!d.vendorId) continue;
          await api(`/materials/${r.id}/vendors`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vendorId: d.vendorId, cost: d.cost, deliveryRule: d.deliveryRule, reviewBy: d.reviewBy }) });
        }
        const def = draftVendors.find(d => d.isDefault);
        if (def) await api('/materials/' + r.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultVendorId: def.vendorId }) });
        state.draftName = state.draftUnit = state.draftMc = null;
        toast('Saved'); materialsTab(v);
      });
      $('#matDetail').scrollIntoView({ behavior: 'smooth' });
    };
    paint();
  }
  const up = $('#upXl'); if (up) {
    up.addEventListener('click', () => $('#xlFile').click());
    $('#xlFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const buf = await f.arrayBuffer();
      const pv = await fetch('/api/materials/import?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }).then(r => r.json());
      $('#xlPreview').innerHTML = `<div class="card"><h2>Review changes before saving</h2>
        <div class="sub">Nothing has been saved yet. ${pv.changes.length} change(s) found${pv.errors.length ? `, ${pv.errors.length} problem(s)` : ''}.</div><div class="rule"></div>
        ${pv.errors.length ? `<div class="emailbar failed">${pv.errors.map(esc).join('<br>')}</div>` : ''}
        ${pv.changes.length ? `<table><thead><tr><th>Change</th><th>Code</th><th>Item</th><th>Vendor</th><th class="right">From</th><th class="right">To</th></tr></thead><tbody>
        ${pv.changes.map(c => `<tr><td>${esc(c.type.replace(/-/g, ' '))}</td><td><b>${esc(c.code || '')}</b></td><td>${esc(c.item || '')}</td><td>${esc(c.vendor || '')}</td>
          <td class="right muted">${c.from !== undefined ? money2(c.from) : '—'}</td><td class="right"><b>${c.to !== undefined ? money2(c.to) : '—'}</b></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">Nothing to change — the file matches what\'s already here.</p>'}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button class="btn btn-ghost" id="xlCancel">Cancel</button>
          ${pv.changes.length ? '<button class="btn btn-blue" id="xlApply">Apply these changes</button>' : ''}</div></div>`;
      $('#xlPreview').scrollIntoView({ behavior: 'smooth' });
      $('#xlCancel').addEventListener('click', () => { $('#xlPreview').innerHTML = ''; $('#xlFile').value = ''; });
      const ap = $('#xlApply'); if (ap) ap.addEventListener('click', async () => {
        const r = await fetch('/api/materials/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }).then(x => x.json());
        toast(r.applied + ' change(s) applied'); $('#xlFile').value = ''; materialsTab(v);
      });
    });
  }
  v.querySelectorAll('[data-em]').forEach(b => b.addEventListener('click', () => openMat(b.dataset.em)));
  async function openMat(id) {
    const all = await api('/materials'); const m = all.find(x => x.id === id); if (!m) return;
    $('#matDetail').innerHTML = `<div class="card"><h2>${esc(m.code)} — ${esc(m.name)}</h2><div class="rule"></div>
      <div class="grid4">
        <div class="field"><label>Name</label><input id="m_name" value="${esc(m.name)}"></div>
        <div class="field"><label>Unit</label><input id="m_unit" value="${esc(m.unit || '')}"></div>
        <div class="field"><label>Type</label><select id="m_cat"><option value="material" ${m.category === 'material' ? 'selected' : ''}>Material</option><option value="plant" ${m.category === 'plant' ? 'selected' : ''}>Plant</option><option value="overhead" ${m.category === 'overhead' ? 'selected' : ''}>Overhead</option></select></div>
        ${m.category === 'overhead'
          ? `<div class="field"><label>Monthly cost $</label><input id="m_mc" type="number" step="10" value="${m.monthlyCost || 0}"></div>`
          : `<div class="field"><label>Default vendor</label><select id="m_def"><option value="">— none —</option>${(m.vendors || []).map(x => `<option value="${x.vendorId}" ${x.isDefault ? 'selected' : ''}>${esc(x.vendorCode || '')} ${esc(x.vendor)}</option>`).join('')}</select></div>`}
      </div>
      <button class="btn btn-blue" id="m_save">Save item</button>
      ${m.category !== 'overhead' ? `<div class="rule" style="margin-top:16px;"></div>
      <h2 style="font-size:12px;">Vendors &amp; prices</h2>
      <div class="sub">Alternates let you switch on proximity, price or availability — at quote time or at Selections.</div>
      <table><thead><tr><th>Code</th><th>Vendor</th><th class="right">Cost</th><th>Delivery rule</th><th>Review by</th><th>Default</th><th></th></tr></thead><tbody>
      ${(m.vendors || []).map(x => `<tr><td><b>${esc(x.code)}</b></td><td>${esc(x.vendor)}</td>
        <td class="right"><input type="number" step="0.01" value="${x.cost}" data-mvc="${x.id}" style="width:90px;text-align:right;"></td>
        <td><input value="${esc(x.deliveryRule || '')}" data-mvd="${x.id}" placeholder="e.g. $180/load"></td>
        <td><input type="date" value="${esc(x.reviewBy || '')}" data-mvr="${x.id}" style="width:135px;"></td>
        <td>${x.isDefault ? '<span class="tag tag-accepted">Default</span>' : `<button class="btn btn-ghost btn-sm" data-mvdef="${x.id}">Make default</button>`}</td>
        <td class="right"><button class="btn btn-danger btn-sm" data-mvdel="${x.id}">✕</button></td></tr>`).join('')}
      </tbody></table>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <select id="m_newv" style="max-width:220px;"><option value="">+ Add a vendor for this item…</option>${vendors.map(x => `<option value="${x.id}">${esc(x.code || '')} ${esc(x.name)}</option>`).join('')}</select>
        <input id="m_newc" type="number" step="0.01" placeholder="cost" style="width:100px;">
        <button class="btn btn-ghost btn-sm" id="m_addv">Add</button>
      </div>` : ''}
      <div class="legend">Used in: ${m.usedIn.length ? m.usedIn.join(', ') : 'no recipes yet'}.</div>
    </div>`;
    $('#m_save').addEventListener('click', async () => {
      const body = { name: $('#m_name').value, unit: $('#m_unit').value, category: $('#m_cat').value };
      if ($('#m_mc')) body.monthlyCost = parseFloat($('#m_mc').value) || 0;
      if ($('#m_def')) body.defaultVendorId = $('#m_def').value || null;
      await api('/materials/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('Saved'); materialsTab(v);
    });
    const av = $('#m_addv'); if (av) av.addEventListener('click', async () => {
      if (!$('#m_newv').value) return;
      await api(`/materials/${id}/vendors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vendorId: $('#m_newv').value, cost: parseFloat($('#m_newc').value) || 0 }) });
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
// Costing one unit puts every once-per-job cost (plant hire, delivery) on that single
// unit, which made In-house look many times dearer than Subcontract. Split them out.
function indicativeLine(cur) {
  const parts = ['in', 'sub', 'mixed'].filter(k => cur.indicative && cur.indicative[k] != null).map(k => {
    const d = cur.indicative[k];
    const variable = typeof d === 'object' ? d.variable : d;
    const fixed = typeof d === 'object' ? d.fixed : 0;
    return `<b>${VNAME[k]}</b> ${money2(variable)}/${esc(cur.unit)}${fixed ? ` + ${money(fixed)} per job` : ''}`;
  });
  return 'Indicative cost at Standard — ' + parts.join(' &nbsp;·&nbsp; ') +
    '<br><span style="color:#aaa;">Variable is per ' + esc(cur.unit) + '; fixed costs (plant hire, delivery) are charged once per job, so compare the two separately.</span>';
}
async function recipesTab(v) {
  const sub = state.recipesSub || 'live';
  const [recs, mats, vendors, pending] = await Promise.all([api('/recipes'), api('/materials'), api('/vendors'),
    isAdmin() ? api('/recipes/pending') : Promise.resolve([])]);
  const pendCount = (pending || []).length;
  if (sub === 'pending') {
    v.innerHTML = `<div class="card"><h2>Cost recipes</h2>
      <div class="seg" id="recSubSeg" style="margin:4px 0 10px;">
        <button data-v="live">Recipes <span style="opacity:.6;">${recs.filter(r => Object.keys(r.variants).length).length}</span></button>
        <button data-v="pending" class="on">Pending <span class="cnt">${pendCount}</span></button>
      </div><div class="rule"></div>
      <div class="sub">Deliverables added to Pricing from a custom line that don't have a recipe yet. Until one exists they cost at the figure typed on the original quote, so quotes stay accurate in the meantime.</div>
      <table class="resp"><thead><tr><th>Code</th><th>Deliverable</th><th>Came from</th><th class="right">Cost in use</th><th class="right">Standard sell</th><th></th></tr></thead><tbody>
      ${pending.map(p => `<tr><td data-l="Code"><b>${esc(p.code)}</b></td>
        <td data-l="Deliverable">${esc(p.name)}${p.description ? `<br><span class="muted" style="font-size:10.5px;">${esc(p.description.slice(0, 90))}</span>` : ''}</td>
        <td data-l="From">Quote ${esc(p.originQuote || '—')}</td>
        <td data-l="Cost" class="right">${p.enteredCost.Standard != null ? money(p.enteredCost.Standard) : '—'} <span class="tag tag-incomplete">entered</span></td>
        <td data-l="Sell" class="right">${money(p.sell.Standard || 0)}</td>
        <td class="right"><button class="btn btn-blue btn-sm" data-build="${p.priceItemId}">Build recipe</button> <button class="btn btn-ghost btn-sm" data-keep="${p.priceItemId}">Keep entered cost</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing pending.</td></tr>'}
      </tbody></table></div>`;
    $('#recSubSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.recipesSub = b.dataset.v; recipesTab(v); }));
    v.querySelectorAll('[data-build]').forEach(b => b.addEventListener('click', async () => {
      const p = pending.find(x => x.priceItemId === b.dataset.build);
      await api('/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priceItemId: p.priceItemId, variant: 'in' }) });
      state.recipesSub = 'live'; state.recipeCode = p.code; state.recipeVariant = 'in'; toast('Recipe started for ' + p.code); recipesTab(v);
    }));
    v.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', async () => {
      await api('/recipes/pending/' + b.dataset.keep + '/keep-entered-cost', { method: 'POST' });
      toast('Will keep using the entered cost'); recipesTab(v);
    }));
    return;
  }
  const openCode = state.recipeCode || (recs.find(r => Object.keys(r.variants).length) || recs[0] || {}).code;
  const cur = recs.find(r => r.code === openCode) || recs[0];
  const variant = state.recipeVariant || (cur && cur.defaultVariant) || 'in';
  v.innerHTML = `<div class="card">
      <h2>Cost recipes</h2>
      <div class="seg" id="recSubSeg" style="margin:4px 0 10px;">
        <button data-v="live" class="on">Recipes <span style="opacity:.6;">${recs.filter(r => Object.keys(r.variants).length).length}</span></button>
        ${pendCount ? `<button data-v="pending">Pending <span class="cnt">${pendCount}</span></button>` : ''}
      </div>
      <div class="sub">Every deliverable has three: In-house, Subcontract and Mixed. One is the default — it can be changed on a quote, and again at Selections before the PO.</div><div class="rule"></div>
      <div id="recPick">${recs.map(r => `<span class="pickitem ${r.code === openCode ? 'on' : ''}" data-rc="${esc(r.code)}">${esc(r.code)} ${esc(r.name.split(' ').slice(0, 2).join(' '))}${r.defaultVariant ? ` <span class="muted">· ${VNAME[r.defaultVariant]}</span>` : ' <span class="tag tag-superseded">none</span>'}</span>`).join('')}</div>
    </div>${cur ? `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><h2>${esc(cur.code)} — ${esc(cur.name)}</h2><div class="sub">per ${esc(cur.unit)}${isAdmin() && cur.indicative ? '' : ''}</div></div>
        <div class="seg" id="varSeg">${['in', 'sub', 'mixed'].map(x => `<button data-v="${x}" class="${variant === x ? 'on' : ''}">${VNAME[x]}${cur.defaultVariant === x ? ' ★' : ''}</button>`).join('')}</div>
      </div>
      ${isAdmin() && cur.indicative ? `<div class="legend" id="indBar" style="margin:2px 0 0;">${indicativeLine(cur)}</div>` : ''}
      <div class="rule"></div><div id="recBody"></div></div>` : ''}`;
  const rss = $('#recSubSeg'); if (rss) rss.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.recipesSub = b.dataset.v; recipesTab(v); }));
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
      ${isAdmin() && (R.deliveryCost > 0) ? `<span style="font-size:11px;color:var(--gold);">Legacy whole-recipe delivery $ <input type="number" id="r_del" value="${R.deliveryCost || 0}" style="width:80px;display:inline-block;"> — set this to 0 and use the per-material delivery rules instead</span>` : `<span style="font-size:11px;" class="muted">Delivery is set per material (below), from each vendor in Costs.</span><input type="hidden" id="r_del" value="0">`}
    </div>
    <table><thead><tr><th>Component</th><th>Item / vendor</th><th>Ratio</th><th>Waste %</th><th class="center">Basic</th><th class="center">Standard</th><th class="center">Premium</th><th>Days</th><th></th></tr></thead><tbody>
    ${R.components.map(c => {
      if (c.kind === 'labour') return `<tr><td><span class="tag t-in">Our labour</span></td><td class="muted">Own crew · person-hrs per ${esc(cur.unit)}</td><td>—</td><td>—</td>
        ${['Basic', 'Standard', 'Premium'].map(t => `<td class="center"><input type="number" step="0.01" value="${c.hrs[t] || 0}" data-rh="${R.id}|${c.id}|${t}" style="width:70px;text-align:center;"></td>`).join('')}
        <td>—</td><td class="right"><button class="btn btn-danger btn-sm" data-rcdel="${R.id}|${c.id}">✕</button></td></tr>`;
      if (c.kind === 'overhead') return `<tr><td><span class="tag t-oh">Overhead</span></td>
        <td><select data-rmm="${R.id}|${c.id}">${matOpts(c.materialId)}</select><br><span class="muted" style="font-size:10px;">from Costs → Overheads</span></td>
        <td><input type="number" step="0.1" value="${c.ratio}" data-rr="${R.id}|${c.id}" style="width:74px;" title="crew-days this deliverable occupies"></td>
        <td class="muted">days</td>
        <td class="center muted" colspan="3">${isAdmin() ? money2(c.unitCost || 0) + ' / day' : '—'}</td>
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
        <td><input type="number" step="0.5" value="${c.wastagePct}" data-rw="${R.id}|${c.id}" style="width:62px;">
          ${c.kind === 'material' || c.kind === 'plant' ? `<div style="margin-top:4px;"><input data-rdel="${c.materialId || (c.mat && c.mat.Standard) || ''}" value="${esc(c.deliveryRule || '')}" placeholder="delivery rule" style="width:150px;font-size:10px;" title="Delivery for THIS material, from its vendor in Costs — e.g. $180 / load · 80 per load"></div>` : ''}</td>
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
      <button class="btn btn-ghost btn-sm" data-addc="overhead">+ Overhead</button>
      <button class="btn btn-danger btn-sm" id="delRec" style="margin-left:auto;">Delete this recipe</button></div>` : ''}
    <div class="legend">Material prices come from the library — change one there and every recipe using it follows. Wastage here is the standard; each quote can override it for odd-shaped sites.</div>`;
  // Keep the indicative line honest as soon as anything changes.
  async function refreshIndicative() {
    const bar = $('#indBar'); if (!bar) return;
    const fresh = await api('/recipes');
    const c2 = fresh.find(r => r.code === cur.code);
    if (c2) bar.innerHTML = indicativeLine(c2);
  }
  const rput = (rid, body) => api('/recipes/' + rid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cput = (key, body) => { const [rid, cid] = key.split('|'); return api(`/recipes/${rid}/components/${cid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); };
  const md = $('#mkDef'); if (md) md.addEventListener('click', async () => { await rput(R.id, { makeDefault: true }); toast('Default set'); recipesTab(v); });
  const rd = $('#r_del'); if (rd) rd.addEventListener('change', () => rput(R.id, { deliveryCost: parseFloat(rd.value) || 0 }).then(() => { toast('Saved'); refreshIndicative(); }));
  const bind = (sel, fn) => v.querySelectorAll(sel).forEach(i => i.addEventListener('change', () => { const r = fn(i); Promise.resolve(r).then(refreshIndicative); }));
  bind('[data-rr]', i => cput(i.dataset.rr, { ratio: parseFloat(i.value) || 0 }));
  bind('[data-rw]', i => cput(i.dataset.rw, { wastagePct: parseFloat(i.value) || 0 }));
  // Delivery rule lives on the material/vendor link in Costs — save it there.
  v.querySelectorAll('[data-rdel]').forEach(i => i.addEventListener('change', async () => {
    const mid = i.dataset.rdel; if (!mid) return toast('Pick a library item first');
    const m = (await api('/materials')).find(x => x.id === mid);
    const mv = m && (m.vendors || []).find(x => x.isDefault) || (m && (m.vendors || [])[0]);
    if (!mv) return toast('That item has no vendor yet — add one in Costs');
    await api(`/materials/${mid}/vendors/${mv.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deliveryRule: i.value }) });
    toast('Delivery rule saved to Costs'); refreshIndicative();
  }));
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
    <table class="resp"><thead><tr><th>Quote</th><th>Client / site</th><th>Package</th><th>Stage</th><th>PO</th><th></th></tr></thead><tbody>
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
    <table><thead><tr><th>Code</th><th>Deliverable</th><th>Qty</th><th>Quoted as</th><th>Final method</th><th>Vendor</th><th>Sub days</th>${d.restricted ? '' : '<th class="right">Cost impact</th>'}</tr></thead><tbody>
    ${d.lines.map(l => `<tr ${l.delta !== 0 ? 'style="background:#FFFBF2;"' : ''}>
      <td><b>${esc(l.code)}</b></td><td>${esc(l.name)}<br><span class="muted" style="font-size:10.5px;">${esc(l.spec || '')}</span></td>
      <td>${l.qty} ${esc(l.unit || '')}</td>
      <td><span class="tag ${l.quotedMethod === 'in' ? 't-in' : l.quotedMethod === 'sub' ? 't-subv' : 't-mix'}">${VNAME[l.quotedMethod] || l.quotedMethod}</span></td>
      <td><select data-sm="${l.id}" ${d.locked ? 'disabled' : ''} style="width:118px;">
        ${['in', 'sub', 'mixed'].map(x => `<option value="${x}" ${l.finalMethod === x ? 'selected' : ''} ${l.availableVariants.includes(x) ? '' : 'disabled'}>${VNAME[x]}${l.variantCost[x] ? ' · ' + money(l.variantCost[x].cost) : ''}</option>`).join('')}</select></td>
      <td><select data-sv="${l.id}" ${d.locked ? 'disabled' : ''} style="width:140px;"><option value="">Default vendor</option>${d.vendors.map(x => `<option value="${x.id}" ${l.selVendorId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
      <td><input type="number" step="0.5" value="${l.subDays ?? ''}" data-sd="${l.id}" ${d.locked ? 'disabled' : ''} style="width:62px;"></td>
      ${d.restricted ? '' : `<td class="right"><b style="color:${l.delta < 0 ? 'var(--green)' : l.delta > 0 ? 'var(--red)' : 'var(--grey)'};">${l.delta === 0 ? 'no change' : (l.delta > 0 ? '+' : '') + money(l.delta)}</b></td>`}</tr>`).join('')}
    </tbody></table>
    <div class="grid4" style="margin-top:14px;">
      ${d.restricted ? '' : `<div class="stat"><div class="k">Quoted cost</div><div class="v">${money(d.quoted.cost)}</div></div>`}
      ${d.restricted ? '' : `<div class="stat hero"><div class="k">Selected cost</div><div class="v">${money(d.final.cost)}</div><div style="font-size:10px;color:#cfe0ff;">${dCost === 0 ? 'same as quoted' : (dCost > 0 ? '+' : '') + money(dCost)}</div></div>
      <div class="admin-only"><div class="k">🔒 Margin after selections</div><div class="v" style="color:${d.final.marginPct >= d.quoted.marginPct ? 'var(--green)' : 'var(--red)'};">${d.final.marginPct}%</div><div style="font-size:10px;">was ${d.quoted.marginPct}% at quote</div></div>`}
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
  v.querySelectorAll('[data-sdesc]').forEach(t => t.addEventListener('change', () => put(t.dataset.sdesc, { description: t.value })));
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
  const sub = state.pricingSub || 'live';
  const [items, pending] = await Promise.all([api('/price-list'), isAdmin() ? api('/quotes/pending/price-items') : Promise.resolve([])]);
  const pendCount = (pending || []).length;
  v.innerHTML = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><h2>Pricing</h2><div class="sub">Sell rates per package. Codes and descriptions flow through to the client link, contract and site PO.</div></div>
        ${isAdmin() && sub === 'live' ? '<button class="btn btn-blue" id="addPi">+ New deliverable</button>' : ''}
      </div>
      <div class="seg" id="priceSeg" style="margin:4px 0 10px;">
        <button data-v="live" class="${sub === 'live' ? 'on' : ''}">Deliverables <span style="opacity:.6;">${items.length}</span></button>
        ${pendCount ? `<button data-v="pending" class="${sub === 'pending' ? 'on' : ''}">Pending <span class="cnt">${pendCount}</span></button>` : ''}
      </div>
      <div class="rule"></div><div id="priceBody"></div></div><div id="piDetail"></div>`;
  $('#priceSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.pricingSub = b.dataset.v; pricingSheet(v); }));
  const body = $('#priceBody');

  if (sub === 'pending') {
    body.innerHTML = `<div class="sub" style="margin-bottom:8px;">Custom lines created on quotes. They already work on the quote they came from — this only decides whether they join the reusable list.</div>
      <table class="resp"><thead><tr><th>Code</th><th>Deliverable</th><th>Created on</th><th>Pricing</th><th class="right">Standard sell</th><th class="right">Our cost</th><th class="right">Margin</th><th></th></tr></thead><tbody>
      ${pending.map(p => `<tr><td data-l="Code"><b>${esc(p.code)}</b></td>
        <td data-l="Deliverable"><b>${esc(p.name)}</b>${p.description ? `<br><span class="muted" style="font-size:10.5px;">${esc(p.description.slice(0, 90))}</span>` : ''}</td>
        <td data-l="From">${esc(p.quoteNumber || '')} · ${esc(p.client || '')}</td>
        <td data-l="Pricing">${p.tiered ? 'Tiered' : 'Same all packages'}</td>
        <td data-l="Sell" class="right">${money(p.value.Standard || 0)}</td>
        <td data-l="Cost" class="right">${p.cost.Standard != null ? money(p.cost.Standard) : '<span class="muted">not set</span>'}</td>
        <td data-l="Margin" class="right"><b style="color:${(p.marginPct || 0) >= 25 ? 'var(--green)' : 'var(--red)'};">${p.marginPct != null ? p.marginPct + '%' : '—'}</b></td>
        <td class="right"><button class="btn btn-blue btn-sm" data-promote="${p.itemId}">Add to list</button> <button class="btn btn-ghost btn-sm" data-dismiss="${p.itemId}">Dismiss</button></td></tr>`).join('')}
      </tbody></table>`;
    body.querySelectorAll('[data-promote]').forEach(b => b.addEventListener('click', async () => {
      const r = await api('/quotes/pending/' + b.dataset.promote + '/promote', { method: 'POST' });
      if (r.error) return toast(r.error);
      state.pendingCheckedAt = 0; toast(r.code + ' added to Pricing — build its recipe when you\'re ready'); pricingSheet(v);
    }));
    body.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
      await api('/quotes/pending/' + b.dataset.dismiss + '/dismiss', { method: 'POST' });
      state.pendingCheckedAt = 0; toast('Dismissed — the quote is unchanged'); pricingSheet(v);
    }));
    return;
  }

  body.innerHTML = `<table class="resp"><thead><tr><th>Code</th><th>Deliverable</th><th>Unit</th><th>Behaviour</th><th class="right">Basic</th><th class="right">Standard</th><th class="right">Premium</th><th></th></tr></thead><tbody>
    ${items.map(p => `<tr><td data-l="Code"><b>${esc(p.code)}</b></td>
      <td data-l="Deliverable">${esc(p.name)}${p.fromCustom ? ' <span class="tag t-cust">from custom</span>' : ''}${p.recipeStatus === 'pending' ? ' <span class="tag tag-incomplete">recipe pending</span>' : ''}
        ${p.description ? `<br><span class="muted" style="font-size:10.5px;">${esc(p.description.slice(0, 80))}</span>` : ''}</td>
      <td data-l="Unit">${esc(p.unit || '')}</td><td data-l="Behaviour" class="muted">${esc(p.behaviour || 'none')}</td>
      <td data-l="Basic" class="right">${money((p.tiers && p.tiers.Basic) ? p.tiers.Basic.sell : 0)}</td>
      <td data-l="Standard" class="right">${money((p.tiers && p.tiers.Standard) ? p.tiers.Standard.sell : 0)}</td>
      <td data-l="Premium" class="right">${money((p.tiers && p.tiers.Premium) ? p.tiers.Premium.sell : 0)}</td>
      <td class="right">${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-pi="${p.id}">Edit</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
  const ap = $('#addPi'); if (ap) ap.addEventListener('click', () => editPriceItem(null, v));
  body.querySelectorAll('[data-pi]').forEach(b => b.addEventListener('click', () => editPriceItem(items.find(x => x.id === b.dataset.pi), v)));
}
function editPriceItem(item, v) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const t = item ? item.tiers : { Basic: {}, Standard: {}, Premium: {} };
  bg.innerHTML = `<div class="modal"><h2 style="margin:0 0 12px;">${item ? 'Edit' : 'Add'} deliverable</h2>
    <div class="grid3"><div class="field"><label>Code</label><input id="p_code" value="${esc(item?.code || '')}"></div><div class="field"><label>Unit</label><input id="p_unit" value="${esc(item?.unit || 'ea')}"></div><div class="field"><label>Behaviour</label><select id="p_behav">${Object.entries(BEHAV).map(([k, val]) => `<option value="${k}" ${item?.behaviour === k ? 'selected' : ''}>${val || 'Standard'}</option>`).join('')}</select></div></div>
    <div class="field"><label>Name</label><input id="p_name" value="${esc(item?.name || '')}"></div>
    <div class="field"><label>Scope description — shown to the client, on the contract and the site PO</label>
      <textarea id="p_desc" rows="3" placeholder="e.g. Supply and install turf to prepared areas including underlay sand, starter fertiliser and consolidation.">${esc(item?.description || '')}</textarea>
      <span class="muted" style="font-size:10px;">This is the default. It can be tailored per quote in the builder, and again at Selections for the site team.</span></div>
    ${TIERS.map(tt => `<div class="grid2"><div class="field"><label>${tt} spec</label><input id="p_${tt}_spec" value="${esc(t[tt].spec || '')}"></div><div class="field"><label>${tt} sell $</label><input id="p_${tt}_sell" type="number" value="${t[tt].sell || 0}"></div></div>`).join('')}
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:8px;">${item ? '<button class="btn btn-danger" id="p_del">Delete</button>' : '<span></span>'}<div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="p_cancel">Cancel</button><button class="btn btn-blue" id="p_save">Save</button></div></div></div>`;
  document.body.appendChild(bg);
  $('#p_cancel').addEventListener('click', () => bg.remove());
  $('#p_save').addEventListener('click', async () => {
    const body = { code: $('#p_code').value, name: $('#p_name').value, unit: $('#p_unit').value, behaviour: $('#p_behav').value, description: $('#p_desc').value, tiers: { Basic: { spec: $('#p_Basic_spec').value, sell: +$('#p_Basic_sell').value }, Standard: { spec: $('#p_Standard_spec').value, sell: +$('#p_Standard_sell').value }, Premium: { spec: $('#p_Premium_spec').value, sell: +$('#p_Premium_sell').value } } };
    if (item) await api('/price-list/' + item.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); else await api('/price-list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    bg.remove(); toast('Saved'); pricingSheet(v || $('#view'));
  });
  const del = $('#p_del'); if (del) del.addEventListener('click', async () => { if (confirm('Delete?')) { await api('/price-list/' + item.id, { method: 'DELETE' }); bg.remove(); pricingSheet(v || $('#view')); } });
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
        <div style="font-size:12.5px;line-height:1.9;margin-top:4px;"><b>${money(parseFloat(s.crew_day_rate || 1150))}</b>/day for <b>${esc(s.crew_people || '3')}</b> people · <b>${esc(s.hours_per_day || '8')}</b> hrs/day<br>
        <span class="muted">= ${money2((parseFloat(s.crew_day_rate || 1150) / Math.max(1, parseFloat(s.crew_people || 3)) / Math.max(1, parseFloat(s.hours_per_day || 8))))} per person-hour</span></div></div>
    </div></div>
  <div class="card"><h2>Email signature</h2>
    <div class="sub">Used on quote emails and signed-contract emails. First line is shown in bold as your name.</div><div class="rule"></div>
    <div class="grid2">
      <div class="field"><label>Signature</label><textarea id="set_email_signature" rows="6">${esc(s.email_signature || '')}</textarea></div>
      <div class="field"><label>Default quote email — subject</label><input id="set_quote_email_subject" value="${esc(s.quote_email_subject || '')}">
        <label style="margin-top:10px;">Default quote email — message</label><textarea id="set_quote_email_body" rows="6">${esc(s.quote_email_body || '')}</textarea>
        <span class="muted" style="font-size:10px;">{{firstname}}, {{client}}, {{number}} and {{address}} are filled in automatically. You can still edit every message before it sends.</span></div>
    </div>
    <button class="btn btn-blue" id="saveSig">Save email settings</button></div>
  <div class="card"><h2>Customer tiers — target gross margin</h2><div class="sub">Warns on quotes below target, and drives the cost-plus guide price.</div><div class="rule"></div>
    <div class="grid3">${[['tier_bronze', 'Bronze %'], ['tier_silver', 'Silver %'], ['tier_gold', 'Gold %']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <button class="btn btn-blue" id="saveTiers">Save tiers</button></div>
  
  <div class="card"><h2>Quote ageing (days)</h2><div class="rule"></div>
    <div class="grid3">${[['age_flag', 'Follow up from'], ['age_chase', 'Chase from'], ['age_dead', 'Dead from']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <button class="btn btn-blue" id="saveAge">Save ageing</button></div>
  <div class="card"><h2>Labour & crew rates</h2><div class="sub">Used by every recipe: crew day rate ÷ people ÷ hours = cost per person-hour. Site time uses crew size on each quote.</div><div class="rule"></div>
    <div class="grid4">${[['crew_day_rate', 'Crew day rate $'], ['crew_people', 'People in day rate'], ['extra_person_rate', 'Extra person $/day'], ['hours_per_day', 'Hours per day']].map(([k, l]) => `<div class="field"><label>${l}</label><input id="set_${k}" type="number" value="${esc(s[k] || '')}"></div>`).join('')}</div>
    <div class="legend" id="ratePreview">= <b>${money2((parseFloat(s.crew_day_rate || 1150)) / Math.max(1, parseFloat(s.crew_people || 3)) / Math.max(1, parseFloat(s.hours_per_day || 8)))}</b> per person-hour — this is what every recipe uses.<br>
      <span style="color:var(--red);">Changing the crew size without changing the day rate makes every quote cheaper. If a bigger crew costs more per day, update both together.</span></div>
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
  $('#saveSig').addEventListener('click', save(['email_signature', 'quote_email_subject', 'quote_email_body'], 'Email settings saved'));
  $('#saveTiers').addEventListener('click', save(['tier_bronze', 'tier_silver', 'tier_gold'], 'Tiers saved'));
  $('#saveAge').addEventListener('click', save(['age_flag', 'age_chase', 'age_dead'], 'Ageing saved'));
  ['set_crew_day_rate', 'set_crew_people', 'set_hours_per_day'].forEach(id => {
    const el = $('#' + id); if (!el) return;
    el.addEventListener('input', () => {
      const d = parseFloat($('#set_crew_day_rate').value) || 0;
      const p = Math.max(1, parseFloat($('#set_crew_people').value) || 1);
      const hr = Math.max(1, parseFloat($('#set_hours_per_day').value) || 1);
      const out = $('#ratePreview');
      if (out) out.innerHTML = `= <b>${money2(d / p / hr)}</b> per person-hour — this is what every recipe uses.<br><span style="color:var(--red);">Changing crew size without the day rate makes every quote cheaper.</span>`;
    });
  });
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
