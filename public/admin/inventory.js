// Estate Landscapers — Inventory tab (v42).
// Equipment register with check-out / check-in, a photo on every hand-over, and service
// tracking. Loaded after app.js and built from the same pieces: .card, .btn, .tag, .seg,
// .stat, .field, table.resp, .modal, the side drawer and toast().
const INV = { data: null, q: '', loc: '', person: '', status: 'all', service: 'all', archived: false, checkedAt: 0 };
const INV_FRESH_MS = 24 * 36e5;
const jpost = (p, body, method) => api(p, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const invDate = d => { if (!d) return '—'; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}`; };
const invThumb = (id, cls) => id ? `<img class="${cls || 'inv-th'}" loading="lazy" alt="" src="/api/inventory/photos/${id}?s=thumb" onerror="this.classList.add('broken')">` : `<span class="${cls || 'inv-th'} none" aria-hidden="true"></span>`;

function invServiceTag(i) {
  if (i.serviceStatus === 'na') return '<span class="muted">Not required</span>';
  if (i.serviceStatus === 'unset') return '<span class="tag tag-draft">No date set</span>';
  const d = i.serviceDays;
  if (i.serviceStatus === 'overdue') return `<span class="tag tag-superseded" title="Was due ${invDate(i.nextServiceDate)}">Overdue ${-d} day${d === -1 ? '' : 's'}</span>`;
  if (i.serviceStatus === 'due') return `<span class="tag tag-viewed" title="Due ${invDate(i.nextServiceDate)}">${d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`}</span>`;
  return `<span class="tag tag-accepted">OK</span>`;
}
const invStatusTag = i => i.archived ? '<span class="tag tag-draft">Archived</span>'
  : i.status === 'out' ? '<span class="tag tag-tier">Checked out</span>' : '<span class="tag tag-accepted">Available</span>';

// Nav badge: how many items are overdue for service. Refreshed at most once a minute.
async function invBadge(force) {
  if (!force && Date.now() - INV.checkedAt < 60000) return;
  INV.checkedAt = Date.now();
  const s = await api('/inventory/summary').catch(() => null);
  const b = document.querySelector('.nav button[data-tab="inventory"]'); if (!b || !s) return;
  b.querySelectorAll('.navdot').forEach(d => d.remove());
  if (s.overdue) b.insertAdjacentHTML('beforeend', `<span class="navdot red" title="${s.overdue} item(s) overdue for service">${s.overdue}</span>`);
}

// ---------------- list ----------------
async function inventoryTab(v) {
  v.innerHTML = `<div class="card"><div class="inv-head"><div><h2>Inventory</h2><div class="sub">Every tool and machine, who has it and where. A new photo is taken each time an item goes out and each time it comes back.</div></div></div><div class="rule"></div>
    <div class="grid4">${[0, 1, 2, 3].map(() => '<div class="stat skel" style="height:58px;"></div>').join('')}</div></div>
    <div class="card">${[0, 1, 2, 3, 4].map(() => '<div class="skel inv-skelrow"></div>').join('')}</div>`;
  const d = await api('/inventory' + (INV.archived ? '?archived=1' : ''));
  if (state.tab !== 'inventory') return;
  if (!d || d.error || !d.items) {
    v.innerHTML = `<div class="card inv-empty"><div class="inv-ico">!</div><h2>Inventory could not be loaded</h2><div class="sub">${esc((d && d.error) || 'No response from the server. Check your connection.')}</div><button class="btn btn-blue" id="invRetry">Try again</button></div>`;
    $('#invRetry').addEventListener('click', () => inventoryTab(v));
    return;
  }
  INV.data = d;
  const c = d.counts;
  const tile = (key, label, n, note, cls) => `<div class="stat tap ${cls || ''} ${INV.tile === key ? 'sel' : ''}" data-tile="${key}" role="button" tabindex="0"><div class="k">${label}</div><div class="v">${n}</div><div class="n">${note}</div></div>`;
  v.innerHTML = `
    <div class="card"><div class="inv-head"><div><h2>Inventory</h2><div class="sub">Every tool and machine, who has it and where. A new photo is taken each time an item goes out and each time it comes back.</div></div>
      <div class="inv-actions">${isAdmin() ? '<button class="btn btn-ghost" id="invLists">Locations &amp; people</button>' : ''}<button class="btn btn-blue" id="invAdd">+ Add item</button></div></div>
      <div class="rule"></div>
      ${d.storage && !d.storage.ready ? `<div class="inv-banner err"><b>Photo storage is not connected.</b> ${esc(d.storage.hint || '')} Items can be added, but nothing can be checked out or in until it is.</div>` : ''}
      <div class="grid4">
        ${tile('all', 'Items', c.total, 'in the register')}
        ${tile('out', 'Checked out', c.out, c.out ? 'with crew now' : 'everything is in')}
        ${tile('due', 'Service due', c.due, `within ${d.dueSoonDays} days`, c.due ? 'warn' : '')}
        ${tile('overdue', 'Service overdue', c.overdue, c.overdue ? 'needs booking' : 'nothing overdue', c.overdue ? 'bad' : '')}
      </div></div>
    <div class="card">
      <div class="boardtools inv-tools">
        <input type="search" id="invQ" placeholder="Search serial, description or person" value="${esc(INV.q)}" autocomplete="off" aria-label="Search inventory">
        ${'BarcodeDetector' in window ? '<button class="btn btn-ghost btn-sm" id="invScan" title="Scan a barcode or QR label">Scan</button>' : ''}
        <select id="invLoc" aria-label="Location"><option value="">All locations</option>${d.locations.filter(l => !l.archived || l.items).map(l => `<option value="${l.id}" ${INV.loc === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        <select id="invPerson" aria-label="Used by"><option value="">Anyone</option>${d.people.filter(p => p.holding).map(p => `<option value="${p.id}" ${INV.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <div class="seg" id="invStatus">${[['all', 'All'], ['in', 'Available'], ['out', 'Out']].map(s => `<button data-v="${s[0]}" class="${INV.status === s[0] ? 'on' : ''}">${s[1]}</button>`).join('')}</div>
        <div class="seg" id="invService">${[['all', 'Any service'], ['due', 'Due'], ['overdue', 'Overdue']].map(s => `<button data-v="${s[0]}" class="${INV.service === s[0] ? 'on' : ''}">${s[1]}</button>`).join('')}</div>
        ${isAdmin() ? `<label class="chk"><input type="checkbox" id="invArch" ${INV.archived ? 'checked' : ''}> Show archived</label>` : ''}
      </div>
      <div id="invList"></div>
    </div>`;
  const repaint = () => invPaintList(v);
  $('#invAdd').addEventListener('click', () => invItemForm(null, v));
  const il = $('#invLists'); if (il) il.addEventListener('click', () => invListsDialog(v));
  $('#invQ').addEventListener('input', e => { INV.q = e.target.value; repaint(); });
  $('#invLoc').addEventListener('change', e => { INV.loc = e.target.value; repaint(); });
  $('#invPerson').addEventListener('change', e => { INV.person = e.target.value; repaint(); });
  const seg = (id, key) => $(id).querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    INV[key] = b.dataset.v; INV.tile = null; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $$('.stat.tap', v).forEach(t => t.classList.remove('sel')); repaint();
  }));
  seg('#invStatus', 'status'); seg('#invService', 'service');
  const ar = $('#invArch'); if (ar) ar.addEventListener('change', e => { INV.archived = e.target.checked; inventoryTab(v); });
  $$('.stat.tap', v).forEach(t => {
    const go = () => {
      const k = t.dataset.tile; INV.tile = k;
      INV.status = k === 'out' ? 'out' : 'all'; INV.service = k === 'due' ? 'due' : k === 'overdue' ? 'overdue' : 'all';
      if (k === 'all') { INV.q = ''; INV.loc = ''; INV.person = ''; }
      inventoryTab(v);
    };
    t.addEventListener('click', go); t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  const sc = $('#invScan'); if (sc) sc.addEventListener('click', () => invScan(code => { INV.q = code; $('#invQ').value = code; repaint(); }));
  repaint();
  invBadge(true);
}

function invFiltered() {
  const q = INV.q.trim().toLowerCase();
  return INV.data.items.filter(i => {
    if (q && !(`${i.serial} ${i.description} ${i.usedBy || ''} ${i.location || ''}`.toLowerCase().includes(q))) return false;
    if (INV.loc && i.locationId !== INV.loc) return false;
    if (INV.person && i.usedById !== INV.person) return false;
    if (INV.status !== 'all' && i.status !== INV.status) return false;
    if (INV.service !== 'all' && i.serviceStatus !== INV.service) return false;
    return true;
  });
}
function invPaintList(v) {
  const box = $('#invList'); if (!box) return;
  const all = INV.data.items, rows = invFiltered();
  if (!all.length) {
    box.innerHTML = `<div class="inv-empty"><div class="inv-ico">+</div><h2>No items yet</h2><div class="sub">Add your first tool or machine. You only need its serial number, a description and where it is kept.</div><button class="btn btn-blue" id="invAdd2">+ Add item</button></div>`;
    $('#invAdd2').addEventListener('click', () => invItemForm(null, v)); return;
  }
  if (!rows.length) {
    box.innerHTML = `<div class="inv-empty"><h2>Nothing matches</h2><div class="sub">No item fits these filters${INV.q ? ` or “${esc(INV.q)}”` : ''}.</div><button class="btn btn-ghost" id="invClear">Clear filters</button></div>`;
    $('#invClear').addEventListener('click', () => { Object.assign(INV, { q: '', loc: '', person: '', status: 'all', service: 'all', tile: null }); inventoryTab(v); }); return;
  }
  box.innerHTML = `<div class="legend" style="margin:0 0 8px;">${rows.length} of ${all.length} item${all.length === 1 ? '' : 's'}</div>
    <table class="resp inv-table"><thead><tr><th style="width:52px;"></th><th>Serial</th><th>Description</th><th>Location</th><th>Used by</th><th>Last service</th><th>Next service</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((i, n) => `<tr class="inv-row ${i.archived ? 'arch' : ''}" data-id="${i.id}" tabindex="0" style="--i:${Math.min(n, 14)}">
      <td class="inv-thcell">${invThumb(i.photoId)}</td>
      <td data-l="Serial"><b>${esc(i.serial)}</b></td>
      <td data-l="Description">${esc(i.description)}</td>
      <td data-l="Location">${esc(i.location || '—')}</td>
      <td data-l="Used by">${i.usedBy ? esc(i.usedBy) : '<span class="muted">—</span>'}</td>
      <td data-l="Last service">${i.lastServiceDate ? invDate(i.lastServiceDate) : '<span class="muted">—</span>'}</td>
      <td data-l="Next service">${i.needsService && i.nextServiceDate ? `${invDate(i.nextServiceDate)} ` : ''}${invServiceTag(i)}</td>
      <td data-l="Status">${invStatusTag(i)}</td>
      <td class="right">${i.archived ? '' : i.status === 'out' ? `<button class="btn btn-ghost btn-sm" data-in="${i.id}">Check in</button>` : `<button class="btn btn-blue btn-sm" data-out="${i.id}">Check out</button>`}</td></tr>`).join('')}
    </tbody></table>`;
  const find = id => INV.data.items.find(x => x.id === id);
  $$('.inv-row', box).forEach(r => {
    r.addEventListener('click', e => { if (e.target.closest('button')) return; invOpen(r.dataset.id, v); });
    r.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === r) invOpen(r.dataset.id, v); });
  });
  $$('[data-out]', box).forEach(b => b.addEventListener('click', () => invUseForm(find(b.dataset.out), 'checkout', v)));
  $$('[data-in]', box).forEach(b => b.addEventListener('click', () => invUseForm(find(b.dataset.in), 'checkin', v)));
}

