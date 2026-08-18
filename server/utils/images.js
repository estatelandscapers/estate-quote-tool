// Every image the tool stores goes through here first.
//
// Site plans and drawings arrive as 4–8 MB phone photos. Stored raw as base64 they are
// a third larger again, which is how the database reached 44 MB on eight quotes. A site
// plan never needs more than about 2000px — beyond that the extra pixels are invisible
// on screen and on the printed contract, but they cost real money in storage, backup
// time and memory on every page load.
//
// Quality is deliberately high (82) and resizing never enlarges. A drawing that is
// already small passes through untouched.
const MAX_DIM = 2000;        // longest edge
const QUALITY = 82;          // visually lossless for photos and scans at this size
const PNG_QUALITY = [70, 90];

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.error('[img] sharp unavailable — images stored as-is:', e.message); }

const isImage = mime => /^image\/(jpe?g|png|webp|tiff|heic|heif)$/i.test(String(mime || ''));

// Returns { data, mime, before, after, skipped } — data is base64, ready to store.
async function compressBase64(b64, mime) {
  const before = Math.round((String(b64 || '').length * 3) / 4);
  if (!sharp || !b64) return { data: b64, mime, before, after: before, skipped: 'no-sharp' };
  // PDFs and SVGs are left alone — they're already compact and rasterising loses detail.
  if (!isImage(mime)) return { data: b64, mime, before, after: before, skipped: 'not-an-image' };

  try {
    const input = Buffer.from(b64, 'base64');
    const meta = await sharp(input).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);

    let pipeline = sharp(input, { failOn: 'none' }).rotate();   // honour EXIF orientation
    if (longest > MAX_DIM) pipeline = pipeline.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });

    // Keep PNG for line drawings and anything with transparency — re-encoding a plan as
    // JPEG puts halos around the lines. Photographs become JPEG.
    const keepPng = /png/i.test(mime) && (meta.hasAlpha || (meta.channels && meta.channels < 3));
    let out, outMime;
    if (keepPng) {
      out = await pipeline.png({ quality: PNG_QUALITY[1], compressionLevel: 9, palette: true }).toBuffer();
      outMime = 'image/png';
    } else {
      out = await pipeline.jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
      outMime = 'image/jpeg';
    }

    // Never make a file bigger. Small or already-optimised images pass straight through.
    if (out.length >= input.length) return { data: b64, mime, before, after: before, skipped: 'already-small' };

    return { data: out.toString('base64'), mime: outMime, before, after: out.length,
      width: Math.min(longest, MAX_DIM) || null };
  } catch (e) {
    console.error('[img] compression failed, storing original:', e.message);
    return { data: b64, mime, before, after: before, skipped: 'error' };
  }
}

const kb = n => Math.round(n / 1024);

// One-off pass over everything already stored.
async function compressExisting({ db, limit = 500 } = {}) {
  const targets = [
    { table: 'quotes', col: 'siteplan_data', mimeCol: 'siteplan_mime' },
    { table: 'purchase_orders', col: 'siteplan_data', mimeCol: 'siteplan_mime' },
  ];
  const report = { rows: 0, before: 0, after: 0, skipped: 0, details: [] };
  for (const t of targets) {
    let rows = [];
    try {
      rows = db.prepare(`SELECT id, ${t.col} AS data, ${t.mimeCol} AS mime FROM ${t.table}
        WHERE ${t.col} IS NOT NULL AND LENGTH(${t.col}) > 40000 LIMIT ?`).all(limit);
    } catch (e) { continue; }
    for (const r of rows) {
      const res = await compressBase64(r.data, r.mime);
      report.rows++;
      report.before += res.before;
      report.after += res.after;
      if (res.skipped) { report.skipped++; continue; }
      db.prepare(`UPDATE ${t.table} SET ${t.col}=?, ${t.mimeCol}=? WHERE id=?`).run(res.data, res.mime, r.id);
      report.details.push(`${t.table} ${r.id.slice(0, 8)}: ${kb(res.before)}KB → ${kb(res.after)}KB`);
    }
  }
  report.savedMB = Math.round((report.before - report.after) / 104857.6) / 10;
  return report;
}

module.exports = { compressBase64, compressExisting, isImage, MAX_DIM, QUALITY };
