// Lead files, shown inside the tool (v52).
//
// The files themselves live in OneDrive — one folder per lead — and never on the Railway
// volume. The tool lists that folder, shows thumbnails, and streams a photo or PDF through
// its own login so nobody needs OneDrive or hipages open.
//
// A lead can have up to three folders, read together as one list:
//   website  — created by the website enquiry form (already existed before v52)
//   hipages  — photos the hipages bot pushed for the job (table hip_jobs)
//   own      — made the first time someone adds a file to a lead that has neither
const crypto = require('crypto');
const { db } = require('../db');
const od = require('./onedrive');

for (const [col, def] of [['files_folder', 'TEXT'], ['files_web', 'TEXT'], ['files_count', 'INTEGER'], ['hip_job_id', 'TEXT']]) {
  try { db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${def}`); } catch (e) {}
}
db.exec(`CREATE TABLE IF NOT EXISTS hip_jobs (
  job_id TEXT PRIMARY KEY, suburb TEXT, postcode TEXT, category TEXT, description TEXT,
  folder_id TEXT, lead_id TEXT, names TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lead_files_added (lead_id TEXT, name TEXT, by TEXT, at TEXT DEFAULT (datetime('now')));`);
// Website enquiries from before v52: show the count the client declared until the lead is opened.
try { for (const l of db.prepare("SELECT id, enquiry_files FROM leads WHERE files_count IS NULL AND enquiry_files IS NOT NULL").all()) {
  let n = 0; try { n = (JSON.parse(l.enquiry_files).declared || []).length; } catch (e) {}
  db.prepare('UPDATE leads SET files_count=? WHERE id=?').run(n, l.id);
} } catch (e) {}

try { db.exec('ALTER TABLE hip_jobs ADD COLUMN phone TEXT'); } catch (e) {}
const digits = s => String(s || '').replace(/\D/g, '').slice(-9);
db.exec('CREATE TABLE IF NOT EXISTS lead_file_rev (item_id TEXT PRIMARY KEY, lead_id TEXT, rev TEXT)');
// ---- which quote revision a file belongs to (v54) ------------------------------
// A file belongs to the revision that was current when it was added: the latest revision
// created at or before the file. Files from before the first quote have no revision.
// Someone can move a file to another revision; that choice is kept by the file's ID.
function revisionsFor(l) {
  const ids = new Set();
  const add = q => { if (q && q.parent_number) ids.add(q.parent_number); };
  if (l.quote_id) add(db.prepare('SELECT parent_number FROM quotes WHERE id=?').get(l.quote_id));
  for (const q of db.prepare('SELECT DISTINCT parent_number FROM quotes WHERE lead_id=?').all(l.id)) add(q);
  const out = [];
  for (const pn of ids) out.push(...db.prepare("SELECT id, quote_number, created_at, status, sent_at FROM quotes WHERE parent_number=? AND COALESCE(is_sample,0)=0").all(pn));
  const ms = t => Date.parse(String(t || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t || '')) ? '' : 'Z')) || 0;
  return out.map(q => ({ id: q.id, number: q.quote_number, at: ms(q.created_at), date: String(q.created_at || '').slice(0, 10), status: q.status, sent: !!q.sent_at }))
    .sort((a, b) => a.at - b.at || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}
function revOf(file, revs, moved) {
  if (moved.has(file.id)) { const m = moved.get(file.id); return m === '' || revs.some(r => r.number === m) ? m : ''; }
  const t = Date.parse(file.created) || 0; let hit = '';
  for (const r of revs) if (r.at <= t + 60000) hit = r.number;      // a minute of slack: uploaded straight after revising
  return hit;
}
function setRev(l, itemId, rev) {
  const revs = revisionsFor(l); rev = String(rev || '');
  if (rev && !revs.some(r => r.number === rev)) throw new Error('That revision is not one of this job\'s quotes');
  db.prepare('INSERT INTO lead_file_rev (item_id, lead_id, rev) VALUES (?,?,?) ON CONFLICT(item_id) DO UPDATE SET rev=excluded.rev').run(itemId, l.id, rev);
}
// The lead a quote belongs to: its own link, or the lead pointing at any revision of it.
function leadOfQuote(q) {
  if (!q) return null;
  if (q.lead_id) { const l = db.prepare('SELECT * FROM leads WHERE id=?').get(q.lead_id); if (l) return l; }
  return db.prepare('SELECT l.* FROM leads l JOIN quotes x ON x.id=l.quote_id WHERE x.parent_number=? LIMIT 1').get(q.parent_number)
    || db.prepare('SELECT l.* FROM leads l JOIN quotes x ON x.lead_id=l.id WHERE x.parent_number=? LIMIT 1').get(q.parent_number) || null;
}

const year = () => require('./refs').sydneyParts().year;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const kindOf = (name, mime) => /svg/i.test(mime) || /\.svgz?$/i.test(name) ? 'file' : /^image\//.test(mime) || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(name) ? 'image'
  : mime === 'application/pdf' || /\.pdf$/i.test(name) ? 'pdf' : /^video\//.test(mime) || /\.(mp4|mov|m4v|webm)$/i.test(name) ? 'video' : 'file';

// ---- v55: every enquiry has an ENQ number and one folder -------------------------
// Estate Enquiries / <year> / ENQ-2026-1101 — Name — Suburb / 01 From client · 02 Site photos · 03 Quote and contract
// Closed or lost enquiries sit under  Estate Enquiries / <year> / Closed / …  and move back
// if the lead is reopened. Folders are held by their OneDrive ID, so renaming or moving
// one by hand does not detach it from its lead.
const SUBS = [['client', '01 From client'], ['site', '02 Site photos'], ['quote', '03 Quote and contract']];
for (const [col, def] of [['enq_folder', 'TEXT'], ['enq_subs', 'TEXT'], ['enq_url', 'TEXT'], ['enq_closed', 'INTEGER']]) {
  try { db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${def}`); } catch (e) {}
}
const isClosed = l => l.status === 'Lost';
const subsOf = l => { try { return JSON.parse(l.enq_subs || 'null') || null; } catch (e) { return null; } };
// Give a lead its reference. Old leads are numbered into the month they arrived.
function ensureRef(l) {
  if (l.enquiry_ref) return l.enquiry_ref;
  const when = new Date(String(l.created_at || '').replace(' ', 'T') + 'Z');
  const ref = require('./refs').nextRef(when);
  db.prepare('UPDATE leads SET enquiry_ref=? WHERE id=? AND enquiry_ref IS NULL').run(ref, l.id);
  l.enquiry_ref = ref; return ref;
}
function numberAll() {
  let n = 0;
  for (const l of db.prepare('SELECT id, created_at, enquiry_ref FROM leads WHERE enquiry_ref IS NULL ORDER BY created_at, rowid').all()) { ensureRef(l); n++; }
  if (n) console.log(`[enq] ${n} lead(s) given an ENQ reference`);
  return n;
}
const enqYear = ref => (String(ref || '').match(/^ENQ-(\d{4})-/) || [])[1] || year();
const enqName = l => `${l.enquiry_ref} — ${od.safeName(l.name) || 'No name'} — ${od.safeName(String(l.suburb || l.address || '').split(',')[0]) || 'No suburb'}`;

