const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const { resolveItem } = require('../utils/pricing');
const router = express.Router();

// Build a PO from an accepted quote. PO number = parent quote number (revision ignored).
function createPOFromQuote(quoteId) {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);
  if (!q) return null;
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE quote_id=?').get(quoteId);
  if (existing) return existing.id;
  const poId = newId();
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const challenges = q.surcharges_na ? [] : applied.map(s => s.name);
  db.prepare(`INSERT INTO purchase_orders (id,quote_id,po_number,client_name,address,siteplan_data,siteplan_mime,site_challenges,status)
    VALUES (?,?,?,?,?,?,?,?, 'open')`).run(poId, quoteId, q.parent_number, q.client_name, q.address,
    q.siteplan_data, q.siteplan_mime, JSON.stringify(challenges));
  const tier = q.accepted_package || q.default_package || 'Standard';
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY scope, sort_order').all(quoteId);
  items.forEach((it, i) => {
    const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
    const r = resolveItem(it, pi, it.tier_override || tier);
    db.prepare('INSERT INTO po_items (id,po_id,code,name,spec,qty,unit,sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId(), poId, r.code, r.name, r.spec, it.qty, r.unit, i);
  });
  return poId;
}

function poView(po) {
  const items = db.prepare('SELECT * FROM po_items WHERE po_id=? ORDER BY sort_order').all(po.id);
  const prints = db.prepare('SELECT * FROM po_prints WHERE po_id=? ORDER BY printed_at DESC').all(po.id);
  return { id: po.id, poNumber: po.po_number, client: po.client_name, address: po.address,
    status: po.status, hasSiteplan: !!po.siteplan_data, siteChallenges: JSON.parse(po.site_challenges || '[]'),
    items: items.map(i => ({ id: i.id, code: i.code, name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, removed: !!i.removed })),
    prints: prints.map(p => ({ by: p.printed_by, at: p.printed_at })), createdAt: po.created_at, closedAt: po.closed_at };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all();
  res.json(rows.map(po => {
    const n = db.prepare('SELECT COUNT(*) c FROM po_prints WHERE po_id=?').get(po.id).c;
    return { id: po.id, poNumber: po.po_number, client: po.client_name, address: po.address, status: po.status, prints: n };
  }));
});
router.get('/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  res.json(poView(po));
});
router.get('/:id/siteplan', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po || !po.siteplan_data) return res.status(404).end();
  res.setHeader('Content-Type', po.siteplan_mime || 'image/png');
  res.send(Buffer.from(po.siteplan_data, 'base64'));
});
// owner edits (PIN-checked client-side; server trusts admin origin)
router.put('/:id/items/:itemId', (req, res) => {
  const b = req.body || {};
  const e = db.prepare('SELECT * FROM po_items WHERE id=?').get(req.params.itemId);
  if (!e) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE po_items SET name=?,spec=?,qty=?,unit=?,removed=? WHERE id=?')
    .run(b.name ?? e.name, b.spec ?? e.spec, b.qty ?? e.qty, b.unit ?? e.unit, b.removed !== undefined ? (b.removed ? 1 : 0) : e.removed, req.params.itemId);
  res.json({ ok: true });
});
router.post('/:id/items', (req, res) => {
  const b = req.body || {};
  const max = db.prepare('SELECT MAX(sort_order) m FROM po_items WHERE po_id=?').get(req.params.id).m || 0;
  db.prepare('INSERT INTO po_items (id,po_id,code,name,spec,qty,unit,sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(newId(), req.params.id, b.code || 'XX', b.name || 'Line', b.spec || '', b.qty || 0, b.unit || 'ea', max + 1);
  res.status(201).json({ ok: true });
});
router.delete('/:id/items/:itemId', (req, res) => { db.prepare('DELETE FROM po_items WHERE id=?').run(req.params.itemId); res.status(204).end(); });
router.post('/:id/reset', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM po_items WHERE po_id=?').run(po.id);
  // rebuild from quote
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(po.quote_id);
  const tier = q.accepted_package || q.default_package || 'Standard';
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY scope, sort_order').all(po.quote_id);
  items.forEach((it, i) => {
    const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
    const r = resolveItem(it, pi, it.tier_override || tier);
    db.prepare('INSERT INTO po_items (id,po_id,code,name,spec,qty,unit,sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId(), po.id, r.code, r.name, r.spec, it.qty, r.unit, i);
  });
  res.json({ ok: true });
});
router.post('/:id/print', (req, res) => {
  db.prepare('INSERT INTO po_prints (id,po_id,printed_by) VALUES (?,?,?)').run(newId(), req.params.id, (req.body && req.body.by) || 'Owner');
  res.json({ ok: true });
});
router.post('/:id/close', (req, res) => {
  db.prepare("UPDATE purchase_orders SET status='closed', closed_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
router.post('/:id/reopen', (req, res) => {
  db.prepare("UPDATE purchase_orders SET status='open', closed_at=NULL WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, createPOFromQuote };
