const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
// estimators may list vendor names (for context); prices/details admin only
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM vendors ORDER BY name').all();
  if (req.user && req.user.role !== 'admin') {
    return res.json(rows.map(v => ({ id: v.id, name: v.name, isSupplier: !!v.is_supplier, isSubcontractor: !!v.is_subcontractor, area: v.area })));
  }
  res.json(rows.map(v => ({ id: v.id, name: v.name, isSupplier: !!v.is_supplier, isSubcontractor: !!v.is_subcontractor,
    contact: v.contact, phone: v.phone, email: v.email, area: v.area, address: v.address, abn: v.abn, terms: v.terms,
    licence: v.licence, insuranceExpiry: v.insurance_expiry, swms: !!v.swms, notes: v.notes,
    materials: db.prepare('SELECT * FROM vendor_materials WHERE vendor_id=? ORDER BY name').all(v.id)
      .map(m => ({ id: m.id, name: m.name, unit: m.unit, cost: m.cost, deliveryRule: m.delivery_rule, reviewBy: m.review_by })) })));
});
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const b = req.body || {}; const id = newId();
  db.prepare(`INSERT INTO vendors (id,name,is_supplier,is_subcontractor,contact,phone,email,area,address,abn,terms,licence,insurance_expiry,swms,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name || 'New vendor', b.isSupplier === false ? 0 : 1, b.isSubcontractor ? 1 : 0, b.contact || '', b.phone || '', b.email || '',
      b.area || '', b.address || '', b.abn || '', b.terms || '', b.licence || '', b.insuranceExpiry || '', b.swms ? 1 : 0, b.notes || '');
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