// Make sure the lead has its folder, its three sub-folders, its older files moved in, and
// that the folder sits under Closed exactly when the lead is closed. Safe to call often.
async function ensureEnq(leadId) {
  if (!od.configured()) return null;
  let l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId); if (!l) return null;
  ensureRef(l);
  const yr = enqYear(l.enquiry_ref), closed = isClosed(l);
  if (!l.enq_folder) {
    // A website enquiry already has its folder; everything else gets one now.
    let f = l.files_web ? { id: l.files_web } : null, inClosed = 0;
    if (!f && l.enquiry_files) { try { const meta = JSON.parse(l.enquiry_files).meta; f = meta && await od.folderByPath(od.folderPathFor(meta)); } catch (e) {} }
    if (!f) {
      // A website lead's folder name comes from the website's own record of it, so the
      // website's later uploads land in this same folder rather than a second one.
      let nm = enqName(l), y = yr;
      try { const meta = l.enquiry_files && JSON.parse(l.enquiry_files).meta; if (meta && meta.ref) { nm = od.folderPathFor(meta).split('/').pop(); y = String(meta.year || yr); } } catch (e) {}
      f = await od.ensurePath(closed ? [y, 'Closed', nm] : [y, nm]); inClosed = closed ? 1 : 0;
    }
    let url = f.webUrl || ''; if (!url) { try { url = (await od.itemInfo(f.id)).webUrl || ''; } catch (e) {} }
    db.prepare('UPDATE leads SET enq_folder=?, enq_url=?, enq_closed=? WHERE id=?').run(f.id, url, inClosed, l.id);
    l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  }
  let subs = subsOf(l);
  if (!subs) {
    subs = {}; for (const [k, name] of SUBS) subs[k] = (await od.ensureChild(l.enq_folder, name)).id;
    db.prepare('UPDATE leads SET enq_subs=? WHERE id=?').run(JSON.stringify(subs), l.id);
  }
  // Files kept elsewhere before v55 (hipages photos, files added in the tool) move in.
  for (const h of db.prepare('SELECT job_id, folder_id FROM hip_jobs WHERE lead_id=? AND folder_id IS NOT NULL AND folder_id<>?').all(l.id, subs.client)) {
    try { for (const k of await od.childrenOf(h.folder_id)) await od.moveItem(k.id, subs.client);
      await od.removeItem(h.folder_id); } catch (e) { if (!/ 404/.test(e.message)) { console.error('[enq] hipages photos not moved:', e.message); continue; } }
    db.prepare('UPDATE hip_jobs SET folder_id=? WHERE job_id=?').run(subs.client, h.job_id);
  }
  if (l.files_folder && l.files_folder !== l.enq_folder) {
    try { for (const k of await od.childrenOf(l.files_folder)) await od.moveItem(k.id, ['image', 'video'].includes(kindOf(k.name, k.mime)) ? subs.site : subs.client);
      await od.removeItem(l.files_folder); db.prepare('UPDATE leads SET files_folder=NULL WHERE id=?').run(l.id);
    } catch (e) { if (/ 404/.test(e.message)) db.prepare('UPDATE leads SET files_folder=NULL WHERE id=?').run(l.id); else console.error('[enq] earlier files not moved:', e.message); }
  }
  if ((closed ? 1 : 0) !== (l.enq_closed || 0)) {
    const parent = await od.ensurePath(closed ? [yr, 'Closed'] : [yr]);
    const moved = await od.moveItem(l.enq_folder, parent.id);
    db.prepare('UPDATE leads SET enq_closed=?, enq_url=COALESCE(?, enq_url) WHERE id=?').run(closed ? 1 : 0, (moved && moved.webUrl) || null, l.id);
    console.log(`[enq] ${l.enquiry_ref} folder moved ${closed ? 'to Closed' : 'back to open'}`);
  }
  return { id: l.enq_folder, subs, url: l.enq_url || '' };
}
// Background pass: number every lead, then give folders to those without one and move the
// folders of leads that were closed or reopened. A few at a time, so a long backlog (every
// lead that existed before v55) never floods OneDrive.
let enqBusy = false;
async function enqTick(limit = 10) {
  numberAll();
  if (!od.configured() || enqBusy) return 0;
  enqBusy = true; let n = 0;
  try {
    const rows = db.prepare(`SELECT id FROM leads WHERE enq_folder IS NULL OR enq_subs IS NULL OR COALESCE(enq_closed,0) <> (CASE WHEN status='Lost' THEN 1 ELSE 0 END)
      ORDER BY (status='Lost'), created_at DESC LIMIT ?`).all(limit);
    for (const r of rows) { try { await ensureEnq(r.id); n++; } catch (e) { console.error('[enq] folder for lead', r.id, 'failed:', e.message); } }
    if (n) console.log(`[enq] ${n} enquiry folder(s) set up or moved`);
  } finally { enqBusy = false; }
  return n;
}
function startEnq() {
  setTimeout(() => enqTick().catch(e => console.error('[enq]', e.message)), 25000).unref();
  setInterval(() => enqTick().catch(e => console.error('[enq]', e.message)), 2 * 60e3).unref();
}

