// Materials & Plant master list. Each item has a default vendor plus optional alternates.
// Linked to recipes (components reference material_id) and to vendors (material_vendors).
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const isAdmin = req => req.user && req.user.role === 'admin';
router.use((req, res, next) => (req.method === 'GET' || isAdmin(req)) ? next() : res.status(403).json({ error: 'admin only' }));

function usedIn(materialId) {
  const rows = db.prepare(`SELECT DISTINCT p.code, r.variant FROM recipe_component c
    JOIN recipe_v2 r ON r.id=c.recipe_id JOIN price_items p ON p.id=r.price_item_id
    WHERE c.material_id=? OR c.mat_basic=? OR c.mat_standard=? OR c.mat_premium=?`).all(materialId, materialId, materialId, materialId);
  return rows.map(r => `${r.code} ${r.variant}`);
}
function codeOf(m, vendorCodeNo) {
  const L = m.category === 'plant' ? 'P' : m.category === 'overhead' ? 'O' : 'M';
  const base = L + (m.code_no || '?');
  return (m.category === 'overhead' || !vendorCodeNo) ? base : `${base}\u00B7V${vendorCodeNo}`;
}
function nextCode(cat) {
  const r = db.prepare('SELECT MAX(code_no) m FROM materials WHERE category=?').get(cat);
  return (r.m || 0) + 1;
}
function view(m, admin) {
  const vendors = db.prepare(`SELECT mv.*, v.name vname, v.code_no vcode FROM material_vendors mv JOIN vendors v ON v.id=mv.vendor_id WHERE mv.material_id=?`).all(m.id);
  const def = vendors.find(v => v.vendor_id === m.default_vendor_id) || vendors[0];
  const out = { id: m.id, name: m.name, unit: m.unit, category: m.category, notes: m.notes,
    codeNo: m.code_no, code: codeOf(m, def ? def.vcode : null),
    monthlyCost: m.category === 'overhead' ? (m.monthly_cost || 0) : undefined,
    defaultVendorId: m.default_vendor_id, defaultVendor: def ? def.vname : null,
    defaultVendorCode: def && def.vcode ? 'V' + def.vcode : null, usedIn: usedIn(m.id) };
  if (admin) {
    out.defaultCost = def ? def.cost : 0;
    out.vendors = vendors.map(v => ({ id: v.id, vendorId: v.vendor_id, vendor: v.vname,
      vendorCode: v.vcode ? 'V' + v.vcode : null, code: codeOf(m, v.vcode), cost: v.cost,
      deliveryRule: v.delivery_rule, reviewBy: v.review_by, isDefault: v.vendor_id === m.default_vendor_id }));
  }
  return out;
}
router.get('/', (req, res) => {
  const cat = req.query.category;
  const rows = cat ? db.prepare('SELECT * FROM materials WHERE category=? ORDER BY name').all(cat)
                   : db.prepare('SELECT * FROM materials ORDER BY category DESC, name').all();
  res.json(rows.map(m => view(m, isAdmin(req))));
});
router.post('/', (req, res) => {
  const b = req.body || {}; const id = newId();
  const cat = ['plant', 'overhead'].includes(b.category) ? b.category : 'material';
  db.prepare('INSERT INTO materials (id,name,unit,category,notes,monthly_cost,code_no) VALUES (?,?,?,?,?,?,?)')
    .run(id, b.name || 'New item', b.unit || (cat === 'overhead' ? 'month' : 'ea'), cat, b.notes || '', b.monthlyCost || 0, nextCode(cat));
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE materials SET name=?,unit=?,category=?,notes=?,default_vendor_id=?,monthly_cost=? WHERE id=?')
    .run(b.name ?? m.name, b.unit ?? m.unit, b.category ?? m.category, b.notes ?? m.notes,
      b.defaultVendorId !== undefined ? b.defaultVendorId : m.default_vendor_id,
      b.monthlyCost !== undefined ? b.monthlyCost : m.monthly_cost, m.id);
  res.json({ ok: true });
});
// Deleting a material used in recipes silently changes what every quote built from
// those recipes costs — so say so, and let the user decide.
router.delete('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const used = usedIn(req.params.id);
  if (used.length && !req.query.force) {
    return res.status(409).json({ error: 'in use', usedCount: used.length, usedIn: used,
      hint: 'Retire it instead, or pass force=1 to delete anyway.' });
  }
  db.prepare('DELETE FROM material_vendors WHERE material_id=?').run(req.params.id);
  db.prepare('DELETE FROM materials WHERE id=?').run(req.params.id);
  res.status(204).end();
});
// vendor pricing for a material
router.post('/:id/vendors', (req, res) => {
  const b = req.body || {}; const id = newId();
  if (!b.vendorId) return res.status(400).json({ error: 'vendorId required' });
  db.prepare('INSERT INTO material_vendors (id,material_id,vendor_id,cost,delivery_rule,review_by) VALUES (?,?,?,?,?,?)')
    .run(id, req.params.id, b.vendorId, b.cost || 0, b.deliveryRule || '', b.reviewBy || '');
  const m = db.prepare('SELECT default_vendor_id FROM materials WHERE id=?').get(req.params.id);
  if (!m.default_vendor_id) db.prepare('UPDATE materials SET default_vendor_id=? WHERE id=?').run(b.vendorId, req.params.id);
  res.status(201).json({ id });
});
router.put('/:id/vendors/:mvId', (req, res) => {
  const r = db.prepare('SELECT * FROM material_vendors WHERE id=?').get(req.params.mvId);
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE material_vendors SET cost=?,delivery_rule=?,review_by=? WHERE id=?')
    .run(b.cost ?? r.cost, b.deliveryRule ?? r.delivery_rule, b.reviewBy ?? r.review_by, r.id);
  if (b.makeDefault) db.prepare('UPDATE materials SET default_vendor_id=? WHERE id=?').run(r.vendor_id, r.material_id);
  res.json({ ok: true });
});
router.delete('/:id/vendors/:mvId', (req, res) => {
  db.prepare('DELETE FROM material_vendors WHERE id=?').run(req.params.mvId); res.status(204).end();
});

