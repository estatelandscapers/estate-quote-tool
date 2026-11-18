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
  const r = await fetch(`${process.env.GRAPH_LOGIN_URL || 'https://login.microsoftonline.com'}/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
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

const drive = () => `${process.env.GRAPH_API_URL || 'https://graph.microsoft.com/v1.0'}/users/${encodeURIComponent(process.env.ONEDRIVE_USER)}/drive`;
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

// Same token and app registration, but hands back the raw Response — for file bytes
// (inventory photos) where the body is an image, not JSON.
async function graphRaw(url, opts = {}) {
  const t = await token();
  return fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
}

// One folder per enquiry: "Estate Enquiries/2026/ENQ-2026-0001 — Jane Smith — Kellyville"
function folderNameFor(meta) {
  return `${meta.ref} — ${safeName(meta.name) || 'No name'} — ${safeName(meta.suburb) || 'No suburb'}`;
}
function folderPathFor(meta) {
  return `${ROOT}/${meta.year}/${folderNameFor(meta)}`;
}

// Create the enquiry folder (and the year folder above it). Returns its webUrl so the lead
// can carry a clickable link. 
async function ensureFolder(meta) {
  await gfetch(`${drive()}/root:/${encPath(ROOT)}:/children`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: String(meta.year), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  }).catch(() => {});           // already exists — fine
  // Never 'replace': from v55 the folder may already exist with sub-folders and files in it
  // (every lead gets one). Create it if missing, otherwise use the one that is there.
  const made = await gfetch(`${drive()}/root:/${encPath(`${ROOT}/${meta.year}`)}:/children`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderNameFor(meta), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  }).catch(() => null);
  if (made && made.id) return made.webUrl || '';
  const have = await folderByPath(folderPathFor(meta));
  if (!have) throw new Error('could not create the enquiry folder');
  return have.webUrl || '';
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
// What is ACTUALLY in the enquiry folder. The browser uploads straight to Microsoft, so
// its report is the only thing the server would otherwise have — and a browser that closed
// mid-upload, or mispaired a file with someone else's upload session, reports success it
// cannot vouch for. This asks Graph directly and is the difference between "the client says
// it worked" and "the file is there".
async function listFolder(meta) {
  try {
    const r = await gfetch(`${drive()}/root:/${encPath(folderPathFor(meta))}:/children?$top=200&$select=name,size`);
    return (r.value || []).map(x => ({ name: x.name, size: x.size || 0 }));
  } catch (e) {
    if (/ 404/.test(e.message)) return [];      // folder never created — nothing landed
    throw e;
  }
}

// ---- v52: lead files shown inside the tool ------------------------------------
// Everything below addresses folders and files by their OneDrive ID, so a folder renamed
// or moved by hand in OneDrive still belongs to its lead.
async function folderByPath(path) {
  try { const r = await gfetch(`${drive()}/root:/${encPath(path)}?$select=id,webUrl,folder`); return r.id ? { id: r.id, webUrl: r.webUrl || '' } : null; }
  catch (e) { if (/ 404/.test(e.message)) return null; throw e; }
}
// Make (or find) a folder under the root, one level at a time. Returns { id, webUrl }.
async function ensurePath(segments) {
  let path = ROOT, last = null;
  for (const seg of segments.map(safeName).filter(Boolean)) {
    last = await gfetch(`${drive()}/root:/${encPath(path)}:/children`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    }).catch(() => null);
    path += '/' + seg;
    if (!last) last = await folderByPath(path);
  }
  if (!last || !last.id) throw new Error('could not create the OneDrive folder');
  return { id: last.id, webUrl: last.webUrl || '' };
}
async function childrenOf(folderId) {
  const out = []; let url = `${drive()}/items/${folderId}/children?$top=200&$select=id,name,size,file,folder,createdDateTime,webUrl&$expand=thumbnails($select=medium)`;
  for (let i = 0; url && i < 5; i++) { const r = await gfetch(url); out.push(...(r.value || [])); url = r['@odata.nextLink'] || null; }
  return out.filter(x => !x.folder && (x.size || 0) > 0).map(x => ({
    id: x.id, name: x.name, size: x.size || 0, mime: (x.file && x.file.mimeType) || '', created: x.createdDateTime || '',
    thumb: !!(x.thumbnails && x.thumbnails[0] && x.thumbnails[0].medium) }));
}
async function itemMeta(id) { return gfetch(`${drive()}/items/${id}?$select=id,name,size,file,parentReference`); }
async function sessionIn(folderId, fileName) {
  const name = safeName(fileName) || 'file';
  const sess = await gfetch(`${drive()}/items/${folderId}:/${encPath(name)}:/createUploadSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name } }),
  });
  return { name, uploadUrl: sess.uploadUrl };
}
// Server-side upload of bytes already in memory (hipages photos pushed by the bot).
// Nothing touches the volume. Chunks are multiples of 320 KiB, as Graph requires.
async function putBytes(folderId, fileName, buf) {
  const { uploadUrl, name } = await sessionIn(folderId, fileName);
  const CH = 327680 * 16; let last = null;
  for (let o = 0; o < buf.length; o += CH) {
    const part = buf.subarray(o, Math.min(buf.length, o + CH));
    const r = await fetch(uploadUrl, { method: 'PUT', body: part,
      headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${o}-${o + part.length - 1}/${buf.length}` } });
    if (!r.ok) throw new Error('OneDrive upload failed: ' + r.status);
    last = await r.json().catch(() => ({}));
  }
  return { id: last && last.id, name: (last && last.name) || name };
}
// ---- v55: one ENQ folder per enquiry, with standard sub-folders -------------------
async function childFolders(folderId) {
  const r = await gfetch(`${drive()}/items/${folderId}/children?$top=200&$select=id,name,folder,webUrl`);
  return (r.value || []).filter(x => x.folder).map(x => ({ id: x.id, name: x.name, webUrl: x.webUrl || '' }));
}
// Find or make a folder directly under a folder we hold by ID.
async function ensureChild(parentId, name) {
  const nm = safeName(name);
  const made = await gfetch(`${drive()}/items/${parentId}/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nm, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }).catch(() => null);
  if (made && made.id) return { id: made.id, webUrl: made.webUrl || '' };
  const hit = (await childFolders(parentId)).find(x => x.name.toLowerCase() === nm.toLowerCase());
  if (!hit) throw new Error('could not create the folder ' + nm);
  return hit;
}
// Move a file or folder under another folder. A name already taken there is kept apart.
async function moveItem(id, parentId) {
  return gfetch(`${drive()}/items/${id}?@microsoft.graph.conflictBehavior=rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: parentId } }) });
}
async function itemInfo(id) { return gfetch(`${drive()}/items/${id}?$select=id,name,webUrl,parentReference`); }
async function removeItem(id) { const r = await graphRaw(`${drive()}/items/${id}`, { method: 'DELETE' }); if (!r.ok && r.status !== 404) throw new Error('OneDrive delete failed: ' + r.status); }
const contentOf = id => graphRaw(`${drive()}/items/${id}/content`);
const thumbOf = id => graphRaw(`${drive()}/items/${id}/thumbnails/0/medium/content`);

module.exports = { configured, ensureFolder, uploadUrlFor, folderPathFor, listFolder, selfTest, ROOT,
  folderByPath, ensurePath, childrenOf, childFolders, ensureChild, moveItem, itemInfo, itemMeta, sessionIn, putBytes, removeItem, contentOf, thumbOf,
  graphJson: gfetch, graphRaw, safeName, driveRoot: drive, encodePath: encPath };