async function foldersFor(l) {
  const out = [], subs = subsOf(l);
  if (l.enq_folder) {
    out.push({ kind: 'root', id: l.enq_folder });
    if (subs) for (const [k] of SUBS) if (subs[k]) out.push({ kind: k, id: subs[k] });
  } else if (l.enquiry_files) {
    let id = l.files_web;
    if (!id) { try { const meta = JSON.parse(l.enquiry_files).meta; const f = meta && await od.folderByPath(od.folderPathFor(meta));
      if (f) { id = f.id; db.prepare('UPDATE leads SET files_web=? WHERE id=?').run(id, l.id); } } catch (e) {} }
    if (id) out.push({ kind: 'website', id });
  }
  const have = new Set(out.map(o => o.id));
  for (const h of db.prepare('SELECT folder_id FROM hip_jobs WHERE lead_id=? AND folder_id IS NOT NULL').all(l.id)) if (!have.has(h.folder_id)) { have.add(h.folder_id); out.push({ kind: 'hipages', id: h.folder_id }); }
  if (l.files_folder && !have.has(l.files_folder)) out.push({ kind: 'own', id: l.files_folder });
  return out;
}
async function list(l) {
  if (!od.configured()) return { configured: false, files: [], revisions: [] };
  const revs = revisionsFor(l);
  const moved = new Map(db.prepare('SELECT item_id, rev FROM lead_file_rev WHERE lead_id=?').all(l.id).map(r => [r.item_id, r.rev]));
  if (String(l.source || '').toLowerCase() === 'hipages' && !l.hip_job_id) { link(); }
  try { await ensureEnq(l.id); } catch (e) { console.error('[enq] folder not ready:', e.message); }
  l = db.prepare('SELECT * FROM leads WHERE id=?').get(l.id) || l;
  const FROM = { client: 'From client', site: 'Site photos', quote: 'Quote and contract', website: 'Website upload', hipages: 'hipages', own: 'Added in the tool', root: l.enquiry_files ? 'Website upload' : 'Enquiry folder' };
  const added = new Map(db.prepare('SELECT name, by FROM lead_files_added WHERE lead_id=?').all(l.id).map(r => [r.name, r.by]));
  const files = [];
  for (const f of await foldersFor(l)) {
    let kids = []; try { kids = await od.childrenOf(f.id); } catch (e) { if (!/ 404/.test(e.message)) throw e; }
    for (const k of kids) files.push({ ...k, kind: kindOf(k.name, k.mime), rev: revOf(k, revs, moved),
      where: f.kind, from: /^hipages-\d+-\d+\./.test(k.name) ? 'hipages' : added.has(k.name) && added.get(k.name) ? (added.get(k.name) === 'Email' ? 'From their email' : 'Added by ' + added.get(k.name)) : FROM[f.kind] || 'Added in the tool' });
  }
  files.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  db.prepare('UPDATE leads SET files_count=? WHERE id=?').run(files.length, l.id);
  return { configured: true, files, ref: l.enquiry_ref || '', folderUrl: l.enq_url || '', closedFolder: !!l.enq_closed, subs: SUBS.map(x => ({ id: x[0], label: x[1] })),
    revisions: revs.map(r => ({ number: r.number, date: r.date, status: r.status, sent: r.sent })) };
}

