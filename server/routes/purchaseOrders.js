// Purchase orders: one job PO on acceptance. Cost lines grouped by vendor (split view = PO 1410-A/-B...).
// Lines are EDITABLE after creation so the PO can match real site conditions —
// the edited (final) PO is the source of ACTUAL cost for the jobs register.
const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const { costQuote, crewHourRate } = require('../utils/costing');
const router = express.Router();
const isAdmin = req => req.user && req.user.role === 'admin';
// Purchase Orders are admin-only per current access policy.
router.use((req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: 'admin only' }));

function createPOFromQuote(quoteId, opts = {}) {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);
  if (!q) return null;
  if (!opts.revision) {
    const existing = db.prepare('SELECT * FROM purchase_orders WHERE quote_id=? AND superseded=0').get(quoteId);
    if (existing) return existing.id;
  }
  const poId = newId();
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const challenges = q.surcharges_na ? [] : applied.map(s => s.name);
  const c = costQuote(q);
  db.prepare(`INSERT INTO purchase_orders (id,quote_id,po_number,client_name,address,siteplan_data,siteplan_mime,site_challenges,status,site_hours,crew_size)
    VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`).run(poId, quoteId, q.parent_number, q.client_name, q.address,
    q.siteplan_data, q.siteplan_mime, JSON.stringify(challenges), c.hours, c.crew);
  db.prepare('UPDATE purchase_orders SET sub_days=?, revision=?, supersedes_id=? WHERE id=?')
    .run(c.subDays || 0, opts.revision || 1, opts.supersedes || null, poId);
  const ins = db.prepare('INSERT INTO po_items (id,po_id,code,name,spec,qty,unit,sort_order,vendor_name,kind,unit_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  // site copy lines (no prices): deliverable + qty + allocated hrs in spec
  c.perLine.forEach((l, i) => {
    const t = l.tiers[l.selected];
    // site copy: spec only — no per-deliverable time (crew plans the job as a whole)
    const note = (l.method === 'sub' || l.method === 'mixed') ? ' — subcontractor' : '';
    ins.run(newId(), poId, l.code, l.name, (t.spec || '') + note, l.qty, l.unit, i, null, 'site', 0);
  });
  // cost lines (vendor take-off, incl wastage) — these become the ACTUALS when edited
  let n = 100;
  c.takeoff.forEach(L => {
    ins.run(newId(), poId, L.itemCode, L.name, null, Math.round(L.qty * 100) / 100, L.unit, n++, L.vendor, L.kind, Math.round(L.unitCost * 100) / 100);
  });
  if (c.selected.labCost > 0) {
    ins.run(newId(), poId, 'LAB', `Own crew labour — ${c.hours} person-hrs @ crew rate`, null, c.hours, 'hrs', n++, 'Own crew', 'labour', Math.round(crewHourRate() * 100) / 100);
  }
  // vendor sub-PO registry with suffixes A, B, C...
  const vendors = [...new Set(c.takeoff.map(L => L.vendor).concat(c.selected.labCost > 0 ? ['Own crew'] : []))];
  vendors.forEach((v, i) => db.prepare('INSERT INTO po_vendors (id,po_id,vendor_name,suffix,status) VALUES (?,?,?,?,?)')
    .run(newId(), poId, v, String.fromCharCode(65 + i), 'ordered'));
  return poId;
}

