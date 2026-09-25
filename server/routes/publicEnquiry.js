// Public enquiry endpoint for the Estate website — the ONE integration point.
//
// Two steps, because attachments go from the browser STRAIGHT to OneDrive and never touch
// this server or the Railway volume:
//
//   1. POST /api/public/enquiry            (JSON)
//      Validates, creates the lead, creates the OneDrive folder, and returns one
//      pre-authorised uploadUrl per declared file.
//   2. Browser PUTs each file to its uploadUrl (Microsoft, direct), then
//      POST /api/public/enquiry/:ref/complete  to report what landed.
//
// The lead is created in step 1 and is never rolled back. If OneDrive is down, the enquiry
// is still captured — only the attachments are lost, and the caller is told to email them.
//
// Spam handling: honeypot field `website` must stay empty; 5 submissions per IP per hour;
// CORS locked to SITE_ORIGIN. All of it runs BEFORE any upload URL is issued, so a bot
// cannot cause a single byte to be written anywhere.

const express = require('express');
const { db, settingGet, settingSet } = require('../db');
const { newId, newToken } = require('../utils/ids');
const { sendMail } = require('../utils/email');
const onedrive = require('../utils/onedrive');

const router = express.Router();

const MAX_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ALLOWED = /\.(pdf|zip|jpe?g|png|heic|heif|webp|dwg|docx?|xlsx?)$/i;

// ---- CORS (before everything, including preflight) ---------------------------
function origins() {
  return (process.env.SITE_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
}
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && origins().includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- rate limit: 5 per IP per hour ------------------------------------------
const HITS = new Map();
function limited(ip) {
  const now = Date.now(), windowMs = 60 * 60 * 1000;
  const arr = (HITS.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= 5) { HITS.set(ip, arr); return true; }
  arr.push(now); HITS.set(ip, arr); return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of HITS) { const a = v.filter(t => now - t < 3600000); a.length ? HITS.set(k, a) : HITS.delete(k); }
}, 10 * 60 * 1000).unref();

// ---- reference numbers: ENQ-YYYY-MMNN (NN resets monthly, grows past 99) ----
// Sydney time, not server time: Railway runs UTC, so without this the month would roll
// over at 10 or 11 am on the 1st and the first morning's enquiries would be numbered into
// the previous month. The old yearly counter (enquiry_seq_2026) is simply no longer read.
function sydneyParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { year: p.year, month: p.month, day: p.day, ymd: `${p.year}-${p.month}-${p.day}` };
}
function nextRef() {
  const { year, month } = sydneyParts();
  const key = `enquiry_seq_${year}${month}`;
  const n = (parseInt(settingGet(key) || '0', 10) || 0) + 1;
  settingSet(key, String(n));
  return `ENQ-${year}-${month}${String(n).padStart(2, '0')}`;
}

const clean = (s, max = 300) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