// ---------------- sheets (the tool's .modal, with a close animation) ----------------
function invSheet(html, opts) {
  const bg = document.createElement('div'); bg.className = 'modal-bg inv-sheet';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${(opts && opts.width) || 480}px;">${html}</div>`;
  document.body.appendChild(bg);
  let locked = false;
  const close = () => { if (locked) return; document.removeEventListener('keydown', onKey, true); bg.classList.add('closing'); setTimeout(() => bg.remove(), 190); };
  // Capture + stop: Escape closes this sheet only, not the drawer underneath it.
  const onKey = e => { if (e.key === 'Escape' && document.body.lastElementChild === bg) { e.stopImmediatePropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const f = bg.querySelector('input:not([type=file]):not([type=checkbox]),select'); if (f && !(opts && opts.noFocus)) setTimeout(() => f.focus(), 60);
  return { bg, close, lock: on => { locked = on; }, q: s => bg.querySelector(s),
    error: (msg, field) => {
      const box = bg.querySelector('.inv-err'); if (!box) return;
      bg.querySelectorAll('.field.bad').forEach(x => x.classList.remove('bad'));
      if (!msg) { box.hidden = true; return; }
      box.textContent = msg; box.hidden = false; box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const el = field && bg.querySelector(`[data-field="${field}"]`); if (el) el.classList.add('bad');
    } };
}

// A <select> that can grow: "+ Add new…" opens a one-line form and saves the new name.
function invGrowSelect(sh, sel, kind) {
  const isLoc = kind === 'location';
  const list = () => isLoc ? INV.data.locations.filter(l => !l.archived) : INV.data.people.filter(p => p.active);
  const paint = keep => {
    sel.innerHTML = `<option value="">${isLoc ? 'Choose location…' : 'Choose person…'}</option>${list().map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}<option value="__new">+ Add new ${isLoc ? 'location' : 'person'}…</option>`;
    sel.value = keep && list().some(o => o.id === keep) ? keep : '';
  };
  paint(sel.dataset.value || '');
  let prev = sel.value;
  sel.addEventListener('change', () => {
    if (sel.value !== '__new') { prev = sel.value; return; }
    const row = document.createElement('div'); row.className = 'inv-addrow';
    row.innerHTML = `<input placeholder="${isLoc ? 'New location name' : 'Person’s name'}" maxlength="60" aria-label="New ${kind} name"><button class="btn btn-blue btn-sm" type="button">Save</button><button class="btn btn-ghost btn-sm" type="button">Cancel</button>`;
    sel.hidden = true; sel.after(row);
    const [inp, save, cancel] = [row.querySelector('input'), ...row.querySelectorAll('button')];
    inp.focus();
    const done = id => { row.remove(); sel.hidden = false; paint(id || prev); prev = sel.value; sel.dispatchEvent(new Event('change', { bubbles: true })); };
    const go = async () => {
      const name = inp.value.trim(); if (!name) return inp.focus();
      save.disabled = true;
      const r = await jpost(isLoc ? '/inventory/locations' : '/inventory/people', { name });
      save.disabled = false;
      if (r.error && !r.id) { sh.error(r.error); return inp.focus(); }
      sh.error('');
      const arr = isLoc ? INV.data.locations : INV.data.people;
      const hit = arr.find(o => o.id === r.id);
      if (hit) { if (isLoc) hit.archived = false; else hit.active = true; }
      else arr.push(isLoc ? { id: r.id, name: r.name || name, archived: false, items: 0 } : { id: r.id, name: r.name || name, active: true, holding: 0 });
      arr.sort((a, b) => a.name.localeCompare(b.name));
      toast(`${r.name || name} added`); done(r.id);
    };
    save.addEventListener('click', go); cancel.addEventListener('click', () => done());
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  });
}

// The photo control. Holds nothing until a picture has been taken and read successfully.
function invPhotoField(sh, host, opts) {
  let photo = null;
  const req = opts && opts.required;
  const render = (msg) => {
    host.innerHTML = photo
      ? `<div class="inv-photo has"><img src="data:${photo.mime};base64,${photo.data}" alt="Photo to be saved"><div class="meta"><b>Photo ready</b><span>${photo.when} · ${Math.round(photo.size / 1024)} KB</span><button type="button" class="btn btn-ghost btn-sm" data-retake>Retake</button></div></div>`
      : `<div class="inv-photo ${req ? 'req' : ''}"><div class="cam" aria-hidden="true"></div><b>${req ? 'Take a new photo of the item' : 'Add a photo (optional)'}</b><span>${req ? 'Required every time. It must show the item as it is right now.' : 'The service docket or the work done.'}</span>
          <div class="btns"><label class="btn btn-blue">Take photo<input type="file" accept="image/*" capture="environment" hidden></label><label class="btn btn-ghost">Upload<input type="file" accept="image/*" hidden></label></div>
          ${msg ? `<div class="warn" role="alert">${esc(msg)}</div>` : ''}</div>`;
    host.querySelectorAll('input[type=file]').forEach(i => i.addEventListener('change', async () => {
      const f = i.files && i.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) return render('That file is not a photo.');
      if (f.lastModified && Date.now() - f.lastModified > INV_FRESH_MS) return render(`That photo is from ${new Date(f.lastModified).toLocaleDateString('en-AU')}. Take a new one of the item as it is now.`);
      host.querySelector('.inv-photo').classList.add('busy');
      try {
        const s = await shrinkImage(f);
        photo = { data: s.data, mime: s.mime, size: s.size, takenAt: new Date(f.lastModified || Date.now()).toISOString(),
          when: new Date(f.lastModified || Date.now()).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) };
        render();
      } catch (e) { photo = null; render(e.message || 'Could not read that photo. Try again.'); }
      opts && opts.onChange && opts.onChange(photo);
    }));
    const rt = host.querySelector('[data-retake]'); if (rt) rt.addEventListener('click', () => { photo = null; render(); opts && opts.onChange && opts.onChange(null); });
  };
  render();
  return { get: () => photo && { data: photo.data, mime: photo.mime, takenAt: photo.takenAt }, clear: msg => { photo = null; render(msg); opts && opts.onChange && opts.onChange(null); } };
}

