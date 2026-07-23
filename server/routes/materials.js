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
function view(m, admin) {
  const vendors = db.prepare(`SELECT mv.*, v.name vname FROM material_vendors mv JOIN vendors v ON v.id=mv.vendor_id WHERE mv.material_id=?`).all(m.id);
  const def = vendors.find(v => v.vendor_id === m.default_vendor_id) || vendors[0];
  const out = { id: m.id, name: m.name, unit: m.unit, category: m.category, notes: m.notes,
    defaultVendorId: m.default_vendor_id, defaultVendor: def ? def.vname : null, usedIn: usedIn(m.id) };
  if (admin) {
    out.defaultCost = def ? def.cost : 0;
    out.vendors = vendors.map(v => ({ id: v.id, vendorId: v.vendor_id, vendor: v.vname, cost: v.cost,
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
  db.prepare('INSERT INTO materials (id,name,unit,category,notes) VALUES (?,?,?,?,?)')
    .run(id, b.name || 'New item', b.unit || 'ea', b.category === 'plant' ? 'plant' : 'material', b.notes || '');
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE materials SET name=?,unit=?,category=?,notes=?,default_vendor_id=? WHERE id=?')
    .run(b.name ?? m.name, b.unit ?? m.unit, b.category ?? m.category, b.notes ?? m.notes,
      b.defaultVendorId !== undefined ? b.defaultVendorId : m.default_vendor_id, m.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => {
  const used = usedIn(req.params.id);
  if (used.length) return res.status(400).json({ error: 'in use by recipe(s): ' + used.join(', ') });
  db.prepare('DELETE FROM materials WHERE id=?').run(req.params.id); res.status(204).end();
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
module.exports = router;
