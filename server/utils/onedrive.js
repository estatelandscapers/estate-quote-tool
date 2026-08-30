// OneDrive via Microsoft Graph (client credentials).
//
// Files go from the CLIENT'S BROWSER straight to OneDrive. Nothing is written to the
// Railway volume at any point. The server's only job is to create the destination folder
// and hand back a short-lived, pre-authorised upload URL per file; the browser then PUTs
// the bytes directly to Microsoft.
//
// Why it works this way: the volume also holds estate.db. Buffering client uploads there
// meant a single form post could write up to 1 GB before any spam check ran, and a full
// volume stops SQLite writing — taking the whole tool down, not just the enquiry form.
// No file on the volume, no such risk.
//
// The trade: there is no local buffer, so if Graph is unreachable the attachments fail at
// that moment. The enquiry and the lead are saved regardless — only the files are lost, and
// the client is told to email them instead.
//
// Railway env vars required to activate:
//   GRAPH_TENANT_ID     Azure tenant ID
//   GRAPH_CLIENT_ID     App registration (client) ID
//   GRAPH_CLIENT_SECRET Client secret VALUE
//   ONEDRIVE_USER       e.g. info@estatelandscapers.onmicrosoft.com
// Optional:
//   ONEDRIVE_ROOT       folder name, default "Estate Enquiries"

const ROOT = process.env.ONEDRIVE_ROOT || 'Estate Enquiries';

function configured() {
  return !!(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID &&
            process.env.GRAPH_CLIENT_SECRET && process.env.ONEDRIVE_USER);
}

// ---- token (cached until 5 min before expiry) --------------------------------
let TOKEN = null, TOKEN_EXP = 0;
async function token() {
  if (TOKEN && Date.now() < TOKEN_EXP - 300000) return TOKEN;
  const r = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph token: ${j.error_description || r.status}`);
  TOKEN = j.access_token; TOKEN_EXP = Date.now() + (j.expires_in * 1000);
  return TOKEN;
}

const drive = () => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.ONEDRIVE_USER)}/drive`;
// Encode each path segment but keep the separators — Graph addresses items by path.
const encPath = p => p.split('/').map(s => encodeURIComponent(s).replace(/'/g, '%27')).join('/');
// Characters OneDrive will not accept in a file or folder name.
const safeName = s => String(s || '').replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim();

async function gfetch(url, opts = {}) {
  const t = await token();
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph ${r.status}: ${(j.error && j.error.message) || url}`);
  return j;
}

// One folder per enquiry: "Estate Enquiries/2026/ENQ-2026-0001 — Jane Smith — Kellyville"
function folderNameFor(meta) {
  return `${meta.ref} — ${safeName(meta.name) || 'No name'} — ${safeName(meta.suburb) || 'No suburb'}`;
}
function folderPathFor(meta) {
  return `${ROOT}/${meta.year}/${folderNameFor(meta)}`;
}

// Create the enquiry folder (and the year folder above it). Returns its webUrl so the lead
// can carry a clickable link. conflictBehavior=replace is safe here: refs are unique.
async function ensureFolder(meta) {
  await gfetch(`${drive()}/root:/${encPath(ROOT)}:/children`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: String(meta.year), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  }).catch(() => {});           // already exists — fine
  const made = await gfetch(`${drive()}/root:/${encPath(`${ROOT}/${meta.year}`)}:/children`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderNameFor(meta), folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }),
  });
  return made.webUrl || '';
}

// A pre-authorised URL the BROWSER uploads to. It carries its own auth, so no Graph token
// is ever exposed to the client. Short-lived by design.
async function uploadUrlFor(meta, fileName) {
  const name = safeName(fileName) || 'file';
  const sess = await gfetch(`${drive()}/root:/${encPath(`${folderPathFor(meta)}/${name}`)}:/createUploadSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name } }),
  });
  return { name, uploadUrl: sess.uploadUrl, expires: sess.expirationDateTime || null };
}

// First-run check: proves token + drive access without uploading anything.
async function selfTest() {
  if (!configured()) return { ok: false, configured: false,
    hint: 'Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and ONEDRIVE_USER in Railway.' };
  const d = await gfetch(drive());
  return { ok: true, configured: true,
    driveOwner: d.owner && d.owner.user && d.owner.user.displayName,
    quotaUsedGB: d.quota ? (d.quota.used / 1e9).toFixed(1) : null,
    quotaTotalGB: d.quota ? (d.quota.total / 1e9).toFixed(1) : null };
}

// gfetch/drive/encPath are exported (as graphJson/driveRoot/encodePath) so the daily
// database backup can reuse this same app registration and token cache rather than
// carrying a second copy of the auth.
module.exports = { configured, ensureFolder, uploadUrlFor, folderPathFor, selfTest, ROOT,
  graphJson: gfetch, driveRoot: drive, encodePath: encPath };