// ---- Excel round-trip: download, edit in Excel, upload with a preview before anything saves ----
const XLSX = require('xlsx');
function sheetRows(cat) {
  const mats = db.prepare('SELECT * FROM materials WHERE category=? ORDER BY code_no').all(cat);
  const rows = [];
  mats.forEach(m => {
    if (cat === 'overhead') {
      rows.push({ Code: codeOf(m, null), Item: m.name, Unit: m.unit || 'month', 'Monthly cost': m.monthly_cost || 0, Notes: m.notes || '' });
      return;
    }
    const vs = db.prepare('SELECT mv.*, v.name vname, v.code_no vcode FROM material_vendors mv JOIN vendors v ON v.id=mv.vendor_id WHERE mv.material_id=?').all(m.id);
    if (!vs.length) rows.push({ Code: codeOf(m, null), Item: m.name, Unit: m.unit || '', Vendor: '', 'Vendor code': '', Cost: '', 'Delivery rule': '', 'Review by': '', Default: '' });
    vs.forEach(v => rows.push({ Code: codeOf(m, v.vcode), Item: m.name, Unit: m.unit || '',
      Vendor: v.vname, 'Vendor code': v.vcode ? 'V' + v.vcode : '', Cost: v.cost || 0,
      'Delivery rule': v.delivery_rule || '', 'Review by': v.review_by || '',
      Default: v.vendor_id === m.default_vendor_id ? 'YES' : '' }));
  });
  return rows;
}
router.get('/export.xlsx', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' }); // costs are admin-only
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows('material')), 'Materials');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows('plant')), 'Plant');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows('overhead')), 'Overheads');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="estate-costs-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});
// Upload: dryRun=1 returns the change list for the preview screen; without it, applies.
router.post('/import', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const dry = req.query.dryRun === '1';
  let wb;
  try { wb = XLSX.read(req.body, { type: 'buffer' }); }
  catch (e) { return res.status(400).json({ error: 'Could not read that file — is it a .xlsx?' }); }
  const changes = []; const errors = [];
  const catOf = sheet => sheet === 'Plant' ? 'plant' : sheet === 'Overheads' ? 'overhead' : 'material';
  ['Materials', 'Plant', 'Overheads'].forEach(sheetName => {
    const ws = wb.Sheets[sheetName]; if (!ws) return;
    const cat = catOf(sheetName);
    XLSX.utils.sheet_to_json(ws).forEach((row, idx) => {
      const rowNo = idx + 2;
      const code = String(row.Code || '').trim();
      const itemName = String(row.Item || '').trim();
      if (!code && !itemName) return;
      const codeNo = parseInt(String(code).replace(/^[MPO]/i, '').split('\u00B7')[0], 10);
      const existing = codeNo ? db.prepare('SELECT * FROM materials WHERE category=? AND code_no=?').get(cat, codeNo) : null;
      if (cat === 'overhead') {
        const monthly = parseFloat(row['Monthly cost']);
        if (isNaN(monthly)) return;
        if (existing) {
          if ((existing.monthly_cost || 0) !== monthly)
            changes.push({ type: 'overhead-cost', code, item: existing.name, from: existing.monthly_cost || 0, to: monthly, apply: () => db.prepare('UPDATE materials SET monthly_cost=?, name=? WHERE id=?').run(monthly, itemName || existing.name, existing.id) });
        } else if (itemName) {
          changes.push({ type: 'new-overhead', code: 'O' + (nextCode('overhead')), item: itemName, to: monthly, apply: () => db.prepare('INSERT INTO materials (id,name,unit,category,monthly_cost,code_no) VALUES (?,?,?,?,?,?)').run(newId(), itemName, 'month', 'overhead', monthly, nextCode('overhead')) });
        }
        return;
      }
      const vendorName = String(row.Vendor || '').trim();
      const cost = row.Cost === '' || row.Cost == null ? null : parseFloat(row.Cost);
      if (!existing) {
        if (!itemName) return;
        changes.push({ type: 'new-item', code: (cat === 'plant' ? 'P' : 'M') + nextCode(cat), item: itemName, vendor: vendorName, to: cost,
          apply: () => {
            const id = newId(); const n = nextCode(cat);
            db.prepare('INSERT INTO materials (id,name,unit,category,code_no) VALUES (?,?,?,?,?)').run(id, itemName, String(row.Unit || 'ea'), cat, n);
            if (vendorName) {
              const v = db.prepare('SELECT id FROM vendors WHERE name=?').get(vendorName);
              if (v) { db.prepare('INSERT INTO material_vendors (id,material_id,vendor_id,cost,delivery_rule,review_by,preferred) VALUES (?,?,?,?,?,?,1)')
                .run(newId(), id, v.id, cost || 0, String(row['Delivery rule'] || ''), String(row['Review by'] || ''));
                db.prepare('UPDATE materials SET default_vendor_id=? WHERE id=?').run(v.id, id); }
            }
          } });
        return;
      }
      if (!vendorName || cost == null || isNaN(cost)) return;
      const v = db.prepare('SELECT id, code_no FROM vendors WHERE name=?').get(vendorName);
      if (!v) { errors.push(`${sheetName} row ${rowNo}: vendor "${vendorName}" not found — add it in Vendors first`); return; }
      const mv = db.prepare('SELECT * FROM material_vendors WHERE material_id=? AND vendor_id=?').get(existing.id, v.id);
      if (mv) {
        if ((mv.cost || 0) !== cost)
          changes.push({ type: 'price', code, item: existing.name, vendor: vendorName, from: mv.cost || 0, to: cost,
            apply: () => db.prepare('UPDATE material_vendors SET cost=?, delivery_rule=?, review_by=? WHERE id=?')
              .run(cost, String(row['Delivery rule'] || mv.delivery_rule || ''), String(row['Review by'] || mv.review_by || ''), mv.id) });
      } else {
        changes.push({ type: 'new-vendor-price', code, item: existing.name, vendor: vendorName, to: cost,
          apply: () => db.prepare('INSERT INTO material_vendors (id,material_id,vendor_id,cost,delivery_rule,review_by) VALUES (?,?,?,?,?,?)')
            .run(newId(), existing.id, v.id, cost, String(row['Delivery rule'] || ''), String(row['Review by'] || '')) });
      }
      if (String(row.Default || '').toUpperCase() === 'YES' && existing.default_vendor_id !== v.id)
        changes.push({ type: 'default-vendor', code, item: existing.name, vendor: vendorName,
          apply: () => db.prepare('UPDATE materials SET default_vendor_id=? WHERE id=?').run(v.id, existing.id) });
    });
  });
  const summary = changes.map(c => ({ type: c.type, code: c.code, item: c.item, vendor: c.vendor, from: c.from, to: c.to }));
  if (dry) return res.json({ dryRun: true, changes: summary, errors });
  let applied = 0;
  changes.forEach(c => { try { c.apply(); applied++; } catch (e) { errors.push(`${c.code} ${c.item}: ${e.message}`); } });
  res.json({ applied, changes: summary, errors });
});

module.exports = router;
