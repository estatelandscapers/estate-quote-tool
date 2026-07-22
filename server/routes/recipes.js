const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const adminGuard = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });
router.use(adminGuard);

function view(r) {
  return { id: r.id, priceItemId: r.price_item_id, methodDefault: r.method_default,
    hrs: { Basic: r.hrs_basic, Standard: r.hrs_standard, Premium: r.hrs_premium },
    deliveryCost: r.delivery_cost, plantCost: r.plant_cost, plantNote: r.plant_note,
    sub: { Basic: r.sub_basic, Standard: r.sub_standard, Premium: r.sub_premium }, subVendor: r.sub_vendor,
    materials: db.prepare('SELECT * FROM recipe_materials WHERE recipe_id=? ORDER BY sort_order').all(r.id).map(m => ({
      id: m.id, name: m.name, unit: m.unit, ratio: m.ratio, wastagePct: m.wastage_pct, kind: m.kind, vendorName: m.vendor_name,
      cost: { Basic: m.cost_basic, Standard: m.cost_standard, Premium: m.cost_premium },
      spec: { Basic: m.spec_basic, Standard: m.spec_standard, Premium: m.spec_premium } })) };
}
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT r.*, p.code, p.name pname, p.unit punit FROM recipes r JOIN price_items p ON p.id=r.price_item_id ORDER BY p.sort_order').all();
  res.json(rows.map(r => ({ ...view(r), code: r.code, name: r.pname, unit: r.punit })));
});
router.get('/by-item/:priceItemId', (req, res) => {
  const r = db.prepare('SELECT * FROM recipes WHERE price_item_id=?').get(req.params.priceItemId);
  if (!r) return res.status(404).json({ error: 'no recipe' });
  res.json(view(r));
});
router.post('/', (req, res) => {
  const { priceItemId } = req.body || {};
  if (!priceItemId) return res.status(400).json({ error: 'priceItemId required' });
  if (db.prepare('SELECT id FROM recipes WHERE price_item_id=?').get(priceItemId)) return res.status(400).json({ error: 'recipe already exists' });
  const id = newId();
  db.prepare('INSERT INTO recipes (id,price_item_id) VALUES (?,?)').run(id, priceItemId);
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM recipes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const h = b.hrs || {}, s = b.sub || {};
  db.prepare(`UPDATE recipes SET method_default=?,hrs_basic=?,hrs_standard=?,hrs_premium=?,delivery_cost=?,plant_cost=?,plant_note=?,sub_basic=?,sub_standard=?,sub_premium=?,sub_vendor=? WHERE id=?`)
    .run(b.methodDefault ?? r.method_default, h.Basic ?? r.hrs_basic, h.Standard ?? r.hrs_standard, h.Premium ?? r.hrs_premium,
      b.deliveryCost ?? r.delivery_cost, b.plantCost ?? r.plant_cost, b.plantNote ?? r.plant_note,
      s.Basic ?? r.sub_basic, s.Standard ?? r.sub_standard, s.Premium ?? r.sub_premium, b.subVendor ?? r.sub_vendor, r.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM recipes WHERE id=?').run(req.params.id); res.status(204).end(); });
router.post('/:id/materials', (req, res) => {
  const b = req.body || {}; const id = newId();
  const max = db.prepare('SELECT MAX(sort_order) m FROM recipe_materials WHERE recipe_id=?').get(req.params.id);
  db.prepare(`INSERT INTO recipe_materials (id,recipe_id,name,unit,ratio,wastage_pct,kind,vendor_name,cost_basic,cost_standard,cost_premium,spec_basic,spec_standard,spec_premium,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, b.name || 'Material', b.unit || 'ea', b.ratio || 0, b.wastagePct ?? 5, b.kind === 'tiered' ? 'tiered' : 'common',
      b.vendorName || '', (b.cost && b.cost.Basic) || 0, (b.cost && b.cost.Standard) || 0, (b.cost && b.cost.Premium) || 0,
      (b.spec && b.spec.Basic) || null, (b.spec && b.spec.Standard) || null, (b.spec && b.spec.Premium) || null, (max.m ?? -1) + 1);
  res.status(201).json({ id });
});
router.put('/:id/materials/:mid', (req, res) => {
  const m = db.prepare('SELECT * FROM recipe_materials WHERE id=?').get(req.params.mid);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const c = b.cost || {}, sp = b.spec || {};
  db.prepare(`UPDATE recipe_materials SET name=?,unit=?,ratio=?,wastage_pct=?,kind=?,vendor_name=?,cost_basic=?,cost_standard=?,cost_premium=?,spec_basic=?,spec_standard=?,spec_premium=? WHERE id=?`)
    .run(b.name ?? m.name, b.unit ?? m.unit, b.ratio ?? m.ratio, b.wastagePct ?? m.wastage_pct, b.kind ?? m.kind, b.vendorName ?? m.vendor_name,
      c.Basic ?? m.cost_basic, c.Standard ?? m.cost_standard, c.Premium ?? m.cost_premium,
      sp.Basic ?? m.spec_basic, sp.Standard ?? m.spec_standard, sp.Premium ?? m.spec_premium, m.id);
  res.json({ ok: true });
});
router.delete('/:id/materials/:mid', (req, res) => { db.prepare('DELETE FROM recipe_materials WHERE id=?').run(req.params.mid); res.status(204).end(); });
module.exports = router;
