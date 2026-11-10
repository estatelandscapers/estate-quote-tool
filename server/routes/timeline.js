// Works timeline API — admin only. See server/utils/timeline.js for the model.
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const T = require('../utils/timeline');
const router = express.Router();
router.use((req, res, next) => (!req.user || req.user.role !== 'admin') ? res.status(403).json({ error: 'admin only' }) : next());

const who = req => req.user ? (req.user.name || req.user.username) : '';
const audit = (req, id, action, detail) => { try { db.prepare('INSERT INTO audit_log (id,entity_type,entity_id,actor,action,detail) VALUES (?,?,?,?,?,?)').run(newId(), 'timeline', id, who(req), action, detail || ''); } catch (e) {} };
const num = v => v === '' || v == null ? null : (isNaN(Number(v)) ? null : Number(v));

// The grid. ?from=YYYY-MM&to=YYYY-MM&archived=1
router.get('/', (req, res) => {
  try { res.json(T.build({ from: req.query.from, to: req.query.to, includeArchived: req.query.archived === '1' })); }
  catch (e) { console.error('[timeline]', e); res.status(500).json({ error: e.message }); }
});
router.get('/cashflow', (req, res) => { try { res.json(T.cashflow()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/pending-count', (req, res) => res.json({ count: T.pendingCount() }));

// Add a job by hand (one that predates the tool, or was contracted outside it).
router.post('/jobs', (req, res) => {
  const b = req.body || {};
  if (!String(b.client || '').trim()) return res.status(400).json({ error: 'Client name is needed.' });
  if (num(b.value) == null) return res.status(400).json({ error: 'Contract value is needed.' });
  const id = newId();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM timeline_items WHERE parent_id IS NULL').get().m;
  db.prepare('INSERT INTO timeline_items (id,source,quote_number,client,address,value,margin_pct,notes,sort_order) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'manual', String(b.quoteNumber || '').trim(), String(b.client).trim(), String(b.address || '').trim(), num(b.value), num(b.margin), b.notes || '', max + 1);
  audit(req, id, 'add job', `${b.quoteNumber || ''} ${b.client} $${b.value}`);
  res.status(201).json({ id });
});
// A separate item under a job — a variation, extra works, a second stage.
router.post('/jobs/:id/items', (req, res) => {
  const job = db.prepare('SELECT * FROM timeline_items WHERE id=? AND parent_id IS NULL').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const b = req.body || {};
  if (!String(b.label || '').trim()) return res.status(400).json({ error: 'Give the item a name, e.g. "Variation 1 — extra retaining wall".' });
  if (num(b.value) == null) return res.status(400).json({ error: 'The item needs a value.' });
  const id = newId();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM timeline_items WHERE parent_id=?').get(job.id).m;
  db.prepare('INSERT INTO timeline_items (id,parent_id,source,quote_number,client,label,value,margin_pct,notes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, job.id, 'manual', job.quote_number, job.client, String(b.label).trim(), num(b.value), num(b.margin), b.notes || '', max + 1);
  audit(req, id, 'add item', `${b.label} $${b.value} under ${job.quote_number || job.client}`);
  res.status(201).json({ id });
});
// Edit an item: client, address, label, value, margin, notes, archived, order.
// value / margin of '' clears an override on a tool job (back to the quote's own figures).
router.put('/items/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM timeline_items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const sets = [], vals = [];
  ['client', 'address', 'label', 'notes'].forEach(k => { if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(b[k])); } });
  if (b.quoteNumber !== undefined && it.source === 'manual') { sets.push('quote_number=?'); vals.push(String(b.quoteNumber)); }
  if (b.value !== undefined) { sets.push('value=?'); vals.push(num(b.value)); }
  if (b.margin !== undefined) { sets.push('margin_pct=?'); vals.push(num(b.margin)); }
  if (b.archived !== undefined) { sets.push('archived=?'); vals.push(b.archived ? 1 : 0); }
  if (b.sort !== undefined) { sets.push('sort_order=?'); vals.push(parseInt(b.sort, 10) || 0); }
  if (!sets.length) return res.json({ ok: true });
  db.prepare(`UPDATE timeline_items SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...vals, it.id);
  audit(req, it.id, 'edit', JSON.stringify(b).slice(0, 300));
  res.json({ ok: true });
});
// Delete: hand-added jobs and items only. A job signed in the tool is archived instead
// (it would only come back on the next sync).
router.delete('/items/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM timeline_items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  if (it.source === 'tool' && !it.parent_id) return res.status(400).json({ error: 'This job comes from a signed quote — archive it instead.' });
  const ids = [it.id, ...db.prepare('SELECT id FROM timeline_items WHERE parent_id=?').all(it.id).map(r => r.id)];
  ids.forEach(id => { db.prepare('DELETE FROM timeline_blocks WHERE item_id=?').run(id); db.prepare('DELETE FROM timeline_items WHERE id=?').run(id); });
  audit(req, it.id, 'delete', `${it.quote_number || ''} ${it.label || it.client}`);
  res.status(204).end();
});
// Move a job up or down. Body: { ids: [job ids in order] }
router.put('/order', (req, res) => {
  const ids = (req.body || {}).ids || [];
  const up = db.prepare('UPDATE timeline_items SET sort_order=? WHERE id=? AND parent_id IS NULL');
  ids.forEach((id, i) => up.run(i + 1, id));
  res.json({ ok: true });
});
// A block: { planned, plannedLock, actual, actualLock, remove }
router.put('/items/:id/blocks/:month', (req, res) => {
  const r = T.setBlock(req.params.id, req.params.month, req.body || {});
  if (r.error) return res.status(r.error === 'not found' ? 404 : 400).json(r);
  audit(req, req.params.id, 'block ' + req.params.month, JSON.stringify(req.body || {}));
  res.json(r);
});
// Month end: { month, entries: [{ itemId, actual }] } — records and locks each actual.
router.post('/confirm', (req, res) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(b.month || '')) return res.status(400).json({ error: 'month required' });
  const n = T.confirmMonth(b.month, b.entries || []);
  audit(req, b.month, 'confirm month', `${n} actual(s)`);
  res.json({ ok: true, confirmed: n });
});

module.exports = router;
