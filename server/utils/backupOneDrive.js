// Daily database backup to OneDrive via Microsoft Graph.
//
// Reuses the app registration already wired up for enquiry attachments — same token, same
// drive, no second credential to manage. See utils/onedrive.js for the auth.
//
// Why the server pushes rather than something pulling /api/backup on a schedule:
//   - Railway is always on, so a backup can't be missed because a laptop was shut.
//   - The backup key stops being part of a daily routine, so it isn't sitting in a
//     third-party automation or getting written into proxy logs.
//
// The snapshot is taken with VACUUM INTO, NOT a file copy. Copying estate.db while writes
// are in flight can miss whatever is still in the -wal file and produce a backup that opens
// cleanly but is quietly short of data. VACUUM INTO writes a consistent point-in-time file.
//
// Uploaded with a resumable session in 5 MiB chunks. The simple Graph upload caps at 4 MB
// and the database is already past that — most of it site plan photos stored as base64
// inside the tables, which grows every time a photo is added.
//
// Railway env vars (all optional — the job stays dormant unless ONEDRIVE_BACKUP=1):
//   ONEDRIVE_BACKUP=1          turn the daily job on
//   ONEDRIVE_BACKUP_PATH       folder, default "Estate Backups"
//   ONEDRIVE_BACKUP_HOUR       local hour to run, default 2 (2am Sydney)
//   BACKUP_ALERT_TO            email address for failure alerts
//   ONEDRIVE_BACKUP_KEEP_DAYS  if set, delete backups older than N days. UNSET = keep
//                              everything, which is the documented preference.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const od = require('./onedrive');

const FOLDER = process.env.ONEDRIVE_BACKUP_PATH || 'Estate Backups';
const CHUNK = 5 * 1024 * 1024;            // 5 MiB — must be a multiple of 320 KiB per Graph
const enabled = () => process.env.ONEDRIVE_BACKUP === '1' && od.configured();

// Sydney-local timestamp, so a backup named ...-02-00 is 2am the way Smit reads a clock,
// not 2am UTC. Railway containers run in UTC.
function stamp(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}-${p.minute}`, year: p.year };
}

// Consistent snapshot on local disk. Caller must delete it.
function snapshot() {
  const { db } = require('../db');
  const file = path.join(os.tmpdir(), `estate-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

// Row counts from the SNAPSHOT, not the live database — this verifies what was actually
// captured. A 5 MB file that opens fine but holds zero quotes is the failure you don't
// notice for six months, so it is checked before the upload is called a success.
function verify(file) {
  const { DatabaseSync } = require('node:sqlite');
  const s = new DatabaseSync(file, { readOnly: true });
  const out = {};
  for (const t of ['quotes', 'quote_items', 'price_items', 'leads', 'materials', 'vendors']) {
    try { out[t] = s.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { out[t] = null; }
  }
  try { s.close(); } catch (e) {}
  return out;
}

async function uploadResumable(localFile, remotePath) {
  const size = fs.statSync(localFile).size;
  const sess = await od.graphJson(
    `${od.driveRoot()}/root:/${od.encodePath(remotePath)}:/createUploadSession`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
  if (!sess.uploadUrl) throw new Error('Graph did not return an upload URL');

  const fd = fs.openSync(localFile, 'r');
  try {
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(start + CHUNK, size) - 1;
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      // The upload URL carries its own auth — deliberately no bearer token here.
      const r = await fetch(sess.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: buf,
      });
      if (!r.ok && r.status !== 202) {
        const t = await r.text().catch(() => '');
        throw new Error(`chunk ${start}-${end} failed: ${r.status} ${t.slice(0, 200)}`);
      }
      if (r.status === 200 || r.status === 201) return await r.json().catch(() => ({}));
    }
  } finally { fs.closeSync(fd); }
  return {};
}

// Only ever runs if ONEDRIVE_BACKUP_KEEP_DAYS is set. Left unset the tool deletes nothing,
// which matches the standing decision that backups are kept forever.
async function prune() {
  const days = parseInt(process.env.ONEDRIVE_BACKUP_KEEP_DAYS || '', 10);
  if (!days || days < 7) return { pruned: 0, skipped: true };
  const cutoff = Date.now() - days * 864e5;
  const list = await od.graphJson(`${od.driveRoot()}/root:/${od.encodePath(FOLDER)}:/children?$top=999`);
  let pruned = 0;
  for (const item of (list.value || [])) {
    if (!/^estate-backup-.*\.db$/.test(item.name || '')) continue;   // never touch other files
    if (new Date(item.createdDateTime).getTime() >= cutoff) continue;
    await od.graphJson(`${od.driveRoot()}/items/${item.id}`, { method: 'DELETE' }).catch(() => {});
    pruned++;
  }
  return { pruned, skipped: false };
}

async function runBackup(reason = 'scheduled') {
  if (!od.configured()) return { ok: false, error: 'OneDrive is not configured' };
  const t0 = Date.now();
  const s = stamp();
  const name = `estate-backup-${s.date}-${s.time}.db`;
  const remote = `${FOLDER}/${s.year}/${name}`;
  let local = null;
  try {
    local = snapshot();
    const bytes = fs.statSync(local).size;
    const counts = verify(local);
    if (!counts.quotes) throw new Error('snapshot verified empty — no quotes found, refusing to call this a backup');
    const up = await uploadResumable(local, remote);
    const pruneRes = await prune().catch(() => ({ pruned: 0 }));
    const res = { ok: true, name, remote, bytes, counts, reason,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      webUrl: up.webUrl || null, pruned: pruneRes.pruned || 0 };
    console.log(`[backup] uploaded ${name} (${(bytes / 1e6).toFixed(1)} MB, ${counts.quotes} quotes, ${res.seconds}s)`);
    return res;
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    await alert(`Estate Landscapers backup FAILED`,
      `<p>The daily OneDrive backup did not complete.</p>
       <p><b>When:</b> ${s.date} ${s.time} (Sydney)<br><b>Error:</b> ${String(e.message).replace(/[<>]/g, '')}</p>
       <p>The tool is unaffected and still running. Nothing has been deleted.</p>`).catch(() => {});
    return { ok: false, error: e.message, reason };
  } finally {
    if (local) fs.unlink(local, () => {});
  }
}

async function alert(subject, html) {
  const to = process.env.BACKUP_ALERT_TO;
  if (!to) return;
  const { sendMail } = require('./email');
  await sendMail({ to, subject, html });
}

// ---- schedule ----------------------------------------------------------------
// Checked every 15 minutes rather than with a 24-hour timer: Railway restarts on every
// deploy, and a long timer would be cancelled by each one, so a day with several deploys
// could quietly never back up.
let lastRunDate = null;
function start() {
  if (!enabled()) {
    console.log('[backup] daily OneDrive backup is off (set ONEDRIVE_BACKUP=1 to enable)');
    return;
  }
  const hour = Math.max(0, Math.min(23, parseInt(process.env.ONEDRIVE_BACKUP_HOUR || '2', 10)));
  console.log(`[backup] daily OneDrive backup on — ${hour}:00 Australia/Sydney, folder "${FOLDER}"`);
  const tick = async () => {
    const s = stamp();
    const nowHour = parseInt(s.time.split('-')[0], 10);
    if (lastRunDate === s.date || nowHour < hour) return;
    lastRunDate = s.date;
    await runBackup('scheduled');
  };
  setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 60 * 1000);        // also check a minute after boot
}

module.exports = { runBackup, start, enabled, FOLDER };