// ---------------- check out / check in ----------------
function invUseForm(item, mode, v) {
  if (!item) return;
  const out = mode === 'checkout';
  const overdue = item.serviceStatus === 'overdue';
  const sh = invSheet(`
    <h2 style="margin:0 0 3px;">${out ? 'Check out' : 'Check in'} · ${esc(item.serial)}</h2>
    <div class="sub">${esc(item.description)}${out ? '' : ` · with ${esc(item.usedBy || 'someone')}${item.outSince ? ' since ' + esc(sydTime(item.outSince)) : ''}`}</div><div class="rule"></div>
    ${out && overdue ? `<div class="inv-banner err"><b>Service overdue.</b> This item was due for service on ${invDate(item.nextServiceDate)}. You can still check it out.</div>` : ''}
    ${out ? `<div class="field" data-field="personId"><label for="iu_person">Used by</label><select id="iu_person"></select></div>` : ''}
    <div class="field" data-field="locationId"><label for="iu_loc">${out ? 'Going to' : 'Returned to'}</label><select id="iu_loc" data-value="${out ? '' : esc(item.locationId || '')}"></select></div>
    <div class="field" data-field="photo"><label>Photo <span class="reqmark">required</span></label><div id="iu_photo"></div></div>
    <div class="field"><label for="iu_notes">Notes <span class="optmark">optional</span></label><textarea id="iu_notes" rows="2" maxlength="1000" placeholder="${out ? 'Job or site, anything to know' : 'Condition, damage, anything missing'}"></textarea></div>
    <div class="inv-err" role="alert" hidden></div>
    <div class="inv-foot"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-blue" id="iu_go" disabled></button></div>`, { noFocus: true });
  if (out) invGrowSelect(sh, sh.q('#iu_person'), 'person');
  invGrowSelect(sh, sh.q('#iu_loc'), 'location');
  const go = sh.q('#iu_go');
  let busy = false;
  const val = id => { const e = sh.q(id); return e && e.value !== '__new' ? e.value : ''; };
  const sync = () => {
    if (busy) return;
    const miss = !pf.get() ? 'Add a photo to continue' : (out && !val('#iu_person')) ? 'Choose who is using it' : !val('#iu_loc') ? 'Choose a location' : '';
    go.disabled = !!miss; go.textContent = miss || (out ? 'Check out' : 'Check in');
  };
  const pf = invPhotoField(sh, sh.q('#iu_photo'), { required: true, onChange: () => { sh.error(''); sync(); } });
  sh.bg.addEventListener('change', sync); sync();
  go.addEventListener('click', async () => {
    if (busy || go.disabled) return;
    busy = true; sh.lock(true); sh.error('');
    go.disabled = true; go.innerHTML = '<span class="spin"></span> Saving photo…';
    sh.bg.querySelectorAll('[data-close]').forEach(b => b.disabled = true);
    const r = await jpost(`/inventory/items/${item.id}/${mode}`, { personId: val('#iu_person'), locationId: val('#iu_loc'), notes: sh.q('#iu_notes').value, photo: pf.get() })
      .catch(() => ({ error: 'No connection. Nothing was logged — try again when you have signal.' }));
    busy = false; sh.lock(false);
    sh.bg.querySelectorAll('[data-close]').forEach(b => b.disabled = false);
    if (r.error || !r.ok) {
      if (r.field === 'photo') pf.clear(r.error); else sh.error(r.error || 'That did not save. Nothing was logged.', r.field);
      return sync();
    }
    go.classList.add('done'); go.innerHTML = '<span class="tick"></span> Saved';
    setTimeout(() => { sh.close(); toast(out ? `${item.serial} checked out to ${r.item.usedBy}` : `${item.serial} checked in at ${r.item.location}`); invAfterChange(item.id, v); }, 520);
  });
}
// After anything changes: refresh the list behind, and the drawer if this item is open in it.
async function invAfterChange(id, v) {
  const open = $('#drawer') && $('#drawer').classList.contains('on') && $('#drawerBody .inv-detail');
  if (state.tab === 'inventory') await inventoryTab($('#view'));
  if (open && id) invOpen(id, v);
}

