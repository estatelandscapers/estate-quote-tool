// ---------------------------------------------------------------------------
// Release archive — every deploy saves its own source code to OneDrive.
//
// The database is already backed up nightly; this is the other half of
// disaster recovery, the CODE that was running. On boot, if the running
// version (public/admin/sw.js VERSION) has not been archived yet, the app
// zips its own source — node_modules, .git and all databases excluded — and
// uploads it next to the data backups:
//
//     <releases folder>/<year>/estate-quote-tool-v20-2026-10-14.zip
//
// Version + ISO 8601 date (Sydney) in the name, so the folder reads as a
// version history. Keyed by version in settings: a crash-loop or redeploy of
// the same version uploads once, and the marker is only written AFTER a
// successful upload, so a boot without OneDrive credentials simply retries
// next time. Any failure is logged and never breaks boot.
//
// Folder: ONEDRIVE_RELEASE_PATH if set; otherwise a sibling of the backup
// folder ("Backups/Estate Tool Backups" -> "Backups/Estate Tool Releases").
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const od = require('./onedrive');
const { settingGet2, settingSet2 } = require('../db');

const APP_ROOT = path.join(__dirname, '..', '..');

function releaseFolder() {
  if (process.env.ONEDRIVE_RELEASE_PATH) return process.env.ONEDRIVE_RELEASE_PATH;
  const bk = process.env.ONEDRIVE_BACKUP_PATH || 'Estate Backups';
  const parent = bk.includes('/') ? bk.slice(0, bk.lastIndexOf('/')) : '';
  return parent ? `${parent}/Estate Tool Releases` : 'Estate Tool Releases';
}

function currentVersion() {
  try {
    const sw = fs.readFileSync(path.join(APP_ROOT, 'public', 'admin', 'sw.js'), 'utf8');
    const m = sw.match(/estate-(v\d+)/);
    if (m) return m[1];
  } catch (e) {}
  return 'v0';
}

function sydneyDate() {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Zip preferred (what gets pasted straight back into the repo on a restore);
// tar.gz when the container image has no zip binary. Store under the OS temp
// dir, never inside the app or the data volume.
function buildArchive(version) {
  const base = `estate-quote-tool-${version}-${sydneyDate()}`;
  const excludes = ['node_modules', '.git', 'data'];
  try {
    const out = path.join(os.tmpdir(), base + '.zip');
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, '.', ...excludes.flatMap(e => ['-x', `${e}/*`]), '-x', '*.db', '-x', '*.db-wal', '-x', '*.db-shm'],
      { cwd: APP_ROOT, stdio: 'pipe' });
    return { file: out, name: base + '.zip' };
  } catch (e) {
    // No zip binary on this image: plain tar (always present), gzipped with
    // Node's own zlib so the fallback depends on no external gzip either.
    const plain = path.join(os.tmpdir(), base + '.tar');
    const out = path.join(os.tmpdir(), base + '.tar.gz');
    fs.rmSync(plain, { force: true }); fs.rmSync(out, { force: true });
    execFileSync('tar', [...excludes.map(x => `--exclude=${x}`), '--exclude=*.db', '--exclude=*.db-wal', '--exclude=*.db-shm',
      '-cf', plain, '-C', APP_ROOT, '.'], { stdio: 'pipe' });
    fs.writeFileSync(out, require('zlib').gzipSync(fs.readFileSync(plain), { level: 6 }));
    fs.rmSync(plain, { force: true });
    return { file: out, name: base + '.tar.gz' };
  }
}

async function maybeArchive(reason) {
  const version = currentVersion();
  if (settingGet2('last_release_archived') === version) return { ok: true, skipped: 'already archived', version };
  if (!od.configured()) {
    console.log(`[release] ${version} not archived yet — OneDrive not configured, will retry next boot`);
    return { ok: false, error: 'OneDrive not configured', version };
  }
  const t0 = Date.now();
  const { file, name } = buildArchive(version);
  const year = sydneyDate().slice(0, 4);
  const remote = `${releaseFolder()}/${year}/${name}`;
  const { uploadResumable } = require('./backupOneDrive');
  const up = await uploadResumable(file, remote);
  fs.rmSync(file, { force: true });
  settingSet2('last_release_archived', version);
  const mb = ((up.size || 0) / 1e6).toFixed(1);
  console.log(`[release] archived ${name} to OneDrive (${mb} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s${reason ? ', ' + reason : ''})`);
  return { ok: true, version, name, remote, bytes: up.size || 0, webUrl: up.webUrl || null };
}

function start() {
  // Well after boot, so the first page load and the mail listener are never
  // waiting behind a source upload.
  setTimeout(() => maybeArchive('deploy').catch(e => console.error('[release] archive failed:', e.message)), 30000).unref();
}

module.exports = { start, maybeArchive, currentVersion, releaseFolder, buildArchive };