function poView(po, admin) {
  const items = db.prepare('SELECT * FROM po_items WHERE po_id=? ORDER BY sort_order').all(po.id);
  const prints = db.prepare('SELECT * FROM po_prints WHERE po_id=? ORDER BY printed_at DESC').all(po.id);
  const vendors = db.prepare('SELECT * FROM po_vendors WHERE po_id=? ORDER BY suffix').all(po.id);
  const siteItems = items.filter(i => i.kind === 'site' && !i.removed);
  const costItems = items.filter(i => i.kind !== 'site' && !i.removed);
  const actualCost = costItems.reduce((a, i) => a + i.qty * (i.unit_cost || 0), 0);
  const view = { id: po.id, poNumber: po.po_number, client: po.client_name, address: po.address,
    status: po.status, hasSiteplan: !!po.siteplan_data, siteChallenges: JSON.parse(po.site_challenges || '[]'),
    siteHours: po.site_hours, crewSize: po.crew_size,
    crewDays: Math.round(po.site_hours / Math.max(1, po.crew_size) / parseFloat(settingGet('hours_per_day') || '8') * 10) / 10,
    subDays: Math.round((po.sub_days || 0) * 10) / 10,
    siteDays: Math.round((po.site_hours / Math.max(1, po.crew_size) / parseFloat(settingGet('hours_per_day') || '8') + (po.sub_days || 0)) * 10) / 10,
    revision: po.revision || 1, superseded: !!po.superseded,
    siteItems: siteItems.map(i => ({ id: i.id, code: i.code, name: i.name, spec: i.spec, qty: i.qty, unit: i.unit })),
    prints: prints.map(p => ({ by: p.printed_by, at: p.printed_at })), createdAt: po.created_at, closedAt: po.closed_at };
  if (admin) {
    view.vendors = vendors.map(v => ({ id: v.id, name: v.vendor_name, suffix: v.suffix, status: v.status,
      total: costItems.filter(i => i.vendor_name === v.vendor_name).reduce((a, i) => a + i.qty * (i.unit_cost || 0), 0) }));
    view.costItems = costItems.map(i => ({ id: i.id, code: i.code, name: i.name, qty: i.qty, unit: i.unit,
      unitCost: i.unit_cost, total: Math.round(i.qty * (i.unit_cost || 0) * 100) / 100, vendor: i.vendor_name, kind: i.kind }));
    view.actualCost = Math.round(actualCost * 100) / 100;
    const q = db.prepare('SELECT quoted_sell, quoted_cost FROM quotes WHERE id=?').get(po.quote_id);
    if (q) { view.sellExGst = q.quoted_sell; view.quotedCost = q.quoted_cost;
      view.actualGM = q.quoted_sell != null ? Math.round((q.quoted_sell - actualCost) * 100) / 100 : null;
      view.actualGMPct = q.quoted_sell > 0 ? Math.round((q.quoted_sell - actualCost) / q.quoted_sell * 1000) / 10 : null; }
  }
  return view;
}

// vendor picker source for adding cost lines
router.get('/vendor-options', (req, res) => {
  const vs = db.prepare('SELECT name FROM vendors ORDER BY name').all().map(v => v.name);
  res.json({ vendors: vs, misc: ['Misc / Other', 'Site damage repair', 'Plant hire', 'Own crew'] });
});
router.get('/', (req, res) => {
  const showSup = req.query.superseded === '1';
  const rows = db.prepare(`SELECT * FROM purchase_orders ${showSup ? '' : 'WHERE superseded=0'} ORDER BY created_at DESC`).all();
  res.json(rows.map(po => {
    const n = db.prepare('SELECT COUNT(*) c FROM po_prints WHERE po_id=?').get(po.id).c;
    const out = { id: po.id, poNumber: po.po_number + (po.revision > 1 ? '-R' + po.revision : ''), client: po.client_name,
      address: po.address, status: po.status, prints: n, superseded: !!po.superseded, revision: po.revision || 1 };
    if (isAdmin(req)) {
      out.actualCost = db.prepare("SELECT SUM(qty*unit_cost) s FROM po_items WHERE po_id=? AND removed=0 AND kind!='site'").get(po.id).s || 0;
      out.vendorStatuses = db.prepare('SELECT status, COUNT(*) c FROM po_vendors WHERE po_id=? GROUP BY status').all(po.id);
    }
    return out;
  }));
});
router.get('/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'not found' });
  res.json(poView(po, isAdmin(req)));
});
router.get('/:id/siteplan', (req, res) => {
  const po = db.prepare('SELECT siteplan_data, siteplan_mime FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po || !po.siteplan_data) return res.status(404).end();
  res.setHeader('Content-Type', po.siteplan_mime || 'image/png');
  res.send(Buffer.from(po.siteplan_data, 'base64'));
});
// edits (admin) — the edited PO becomes the ACTUAL cost record
router.post('/:id/items', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const b = req.body || {}; const id = newId();
  const max = db.prepare('SELECT MAX(sort_order) m FROM po_items WHERE po_id=?').get(req.params.id);
  db.prepare('INSERT INTO po_items (id,po_id,code,name,qty,unit,sort_order,vendor_name,kind,unit_cost) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, b.code || '', b.name || 'New line', b.qty ?? 1, b.unit || 'ea', (max.m ?? 0) + 1,
      b.vendor || 'Supplier', b.kind || 'material', b.unitCost ?? 0);
  res.status(201).json({ id });
});
router.put('/:id/items/:itemId', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const e = db.prepare('SELECT * FROM po_items WHERE id=?').get(req.params.itemId);
  if (!e) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE po_items SET name=?,qty=?,unit=?,unit_cost=?,vendor_name=?,removed=? WHERE id=?')
    .run(b.name ?? e.name, b.qty ?? e.qty, b.unit ?? e.unit, b.unitCost ?? e.unit_cost,
      b.vendor ?? e.vendor_name, b.removed !== undefined ? (b.removed ? 1 : 0) : e.removed, e.id);
  res.json({ ok: true });
});
router.delete('/:id/items/:itemId', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  db.prepare('UPDATE po_items SET removed=1 WHERE id=?').run(req.params.itemId); res.status(204).end();
});
router.post('/:id/reset', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM po_items WHERE po_id=?').run(po.id);
  db.prepare('DELETE FROM po_vendors WHERE po_id=?').run(po.id);
  db.prepare('DELETE FROM purchase_orders WHERE id=?').run(po.id);
  const newIdPo = createPOFromQuote(po.quote_id);
  res.json({ ok: true, id: newIdPo });
});
router.put('/:id/vendor-status/:vid', (req, res) => {
  const v = db.prepare('SELECT * FROM po_vendors WHERE id=?').get(req.params.vid);
  if (!v) return res.status(404).json({ error: 'not found' });
  const s = (req.body || {}).status;
  if (!['ordered', 'delivered', 'invoiced'].includes(s)) return res.status(400).json({ error: 'bad status' });
  db.prepare('UPDATE po_vendors SET status=? WHERE id=?').run(s, v.id);
  res.json({ ok: true });
});
router.post('/:id/print', (req, res) => {
  db.prepare('INSERT INTO po_prints (id,po_id,printed_by) VALUES (?,?,?)').run(newId(), req.params.id, (req.body || {}).by || (req.user ? req.user.name : 'Team'));
  res.json({ ok: true });
});
router.post('/:id/close', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  db.prepare("UPDATE purchase_orders SET status='closed', closed_at=datetime('now') WHERE id=?").run(req.params.id); res.json({ ok: true });
});
router.post('/:id/reopen', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  db.prepare("UPDATE purchase_orders SET status='open', closed_at=NULL WHERE id=?").run(req.params.id); res.json({ ok: true });
});