// ---------------- add / edit ----------------
function invItemForm(item, v) {
  const d = INV.data, ed = !!item;
  const sh = invSheet(`
    <h2 style="margin:0 0 3px;">${ed ? 'Edit item' : 'Add item'}</h2><div class="sub">${ed ? esc(item.serial) : 'Serial number, description and where it is kept. Service dates only if it needs servicing.'}</div><div class="rule"></div>
    <div class="grid2">
      <div class="field" data-field="serial"><label for="ii_serial">Serial number</label><input id="ii_serial" maxlength="60" autocapitalize="characters" autocomplete="off" value="${esc(ed ? item.serial : d.suggestedSerial)}" ${ed && !isAdmin() ? 'disabled title="Only an admin can change a serial number"' : ''}><div class="hint" id="ii_serialhint">${ed ? '' : 'Suggested next number. Replace it with the maker’s serial if the item has one.'}</div></div>
      <div class="field" data-field="locationId"><label for="ii_loc">Item location</label><select id="ii_loc" data-value="${esc(ed ? item.locationId || '' : '')}" ${ed && item.status === 'out' ? 'disabled title="Checked out — check it in to move it"' : ''}></select></div>
    </div>
    <div class="field" data-field="description"><label for="ii_desc">Description</label><input id="ii_desc" maxlength="160" placeholder="e.g. Stihl HS 82 hedge trimmer" value="${esc(ed ? item.description : '')}"></div>
    <label class="inv-switch"><input type="checkbox" id="ii_svc" ${ed && item.needsService ? 'checked' : ''}><span class="track"></span><span>This item needs servicing</span></label>
    <div class="inv-collapse ${ed && item.needsService ? 'open' : ''}" id="ii_svcbox"><div><div class="grid3" style="padding-top:12px;">
      <div class="field" data-field="lastServiceDate"><label for="ii_last">Last service date</label><input id="ii_last" type="date" max="${esc(d.today)}" value="${esc(ed ? item.lastServiceDate || '' : '')}"></div>
      <div class="field"><label for="ii_iv">Service every</label><select id="ii_iv"><option value="">No fixed interval</option>${[1, 3, 6, 12, 24].map(m => `<option value="${m}" ${ed && item.serviceIntervalMonths === m ? 'selected' : ''}>${m === 12 ? '12 months' : m === 24 ? '2 years' : m + ' month' + (m > 1 ? 's' : '')}</option>`).join('')}</select></div>
      <div class="field" data-field="nextServiceDate"><label for="ii_next">Next service date</label><input id="ii_next" type="date" value="${esc(ed ? item.nextServiceDate || '' : '')}"></div>
    </div></div></div>
    <div class="field" style="margin-top:12px;"><label for="ii_notes">Notes <span class="optmark">optional</span></label><textarea id="ii_notes" rows="2" maxlength="2000">${esc(ed ? item.notes : '')}</textarea></div>
    <div class="inv-err" role="alert" hidden></div>
    <div class="inv-foot">${ed && isAdmin() && !item.archived ? '<button class="btn btn-danger" id="ii_arch" style="margin-right:auto;">Archive</button>' : ''}<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-blue" id="ii_save">${ed ? 'Save changes' : 'Add item'}</button></div>`, { width: 600 });
  invGrowSelect(sh, sh.q('#ii_loc'), 'location');
  const svc = sh.q('#ii_svc'), box = sh.q('#ii_svcbox');
  svc.addEventListener('change', () => box.classList.toggle('open', svc.checked));
  // Next date follows last date + interval until someone types their own.
  let nextTouched = ed && !!item.nextServiceDate;
  const calc = () => {
    const last = sh.q('#ii_last').value, iv = +sh.q('#ii_iv').value;
    if (nextTouched || !last || !iv) return;
    const [y, m, dd] = last.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + iv, 1));
    const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(dd, lastDay));
    sh.q('#ii_next').value = t.toISOString().slice(0, 10);
  };
  sh.q('#ii_last').addEventListener('change', calc);
  sh.q('#ii_iv').addEventListener('change', () => { nextTouched = false; calc(); });
  sh.q('#ii_next').addEventListener('input', () => { nextTouched = true; });
  // Tell them a serial is taken while they are still typing it.
  const sInp = sh.q('#ii_serial'), sHint = sh.q('#ii_serialhint');
  sInp.addEventListener('input', () => {
    const s = sInp.value.trim().toUpperCase();
    const hit = s && d.items.find(i => i.serial.toUpperCase() === s && (!ed || i.id !== item.id));
    sInp.closest('.field').classList.toggle('bad', !!hit);
    sHint.textContent = hit ? `${s} is already in the register (${hit.description}).` : '';
  });
  const save = sh.q('#ii_save');
  save.addEventListener('click', async () => {
    const body = { serial: sInp.value, description: sh.q('#ii_desc').value, locationId: sh.q('#ii_loc').value === '__new' ? '' : sh.q('#ii_loc').value,
      needsService: svc.checked, lastServiceDate: sh.q('#ii_last').value, nextServiceDate: sh.q('#ii_next').value, serviceIntervalMonths: sh.q('#ii_iv').value, notes: sh.q('#ii_notes').value };
    if (!body.serial.trim()) return sh.error('Enter the serial number.', 'serial');
    if (!body.description.trim()) return sh.error('Give the item a description.', 'description');
    if (!body.locationId) return sh.error('Choose where the item is kept.', 'locationId');
    if (body.needsService && !body.nextServiceDate && !(body.lastServiceDate && body.serviceIntervalMonths)) return sh.error('This item needs servicing, so it needs a next service date.', 'nextServiceDate');
    save.disabled = true; const label = save.textContent; save.innerHTML = '<span class="spin"></span> Saving…';
    const r = await jpost(ed ? `/inventory/items/${item.id}` : '/inventory/items', body, ed ? 'PUT' : 'POST').catch(() => ({ error: 'No connection. Nothing was saved.' }));
    save.disabled = false; save.textContent = label;
    if (r.error) return sh.error(r.error, r.field);
    sh.close(); toast(ed ? 'Item saved' : `${r.serial} added`); invAfterChange(r.id, v);
  });
  const ar = sh.q('#ii_arch'); if (ar) ar.addEventListener('click', async () => {
    if (!confirm(`Archive ${item.serial}?\n\nIt leaves the register but its history and photos are kept. An admin can restore it.`)) return;
    const r = await api('/inventory/items/' + item.id, { method: 'DELETE' });
    if (r.error) return sh.error(r.error);
    sh.close(); closeDrawer(); toast(`${item.serial} archived`); invAfterChange(null, v);
  });
}