router.post('/enquiry', async (req, res) => {
  try {
    const b = req.body || {};
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // Honeypot: bots fill every field. Accept, discard, tell them nothing.
    if (clean(b.website)) return res.json({ ok: true, ref: null, uploads: [] });
    if (limited(ip)) return res.status(429).json({ error: 'Too many submissions — please try again later, or email enquiry@estatelandscapers.com.au.' });

    const name = clean(b.name, 120), email = clean(b.email, 160), phone = clean(b.phone, 40);
    if (!name || (!email && !phone)) return res.status(400).json({ error: 'A name plus an email or phone number is required.' });

    // Declared files — validated before any upload URL exists. Sizes are the browser's word,
    // but that costs us nothing now: no byte is written here, and OneDrive enforces its own.
    const declared = Array.isArray(b.files) ? b.files.slice(0, MAX_FILES + 1) : [];
    if (declared.length > MAX_FILES) return res.status(400).json({ error: `Up to ${MAX_FILES} files, please. Email the rest through.` });
    for (const f of declared) {
      if (!ALLOWED.test(String(f && f.name || ''))) return res.status(400).json({ error: `That file type isn't accepted: ${clean(f && f.name, 60)}` });
      if (Number(f.size) > MAX_FILE_BYTES) return res.status(400).json({ error: `${clean(f.name, 60)} is over 50 MB.` });
    }
    const total = declared.reduce((s, f) => s + (Number(f.size) || 0), 0);
    if (total > MAX_TOTAL_BYTES) return res.status(400).json({ error: 'Files total more than 100 MB. Remove some and try again, or email the rest through.' });

    const audience = b.audience === 'commercial' ? 'commercial' : 'residential';
    const suburb = clean(b.suburb, 80), address = clean(b.address, 200);
    const jobType = clean(b.jobType, 120), budget = clean(b.budget, 60),
          timeline = clean(b.timeline, 80), company = clean(b.company, 140),
          message = String(b.message || '').trim().slice(0, 4000),
          page = clean(b.page, 300);
    let utm = {};
    try { utm = typeof b.utm === 'string' ? JSON.parse(b.utm || '{}') : (b.utm || {}); } catch (e) {}
    const utmLine = ['source', 'medium', 'campaign', 'term', 'content']
      .map(k => utm['utm_' + k] ? `${k}=${clean(utm['utm_' + k], 60)}` : null).filter(Boolean).join(' ');

    // The website marks under-$25k budgets two ways: a structured field, and a first line
    // in the message. Either is enough, so nothing is missed if one side ships first.
    const smallProject = b.smallProject === true || b.smallProject === 'true' || /^\s*SMALL PROJECT/i.test(message);

    const ref = nextRef();
    const id = newId();
    // Folder year comes from the ref itself, so ref and OneDrive folder can never disagree
    // (the server clock is UTC and would file New Year's Day morning under the old year).
    const year = ref.slice(4, 8);
    const meta = { ref, name, suburb, year, leadId: id };

    const noteLines = [
      `${ref} · ${audience.toUpperCase()} enquiry via website form`,
      company ? `Company: ${company}` : null,
      jobType ? `Job type: ${jobType}` : null,
      budget ? `Budget: ${budget}` : null,
      timeline ? `Timeline: ${timeline}` : null,
      declared.length ? `Files: ${declared.length} (${(total / 1e6).toFixed(1)} MB) → OneDrive` : 'Files: none',
      page ? `Landing page: ${page}` : null,
      utmLine ? `Campaign: ${utmLine}` : null,
      message ? `— Message —\n${message}` : null,
    ].filter(Boolean).join('\n');

    // `_prefill` populates the pre-call checklist — same shape the email ingest uses. It is
    // NOT a call answer: derivedStage() ignores it, so this lead correctly sits on Step 1
    // until someone actually runs the discovery call.
    const prefill = { _prefill: {
      source: 'Our website', name, phone, email, suburb, address,
      job_type: jobType, budget, timeline, enquiry_ref: ref, audience, confirmed: {},
    } };

    db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb,call_answers,docs_channel)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, phone, email, address, 'Our website', noteLines, 'New', 'call1',
        sydneyParts().ymd, jobType, suburb, JSON.stringify(prefill), 'website');   // call them today, Sydney date
    if (smallProject) db.prepare('UPDATE leads SET small_project=1 WHERE id=?').run(id);

    // The completion callback is authenticated by this token, not by the reference. Refs are
    // sequential and therefore guessable; without a secret, anyone could post file names into
    // any lead's notes.
    const completeToken = newToken();
    db.prepare('UPDATE leads SET enquiry_ref=?, enquiry_token=?, enquiry_files=? WHERE id=?')
      .run(ref, completeToken, JSON.stringify({
        declared: declared.map(f => f.name), meta, email: email || '', name, audience,
      }), id);

    // Upload URLs — best effort. A OneDrive outage must never cost us the enquiry itself.
    let uploads = [], folderUrl = '', filesOk = true;
    if (declared.length && onedrive.configured()) {
      try {
        folderUrl = await onedrive.ensureFolder(meta);
        for (const f of declared) uploads.push(await onedrive.uploadUrlFor(meta, f.name));
        if (folderUrl) db.prepare("UPDATE leads SET notes=?, updated_at=datetime('now') WHERE id=?")
          .run(noteLines + '\nOneDrive: ' + folderUrl, id);
      } catch (e) {
        filesOk = false; uploads = [];
        console.log(`[enquiry] ${ref} OneDrive unavailable: ${e.message}`);
        db.prepare("UPDATE leads SET notes=?, updated_at=datetime('now') WHERE id=?")
          .run(noteLines + '\n⚠ Files could NOT be sent to OneDrive — ask the client to email them.', id);
      }
    } else if (declared.length) {
      filesOk = false;
      console.log(`[enquiry] ${ref} has ${declared.length} files but OneDrive is not configured`);
      db.prepare("UPDATE leads SET notes=?, updated_at=datetime('now') WHERE id=?")
        .run(noteLines + '\n⚠ OneDrive not configured — files were not received.', id);
    }

    // The acknowledgement names the files, so it has to wait until we know which ones
    // actually arrived. With no files there is nothing to wait for. With files, it is sent
    // by the reconciliation below — plus a fallback if the browser never reports back
    // (tab closed, connection dropped), so a client is never left without a reply.
    if (email && !declared.length) sendAck({ email, name, ref, audience, files: [], missing: [] });
    if (email && declared.length) scheduleFallbackAck(ref);

    console.log(`[enquiry] ${ref} lead ${id} (${audience}) files=${declared.length} onedrive=${filesOk}`);
    res.status(201).json({
      ok: true, ref, completeToken, uploads,
      filesAccepted: filesOk,
      message: filesOk ? null : 'Your enquiry is in. We could not attach your files — please email them to enquiry@estatelandscapers.com.au quoting ' + ref + '.',
    });
  } catch (e) {
    console.log('[enquiry] error:', e.message);
    res.status(500).json({ error: 'Something went wrong on our side. Please email enquiry@estatelandscapers.com.au.' });
  }
});

