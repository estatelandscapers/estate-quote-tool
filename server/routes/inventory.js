// Inventory — equipment register, check-out / check-in with a mandatory photo, service
// tracking. Sits beside Projects and Purchase Orders.
//
// The rule this file exists to enforce: an item cannot change hands without a new photo.
// "New" is checked three ways, all on the server, because the button being greyed out in
// the browser is a courtesy and not a control:
//   1. a photo must be present in the request;
//   2. its fingerprint (SHA-256) must never have been used on any entry before;
//   3. the phone's own timestamp for the picture must be within the last 24 hours.
// The usage entry is written only after the photo is confirmed stored in OneDrive.
//
// Who can do what: any signed-in office login can add and edit items and log usage or
// service. Only admin can archive, restore, change a serial number, or rename/retire
// locations and people. Usage entries and photos can't be edited or removed by anyone.
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const { sydneyParts } = require('../utils/refs');
const photos = require('../utils/inventoryPhotos');
const router = express.Router();

const DUE_SOON_DAYS = 14;
const FRESH_HOURS = 24;

const isAdmin = req => req.user && req.user.role === 'admin';
const who = req => (req.user && (req.user.name || req.user.username)) || 'unknown';
router.use((req, res, next) => req.user ? next() : res.status(403).json({ error: 'sign in required' }));
const adminOnly = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: 'Only an admin can do that.' });
const audit = (req, id, action, detail) => {
  try { db.prepare('INSERT INTO audit_log (id,entity_type,entity_id,actor,action,detail) VALUES (?,?,?,?,?,?)').run(newId(), 'inventory', id, who(req), action, detail || ''); } catch (e) {}
};
const bad = (res, msg, code = 400, extra) => res.status(code).json({ error: msg, ...(extra || {}) });

const today = () => sydneyParts().ymd;
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const cleanSerial = s => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ');

function serviceStatus(r, t = today()) {
  if (!r.needs_service) return 'na';
  if (!r.next_service_date) return 'unset';
  if (r.next_service_date < t) return 'overdue';
  if (r.next_service_date <= addDays(t, DUE_SOON_DAYS)) return 'due';
  return 'ok';
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }

const ITEM_SQL = `SELECT i.*, l.name AS location_name, p.name AS held_by_name
  FROM inv_items i LEFT JOIN inv_locations l ON l.id=i.location_id LEFT JOIN inv_people p ON p.id=i.held_by`;