// ---------------- service ----------------
function invServiceForm(item, v) {
  const t = INV.data.today;
  const sh = invSheet(`
    <h2 style="margin:0 0 3px;">Log service · ${esc(item.serial)}</h2><div class="sub">${esc(item.description)}${item.lastServiceDate ? ' · last serviced ' + invDate(item.lastServiceDate) : ''}</div><div class="rule"></div>
    <div class="grid2">
      <div class="field" data-field="serviceDate"><label for="is_date">Serviced on</label><input id="is_date" type="date" max="${t}" value="${t}"></div>
      <div class="field" data-field="nextServiceDate"><label for="is_next">Next service date</label><input id="is_next" type="date" min="${t}"><div class="hint">${item.serviceIntervalMonths ? `Left blank, it is set ${item.serviceIntervalMonths} month${item.serviceIntervalMonths > 1 ? 's' : ''} on.` : ''}</div></div>
    </div>
    <div class="field"><label for="is_notes">What was done <span class="optmark">optional</span></label><textarea id="is_notes" rows="2" maxlength="1000" placeholder="e.g. Blade replaced, oil changed"></textarea></div>
    <div class="field" data-field="photo"><label>Photo <span class="optmark">optional</span></label><div id="is_photo"></div></div>
    <div class="inv-err" role="alert" hidden></div>
    <div class="inv-foot"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-blue" id="is_go">Save service</button></div>`);
  const pf = invPhotoField(sh, sh.q('#is_photo'), { required: false });
  const go = sh.q('#is_go');
  go.addEventListener('click', async () => {
    go.disabled = true; go.innerHTML = '<span class="spin"></span> Saving…'; sh.error('');
    const r = await jpost(`/inventory/items/${item.id}/service`, { serviceDate: sh.q('#is_date').value, nextServiceDate: sh.q('#is_next').value, notes: sh.q('#is_notes').value, photo: pf.get() })
      .catch(() => ({ error: 'No connection. Nothing was saved.' }));
    go.disabled = false; go.textContent = 'Save service';
    if (r.error) { if (r.field === 'photo') pf.clear(r.error); else sh.error(r.error, r.field); return; }
    sh.close(); toast(`Service logged${r.item.nextServiceDate ? ' — next due ' + invDate(r.item.nextServiceDate) : ''}`); invAfterChange(item.id, v);
  });
}