// Step 2: the browser reports which direct uploads landed. Advisory only — the lead already
// exists, so a client who closes the tab mid-upload still reaches us.
//
// This writes into lead notes from an UNAUTHENTICATED caller, so it is locked down hard:
//   · ref must match ENQ-YYYY-MMNN (4 to 6 digits) — a bare '%' previously slipped into a
//     `notes LIKE ref||'%'` lookup and matched the newest lead, letting a stranger append
//     arbitrary lines to a real customer's notes
//   · lookup is an exact column match, not LIKE, so wildcards mean nothing
//   · a token issued at submission is required — refs are sequential and guessable
//   · same 5/hr per-IP limit as submission
//   · at most 20 names per list, so one call can't paste an essay into the notes
//   · single use — once completed the callback is ignored
// Every rejection returns the same {ok:true}: a public endpoint should not confirm which
// references exist.
router.post('/enquiry/:ref/complete', (req, res) => {
  const ok = () => res.json({ ok: true });
  const ref = clean(req.params.ref, 20);
  // MMNN (4 digits), or MMNNN+ (5 or 6) once a month passes 99. Old ENQ-YYYY-NNNN refs
  // still match, so enquiries mid-upload across the deploy are not dropped.
  if (!/^ENQ-\d{4}-\d{4,6}$/.test(ref)) return ok();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return ok();

  const b = req.body || {};
  const token = clean(b.completeToken, 64);
  if (!token) return ok();
  const lead = db.prepare('SELECT id, notes, enquiry_token, enquiry_completed FROM leads WHERE enquiry_ref=?').get(ref);
  if (!lead || !lead.enquiry_token || lead.enquiry_token !== token) return ok();
  if (lead.enquiry_completed) return ok();

  const names = v => (Array.isArray(v) ? v.slice(0, MAX_FILES) : []).map(n => clean(n, 140)).filter(Boolean);
  db.prepare("UPDATE leads SET enquiry_completed=1, updated_at=datetime('now') WHERE id=?").run(lead.id);
  reconcile(ref, names(b.uploaded), names(b.failed)).catch(e =>
    console.log(`[enquiry] ${ref} reconcile failed: ${e.message}`));
  ok();
});