// Job details changed → supersede this PO and issue the next revision.
// Lines already Ordered or Delivered are carried forward with their status so nothing is re-ordered.
// Only the CURRENT (non-superseded) PO counts toward actual cost, so nothing is double-counted.
router.post('/:id/supersede', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const old = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'not found' });
  const carried = db.prepare("SELECT * FROM po_items WHERE po_id=? AND removed=0 AND kind!='site' AND po_status IN ('ordered','delivered')").all(old.id);
  const carriedVendors = db.prepare("SELECT * FROM po_vendors WHERE po_id=? AND status IN ('delivered','invoiced')").all(old.id);
  db.prepare('UPDATE purchase_orders SET superseded=1 WHERE id=?').run(old.id);
  const newPoId = createPOFromQuote(old.quote_id, { revision: (old.revision || 1) + 1, supersedes: old.id });
  if (!newPoId) { db.prepare('UPDATE purchase_orders SET superseded=0 WHERE id=?').run(old.id); return res.status(500).json({ error: 'could not create revision' }); }
  const ins = db.prepare('INSERT INTO po_items (id,po_id,code,name,qty,unit,sort_order,vendor_name,kind,unit_cost,po_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  let n = 900;
  carried.forEach(i => ins.run(newId(), newPoId, i.code, i.name + ' (carried forward)', i.qty, i.unit, n++, i.vendor_name, i.kind, i.unit_cost, i.po_status));
  carriedVendors.forEach(v => db.prepare('UPDATE po_vendors SET status=? WHERE po_id=? AND vendor_name=?').run(v.status, newPoId, v.vendor_name));
  res.json({ ok: true, id: newPoId, carried: carried.length });
});
router.put('/:id/items/:itemId/status', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const s = (req.body || {}).status;
  if (!['pending', 'ordered', 'delivered', 'invoiced'].includes(s)) return res.status(400).json({ error: 'bad status' });
  db.prepare('UPDATE po_items SET po_status=? WHERE id=?').run(s, req.params.itemId);
  res.json({ ok: true });
});