function shape(r, t = today()) {
  const st = serviceStatus(r, t);
  return {
    id: r.id, serial: r.serial, description: r.description, notes: r.notes || '',
    status: r.status === 'out' ? 'out' : 'in',
    usedById: r.held_by || null, usedBy: r.held_by_name || null, outSince: r.out_since || null,
    locationId: r.location_id || null, location: r.location_name || null,
    needsService: !!r.needs_service, lastServiceDate: r.last_service_date || null, nextServiceDate: r.next_service_date || null,
    serviceIntervalMonths: r.service_interval_months || null,
    serviceStatus: st, serviceDays: r.needs_service && r.next_service_date ? daysBetween(t, r.next_service_date) : null,
    photoId: r.last_photo_id || null, archived: !!r.archived_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
const getItem = id => db.prepare(ITEM_SQL + ' WHERE i.id=?').get(id);
const locations = () => db.prepare(`SELECT l.id, l.name, l.archived,
  (SELECT COUNT(*) FROM inv_items i WHERE i.location_id=l.id AND i.archived_at IS NULL) AS items
  FROM inv_locations l ORDER BY l.archived, l.name COLLATE NOCASE`).all().map(l => ({ ...l, archived: !!l.archived }));
const people = () => db.prepare(`SELECT p.id, p.name, p.active,
  (SELECT COUNT(*) FROM inv_items i WHERE i.held_by=p.id AND i.archived_at IS NULL) AS holding
  FROM inv_people p ORDER BY p.active DESC, p.name COLLATE NOCASE`).all().map(p => ({ ...p, active: !!p.active }));

function suggestSerial() {
  const rows = db.prepare("SELECT serial FROM inv_items WHERE serial LIKE 'EST-%'").all();
  const max = rows.reduce((m, r) => { const n = parseInt(r.serial.slice(4), 10); return n > m ? n : m; }, 0);
  return 'EST-' + String(max + 1).padStart(5, '0');
}

// ---- everything the tab needs, in one call ---------------------------------------
router.get('/', (req, res) => {
  const t = today();
  const showArchived = req.query.archived === '1' && isAdmin(req);
  const items = db.prepare(ITEM_SQL + (showArchived ? '' : ' WHERE i.archived_at IS NULL') + ' ORDER BY i.serial COLLATE NOCASE').all().map(r => shape(r, t));
  const live = items.filter(i => !i.archived);
  res.json({
    items, locations: locations(), people: people(), today: t, suggestedSerial: suggestSerial(),
    storage: photos.storageState(), dueSoonDays: DUE_SOON_DAYS,
    counts: { total: live.length, out: live.filter(i => i.status === 'out').length,
      due: live.filter(i => i.serviceStatus === 'due').length, overdue: live.filter(i => i.serviceStatus === 'overdue').length },
  });
});
// Just the number for the nav badge.
router.get('/summary', (req, res) => {
  const t = today();
  const rows = db.prepare('SELECT needs_service, next_service_date FROM inv_items WHERE archived_at IS NULL').all();
  res.json({ overdue: rows.filter(r => serviceStatus(r, t) === 'overdue').length, due: rows.filter(r => serviceStatus(r, t) === 'due').length });
});

// ---- items ------------------------------------------------------------------------
function readItemBody(b, existing) {
  const out = {};
  out.description = cleanName(b.description);
  if (!out.description) return { error: 'Give the item a description.', field: 'description' };
  if (out.description.length > 160) return { error: 'Keep the description under 160 characters.', field: 'description' };
  out.needs_service = b.needsService ? 1 : 0;
  out.last_service_date = b.lastServiceDate || null;
  out.next_service_date = out.needs_service ? (b.nextServiceDate || null) : null;
  const iv = parseInt(b.serviceIntervalMonths, 10);
  out.service_interval_months = out.needs_service && iv > 0 && iv <= 120 ? iv : null;
  if (out.last_service_date && !isYmd(out.last_service_date)) return { error: 'Last service date is not a valid date.', field: 'lastServiceDate' };
  if (out.last_service_date && out.last_service_date > today()) return { error: 'Last service date cannot be in the future.', field: 'lastServiceDate' };
  if (out.needs_service) {
    // Work the next date out from the interval when it was left blank.
    if (!out.next_service_date && out.service_interval_months && out.last_service_date) out.next_service_date = addMonths(out.last_service_date, out.service_interval_months);
    if (!out.next_service_date) return { error: 'This item needs servicing, so it needs a next service date (or a last service date and an interval).', field: 'nextServiceDate' };
    if (!isYmd(out.next_service_date)) return { error: 'Next service date is not a valid date.', field: 'nextServiceDate' };
    if (out.last_service_date && out.next_service_date <= out.last_service_date) return { error: 'Next service date must be after the last service date.', field: 'nextServiceDate' };
  }
  out.notes = String(b.notes || '').trim().slice(0, 2000);
  out.location_id = b.locationId || (existing && existing.location_id) || null;
  if (!out.location_id) return { error: 'Choose where the item is kept.', field: 'locationId' };
  const loc = db.prepare('SELECT id, archived FROM inv_locations WHERE id=?').get(out.location_id);
  if (!loc) return { error: 'That location no longer exists — choose another.', field: 'locationId' };
  if (loc.archived && (!existing || existing.location_id !== loc.id)) return { error: 'That location has been retired — choose another.', field: 'locationId' };
  return { v: out };
}
function serialClash(serial, exceptId) {
  const hit = db.prepare('SELECT id, archived_at FROM inv_items WHERE serial=? COLLATE NOCASE').get(serial);
  if (!hit || hit.id === exceptId) return null;
  return hit.archived_at ? `Serial ${serial} belongs to an archived item. Restore that item instead of creating it again.`
    : `Serial ${serial} is already in the register.`;
}

router.post('/items', (req, res) => {
  const b = req.body || {};
  const serial = cleanSerial(b.serial);
  if (!serial) return bad(res, 'Enter the serial number.', 400, { field: 'serial' });
  if (serial.length > 60) return bad(res, 'Serial number is too long.', 400, { field: 'serial' });
  const clash = serialClash(serial); if (clash) return bad(res, clash, 409, { field: 'serial' });
  const r = readItemBody(b); if (r.error) return bad(res, r.error, 400, { field: r.field });
  const id = newId(), v = r.v;
  db.prepare(`INSERT INTO inv_items (id,serial,description,needs_service,last_service_date,next_service_date,service_interval_months,location_id,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, serial, v.description, v.needs_service, v.last_service_date, v.next_service_date, v.service_interval_months, v.location_id, v.notes, who(req));
  audit(req, id, 'item_created', `${serial} — ${v.description}`);
  res.json(shape(getItem(id)));
});

router.get('/items/:id', (req, res) => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  const logs = db.prepare('SELECT * FROM inv_logs WHERE item_id=? ORDER BY created_at DESC, rowid DESC').all(it.id).map(l => ({
    id: l.id, type: l.type, person: l.person_name, location: l.location_name, notes: l.notes || '', photoId: l.photo_id || null,
    serviceDate: l.service_date, nextServiceDate: l.next_service_date, loggedBy: l.logged_by, at: l.created_at,
  }));
  const ph = db.prepare(`SELECT p.id, p.uploaded_by, p.uploaded_at, p.taken_at, p.bytes, p.web_url, l.type, l.person_name, l.location_name
    FROM inv_photos p LEFT JOIN inv_logs l ON l.id=p.log_id WHERE p.item_id=? ORDER BY p.uploaded_at DESC, p.rowid DESC`).all(it.id).map(p => ({
    id: p.id, by: p.uploaded_by, at: p.uploaded_at, takenAt: p.taken_at, bytes: p.bytes, type: p.type, person: p.person_name, location: p.location_name,
    webUrl: isAdmin(req) ? p.web_url : null,
  }));
  res.json({ item: shape(it), logs, photos: ph });
});

router.put('/items/:id', (req, res) => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  if (it.archived_at) return bad(res, 'This item is archived. Restore it before editing.', 409);
  const b = req.body || {};
  let serial = it.serial;
  if (b.serial != null && cleanSerial(b.serial) !== it.serial) {
    if (!isAdmin(req)) return bad(res, 'Only an admin can change a serial number.', 403, { field: 'serial' });
    serial = cleanSerial(b.serial);
    if (!serial) return bad(res, 'Enter the serial number.', 400, { field: 'serial' });
    const clash = serialClash(serial, it.id); if (clash) return bad(res, clash, 409, { field: 'serial' });
  }
  const r = readItemBody(b, it); if (r.error) return bad(res, r.error, 400, { field: r.field });
  const v = r.v;
  // While an item is out, where it is was set by the check-out and its photo. Moving it
  // from the edit form would change the record without the proof.
  if (it.status === 'out' && v.location_id !== it.location_id) return bad(res, 'This item is checked out. Check it in to change its location.', 409, { field: 'locationId' });
  db.prepare(`UPDATE inv_items SET serial=?, description=?, needs_service=?, last_service_date=?, next_service_date=?, service_interval_months=?,
    location_id=?, notes=?, updated_at=datetime('now') WHERE id=?`).run(serial, v.description, v.needs_service, v.last_service_date, v.next_service_date, v.service_interval_months, v.location_id, v.notes, it.id);
  const ch = [];
  if (serial !== it.serial) ch.push(`serial ${it.serial} → ${serial}`);
  if (v.description !== it.description) ch.push('description');
  if (v.location_id !== it.location_id) ch.push('location');
  if ((v.next_service_date || '') !== (it.next_service_date || '')) ch.push(`next service ${it.next_service_date || '—'} → ${v.next_service_date || '—'}`);
  if ((v.last_service_date || '') !== (it.last_service_date || '')) ch.push(`last service ${it.last_service_date || '—'} → ${v.last_service_date || '—'}`);
  if (!!v.needs_service !== !!it.needs_service) ch.push(v.needs_service ? 'servicing on' : 'servicing off');
  audit(req, it.id, 'item_edited', ch.join('; ') || 'notes');
  res.json(shape(getItem(it.id)));
});

// Archive, never delete: the usage history and its photos are the point of the register.
router.delete('/items/:id', adminOnly, (req, res) => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  if (it.status === 'out') return bad(res, `This item is checked out to ${it.held_by_name || 'someone'}. Check it in before archiving.`, 409);
  db.prepare("UPDATE inv_items SET archived_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(it.id);
  audit(req, it.id, 'item_archived', it.serial);
  res.json({ ok: true });
});
router.post('/items/:id/restore', adminOnly, (req, res) => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  db.prepare("UPDATE inv_items SET archived_at=NULL, updated_at=datetime('now') WHERE id=?").run(it.id);
  audit(req, it.id, 'item_restored', it.serial);
  res.json(shape(getItem(it.id)));
});

// ---- the photo gate ---------------------------------------------------------------
async function takePhoto(req, it, kind, required) {
  const p = (req.body || {}).photo;
  if (!p || !p.data) {
    if (!required) return null;
    const e = new Error('A new photo is required. Take one before submitting.'); e.status = 400; e.field = 'photo'; throw e;
  }
  if (p.takenAt) {
    const age = Date.now() - new Date(p.takenAt).getTime();
    if (isFinite(age) && age > FRESH_HOURS * 36e5) {
      const e = new Error(`That photo is older than ${FRESH_HOURS} hours. Take a new one of the item as it is now.`); e.status = 400; e.field = 'photo'; throw e;
    }
  }
  let prep;
  try { prep = await photos.prepare(p.data); } catch (x) { x.status = 400; x.field = 'photo'; throw x; }
  const dup = db.prepare(`SELECT p.uploaded_at, i.serial FROM inv_photos p JOIN inv_items i ON i.id=p.item_id WHERE p.sha256=?`).get(prep.sha256);
  if (dup) {
    const e = new Error(`That photo has been used before (on ${dup.serial}, ${String(dup.uploaded_at).slice(0, 10)}). Take a new one.`); e.status = 409; e.field = 'photo'; throw e;
  }
  const stored = await photos.store({ serial: it.serial, kind, buffer: prep.buffer });
  return { prep, stored, takenAt: p.takenAt && !isNaN(new Date(p.takenAt)) ? new Date(p.takenAt).toISOString() : null };
}
function savePhoto(req, it, logId, ph) {
  const id = newId();
  db.prepare(`INSERT INTO inv_photos (id,item_id,log_id,storage,od_item_id,od_path,web_url,sha256,bytes,width,height,taken_at,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, it.id, logId, ph.stored.storage, ph.stored.odItemId, ph.stored.path, ph.stored.webUrl,
    ph.prep.sha256, ph.prep.buffer.length, ph.prep.width, ph.prep.height, ph.takenAt, who(req));
  audit(req, it.id, 'photo_uploaded', `${ph.stored.path} · ${ph.prep.buffer.length} bytes · sha256 ${ph.prep.sha256.slice(0, 16)}`);
  return id;
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
}
const fail = (res, e) => { if (!e.status) console.error('[inventory]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong saving that. Nothing was logged.', field: e.field }); };
// Two people pressing Check out on the same item at once: the second must lose cleanly.
const BUSY = new Set();
async function exclusive(id, res, fn) {
  if (BUSY.has(id)) return bad(res, 'Someone else is updating this item right now. Try again in a moment.', 409);
  BUSY.add(id);
  try { await fn(); } catch (e) { fail(res, e); } finally { BUSY.delete(id); }
}

router.post('/items/:id/checkout', (req, res) => exclusive(req.params.id, res, async () => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  if (it.archived_at) return bad(res, 'This item is archived.', 409);
  if (it.status === 'out') return bad(res, `Already checked out to ${it.held_by_name || 'someone'}. Check it in first.`, 409);
  const b = req.body || {};
  const person = b.personId && db.prepare('SELECT * FROM inv_people WHERE id=? AND active=1').get(b.personId);
  if (!person) return bad(res, 'Choose who is using the item.', 400, { field: 'personId' });
  const loc = b.locationId && db.prepare('SELECT * FROM inv_locations WHERE id=? AND archived=0').get(b.locationId);
  if (!loc) return bad(res, 'Choose where the item is going.', 400, { field: 'locationId' });
  const notes = String(b.notes || '').trim().slice(0, 1000);
  const ph = await takePhoto(req, it, 'out', true);
  const out = tx(() => {
    const logId = newId();
    const photoId = savePhoto(req, it, logId, ph);
    db.prepare(`INSERT INTO inv_logs (id,item_id,type,person_id,person_name,location_id,location_name,notes,photo_id,logged_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(logId, it.id, 'checkout', person.id, person.name, loc.id, loc.name, notes, photoId, who(req));
    db.prepare(`UPDATE inv_items SET status='out', held_by=?, location_id=?, out_since=datetime('now'), last_photo_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(person.id, loc.id, photoId, it.id);
    return { logId, photoId };
  });
  audit(req, it.id, 'checked_out', `${it.serial} → ${person.name} @ ${loc.name}`);
  res.json({ ok: true, ...out, item: shape(getItem(it.id)) });
}));

router.post('/items/:id/checkin', (req, res) => exclusive(req.params.id, res, async () => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  if (it.status !== 'out') return bad(res, 'This item is not checked out.', 409);
  const b = req.body || {};
  const loc = b.locationId && db.prepare('SELECT * FROM inv_locations WHERE id=? AND archived=0').get(b.locationId);
  if (!loc) return bad(res, 'Choose where the item has been returned to.', 400, { field: 'locationId' });
  const notes = String(b.notes || '').trim().slice(0, 1000);
  const ph = await takePhoto(req, it, 'in', true);
  const out = tx(() => {
    const logId = newId();
    const photoId = savePhoto(req, it, logId, ph);
    db.prepare(`INSERT INTO inv_logs (id,item_id,type,person_id,person_name,location_id,location_name,notes,photo_id,logged_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(logId, it.id, 'checkin', it.held_by, it.held_by_name, loc.id, loc.name, notes, photoId, who(req));
    db.prepare(`UPDATE inv_items SET status='in', held_by=NULL, out_since=NULL, location_id=?, last_photo_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(loc.id, photoId, it.id);
    return { logId, photoId };
  });
  audit(req, it.id, 'checked_in', `${it.serial} ← ${it.held_by_name || '?'} @ ${loc.name}`);
  res.json({ ok: true, ...out, item: shape(getItem(it.id)) });
}));

// A service: photo welcome (the docket, the new blade) but not compulsory.
router.post('/items/:id/service', (req, res) => exclusive(req.params.id, res, async () => {
  const it = getItem(req.params.id); if (!it) return bad(res, 'Item not found.', 404);
  if (it.archived_at) return bad(res, 'This item is archived.', 409);
  const b = req.body || {};
  const date = b.serviceDate || today();
  if (!isYmd(date)) return bad(res, 'Service date is not a valid date.', 400, { field: 'serviceDate' });
  if (date > today()) return bad(res, 'Service date cannot be in the future.', 400, { field: 'serviceDate' });
  let next = b.nextServiceDate || null;
  if (!next && it.service_interval_months) next = addMonths(date, it.service_interval_months);
  if (it.needs_service && !next) return bad(res, 'Enter the next service date.', 400, { field: 'nextServiceDate' });
  if (next && (!isYmd(next) || next <= date)) return bad(res, 'Next service date must be after the service date.', 400, { field: 'nextServiceDate' });
  const notes = String(b.notes || '').trim().slice(0, 1000);
  const ph = await takePhoto(req, it, 'service', false);
  const out = tx(() => {
    const logId = newId();
    const photoId = ph ? savePhoto(req, it, logId, ph) : null;
    db.prepare(`INSERT INTO inv_logs (id,item_id,type,location_id,location_name,notes,photo_id,service_date,next_service_date,logged_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(logId, it.id, 'service', it.location_id, it.location_name, notes, photoId, date, next, who(req));
    db.prepare(`UPDATE inv_items SET last_service_date=?, next_service_date=?, needs_service=CASE WHEN ? IS NOT NULL THEN 1 ELSE needs_service END,
      last_photo_id=COALESCE(?, last_photo_id), updated_at=datetime('now') WHERE id=?`).run(date, next, next, photoId, it.id);
    return { logId, photoId };
  });
  audit(req, it.id, 'serviced', `${it.serial} serviced ${date}; next ${next || '—'}`);
  res.json({ ok: true, ...out, item: shape(getItem(it.id)) });
}));

// ---- photos (served through the tool so the OneDrive links stay private) ------------
router.get('/photos/:id', async (req, res) => {
  const p = db.prepare('SELECT * FROM inv_photos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).end();
  try {
    const out = await photos.read(p, req.query.s === 'thumb' ? 'thumb' : 'full');
    // A stored photo never changes, so the browser may keep it for good.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(out.mime).send(out.buffer);
  } catch (e) { res.status(e.status || 502).end(); }
});

// ---- locations & people -------------------------------------------------------------
function lookupRoutes(path, table, label, activeCol, activeOn, usedSql) {
  router.post(path, (req, res) => {
    const name = cleanName((req.body || {}).name);
    if (!name) return bad(res, `Enter a ${label} name.`, 400, { field: 'name' });
    if (name.length > 60) return bad(res, 'Keep the name under 60 characters.', 400, { field: 'name' });
    const hit = db.prepare(`SELECT * FROM ${table} WHERE name=? COLLATE NOCASE`).get(name);
    if (hit) {
      // Adding a name that was retired brings it back rather than failing on "already exists".
      if (hit[activeCol] !== activeOn) { db.prepare(`UPDATE ${table} SET ${activeCol}=? WHERE id=?`).run(activeOn, hit.id); audit(req, hit.id, `${label}_restored`, hit.name); return res.json({ id: hit.id, name: hit.name, restored: true }); }
      return bad(res, `"${hit.name}" is already in the list.`, 409, { field: 'name', id: hit.id });
    }
    const id = newId();
    db.prepare(`INSERT INTO ${table} (id,name,created_by) VALUES (?,?,?)`).run(id, name, who(req));
    audit(req, id, `${label}_added`, name);
    res.json({ id, name });
  });
  router.put(path + '/:id', adminOnly, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id); if (!row) return bad(res, 'Not found.', 404);
    const b = req.body || {};
    if (b.name != null) {
      const name = cleanName(b.name);
      if (!name) return bad(res, `Enter a ${label} name.`, 400, { field: 'name' });
      const hit = db.prepare(`SELECT id FROM ${table} WHERE name=? COLLATE NOCASE AND id<>?`).get(name, row.id);
      if (hit) return bad(res, `"${name}" is already in the list.`, 409, { field: 'name' });
      db.prepare(`UPDATE ${table} SET name=? WHERE id=?`).run(name, row.id);
      audit(req, row.id, `${label}_renamed`, `${row.name} → ${name}`);
    }
    if (b.retired != null) {
      const used = db.prepare(usedSql).get(row.id).c;
      if (b.retired && used) return bad(res, label === 'location' ? `${used} item(s) are at ${row.name}. Move them first.` : `${row.name} still has ${used} item(s) checked out. Check them in first.`, 409);
      db.prepare(`UPDATE ${table} SET ${activeCol}=? WHERE id=?`).run(b.retired ? (activeOn ? 0 : 1) : activeOn, row.id);
      audit(req, row.id, b.retired ? `${label}_retired` : `${label}_restored`, row.name);
    }
    res.json({ ok: true });
  });
  // Delete only what has never been used; anything with history is retired instead.
  router.delete(path + '/:id', adminOnly, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id); if (!row) return bad(res, 'Not found.', 404);
    const col = label === 'location' ? 'location_id' : 'person_id';
    const hist = db.prepare(`SELECT COUNT(*) c FROM inv_logs WHERE ${col}=?`).get(row.id).c
      + (label === 'location' ? db.prepare('SELECT COUNT(*) c FROM inv_items WHERE location_id=?').get(row.id).c : 0);
    if (hist) return bad(res, `${row.name} appears in the usage history, so it can be retired but not deleted.`, 409);
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    audit(req, row.id, `${label}_deleted`, row.name);
    res.json({ ok: true });
  });
}
lookupRoutes('/locations', 'inv_locations', 'location', 'archived', 0, 'SELECT COUNT(*) c FROM inv_items WHERE location_id=? AND archived_at IS NULL');
lookupRoutes('/people', 'inv_people', 'person', 'active', 1, 'SELECT COUNT(*) c FROM inv_items WHERE held_by=? AND archived_at IS NULL');

module.exports = router;
