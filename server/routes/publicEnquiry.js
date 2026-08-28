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
const { newId } = require('../utils/ids');
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

// ---- reference numbers: ENQ-YYYY-NNNN ---------------------------------------
function nextRef() {
  const year = new Date().getFullYear();
  const key = 'enquiry_seq_' + year;
  const n = (parseInt(settingGet(key) || '0', 10) || 0) + 1;
  settingSet(key, String(n));
  return `ENQ-${year}-${String(n).padStart(4, '0')}`;
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

    const ref = nextRef();
    const id = newId();
    const year = new Date().getFullYear();
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
        new Date().toISOString().slice(0, 10), jobType, suburb, JSON.stringify(prefill), 'website');

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

    if (email) sendAck({ email, name, ref, audience, fileCount: filesOk ? declared.length : 0 });

    console.log(`[enquiry] ${ref} lead ${id} (${audience}) files=${declared.length} onedrive=${filesOk}`);
    res.status(201).json({
      ok: true, ref, uploads,
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
router.post('/enquiry/:ref/complete', (req, res) => {
  const ref = clean(req.params.ref, 20);
  // Hardening: refs are strictly formatted — anything else (wildcards included) is
  // silently accepted and ignored, and the same rate limit as /enquiry applies.
  if (!/^ENQ-\d{4}-\d{4}$/.test(ref)) return res.json({ ok: true });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return res.json({ ok: true });
  const b = req.body || {};
  const okNames = (Array.isArray(b.uploaded) ? b.uploaded.slice(0, 20) : []).map(n => clean(n, 140)).filter(Boolean);
  const badNames = (Array.isArray(b.failed) ? b.failed.slice(0, 20) : []).map(n => clean(n, 140)).filter(Boolean);
  const lead = db.prepare("SELECT id, notes FROM leads WHERE notes LIKE ? ORDER BY created_at DESC LIMIT 1").get(ref + '%');
  if (!lead) return res.json({ ok: true });        // nothing to attach it to; never error at the client
  const extra = [
    okNames.length ? `Files received: ${okNames.join(', ')}` : null,
    badNames.length ? `⚠ Files that FAILED to upload: ${badNames.join(', ')} — ask the client to email these.` : null,
  ].filter(Boolean).join('\n');
  if (extra) db.prepare("UPDATE leads SET notes=?, updated_at=datetime('now') WHERE id=?")
    .run((lead.notes || '') + '\n' + extra, lead.id);
  res.json({ ok: true });
});

function sendAck({ email, name, ref, audience, fileCount }) {
  const first = String(name).split(' ')[0];
  sendMail({
    to: email,
    subject: `We've received your enquiry — ${ref}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#000">
<p>Hi ${first},</p>
<p>Thanks for your enquiry — it's in front of our team now, reference <b>${ref}</b>.</p>
<p><b>What happens next:</b> we'll call you ${audience === 'commercial'
  ? 'to talk through the project and what documents we need for a priced submission'
  : 'the same business day to talk through your project'}.
${fileCount ? `Your ${fileCount} file${fileCount > 1 ? 's have' : ' has'} been received safely.` : ''}</p>
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