// Where a file added from the tool goes: the chosen sub-folder of the ENQ folder, or by
// type when none is chosen (photos and video to Site photos, documents to From client).
async function targetFolder(l, name, where) {
  const e = await ensureEnq(l.id);
  const k = ['client', 'site', 'quote'].includes(where) ? where : (['image', 'video'].includes(kindOf(name, '')) ? 'site' : 'client');
  return e.subs[k] || e.id;
}
async function session(l, name, by, where) {
  const s = await od.sessionIn(await targetFolder(l, name, where), name);
  db.prepare('INSERT INTO lead_files_added (lead_id,name,by) VALUES (?,?,?)').run(l.id, s.name, by || '');
  return s;
}
// Bytes the server already holds (an email attachment) filed against a lead.
async function addBytes(leadId, name, buf, by, where) {
  if (!od.configured()) throw new Error('OneDrive is not configured');
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId); if (!l) throw new Error('lead not found');
  const r = await od.putBytes(await targetFolder(l, name, where), name, buf);
  db.prepare('INSERT INTO lead_files_added (lead_id,name,by) VALUES (?,?,?)').run(l.id, r.name, by || '');
  db.prepare('UPDATE leads SET files_count=COALESCE(files_count,0)+1 WHERE id=?').run(l.id);
  return r;
}
// A file may only be opened or deleted through the lead whose folder holds it.
async function owned(l, itemId) {
  if (!/^[A-Za-z0-9!_-]{6,80}$/.test(itemId)) return null;
  const ids = (await foldersFor(l)).map(f => f.id);
  const m = await od.itemMeta(itemId).catch(() => null);
  return m && m.parentReference && ids.includes(m.parentReference.id) ? m : null;
}

// ---- hipages photos, pushed by the bot ---------------------------------------
const keyOk = k => { const want = process.env.HIPAGES_FILES_KEY || ''; const a = Buffer.from(String(k || '')), b = Buffer.from(want);
  return want.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b); };

