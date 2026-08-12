// Selections — the gate between winning a job and raising the PO.
// Confirm HOW each deliverable will be done and WHO supplies it, then lock and create the PO.
const express = require('express');
const { db } = require('../db');
const { costQuote } = require('../utils/costing');
const router = express.Router();
const isAdmin = req => req.user && req.user.role === 'admin';
// The site/ops side needs Selections to do their job — choosing how each deliverable
// is delivered and by whom. They just don't see what any of it costs.
router.use((req, res, next) => req.user ? next() : res.status(403).json({ error: 'sign in required' }));

router.get('/', (req, res) => {
  const rows = db.prepare("SELECT * FROM quotes WHERE status='accepted' ORDER BY accepted_at DESC").all();
  res.json(rows.map(q => {
    const po = db.prepare('SELECT id, po_number, revision FROM purchase_orders WHERE quote_id=? AND superseded=0').get(q.id);
    return { id: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address,
      acceptedAt: q.accepted_at, acceptedPackage: q.accepted_package,
      locked: !!q.selections_locked, poId: po ? po.id : null,
      poNumber: po ? po.po_number + (po.revision > 1 ? '-R' + po.revision : '') : null,
      stage: q.selections_locked ? (po ? 'PO raised' : 'Locked') : 'Awaiting selections' };
  }));
});
router.get('/:quoteId', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: 'not found' });
  const quoted = costQuote(q, { useSelections: false });
  const selected = costQuote(q, { useSelections: true });
  const vendors = db.prepare('SELECT id,name,is_subcontractor FROM vendors ORDER BY name').all()
    .map(v => ({ id: v.id, name: v.name, isSub: !!v.is_subcontractor }));
  const lines = selected.perLine.map(l => {
    const qLine = quoted.perLine.find(x => x.id === l.id) || l;
    const qi = db.prepare('SELECT desc_override, price_item_id FROM quote_items WHERE id=?').get(l.id);
    const dpi = qi && qi.price_item_id ? db.prepare('SELECT description FROM price_items WHERE id=?').get(qi.price_item_id) : null;
    return { id: l.id, code: l.code, name: l.name, qty: l.qty, unit: l.unit, tier: l.selected,
      description: (qi && qi.desc_override) || (dpi && dpi.description) || '',
      spec: l.tiers[l.selected].spec, quotedMethod: qLine.method, finalMethod: l.method,
      defaultMethod: l.defaultMethod, availableVariants: l.availableVariants,
      subDays: l.subDays, selVendorId: l.selVendorId,
      variantCost: l.variantCost, quotedCost: qLine.tiers[qLine.selected].cost,
      finalCost: l.tiers[l.selected].cost,
      delta: Math.round(l.tiers[l.selected].cost - qLine.tiers[qLine.selected].cost) };
  });
  if (!isAdmin(req)) {
    return res.json({ quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address,
      locked: !!q.selections_locked, vendors, restricted: true,
      lines: lines.map(l => { const { quotedCost, finalCost, delta, variantCost, ...rest } = l; return rest; }),
      quoted: { days: quoted.days, crewDays: quoted.crewDays, subDays: quoted.subDays },
      final: { days: selected.days, crewDays: selected.crewDays, subDays: selected.subDays } });
  }
  res.json({ quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address,
    locked: !!q.selections_locked, vendors, lines,
    quoted: { cost: Math.round(quoted.selected.cost), days: quoted.days, crewDays: quoted.crewDays, subDays: quoted.subDays, marginPct: quoted.grossMarginPct },
    final: { cost: Math.round(selected.selected.cost), sell: Math.round(selected.selected.sell),
      days: selected.days, crewDays: selected.crewDays, subDays: selected.subDays, marginPct: selected.grossMarginPct } });
});
router.put('/:quoteId/line/:itemId', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: 'not found' });
  if (q.selections_locked) return res.status(400).json({ error: 'selections are locked — unlock first' });
  const b = req.body || {};
  const e = db.prepare('SELECT * FROM quote_items WHERE id=?').get(req.params.itemId);
  if (!e) return res.status(404).json({ error: 'line not found' });
  db.prepare('UPDATE quote_items SET sel_method=?, sel_vendor_id=?, sel_sub_days=?, desc_override=? WHERE id=?')
    .run(b.method !== undefined ? b.method : e.sel_method,
      b.vendorId !== undefined ? b.vendorId : e.sel_vendor_id,
      b.subDays !== undefined ? b.subDays : e.sel_sub_days,
      b.description !== undefined ? (b.description || null) : e.desc_override, e.id);
  res.json({ ok: true });
});
// Lock the selections and raise the PO from those exact decisions.
router.post('/:quoteId/lock', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE quotes SET selections_locked=1 WHERE id=?').run(q.id);
  const { createPOFromQuote } = require('./purchaseOrders');
  let poId = null;
  try { poId = createPOFromQuote(q.id); } catch (e) { console.error('PO creation failed', e.message); }
  res.json({ ok: true, poId });
});
router.post('/:quoteId/unlock', (req, res) => {
  db.prepare('UPDATE quotes SET selections_locked=0 WHERE id=?').run(req.params.quoteId);
  res.json({ ok: true });
});
module.exports = router;
