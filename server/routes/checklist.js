const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');

const router = express.Router();

// ---- Editable master template (draft you can adjust over time) ----
router.get('/template', (req, res) => {
  const rows = db.prepare('SELECT * FROM checklist_template ORDER BY sort_order').all();
  res.json(rows.map(r => ({ id: r.id, category: r.category, label: r.label, critical: !!r.critical, sortOrder: r.sort_order })));
});

router.post('/template', (req, res) => {
  const { category, label, critical } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  const max = db.prepare('SELECT MAX(sort_order) as m FROM checklist_template').get();
  const id = newId();
  db.prepare('INSERT INTO checklist_template (id, sort_order, category, label, critical) VALUES (?,?,?,?,?)')
    .run(id, (max.m ?? -1) + 1, category || 'General', label, critical ? 1 : 0);
  res.status(201).json({ id });
});

router.put('/template/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM checklist_template WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { category, label, critical } = req.body;
  db.prepare('UPDATE checklist_template SET category=?, label=?, critical=? WHERE id=?')
    .run(category ?? existing.category, label ?? existing.label, critical === undefined ? existing.critical : (critical ? 1 : 0), req.params.id);
  res.json({ ok: true });
});

router.delete('/template/:id', (req, res) => {
  db.prepare('DELETE FROM checklist_template WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---- Per-quote checklist instance (a snapshot the team actually ticks off) ----
router.get('/quote/:quoteId', (req, res) => {
  const quote = db.prepare('SELECT id FROM quotes WHERE id = ?').get(req.params.quoteId);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  let rows = db.prepare('SELECT * FROM quote_checklist WHERE quote_id = ? ORDER BY sort_order').all(req.params.quoteId);
  if (rows.length === 0) {
    // First time this quote's checklist is opened — snapshot the current template into it.
    const template = db.prepare('SELECT * FROM checklist_template ORDER BY sort_order').all();
    const stmt = db.prepare(`INSERT INTO quote_checklist
      (id, quote_id, template_item_id, sort_order, category, label, critical, checked)
      VALUES (?,?,?,?,?,?,?,0)`);
    template.forEach(t => stmt.run(newId(), req.params.quoteId, t.id, t.sort_order, t.category, t.label, t.critical));
    rows = db.prepare('SELECT * FROM quote_checklist WHERE quote_id = ? ORDER BY sort_order').all(req.params.quoteId);
  }
  res.json(rows.map(r => ({
    id: r.id, category: r.category, label: r.label, critical: !!r.critical,
    checked: !!r.checked, checkedBy: r.checked_by, checkedAt: r.checked_at, notes: r.notes,
  })));
});

router.put('/quote/:quoteId/item/:itemId', (req, res) => {
  const existing = db.prepare('SELECT * FROM quote_checklist WHERE id = ? AND quote_id = ?').get(req.params.itemId, req.params.quoteId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { checked, checkedBy, notes } = req.body;
  const nowChecked = checked === undefined ? existing.checked : (checked ? 1 : 0);
  db.prepare('UPDATE quote_checklist SET checked=?, checked_by=?, checked_at=?, notes=? WHERE id=?')
    .run(nowChecked, checkedBy ?? existing.checked_by, nowChecked ? new Date().toISOString() : null, notes ?? existing.notes, req.params.itemId);

  db.prepare('INSERT INTO audit_log (id, entity_type, entity_id, actor, action, detail) VALUES (?,?,?,?,?,?)').run(
    newId(), 'checklist_item', req.params.itemId, checkedBy || 'unknown',
    nowChecked ? 'checked' : 'unchecked',
    `"${existing.label}" on quote ${req.params.quoteId}${notes ? ' — note: ' + notes : ''}`,
  );
  res.json({ ok: true });
});

// ---- Accountability trail ----
router.get('/audit-log/:quoteId', (req, res) => {
  // Pull audit entries for this quote's checklist items plus the quote itself
  const items = db.prepare('SELECT id FROM quote_checklist WHERE quote_id = ?').all(req.params.quoteId).map(r => r.id);
  if (items.length === 0) return res.json([]);
  const placeholders = items.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM audit_log WHERE entity_id IN (${placeholders}) ORDER BY created_at DESC`).all(...items);
  res.json(rows.map(r => ({ id: r.id, actor: r.actor, action: r.action, detail: r.detail, createdAt: r.created_at })));
});

module.exports = router;