// ---------------- item detail (side drawer) ----------------
const INV_LOG = { checkout: 'Checked out', checkin: 'Checked in', service: 'Serviced' };
async function invOpen(id, v) {
  const d0 = $('#drawer'); const already = d0 && d0.classList.contains('on') && $('#drawerBody .inv-detail');
  if (!already) openDrawer('<div class="inv-detail"><div class="skel" style="height:22px;width:55%;margin-bottom:10px;"></div><div class="skel" style="height:14px;width:80%;margin-bottom:18px;"></div><div class="skel" style="height:180px;"></div></div>');
  const r = await api('/inventory/items/' + id);
  if (r.error || !r.item) return openDrawer(`<div class="inv-detail"><h3>Item</h3><p class="muted">${esc(r.error || 'Could not load this item.')}</p><button class="btn btn-ghost btn-sm" id="idRetry">Try again</button></div>`), $('#idRetry') && $('#idRetry').addEventListener('click', () => invOpen(id, v));
  const i = r.item;
  const kv = (l, val) => `<div><div class="l">${l}</div><div class="v">${val}</div></div>`;
  openDrawer(`<div class="inv-detail">
    <h3>${esc(i.serial)}</h3>
    <div class="muted" style="font-size:12.5px;margin:3px 0 10px;">${esc(i.description)}</div>
    <div class="inv-tags">${invStatusTag(i)} ${i.needsService ? invServiceTag(i) : ''}</div>
    <div class="inv-cta">
      ${i.archived ? (isAdmin() ? '<button class="btn btn-blue" id="idRestore">Restore item</button>' : '')
        : `${i.status === 'out' ? '<button class="btn btn-blue" id="idUse">Check in</button>' : '<button class="btn btn-blue" id="idUse">Check out</button>'}
           <button class="btn btn-ghost" id="idSvc">Log service</button><button class="btn btn-ghost" id="idEdit">Edit</button>`}
    </div>
    <div class="kv inv-kv">
      ${kv('Used by', i.usedBy ? esc(i.usedBy) : '<span class="muted">Nobody — available</span>')}
      ${kv('Item location', esc(i.location || '—'))}
      ${kv('Last service', i.lastServiceDate ? invDate(i.lastServiceDate) : '—')}
      ${kv('Next service', i.needsService ? (i.nextServiceDate ? invDate(i.nextServiceDate) : 'Not set') : 'Not required')}
    </div>
    ${i.status === 'out' && i.outSince ? `<div class="muted" style="font-size:11.5px;margin-top:8px;">Out since ${esc(sydTime(i.outSince))}</div>` : ''}
    ${i.notes ? `<div class="read" style="white-space:pre-wrap;">${esc(i.notes)}</div>` : ''}
    <div class="dsec"><h4>Photos · ${r.photos.length}</h4>
      ${r.photos.length ? `<div class="inv-gallery">${r.photos.map((p, n) => `<button class="ph" data-n="${n}" style="--i:${Math.min(n, 11)}" aria-label="Photo, ${esc(INV_LOG[p.type] || 'photo')} ${esc(sydTime(p.at))}">${invThumb(p.id, 'im')}<span class="cap"><b>${esc(INV_LOG[p.type] || 'Photo')}</b>${esc(sydTime(p.at))}<br>${esc(p.by || '')}</span></button>`).join('')}</div>`
        : '<p class="muted" style="font-size:12.5px;">No photos yet. The first one is taken when the item is checked out.</p>'}</div>
    <div class="dsec"><h4>History</h4>
      ${r.logs.length ? `<div class="inv-timeline">${r.logs.map(l => `<div class="iev ${l.type}"><div class="t"><b>${esc(INV_LOG[l.type] || l.type)}</b>${l.type === 'service' ? ` · ${invDate(l.serviceDate)}` : l.person ? ` · ${esc(l.person)}` : ''}${l.location && l.type !== 'service' ? ` · ${esc(l.location)}` : ''}</div>
        <div class="m">${esc(sydTime(l.at))} · logged by ${esc(l.loggedBy || '—')}${l.type === 'service' && l.nextServiceDate ? ` · next due ${invDate(l.nextServiceDate)}` : ''}${l.photoId ? ' · photo' : ''}</div>${l.notes ? `<div class="p">${esc(l.notes)}</div>` : ''}</div>`).join('')}</div>`
        : '<p class="muted" style="font-size:12.5px;">Nothing logged yet.</p>'}</div>
  </div>`);
  const u = $('#idUse'); if (u) u.addEventListener('click', () => invUseForm(i, i.status === 'out' ? 'checkin' : 'checkout', v));
  const s = $('#idSvc'); if (s) s.addEventListener('click', () => invServiceForm(i, v));
  const e = $('#idEdit'); if (e) e.addEventListener('click', () => invItemForm(i, v));
  const rs = $('#idRestore'); if (rs) rs.addEventListener('click', async () => { const x = await jpost(`/inventory/items/${i.id}/restore`); if (x.error) return toast(x.error); toast(`${i.serial} restored`); invAfterChange(i.id, v); });
  $$('#drawerBody .inv-gallery .ph').forEach(b => b.addEventListener('click', () => invLightbox(r.photos, +b.dataset.n, i)));
}

