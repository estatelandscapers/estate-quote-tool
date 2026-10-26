// Public routes for the website's online estimator. No login: a 4-digit code plus the
// email it was sent to opens a lead; everything after that carries the per-lead token the
// code exchange returns (X-Est-Token header). Same CORS, honeypot and per-IP limits as the
// enquiry form. All the thinking lives in utils/estimator.js; this file is plumbing.
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const EST = require('../utils/estimator');
const LA = require('../utils/linkAnalytics');
const onedrive = require('../utils/onedrive');
const { nextRef, sydneyParts } = require('../utils/refs');

const router = express.Router();
const REACTIONS = ['works', 'high', 'low', 'cheaper', 'nocommit', 'definite-no'].map(v => ({ v, label: { works: 'Yes, that works', high: 'Higher than I expected', low: 'Lower than I expected', cheaper: 'I would want it cheaper', nocommit: 'Not sure yet', 'definite-no': 'Out of my budget' }[v] }));
const clean = (s, max = 300) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---- CORS -----------------------------------------------------------------------------------
function origins() { return (process.env.SITE_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean); }
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && origins().includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    // Echo whatever headers the browser asks about (Content-Type, X-Est-Token, X-Est-Visitor),
    // so a header added later never breaks the preflight again.
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, X-Est-Token, X-Est-Visitor');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- rate limit: 20 writes per IP per hour on the open endpoints ---------------------------
const HITS = new Map();
function limited(ip, max = 20) {
  const now = Date.now(), arr = (HITS.get(ip) || []).filter(t => now - t < 3600e3);
  if (arr.length >= max) { HITS.set(ip, arr); return true; }
  arr.push(now); HITS.set(ip, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of HITS) { const a = v.filter(t => now - t < 3600e3); a.length ? HITS.set(k, a) : HITS.delete(k); } }, 600e3).unref();

const mask = e => { const [u, d] = String(e || '').split('@'); return u && d ? `${u.slice(0, 2)}••••@${d}` : ''; };

// ---- master switch ----------------------------------------------------------------------------
// Off = every call answers 503 "paused" and the website shows its fallback. Nothing is deleted;
// codes, answers and sessions are all still there when it comes back on.
router.use((req, res, next) => {
  if (EST.enabled()) return next();
  res.status(503).json({ error: 'The online estimator is paused at the moment. Use the quote form and we will call you the same business day.', paused: true });
});

// ---- 1. "Get a code": the same enquiry, from the estimate page -------------------------------
router.post('/start', async (req, res) => {
  try {
    const b = req.body || {}, ip = ipOf(req);
    if (clean(b.website)) return res.json({ ok: true, email: mask(b.email) });     // honeypot
    if (limited(ip, 5)) return res.status(429).json({ error: 'Too many requests. Please try again later, or email enquiry@estatelandscapers.com.au.' });
    const name = clean(b.name, 120), email = clean(b.email, 160).toLowerCase(), phone = clean(b.phone, 40), suburb = clean(b.suburb, 80);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Your name and a valid email address are needed. The code is emailed to you.' });
    // Same person, same month: reuse the lead and resend the code rather than making a twin.
    let l = db.prepare("SELECT * FROM leads WHERE lower(email)=? AND status NOT IN ('Won','Lost') AND created_at > datetime('now','-30 days') ORDER BY created_at DESC LIMIT 1").get(email);
    if (!l) {
      const id = newId(), ref = nextRef();
      db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb,call_answers,docs_channel,enquiry_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, name, phone, email, '', 'Our website', `${ref} · RESIDENTIAL enquiry via the online estimator`, 'New', 'call1',
          sydneyParts().ymd, '', suburb, JSON.stringify({ _prefill: { source: 'Our website', name, phone, email, suburb, enquiry_ref: ref, audience: 'residential', confirmed: {} } }), 'website', ref);
      l = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
      try { require('../utils/push').notify({ title: `New estimator enquiry: ${name}`, body: [suburb, phone].filter(Boolean).join(' · ') + ` · ${ref}`, url: '/admin/?lead=' + id, tag: 'lead-' + id }).catch(() => {}); } catch (e) {}
    } else if (phone && !l.phone) db.prepare('UPDATE leads SET phone=? WHERE id=?').run(phone, l.id);
    const r = await EST.invite(l.id, { reason: l.est_invited_at ? 'resend' : 'new' });
    res.json({ ok: true, email: mask(email), sent: r.ok });
  } catch (e) {
    console.log('[estimator] start error:', e.message);
    res.status(500).json({ error: 'Something went wrong on our side. Please email enquiry@estatelandscapers.com.au.' });
  }
});

