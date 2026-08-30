const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
// Estimators can't browse or edit the rate card (the Pricing tab is admin-only), but
// they DO need to read it to build a quote — otherwise there are no deliverables to
// add and the builder never loads. So: reads allowed, writes admin-only.
const isAdminReq = req => req.user && req.user.role === 'admin';
router.use((req, res, next) => {
  if (!req.user) return res.status(403).json({ error: 'sign in required' });
  if (req.method === 'GET' || isAdminReq(req)) return next();
  return res.status(403).json({ error: 'admin only' });
});

const rowOut = r => ({
  id: r.id, code: r.code, name: r.name, description: r.description || '', fromCustom: !!r.from_custom, originQuote: r.origin_quote, recipeStatus: r.recipe_status || 'none', unit: r.unit, behaviour: r.behaviour, notes: r.notes,
  sectionId: r.section_id || null,
  tiers: { Basic: { spec: r.basic_spec, sell: r.basic_sell }, Standard: { spec: r.standard_spec, sell: r.standard_sell }, Premium: { spec: r.premium_spec, sell: r.premium_sell } },
});

// ---- Deliverable sections -------------------------------------------------------
// Admin organisation only. The client link and contract never show these — they keep
// reading sort_order, which resequence() rebuilds from section order + position.
//
// EVERY literal path here MUST stay above router.put('/:id') and router.post('/:id/...').
// '/reorder' was previously declared below '/:id' and Express matched it as an id, so the
// endpoint silently 404'd and drag-reordering never worked at all.
router.get('/sections', (req, res) => {
  res.json(db.prepare('SELECT id, name, sort_order FROM price_sections ORDER BY sort_order, name').all()
    .map(s => ({ id: s.id, name: s.name, sortOrder: s.sort_order })));
});
router.post('/sections', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the section a name' });
  const max = db.prepare('SELECT MAX(sort_order) m FROM price_sections').get().m || 0;
  const id = newId();
  db.prepare('INSERT INTO price_sections (id,name,sort_order) VALUES (?,?,?)').run(id, name, max + 1);
  res.status(201).json({ id, name, sortOrder: max + 1 });
});
router.put('/sections/:sid', (req, res) => {
  const s = db.prepare('SELECT * FROM price_sections WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare('UPDATE price_sections SET name=?, sort_order=? WHERE id=?')
    .run(b.name != null ? String(b.name).trim() || s.name : s.name,
         b.sortOrder != null ? parseInt(b.sortOrder) || s.sort_order : s.sort_order, req.params.sid);
  resequence();
  res.json({ ok: true });
});
// Deleting a section never deletes deliverables — they fall into Unsorted at the bottom.
router.delete('/sections/:sid', (req, res) => {
  const moved = db.prepare('SELECT COUNT(*) c FROM price_items WHERE section_id=?').get(req.params.sid).c;
  db.prepare('UPDATE price_items SET section_id=NULL WHERE section_id=?').run(req.params.sid);
  db.prepare('DELETE FROM price_sections WHERE id=?').run(req.params.sid);
  resequence();
  res.json({ ok: true, moved });
});

// Rebuild the flat sort_order from section order, then position within section. This is
// what carries the owner's arrangement through to the quote builder, client link and PDF.
function resequence() {
  const secs = db.prepare('SELECT id FROM price_sections ORDER BY sort_order, name').all().map(s => s.id);
  secs.push(null);                                    // Unsorted always last
  let n = 1;
  const up = db.prepare('UPDATE price_items SET sort_order=? WHERE id=?');
  for (const sid of secs) {
    const items = sid === null
      ? db.prepare('SELECT id FROM price_items WHERE section_id IS NULL ORDER BY sort_order, code').all()
      : db.prepare('SELECT id FROM price_items WHERE section_id=? ORDER BY sort_order, code').all(sid);
    items.forEach(it => up.run(n++, it.id));
  }
}

// Apply typed position numbers. Body: { items: [{ id, sectionId, position }] }
router.put('/arrange', (req, res) => {
  const items = (req.body || {}).items || [];
  if (!items.length) return res.json({ ok: true, count: 0 });
  const valid = new Set(db.prepare('SELECT id FROM price_sections').all().map(s => s.id));
  const setSec = db.prepare('UPDATE price_items SET section_id=? WHERE id=?');
  const setOrd = db.prepare('UPDATE price_items SET sort_order=? WHERE id=?');
  // Position numbers are per-section and may be typed with gaps or duplicates. Sort by the
  // typed number, then write back a clean 1..n — so "3" always lands where the owner meant.
  const bySec = new Map();
  items.forEach(it => {
    const sid = it.sectionId && valid.has(it.sectionId) ? it.sectionId : null;
    setSec.run(sid, it.id);
    if (!bySec.has(sid)) bySec.set(sid, []);
    bySec.get(sid).push({ id: it.id, pos: Number(it.position) || 9999 });
  });
  for (const [, list] of bySec) {
    list.sort((a, b) => a.pos - b.pos);
    list.forEach((x, i) => setOrd.run(i + 1, x.id));
  }
  resequence();
  res.json({ ok: true, count: items.length });
});

router.get('/', (req, res) => res.json(db.prepare('SELECT * FROM price_items ORDER BY sort_order, code').all().map(rowOut)));

router.post('/', (req, res) => {
  const b = req.body || {}; const t = b.tiers || {};
  const max = db.prepare('SELECT MAX(sort_order) m FROM price_items').get().m || 0;
  const id = newId();
  // description was missing from this INSERT — a new deliverable silently lost its scope
  // and only kept it on a second, editing save. The PUT below has always handled it.
  db.prepare(`INSERT INTO price_items (id,code,name,unit,behaviour,description,basic_spec,basic_sell,standard_spec,standard_sell,premium_spec,premium_sell,notes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.code || 'XX', b.name || 'New deliverable', b.unit || 'ea', b.behaviour || 'none', b.description || '',
      t.Basic?.spec || '', t.Basic?.sell || 0, t.Standard?.spec || '', t.Standard?.sell || 0, t.Premium?.spec || '', t.Premium?.sell || 0, b.notes || '', max + 1);
  if (b.sectionId && db.prepare('SELECT 1 x FROM price_sections WHERE id=?').get(b.sectionId)) {
    db.prepare('UPDATE price_items SET section_id=? WHERE id=?').run(b.sectionId, id);
    resequence();
  }
  res.status(201).json(rowOut(db.prepare('SELECT * FROM price_items WHERE id=?').get(id)));
});

router.put('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM price_items WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {}; const t = b.tiers || {};
  db.prepare(`UPDATE price_items SET code=?,name=?,unit=?,behaviour=?,basic_spec=?,basic_sell=?,standard_spec=?,standard_sell=?,premium_spec=?,premium_sell=?,notes=?,updated_at=datetime('now') WHERE id=?`)
    .run(b.code ?? e.code, b.name ?? e.name, b.unit ?? e.unit, b.behaviour ?? e.behaviour,
      t.Basic?.spec ?? e.basic_spec, t.Basic?.sell ?? e.basic_sell,
      t.Standard?.spec ?? e.standard_spec, t.Standard?.sell ?? e.standard_sell,
      t.Premium?.spec ?? e.premium_spec, t.Premium?.sell ?? e.premium_sell,
      b.notes ?? e.notes, req.params.id);
  if (b.description !== undefined) db.prepare('UPDATE price_items SET description=? WHERE id=?').run(b.description, req.params.id);
  if (b.sectionId !== undefined) {
    const ok = b.sectionId && db.prepare('SELECT 1 x FROM price_sections WHERE id=?').get(b.sectionId);
    db.prepare('UPDATE price_items SET section_id=? WHERE id=?').run(ok ? b.sectionId : null, req.params.id);
    resequence();
  }
  db.prepare('INSERT INTO audit_log (id,entity_type,entity_id,actor,action,detail) VALUES (?,?,?,?,?,?)')
    .run(newId(), 'price_item', req.params.id, req.headers['x-actor'] || 'owner', 'update', `Rate updated: ${b.name || e.name}`);
  res.json(rowOut(db.prepare('SELECT * FROM price_items WHERE id=?').get(req.params.id)));
});

router.delete('/:id', (req, res) => { db.prepare('DELETE FROM price_items WHERE id=?').run(req.params.id); res.status(204).end(); });

// ---- surcharges ----
router.get('/surcharges/all', (req, res) => res.json(db.prepare('SELECT * FROM surcharges ORDER BY sort_order').all()));
router.post('/surcharges', (req, res) => {
  const b = req.body || {}; const id = newId();
  const max = db.prepare('SELECT MAX(sort_order) m FROM surcharges').get().m || 0;
  db.prepare('INSERT INTO surcharges (id,name,trigger_note,kind,rate,sort_order) VALUES (?,?,?,?,?,?)')
    .run(id, b.name || 'New surcharge', b.triggerNote || '', b.kind || 'percent', b.rate || 0, max + 1);
  res.status(201).json({ id });
});
router.put('/surcharges/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM surcharges WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare('UPDATE surcharges SET name=?,trigger_note=?,kind=?,rate=? WHERE id=?')
    .run(b.name ?? e.name, b.triggerNote ?? e.trigger_note, b.kind ?? e.kind, b.rate ?? e.rate, req.params.id);
  res.json({ ok: true });
});
router.delete('/surcharges/:id', (req, res) => { db.prepare('DELETE FROM surcharges WHERE id=?').run(req.params.id); res.status(204).end(); });

// NOTE: the old PUT '/reorder' lived here, below router.put('/:id'), so Express matched
// 'reorder' as an :id and it never ran. Replaced by PUT '/arrange' declared above '/:id'.
router.post('/:id/move', (req, res) => {
  const dir = (req.body || {}).dir === 'up' ? -1 : 1;
  const all = db.prepare('SELECT id, sort_order FROM price_items ORDER BY sort_order, code').all();
  const i = all.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const j = i + dir;
  if (j < 0 || j >= all.length) return res.json({ ok: true, moved: false });
  const up = db.prepare('UPDATE price_items SET sort_order=? WHERE id=?');
  all.forEach((x, k) => up.run(k + 1, x.id));
  up.run(j + 1, all[i].id); up.run(i + 1, all[j].id);
  res.json({ ok: true, moved: true });
});
module.exports = router;