// Tie a pushed hipages job to its lead. The bot knows the job number, suburb and the
// customer's description; the lead (made from the "Job Details" email) carries the same
// description. A match needs the postcode AND the description, or failing a description,
// exactly one unlinked hipages lead in that postcode and category.
function link() {
  let n = 0;
  for (const j of db.prepare("SELECT * FROM hip_jobs WHERE lead_id IS NULL AND created_at > datetime('now','-30 days')").all()) {
    const cands = db.prepare(`SELECT id, notes, job_type FROM leads WHERE lower(source)='hipages' AND hip_job_id IS NULL
      AND (suburb LIKE ? OR address LIKE ?)`).all('%' + j.postcode + '%', '%' + j.postcode + '%');
    const d = norm(j.description).slice(0, 60);
    // The customer's mobile, when the bot knows it (nightly sweep), settles it outright.
    const ph = digits(j.phone);
    let hit = ph.length === 9 ? db.prepare("SELECT id, notes, job_type, phone FROM leads WHERE lower(source)='hipages' AND hip_job_id IS NULL").all().filter(c => digits(c.phone) === ph) : [];
    if (hit.length !== 1) hit = d.length >= 12 ? cands.filter(c => norm(c.notes).includes(d)) : [];
    if (!hit.length && d.length < 12) hit = cands.filter(c => norm(c.job_type) === norm(j.category));
    if (hit.length !== 1) continue;
    db.prepare('UPDATE hip_jobs SET lead_id=? WHERE job_id=?').run(hit[0].id, j.job_id);
    let names = []; try { names = JSON.parse(j.names || '[]'); } catch (e) {}
    db.prepare('UPDATE leads SET hip_job_id=?, files_count=COALESCE(files_count,0)+? WHERE id=?').run(j.job_id, names.length, hit[0].id);
    console.log(`[files] hipages job ${j.job_id} linked to lead ${hit[0].id} (${names.length} photo(s))`); n++;
  }
  return n;
}

// Catch-up for leads that were in the tool before photos were sent: the bot asks, per
// portal job, whether any hipages lead here still without photos carries that description.
// Returns { wanted, have }: `have` is how many photos the tool already holds for that job,
// so the nightly sweep only sends when hipages now has more (the customer added some later).
function wanted(description) {
  const d = norm(description).slice(0, 60);
  if (d.length < 12) return { wanted: false, have: 0 };
  const rows = db.prepare(`SELECT notes, hip_job_id FROM leads WHERE lower(source)='hipages'
    AND (hip_job_id IS NULL OR created_at > datetime('now','-45 days'))`).all().filter(l => norm(l.notes).includes(d));
  if (!rows.length) return { wanted: false, have: 0 };
  if (rows.some(l => !l.hip_job_id)) return { wanted: true, have: 0 };
  let have = 0; try { have = JSON.parse((db.prepare('SELECT names FROM hip_jobs WHERE job_id=?').get(rows[0].hip_job_id) || {}).names || '[]').length; } catch (e) {}
  return { wanted: true, have };
}

async function ingestHip({ jobId, suburb, postcode, category, description, phone, index, mime, buf }) {
  if (!od.configured()) throw new Error('OneDrive is not configured');
  let j = db.prepare('SELECT * FROM hip_jobs WHERE job_id=?').get(jobId);
  if (!j) { db.prepare('INSERT INTO hip_jobs (job_id,suburb,postcode,category,description) VALUES (?,?,?,?,?)').run(jobId, suburb, postcode, category, description);
    j = db.prepare('SELECT * FROM hip_jobs WHERE job_id=?').get(jobId); }
  if (phone && !j.phone) { db.prepare('UPDATE hip_jobs SET phone=? WHERE job_id=?').run(phone, jobId); j.phone = phone; }
  if (!j.folder_id) { const f = await od.ensurePath([year(), `HIP-${jobId} — hipages — ${suburb} ${postcode}`]);
    db.prepare('UPDATE hip_jobs SET folder_id=? WHERE job_id=?').run(f.id, jobId); j.folder_id = f.id; }
  let names = []; try { names = JSON.parse(j.names || '[]'); } catch (e) {}
  const name = `hipages-${jobId}-${index}.${EXT[String(mime).toLowerCase()] || 'jpg'}`;
  if (names.includes(name)) { link(); return { ok: true, name, already: true }; }
  await od.putBytes(j.folder_id, name, buf);
  names.push(name); db.prepare('UPDATE hip_jobs SET names=? WHERE job_id=?').run(JSON.stringify(names), jobId);
  if (j.lead_id) db.prepare('UPDATE leads SET files_count=COALESCE(files_count,0)+1 WHERE id=?').run(j.lead_id); else link();
  return { ok: true, name };
}

module.exports = { ensureEnq, ensureRef, enqTick, startEnq, numberAll, list, session, owned, addBytes, setRev, leadOfQuote, revisionsFor, ingestHip, link, keyOk, kindOf, wanted };
