// Recipes v11 — three variants per deliverable (in / sub / mixed), built from components
// that reference the Materials & Plant library. One variant is the default.
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const { materialPrice, costVariant, recipesFor } = require('../utils/costing');
const router = express.Router();
const isAdmin = req => req.user && req.user.role === 'admin';
router.use((req, res, next) => (req.method === 'GET' || isAdmin(req)) ? next() : res.status(403).json({ error: 'admin only' }));
const VARIANTS = ['in', 'sub', 'mixed'];
const VNAME = { in: 'In-house', sub: 'Subcontract', mixed: 'Mixed' };

function compView(c, admin) {
  const base = { id: c.id, kind: c.kind, label: c.label, sortOrder: c.sort_order,
    materialId: c.material_id, tiered: !!c.tiered,
    mat: { Basic: c.mat_basic, Standard: c.mat_standard, Premium: c.mat_premium },
    ratio: c.ratio, wastagePct: c.wastage_pct,
    hrs: { Basic: c.hrs_basic, Standard: c.hrs_standard, Premium: c.hrs_premium },
    subBasis: c.sub_basis, subDays: c.sub_days, vendorId: c.vendor_id };
  const nameOf = id => { const m = materialPrice(id); return m ? m.name : null; };
  base.materialName = c.tiered ? null : nameOf(c.material_id);
  base.matNames = c.tiered ? { Basic: nameOf(c.mat_basic), Standard: nameOf(c.mat_standard), Premium: nameOf(c.mat_premium) } : null;
  if (admin) {
    const mp = materialPrice(c.tiered ? c.mat_standard : c.material_id, c.vendor_id);
    base.vendor = mp ? mp.vendor : null;
    base.unitCost = mp ? mp.cost : 0;
    base.amount = c.amount;
    base.sub = { Basic: c.sub_basic, Standard: c.sub_standard, Premium: c.sub_premium };
    if (c.tiered) {
      base.tierCost = {};
      ['Basic', 'Standard', 'Premium'].forEach(t => {
        const p = materialPrice(c[`mat_${t.toLowerCase()}`], c.vendor_id);
        base.tierCost[t] = p ? p.cost : 0;
      });
    }
  }
  return base;
}
function recipeView(r, admin) {
  const comps = db.prepare('SELECT * FROM recipe_component WHERE recipe_id=? ORDER BY sort_order').all(r.id);
  return { id: r.id, variant: r.variant, variantName: VNAME[r.variant] || r.variant,
    isDefault: !!r.is_default, deliveryCost: admin ? r.delivery_cost : undefined, notes: r.notes,
    components: comps.map(c => compView(c, admin)) };
}
router.get('/', (req, res) => {
  const admin = isAdmin(req);
  const items = db.prepare('SELECT * FROM price_items ORDER BY sort_order').all();
  res.json(items.map(p => {
    const recs = db.prepare('SELECT * FROM recipe_v2 WHERE price_item_id=?').all(p.id);
    const out = { priceItemId: p.id, code: p.code, name: p.name, unit: p.unit, variants: {} };
    recs.forEach(r => out.variants[r.variant] = recipeView(r, admin));
    const d = recs.find(r => r.is_default);
    out.defaultVariant = d ? d.variant : null;
    if (admin) {
      // indicative cost of each variant for 1 unit at Standard
      out.indicative = {};
      const full = recipesFor(p.id);
      VARIANTS.forEach(v => { if (full[v]) out.indicative[v] = Math.round(costVariant({ qty: 1 }, full[v], 'Standard').cost * 100) / 100; });
    }
    return out;
  }));
});
router.post('/', (req, res) => {
  const { priceItemId, variant } = req.body || {};
  if (!priceItemId || !VARIANTS.includes(variant)) return res.status(400).json({ error: 'priceItemId and valid variant required' });
  if (db.prepare('SELECT id FROM recipe_v2 WHERE price_item_id=? AND variant=?').get(priceItemId, variant))
    return res.status(400).json({ error: 'that variant already exists' });
  const id = newId();
  const any = db.prepare('SELECT COUNT(*) c FROM recipe_v2 WHERE price_item_id=?').get(priceItemId).c;
  db.prepare('INSERT INTO recipe_v2 (id,price_item_id,variant,is_default) VALUES (?,?,?,?)').run(id, priceItemId, variant, any === 0 ? 1 : 0);
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM recipe_v2 WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.makeDefault) {
    db.prepare('UPDATE recipe_v2 SET is_default=0 WHERE price_item_id=?').run(r.price_item_id);
    db.prepare('UPDATE recipe_v2 SET is_default=1 WHERE id=?').run(r.id);
  }
  db.prepare('UPDATE recipe_v2 SET delivery_cost=?, notes=? WHERE id=?')
    .run(b.deliveryCost ?? r.delivery_cost, b.notes ?? r.notes, r.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM recipe_v2 WHERE id=?').run(req.params.id); res.status(204).end(); });
router.post('/:id/components', (req, res) => {
  const b = req.body || {}; const id = newId();
  const max = db.prepare('SELECT MAX(sort_order) m FROM recipe_component WHERE recipe_id=?').get(req.params.id);
  db.prepare(`INSERT INTO recipe_component (id,recipe_id,kind,material_id,tiered,ratio,wastage_pct,sub_basis,label,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.params.id, b.kind || 'material', b.materialId || null,
    b.tiered ? 1 : 0, b.ratio || 0, b.wastagePct ?? 5, b.subBasis || 'unit', b.label || null, (max.m ?? -1) + 1);
  res.status(201).json({ id });
});
router.put('/:id/components/:cid', (req, res) => {
  const c = db.prepare('SELECT * FROM recipe_component WHERE id=?').get(req.params.cid);
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const m = b.mat || {}, h = b.hrs || {}, s = b.sub || {};
  db.prepare(`UPDATE recipe_component SET kind=?,material_id=?,vendor_id=?,tiered=?,mat_basic=?,mat_standard=?,mat_premium=?,
      ratio=?,wastage_pct=?,hrs_basic=?,hrs_standard=?,hrs_premium=?,sub_basis=?,sub_basic=?,sub_standard=?,sub_premium=?,
      sub_days=?,amount=?,label=? WHERE id=?`)
    .run(b.kind ?? c.kind, b.materialId !== undefined ? b.materialId : c.material_id,
      b.vendorId !== undefined ? b.vendorId : c.vendor_id, b.tiered !== undefined ? (b.tiered ? 1 : 0) : c.tiered,
      m.Basic !== undefined ? m.Basic : c.mat_basic, m.Standard !== undefined ? m.Standard : c.mat_standard,
      m.Premium !== undefined ? m.Premium : c.mat_premium, b.ratio ?? c.ratio, b.wastagePct ?? c.wastage_pct,
      h.Basic ?? c.hrs_basic, h.Standard ?? c.hrs_standard, h.Premium ?? c.hrs_premium,
      b.subBasis ?? c.sub_basis, s.Basic ?? c.sub_basic, s.Standard ?? c.sub_standard, s.Premium ?? c.sub_premium,
      b.subDays ?? c.sub_days, b.amount ?? c.amount, b.label ?? c.label, c.id);
  res.json({ ok: true });
});
router.delete('/:id/components/:cid', (req, res) => { db.prepare('DELETE FROM recipe_component WHERE id=?').run(req.params.cid); res.status(204).end(); });
module.exports = router;
