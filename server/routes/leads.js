// Leads / enquiries. Manual entry now; a public website form can POST to /api/public/lead later
// without any rework (same table, same fields).
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const STATUS = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];

function view(l) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(l.created_at + 'Z').getTime()) / 864e5));
  let q = null;
  if (l.quote_id) q = db.prepare('SELECT quote_number, status FROM quotes WHERE id=?').get(l.quote_id);
  return { id: l.id, name: l.name, phone: l.phone, email: l.email, address: l.address,
    source: l.source, notes: l.notes, status: l.status, ageDays,
    quoteId: l.quote_id, quoteNumber: q ? q.quote_number : null, quoteStatus: q ? q.status : null,
    createdAt: l.created_at };
}
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const open = rows.filter(l => !['Won', 'Lost'].includes(l.status));
  res.json({ leads: rows.map(view), openCount: open.length, statuses: STATUS });
});
router.post('/', (req, res) => {
  const b = req.body || {}; const id = newId();
  db.prepare('INSERT INTO leads (id,name,phone,email,address,source,notes,status) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, b.name || '', b.phone || '', b.email || '', b.address || '', b.source || 'Phone', b.notes || '', b.status || 'New');
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare("UPDATE leads SET name=?,phone=?,email=?,address=?,source=?,notes=?,status=?,updated_at=datetime('now') WHERE id=?")
    .run(b.name ?? l.name, b.phone ?? l.phone, b.email ?? l.email, b.address ?? l.address,
      b.source ?? l.source, b.notes ?? l.notes, b.status ?? l.status, l.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id); res.status(204).end(); });

// Convert a lead into a quote — carries the details across, links both ways.
router.post('/:id/convert', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (l.quote_id) return res.status(400).json({ error: 'already converted', quoteId: l.quote_id });
  const { createQuote } = require('./quotes');
  const q = createQuote({ client: l.name, clientEmail: l.email, address: l.address, projectTitle: 'Landscape Works', leadId: l.id });
  db.prepare("UPDATE leads SET quote_id=?, status='Quoted', updated_at=datetime('now') WHERE id=?").run(q.id, l.id);
  res.status(201).json({ quoteId: q.id, quoteNumber: q.quote_number });
});
module.exports = router;
