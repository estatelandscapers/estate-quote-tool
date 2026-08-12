const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
// The Vendors TAB is admin-only, but Selections needs the vendor list to offer a
// choice. Non-admin reads return names and type only — no terms, contacts, prices
// or supplied-item costs (see the GET handler). Writes stay admin-only.
const isAdminReq2 = req => req.user && req.user.role === 'admin';
router.use((req, res, next) => {
  if (!req.user) return res.status(403).json({ error: 'sign in required' });
  if (req.method === 'GET' || isAdminReq2(req)) return next();
  return res.status(403).json({ error: 'admin only' });
});
// estimators may list vendor names (for context); prices/details admin only
// What this vendor supplies is GENERATED from the Costs library (material_vendors) —
// it is never a separate typed list, so the two can't drift apart.
function suppliedBy(vendorId, vendorCodeNo, admin) {
  const rows = db.prepare(`SELECT mv.*, m.name, m.unit, m.category, m.code_no, m.default_vendor_id
    FROM material_vendors mv JOIN materials m ON m.id=mv.material_id
    WHERE mv.vendor_id=? ORDER BY m.category DESC, m.code_no`).all(vendorId);
  return rows.map(r => {
    const L = r.category === 'plant' ? 'P' : 'M';
    const o = { id: r.id, materialId: r.material_id, code: `${L}${r.code_no || '?'}\u00B7V${vendorCodeNo || '?'}`,
      name: r.name, unit: r.unit, category: r.category, isDefault: r.default_vendor_id === vendorId };
    if (admin) { o.cost = r.cost; o.deliveryRule = r.delivery_rule; o.reviewBy = r.review_by; }
    return o;
  });
}
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM vendors ORDER BY code_no, name').all();
  const admin = req.user && req.user.role === 'admin';
  if (!admin) {
    return res.json(rows.map(v => ({ id: v.id, code: v.code_no ? 'V' + v.code_no : null, name: v.name,
      isSupplier: !!v.is_supplier, isSubcontractor: !!v.is_subcontractor, area: v.area,
      supplies: suppliedBy(v.id, v.code_no, false) })));
  }
  res.json(rows.map(v => ({ id: v.id, code: v.code_no ? 'V' + v.code_no : null, codeNo: v.code_no, name: v.name,
    isSupplier: !!v.is_supplier, isSubcontractor: !!v.is_subcontractor,
    contact: v.contact, phone: v.phone, email: v.email, area: v.area, address: v.address, abn: v.abn, terms: v.terms,
    licence: v.licence, insuranceExpiry: v.insurance_expiry, swms: !!v.swms, notes: v.notes,
    supplies: suppliedBy(v.id, v.code_no, true),
    usedInRecipes: db.prepare(`SELECT DISTINCT p.code FROM recipe_component c JOIN recipe_v2 r ON r.id=c.recipe_id
      JOIN price_items p ON p.id=r.price_item_id WHERE c.vendor_id=?`).all(v.id).map(x => x.code) })));
});
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const b = req.body || {}; const id = newId();
  const nextV = (db.prepare('SELECT MAX(code_no) m FROM vendors').get().m || 0) + 1;
  db.prepare(`INSERT INTO vendors (id,name,is_supplier,is_subcontractor,contact,phone,email,area,address,abn,terms,licence,insurance_expiry,swms,notes,code_no)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name || 'New vendor', b.isSupplier === false ? 0 : 1, b.isSubcontractor ? 1 : 0, b.contact || '', b.phone || '', b.email || '',
      b.area || '', b.address || '', b.abn || '', b.terms || '', b.licence || '', b.insuranceExpiry || '', b.swms ? 1 : 0, b.notes || '', nextV);
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare(`UPDATE vendors SET name=?,is_supplier=?,is_subcontractor=?,contact=?,phone=?,email=?,area=?,address=?,abn=?,terms=?,licence=?,insurance_expiry=?,swms=?,notes=? WHERE id=?`)
    .run(b.name ?? v.name, (b.isSupplier ?? !!v.is_supplier) ? 1 : 0, (b.isSubcontractor ?? !!v.is_subcontractor) ? 1 : 0,
      b.contact ?? v.contact, b.phone ?? v.phone, b.email ?? v.email, b.area ?? v.area, b.address ?? v.address, b.abn ?? v.abn,
      b.terms ?? v.terms, b.licence ?? v.licence, b.insuranceExpiry ?? v.insurance_expiry, (b.swms ?? !!v.swms) ? 1 : 0, b.notes ?? v.notes, v.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  db.prepare('DELETE FROM vendors WHERE id=?').run(req.params.id); res.status(204).end();
});
router.post('/:id/materials', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const b = req.body || {}; const id = newId();
  db.prepare('INSERT INTO vendor_materials (id,vendor_id,name,unit,cost,delivery_rule,review_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.id, b.name || 'Material', b.unit || 'ea', b.cost || 0, b.deliveryRule || '', b.reviewBy || '');
  res.status(201).json({ id });
});
router.put('/:id/materials/:mid', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const m = db.prepare('SELECT * FROM vendor_materials WHERE id=?').get(req.params.mid);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE vendor_materials SET name=?,unit=?,cost=?,delivery_rule=?,review_by=? WHERE id=?')
    .run(b.name ?? m.name, b.unit ?? m.unit, b.cost ?? m.cost, b.deliveryRule ?? m.delivery_rule, b.reviewBy ?? m.review_by, m.id);
  res.json({ ok: true });
});
router.delete('/:id/materials/:mid', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  db.prepare('DELETE FROM vendor_materials WHERE id=?').run(req.params.mid); res.status(204).end();
});
module.exports = router;