function invLightbox(list, n, item) {
  const bg = document.createElement('div'); bg.className = 'inv-lightbox'; bg.tabIndex = -1;
  const paint = () => {
    const p = list[n];
    bg.innerHTML = `<button class="x" aria-label="Close">×</button>${list.length > 1 ? '<button class="lbnav prev" aria-label="Previous photo">‹</button><button class="lbnav next" aria-label="Next photo">›</button>' : ''}
      <figure><img src="/api/inventory/photos/${p.id}" alt="${esc(item.serial)} — ${esc(INV_LOG[p.type] || 'photo')}"><figcaption><b>${esc(item.serial)} · ${esc(INV_LOG[p.type] || 'Photo')}</b>${esc(sydTime(p.at))} · uploaded by ${esc(p.by || '—')}${p.person ? ` · ${esc(p.person)}` : ''}${p.location ? ` · ${esc(p.location)}` : ''}<span>${n + 1} of ${list.length}${p.webUrl ? ` · <a href="${esc(p.webUrl)}" target="_blank" rel="noopener">Open in OneDrive</a>` : ''}</span></figcaption></figure>`;
  };
  const close = () => { document.removeEventListener('keydown', key, true); bg.classList.add('closing'); setTimeout(() => bg.remove(), 190); };
  const step = d => { n = (n + d + list.length) % list.length; paint(); };
  const key = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
  bg.addEventListener('click', e => { if (e.target.closest('.prev')) return step(-1); if (e.target.closest('.next')) return step(1); if (e.target.closest('a')) return; if (!e.target.closest('img')) close(); });
  document.addEventListener('keydown', key, true);
  paint(); document.body.appendChild(bg);
}