// Printable documents. site copy = no prices; vendor doc = prices for that vendor only (admin).
function printPage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;max-width:760px;margin:24px auto;padding:0 16px;}
  h1{font-size:18px;letter-spacing:2px;color:#143FB0;margin:0;}h2{font-size:14px;margin:18px 0 6px;text-transform:uppercase;}
  .hd{border-bottom:3px solid #1E5BFF;padding-bottom:10px;margin-bottom:14px;}
  .muted{color:#777;font-size:11px;}table{width:100%;border-collapse:collapse;margin-top:6px;}
  th{font-size:10px;text-transform:uppercase;color:#777;text-align:left;border-bottom:2px solid #ddd;padding:6px 5px;}
  td{padding:6px 5px;border-bottom:1px solid #eee;}.r{text-align:right;}
  .box{border:1.5px solid #1E5BFF;border-radius:8px;padding:10px;margin-top:10px;}
  @media print{button{display:none;}}</style></head>
  <body onload="window.print()"><button onclick="window.print()">Print</button>${bodyHtml}
  <p class="muted" style="margin-top:26px;text-align:center;">Estate Landscapers — Integrity. Precision. Value.</p></body></html>`;
}
router.get('/:id/print/site', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).send('not found');
  const v = poView(po, false);
  const company = `${settingGet('company_name')} · ${settingGet('company_abn')} · ${settingGet('company_lic')}`;
  let html = `<div class="hd"><h1>ESTATE LANDSCAPERS</h1><div class="muted">${company}</div></div>
  <h2>Site Instruction — PO ${v.poNumber}</h2>
  <p><b>${v.client || ''}</b><br>${v.address || ''}</p>
  <div class="box"><b>Total site duration: ${v.siteDays} days</b><br>
    Our crew: <b>${v.crewSize} people</b> for <b>${v.crewDays} days</b><br>
    Subcontractors: <b>${v.subDays} days</b><br>
    <span class="muted">Total is our crew plus subcontractors.</span></div>
  <table><thead><tr><th>Code</th><th>Deliverable / spec</th><th>Qty</th></tr></thead><tbody>
  ${v.siteItems.map(i => `<tr><td><b>${i.code || ''}</b></td><td>${i.name}${i.spec ? `<br><span class="muted">${i.spec}</span>` : ''}</td><td>${i.qty} ${i.unit || ''}</td></tr>`).join('')}
  </tbody></table>
  ${po.siteplan_data ? `<h2>Approved site plan</h2><img src="data:${po.siteplan_mime || 'image/png'};base64,${po.siteplan_data}" style="max-width:100%;border:1px solid #ddd;border-radius:6px;">` : ''}
  ${v.siteChallenges.length ? `<h2>Site challenges</h2><p>${v.siteChallenges.join(' · ')}</p>` : ''}
  <p class="muted">No pricing on this document. Refer to the approved drawing for layout.</p>`;
  db.prepare('INSERT INTO po_prints (id,po_id,printed_by) VALUES (?,?,?)').run(newId(), po.id, (req.user ? req.user.name : 'Team') + ' (site copy)');
  res.send(printPage(`PO ${v.poNumber} site copy`, html));
});
router.get('/:id/print/vendor/:vid', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('admin only');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  const pv = db.prepare('SELECT * FROM po_vendors WHERE id=?').get(req.params.vid);
  if (!po || !pv) return res.status(404).send('not found');
  const items = db.prepare("SELECT * FROM po_items WHERE po_id=? AND removed=0 AND kind!='site' AND vendor_name=? ORDER BY sort_order").all(po.id, pv.vendor_name);
  const total = items.reduce((a, i) => a + i.qty * (i.unit_cost || 0), 0);
  const company = `${settingGet('company_name')} · ${settingGet('company_abn')} · ${settingGet('company_lic')} · ${settingGet('company_address') || ''}`;
  let html = `<div class="hd"><h1>ESTATE LANDSCAPERS</h1><div class="muted">${company}</div></div>
  <h2>Purchase Order ${po.po_number}-${pv.suffix} — ${pv.vendor_name}</h2>
  <p><b>Deliver to:</b> ${po.address || ''}<br><b>Site contact:</b> ${settingGet('company_phone')}<br><b>Job ref:</b> ${po.client_name || ''} · PO ${po.po_number}</p>
  <table><thead><tr><th>Item</th><th>Qty</th><th class="r">Unit rate</th><th class="r">Total</th></tr></thead><tbody>
  ${items.map(i => `<tr><td>${i.name}</td><td>${i.qty} ${i.unit || ''}</td><td class="r">$${(i.unit_cost || 0).toFixed(2)}</td><td class="r">$${(i.qty * (i.unit_cost || 0)).toFixed(2)}</td></tr>`).join('')}
  <tr><td colspan="3"><b>PO total (ex GST)</b></td><td class="r"><b>$${total.toFixed(2)}</b></td></tr>
  </tbody></table>
  <p class="muted">Please quote PO number ${po.po_number}-${pv.suffix} on your invoice. Payment terms as agreed.</p>`;
  db.prepare('INSERT INTO po_prints (id,po_id,printed_by) VALUES (?,?,?)').run(newId(), po.id, (req.user ? req.user.name : 'Admin') + ` (vendor ${pv.suffix})`);
  res.send(printPage(`PO ${po.po_number}-${pv.suffix}`, html));
});
module.exports = { router, createPOFromQuote };