// "Didn't get the code": resend to whatever lead that email belongs to. Always answers ok.
router.post('/resend', async (req, res) => {
  const ip = ipOf(req), email = clean((req.body || {}).email, 160).toLowerCase();
  if (limited(ip, 5) || !email) return res.json({ ok: true });
  const l = db.prepare("SELECT * FROM leads WHERE lower(email)=? AND status NOT IN ('Won','Lost') ORDER BY created_at DESC LIMIT 1").get(email);
  if (l) await EST.invite(l.id, { reason: 'resend' });
  res.json({ ok: true });
});

// ---- 2. the gate ----------------------------------------------------------------------------
router.post('/auth', (req, res) => {
  const b = req.body || {}, ip = ipOf(req);
  if (limited(ip, 40)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  const v = EST.verify(b.code, b.email, ip);
  if (!v.ok) {
    if (v.locked) return res.status(423).json({ error: 'Too many wrong attempts. Please wait 15 minutes, or call us.' });
    if (v.closed) return res.status(410).json({ error: 'This estimate has been closed. Call us if you would like to reopen it.' });
    return res.status(401).json({ error: 'That code and email do not match. Check the email we sent you.' });
  }
  const l = v.lead;
  const vk = clean(b.vk, 64) || 'unknown';
  try { LA.noteVisitor(vk, { ua: req.get('user-agent'), touch: !!b.touch }, ip); } catch (e) {}
  EST.logEvent(l.id, vk, 'auth', {});
  const a = EST.answersOf(l);
  const answers = { ...EST.prefillFrom(l), ...(a.current || {}) };
  res.json({ ok: true, token: l.est_token, first: String(l.name || '').split(' ')[0], ref: l.enquiry_ref || null,
    expires: l.est_code_expires, steps: EST.onlineSteps(), sizes: EST.sizesFor(), answers, saved: Object.keys(a.current || {}).length,
    completed: !!a.completedAt, versions: a.versions.length, booked: l.est_status === 'booked',
    reactions: REACTIONS });
});

// Same browser, same session: skip the code screen. The token alone is enough here because
// it was only ever handed out after a correct code + email.
router.post('/auth-resume', (req, res) => {
  const l = EST.byToken(req.get('x-est-token'));
  if (!l) return res.status(401).json({ error: 'expired' });
  const a = EST.answersOf(l);
  res.json({ ok: true, first: String(l.name || '').split(' ')[0], email: l.email, expires: l.est_code_expires,
    steps: EST.onlineSteps(), sizes: EST.sizesFor(), answers: { ...EST.prefillFrom(l), ...(a.current || {}) }, saved: Object.keys(a.current || {}).length,
    completed: !!a.completedAt, versions: a.versions.length, booked: l.est_status === 'booked',
    reactions: REACTIONS });
});

// Every route below needs the token the gate handed out.
function withLead(req, res, next) {
  const l = EST.byToken(req.get('x-est-token') || (req.body || {}).token);
  if (!l) return res.status(401).json({ error: 'Your session has expired. Enter your code again.' });
  req.lead = l; req.vk = clean(req.get('x-est-visitor') || (req.body || {}).vk, 64) || 'unknown';
  next();
}

// ---- 3. answers, saved as they go --------------------------------------------------------------
router.post('/answers', withLead, (req, res) => {
  const b = req.body || {};
  const incoming = b.answers && typeof b.answers === 'object' ? b.answers : {};
  // Whitelist: only keys the call script knows, plus the client's free-text notes.
  const KEYS = ['siteAddress', 'propertyType', 'builder', 'handover', 'startWhen', 'plans', 'toRemove', 'scope', 'areaOfBlock', 'sizes', 'accessMm', 'steps', 'fallMm', 'fallDir', 'vehicle', 'services', 'timing', 'driver', 'otherQuotes', 'decisionMaker', 'notes', 'priceReaction'];
  const safe = {};
  KEYS.forEach(k => { if (incoming[k] !== undefined) safe[k] = typeof incoming[k] === 'string' ? incoming[k].slice(0, 2000) : incoming[k]; });
  EST.saveAnswers(req.lead, safe);
  if (b.step) EST.logEvent(req.lead.id, req.vk, b.unknown ? 'unknown' : 'answer', { step: clean(b.step, 30) });
  res.json({ ok: true });
});

router.post('/event', withLead, (req, res) => {
  const b = req.body || {};
  const type = ['heartbeat', 'tier', 'screen'].includes(b.type) ? b.type : null;
  if (type) EST.logEvent(req.lead.id, req.vk, type, b.payload || {});
  res.json({ ok: true });
});

// ---- 4. the ballpark --------------------------------------------------------------------------
router.post('/complete', withLead, (req, res) => {
  const r = EST.complete(req.lead, req.vk);
  EST.logEvent(req.lead.id, req.vk, 'ballpark', { version: r.version });
  const bp = r.ballpark, a = r.answers.current || {};
  const text = EST.clientText(bp, a);
  const fresh = db.prepare('SELECT * FROM leads WHERE id=?').get(req.lead.id);
  const ver = r.answers.versions[r.version - 1];
  if (ver && !ver.emailed) EST.sendBallparkEmail(fresh, bp, a, r.version).catch(e => console.log('[estimator] ballpark email:', e.message));
  res.json({ ok: true, version: r.version, decline: !!bp.decline, tooUnknown: !!bp.tooUnknown,
    lo: bp.incLo || null, hi: bp.incHi || null, headline: text.headline, body: text.body,
    included: (bp.inc || []).filter(i => !/Establishment/.test(i.name)).map(i => ({ name: i.name, qty: i.qty })),
    allowed: (bp.sur || []).map(s => s.name.replace(/ — /g, ', ')),
    excluded: (bp.exc || []).map(e => ({ name: e.split(' — ')[0], why: (e.split(' — ')[1] || 'checked on site').replace(/ — /g, ', ') })) });
});

router.post('/reaction', withLead, (req, res) => {
  const v = clean((req.body || {}).v, 20);
  if (!['works', 'high', 'low', 'cheaper', 'nocommit', 'definite-no'].includes(v)) return res.status(400).json({ error: 'bad value' });
  EST.saveAnswers(req.lead, { priceReaction: v });
  try { let ca = JSON.parse(req.lead.call_answers || '{}') || {}; ca.priceReaction = v; db.prepare('UPDATE leads SET call_answers=? WHERE id=?').run(JSON.stringify(ca), req.lead.id); } catch (e) {}
  EST.logEvent(req.lead.id, req.vk, 'reaction', { v });
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), req.lead.id, 'note', 'estimatedone', null, null, 'client', 'logged', 'Reaction to the online ballpark: ' + v);
  res.json({ ok: true });
});

