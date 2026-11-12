// Inventory proof-of-use photos.
//
// Every check-out and check-in carries a photo, so this is the highest-volume image
// source in the tool. None of it goes in the database and none of it stays on the
// Railway volume: the compressed photo is uploaded to OneDrive and the database keeps
// only its address, size and fingerprint. That is the lesson from the site plans, which
// took estate.db to 44 MB on eight quotes.
//
//   <ONEDRIVE_INVENTORY_PATH>/<SERIAL>/<SERIAL>-YYYYMMDD-HHMMSS-<kind>.jpg
//   default folder: "Estate Inventory"
//
// A usage entry is only saved AFTER its photo is safely in OneDrive. If OneDrive is not
// set up or refuses the file, the check-out fails with a clear message — the rule is
// "no photo, no usage", and a photo that was not stored is no photo.
//
// INVENTORY_PHOTOS_LOCAL=1 stores under DATA_DIR/inventory-photos instead. That exists
// for running the tool on a laptop without Graph credentials; it is not for production.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const od = require('./onedrive');

const ROOT = process.env.ONEDRIVE_INVENTORY_PATH || 'Estate Inventory';
const MAX_DIM = 1600;         // plenty to read a serial plate or see damage
const QUALITY = 80;
const MAX_BYTES = 12 * 1024 * 1024;
const LOCAL_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'inventory-photos');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.error('[inventory] sharp unavailable — photos stored as sent:', e.message); }

const localMode = () => process.env.INVENTORY_PHOTOS_LOCAL === '1';
function storageState() {
  if (od.configured()) return { ready: true, mode: 'onedrive', folder: ROOT };
  if (localMode()) return { ready: true, mode: 'local', folder: LOCAL_DIR };
  return { ready: false, mode: 'none',
    hint: 'Photo storage is not connected. Set the OneDrive (GRAPH_*) variables in Railway — usage cannot be logged without it.' };
}

function sydneyStamp(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}${p.month}${p.day}-${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`;
}

// Decode, validate and compress. Throws a message fit to show the user.
async function prepare(b64) {
  const input = Buffer.from(String(b64 || ''), 'base64');
  if (input.length < 2000) throw new Error('That photo is empty or unreadable — take it again.');
  if (input.length > MAX_BYTES) throw new Error('That photo is too large — take it again at normal quality.');
  // The fingerprint is of what the phone sent, so the same picture picked twice is
  // recognised even though the server re-encodes it.
  const sha256 = crypto.createHash('sha256').update(input).digest('hex');
  if (!sharp) return { buffer: input, mime: 'image/jpeg', sha256, width: null, height: null };
  let meta;
  try { meta = await sharp(input).metadata(); } catch (e) { throw new Error('That file is not a photo.'); }
  if (!meta.width || !meta.height) throw new Error('That file is not a photo.');
  const { data, info } = await sharp(input, { failOn: 'none' }).rotate()
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: data, mime: 'image/jpeg', sha256, width: info.width, height: info.height };
}

async function store({ serial, kind, buffer }) {
  const st = storageState();
  if (!st.ready) { const e = new Error(st.hint); e.status = 503; throw e; }
  const safe = od.safeName(serial).replace(/\s+/g, '-') || 'ITEM';
  const name = `${safe}-${sydneyStamp()}-${kind}.jpg`;
  if (st.mode === 'local') {
    const dir = path.join(LOCAL_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buffer);
    return { storage: 'local', odItemId: null, path: `${safe}/${name}`, webUrl: null, name };
  }
  const remote = `${ROOT}/${safe}/${name}`;
  // Simple upload: one PUT, creates the folders on the way. Photos are ~200 KB after
  // compression, far under the 4 MB ceiling for this call.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await od.graphRaw(`${od.driveRoot()}/root:/${od.encodePath(remote)}:/content?@microsoft.graph.conflictBehavior=rename`,
        { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: buffer });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`OneDrive ${r.status}: ${(j.error && j.error.message) || 'upload refused'}`);
      if (!j.id) throw new Error('OneDrive did not confirm the upload');
      if (j.size != null && j.size !== buffer.length) throw new Error('OneDrive stored a different size than was sent');
      return { storage: 'onedrive', odItemId: j.id, path: remote.replace(/\/[^/]+$/, '/') + (j.name || name), webUrl: j.webUrl || null, name: j.name || name };
    } catch (e) { lastErr = e; }
  }
  console.error('[inventory] photo upload failed:', lastErr && lastErr.message);
  const e = new Error('The photo could not be saved to OneDrive, so nothing was logged. Check your signal and try again.');
  e.status = 502; throw e;
}

// ---- reading back ------------------------------------------------------------
// Thumbnails are small and asked for constantly (every row of the list), so a modest
// in-memory cache saves a Graph round-trip each time. Lost on restart; that is fine.
const CACHE = new Map(); const CACHE_MAX = 400;
function cachePut(k, v) { CACHE.set(k, v); if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value); }

async function read(photo, size) {
  const thumb = size === 'thumb';
  const key = photo.id + (thumb ? ':t' : ':f');
  if (thumb && CACHE.has(key)) return CACHE.get(key);
  let buf = null;
  if (photo.storage === 'local') {
    buf = fs.readFileSync(path.join(LOCAL_DIR, photo.od_path));
  } else {
    const base = `${od.driveRoot()}/items/${encodeURIComponent(photo.od_item_id)}`;
    if (thumb) {
      // OneDrive makes its own thumbnails; they can lag a few seconds behind an upload.
      const t = await od.graphRaw(`${base}/thumbnails/0/large/content`).catch(() => null);
      if (t && t.ok) buf = Buffer.from(await t.arrayBuffer());
    }
    if (!buf) {
      const r = await od.graphRaw(`${base}/content`);
      if (!r.ok) { const e = new Error('Photo not available from OneDrive (' + r.status + ')'); e.status = r.status === 404 ? 404 : 502; throw e; }
      buf = Buffer.from(await r.arrayBuffer());
    }
  }
  if (thumb && sharp && buf.length > 60000) {
    try { buf = await sharp(buf).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer(); } catch (e) {}
  }
  const out = { buffer: buf, mime: 'image/jpeg' };
  if (thumb) cachePut(key, out);
  return out;
}

module.exports = { prepare, store, read, storageState, ROOT };