// ---------------- locations & people (admin) ----------------
function invListsDialog(v) {
  const sh = invSheet(`<h2 style="margin:0 0 3px;">Locations &amp; people</h2><div class="sub">The choices offered when an item is added, checked out or checked in. Anything with history is retired, not deleted, so old entries still read correctly.</div><div class="rule"></div>
    <div class="inv-err" role="alert" hidden></div><div class="grid2" id="il_body"></div>
    <div class="inv-foot"><button class="btn btn-blue" data-close>Done</button></div>`, { width: 640, noFocus: true });
  let dirty = false;
  const paint = () => {
    const col = (kind, title, rows, offKey, noteFn) => `<div><div class="scope-title">${title}</div>
      ${rows.map(r => `<div class="inv-lrow ${r[offKey] ? 'off' : ''}"><span><b>${esc(r.name)}</b><i>${noteFn(r)}</i></span>
        <button class="btn btn-ghost btn-sm" data-ren="${kind}:${r.id}">Rename</button><button class="btn btn-ghost btn-sm" data-ret="${kind}:${r.id}:${r[offKey] ? 0 : 1}">${r[offKey] ? 'Restore' : 'Retire'}</button></div>`).join('') || '<p class="muted" style="font-size:12px;">None yet.</p>'}
      <div class="inv-addrow" style="margin-top:8px;"><input placeholder="Add ${kind}" maxlength="60" data-new="${kind}" aria-label="Add ${kind}"><button class="btn btn-blue btn-sm" data-add="${kind}">Add</button></div></div>`;
    sh.q('#il_body').innerHTML = col('location', 'Locations', INV.data.locations.map(l => ({ ...l, off: l.archived })), 'off', r => r.off ? 'retired' : `${r.items} item${r.items === 1 ? '' : 's'}`)
      + col('person', 'People', INV.data.people.map(p => ({ ...p, off: !p.active })), 'off', r => r.off ? 'retired' : r.holding ? `holding ${r.holding}` : 'nothing out');
    const path = k => k === 'location' ? '/inventory/locations' : '/inventory/people';
    const reload = async () => { dirty = true; const d = await api('/inventory'); if (d.items) INV.data = d; paint(); };
    sh.bg.querySelectorAll('[data-add]').forEach(b => { const go = async () => { const inp = sh.q(`[data-new="${b.dataset.add}"]`); if (!inp.value.trim()) return inp.focus(); const r = await jpost(path(b.dataset.add), { name: inp.value }); if (r.error) return sh.error(r.error); sh.error(''); reload(); }; b.addEventListener('click', go); sh.q(`[data-new="${b.dataset.add}"]`).addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); });
    sh.bg.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', async () => { const [k, id] = b.dataset.ren.split(':'); const cur = (k === 'location' ? INV.data.locations : INV.data.people).find(x => x.id === id); const name = prompt('New name', cur.name); if (!name || name.trim() === cur.name) return; const r = await jpost(`${path(k)}/${id}`, { name }, 'PUT'); if (r.error) return sh.error(r.error); sh.error(''); reload(); }));
    sh.bg.querySelectorAll('[data-ret]').forEach(b => b.addEventListener('click', async () => { const [k, id, on] = b.dataset.ret.split(':'); const r = await jpost(`${path(k)}/${id}`, { retired: on === '1' }, 'PUT'); if (r.error) return sh.error(r.error); sh.error(''); reload(); }));
  };
  paint();
  sh.bg.querySelector('[data-close]').addEventListener('click', () => { if (dirty) inventoryTab(v); });
}

// ---------------- scan a label (where the browser can) ----------------
async function invScan(onCode) {
  const sh = invSheet(`<h2 style="margin:0 0 3px;">Scan a label</h2><div class="sub">Point the camera at the barcode or QR code on the item.</div><div class="rule"></div>
    <div class="inv-scan"><video playsinline muted></video></div><div class="inv-err" role="alert" hidden></div><div class="inv-foot"><button class="btn btn-ghost" data-close>Cancel</button></div>`, { noFocus: true });
  let stream = null, live = true;
  const stop = () => { live = false; if (stream) stream.getTracks().forEach(t => t.stop()); };
  sh.bg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', stop));
  new MutationObserver((m, o) => { if (!document.body.contains(sh.bg)) { stop(); o.disconnect(); } }).observe(document.body, { childList: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const vid = sh.q('video'); vid.srcObject = stream; await vid.play();
    const det = new BarcodeDetector();
    const tick = async () => {
      if (!live) return;
      const codes = await det.detect(vid).catch(() => []);
      if (codes.length && codes[0].rawValue) { stop(); sh.close(); return onCode(String(codes[0].rawValue).trim()); }
      setTimeout(tick, 220);
    };
    tick();
  } catch (e) { sh.error('The camera could not be opened. Allow camera access for this site, or type the serial number instead.'); }
}