// ---- 5. Friday booking --------------------------------------------------------------------------
router.get('/slots', withLead, (req, res) => res.json({ slots: EST.fridaySlots() }));
router.post('/book', withLead, async (req, res) => {
  const b = req.body || {};
  const r = EST.book(req.lead, clean(b.date, 10), clean(b.half, 2));
  if (!r.ok) return res.status(409).json({ error: r.error });
  EST.logEvent(req.lead.id, req.vk, 'booked', { date: r.date, half: r.half });
  const fresh = db.prepare('SELECT * FROM leads WHERE id=?').get(req.lead.id);
  EST.sendBookingEmail(fresh, r).catch(() => {});
  res.json({ ok: true, date: r.date, half: r.half, label: r.label });
});
router.post('/not-ready', withLead, (req, res) => {
  const why = clean((req.body || {}).reason, 20) === 'fridays' ? 'Fridays do not work for them: call to find a day' : 'not ready to book yet';
  EST.logEvent(req.lead.id, req.vk, 'screen', { step: 'not-ready', why });
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), req.lead.id, 'note', req.lead.stage || null, null, null, 'client', 'logged', 'Online estimate: ' + why);
  res.json({ ok: true });
});

// ---- 6. photos and drawings, straight to the ENQ folder ----------------------------------------
const MAX_FILES = 20, ALLOWED = /\.(pdf|zip|jpe?g|png|heic|heif|webp|dwg|docx?|xlsx?)$/i;
function metaFor(l) {
  let info = {}; try { info = JSON.parse(l.enquiry_files || '{}') || {}; } catch (e) {}
  if (info.meta && info.meta.ref) return info;
  const ref = l.enquiry_ref || nextRef();
  if (!l.enquiry_ref) db.prepare('UPDATE leads SET enquiry_ref=? WHERE id=?').run(ref, l.id);
  info = { declared: [], meta: { ref, name: l.name, suburb: l.suburb, year: ref.slice(4, 8), leadId: l.id }, email: l.email || '', name: l.name, audience: 'residential' };
  db.prepare('UPDATE leads SET enquiry_files=? WHERE id=?').run(JSON.stringify(info), l.id);
  return info;
}
router.post('/files', withLead, async (req, res) => {
  const declared = Array.isArray((req.body || {}).files) ? req.body.files.slice(0, MAX_FILES) : [];
  for (const f of declared) {
    if (!ALLOWED.test(String(f && f.name || ''))) return res.status(400).json({ error: `That file type isn't accepted: ${clean(f && f.name, 60)}` });
    if (Number(f.size) > 50 * 1024 * 1024) return res.status(400).json({ error: `${clean(f.name, 60)} is over 50 MB.` });
  }
  if (!declared.length) return res.json({ ok: true, uploads: [] });
  if (!onedrive.configured()) return res.status(503).json({ error: 'Uploads are not available right now. Email them to enquiry@estatelandscapers.com.au instead.' });
  try {
    const info = metaFor(req.lead);
    await onedrive.ensureFolder(info.meta);
    const uploads = [];
    for (const f of declared) uploads.push(await onedrive.uploadUrlFor(info.meta, f.name));
    res.json({ ok: true, uploads });
  } catch (e) {
    console.log(`[estimator] OneDrive unavailable: ${e.message}`);
    res.status(503).json({ error: 'Uploads are not available right now. Email them to enquiry@estatelandscapers.com.au instead.' });
  }
});
router.post('/files/complete', withLead, (req, res) => {
  const names = (Array.isArray((req.body || {}).uploaded) ? req.body.uploaded : []).slice(0, MAX_FILES).map(n => clean(n, 140)).filter(Boolean);
  if (!names.length) return res.json({ ok: true });
  const l = req.lead;
  let got = []; try { got = JSON.parse(l.docs_received || '[]') || []; } catch (e) {}
  names.forEach(nm => { if (!got.includes(nm)) got.push(nm); });
  db.prepare("UPDATE leads SET docs_received=?, docs_channel='website', notes=COALESCE(notes,'') || ?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(got), `\nFiles uploaded via the estimator (${names.length}): ${names.join(', ')}`, l.id);
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'note', 'docsin', null, null, 'client', 'logged', `Uploaded via the estimator: ${names.join(', ')}`);
  EST.logEvent(l.id, req.vk, 'upload', { count: names.length });
  res.json({ ok: true });
});

module.exports = router;