// Compare what was DECLARED against what OneDrive actually holds, and record the truth.
//
// The browser's report is a claim, not evidence: it uploads directly to Microsoft, so a
// mispaired upload session or a tab closed mid-transfer can report success for a file that
// is not there. Asking Graph is what turns a silent loss into a visible one.
async function reconcile(ref, reportedOk = [], reportedBad = []) {
  const lead = db.prepare('SELECT id, notes, enquiry_files FROM leads WHERE enquiry_ref=?').get(ref);
  if (!lead || !lead.enquiry_files) return;
  let info = {};
  try { info = JSON.parse(lead.enquiry_files) || {}; } catch (e) { return; }
  const declared = info.declared || [];
  if (info.acked) return;                        // one acknowledgement only

  let actual = [];
  let checked = false;
  if (onedrive.configured() && declared.length) {
    try { actual = await onedrive.listFolder(info.meta); checked = true; } catch (e) {
      console.log(`[enquiry] ${ref} could not list OneDrive: ${e.message}`);
    }
  }
  // Match on the SANITISED name, since that is what OneDrive stores. Graph's
  // conflictBehavior=rename can also append " 1", so compare on the stem.
  const stem = s => String(s).replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const there = new Set(actual.map(a => stem(a.name)));
  const landed = checked ? declared.filter(d => there.has(stem(d))) : reportedOk;
  const missing = checked ? declared.filter(d => !there.has(stem(d)))
                          : declared.filter(d => !reportedOk.includes(d));
  // A zero-byte file in OneDrive is a failed upload, not a file.
  const empty = actual.filter(a => !a.size).map(a => a.name);

  const lines = [
    landed.length ? `Files received (${landed.length}): ${landed.join(', ')}` : null,
    missing.length ? `⚠ MISSING (${missing.length}): ${missing.join(', ')} — not in OneDrive. Ask the client to email these, quoting ${ref}.` : null,
    empty.length ? `⚠ Empty (0 bytes): ${empty.join(', ')} — upload did not complete.` : null,
    checked ? null : 'Note: OneDrive could not be checked; the list above is what the browser reported.',
  ].filter(Boolean).join('\n');
  if (lines) db.prepare("UPDATE leads SET notes=?, updated_at=datetime('now') WHERE id=?")
    .run((lead.notes || '') + '\n' + lines, lead.id);

  if (missing.length || empty.length) {
    const to = process.env.ENQUIRY_ALERT_TO || process.env.BACKUP_ALERT_TO;
    if (to) sendMail({ to, subject: `Enquiry ${ref} — ${missing.length + empty.length} file(s) did not arrive`,
      html: `<p>Enquiry <b>${ref}</b> declared ${declared.length} file(s); ${landed.length} are in OneDrive.</p>
             <p><b>Missing:</b> ${[...missing, ...empty].join(', ') || 'none'}</p>
             <p>The lead notes carry the same detail. The client has been asked to email these through.</p>`,
    }).catch(() => {});
  }

  info.acked = true; info.landed = landed; info.missing = missing;
  db.prepare('UPDATE leads SET enquiry_files=? WHERE id=?').run(JSON.stringify(info), lead.id);
  if (info.email) sendAck({ email: info.email, name: info.name, ref, audience: info.audience,
    files: landed, missing: [...missing, ...empty] });
}

// If the browser never calls back, reconcile anyway. Otherwise a client whose tab closed
// mid-upload gets no acknowledgement at all.
function scheduleFallbackAck(ref) {
  setTimeout(() => { reconcile(ref).catch(() => {}); }, 10 * 60 * 1000).unref();
}

// Sent once, after we know what actually reached OneDrive — never before. The old version
// went out at submission time saying files "have been received safely", which was a claim
// the server had no way to stand behind: the browser had not finished uploading yet.
function sendAck({ email, name, ref, audience, files = [], missing = [] }) {
  const first = String(name || '').split(' ')[0] || 'there';
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const list = files.length
    ? `<p><b>Files received:</b></p><ul style="margin:6px 0 10px;padding-left:20px">${
        files.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
       <p>We're assessing ${files.length > 1 ? 'these' : 'this'} now and will get back to you shortly.</p>`
    : '';
  const chase = missing.length
    ? `<p style="background:#FFF4E5;padding:10px;border-left:3px solid #E08600">
         <b>${missing.length === 1 ? 'One file didn\'t come through:' : 'Some files didn\'t come through:'}</b>
         ${esc(missing.join(', '))}.<br>Could you reply to this email with ${missing.length === 1 ? 'it' : 'them'} attached, quoting ${ref}?</p>`
    : '';
  sendMail({
    to: email,
    subject: `We've received your enquiry — ${ref}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#000">
<p>Hi ${esc(first)},</p>
<p>Thanks for your enquiry — it's in front of our team now, reference <b>${ref}</b>.</p>
${list}${chase}
<p><b>What happens next:</b> we'll call you ${audience === 'commercial'
  ? 'to talk through the project and what documents we need for a priced submission'
  : 'the same business day to talk through your project'}.</p>
<p>If anything changes in the meantime, just reply to this email and quote ${ref}.</p>
<p>Estate Landscapers<br>
<span style="color:#666">Licensed Landscapers · LIC 487076C · enquiry@estatelandscapers.com.au</span></p>
</div>`,
  }).catch(e => console.log(`[enquiry] ack email failed for ${ref}: ${e.message}`));
}

// First-run check: /api/public/enquiry/health — safe to expose, no secrets returned.
router.get('/enquiry/health', async (req, res) => {
  try {
    const g = await onedrive.selfTest().catch(e => ({ ok: false, configured: true, error: e.message }));
    res.json({ endpoint: 'ok', corsOrigins: origins().length, onedrive: g });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
