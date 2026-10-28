// ---------------------------------------------------------------------------
// The online estimator: the discovery call, done by the client on their phone.
//
// Nothing here invents a second system. The questions are the call script's STEPS reworded
// for the client; the number is the call script's ballpark(); the behaviour tracking is the
// same session-and-signal idea as the client quote link; the lead moves through the same
// stages the rep would move it through. What this file adds:
//
//   · a 4-digit access code per lead (plus the email it was sent to), valid est_code_days
//   · the intro email ("hi, here's how it works") with the code, logged on the lead
//   · answers saved as they go, VERSIONED on every completed run, mirrored into
//     call_answers once the client reaches the ballpark so every existing screen
//     (answers panel, pre-call checklist, quote comparison) just works
//   · the ballpark email, same words as the phone script, logged on the lead
//   · events → sessions → hot / warm / cold, thresholds in Settings (est_*)
//   · a real Friday AM/PM booking that writes site_visits like the Book button does
//
// Everything client-facing is in plain words. Everything a rep sees is in the lead console.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const { db, settingGet, settingSet } = require('../db');
const { newId, newToken } = require('./ids');
const CS = require('./callScript');
const { sendMail } = require('./email');
const { shell, esc } = require('./quoteEmail');
const { nextRef } = require('./refs');
const LA = require('./linkAnalytics');

const n = (k, d) => { const v = parseFloat(settingGet(k)); return isNaN(v) ? d : v; };
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const ms = s => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).getTime();
const first = l => String((l && l.name) || 'there').trim().split(/\s+/)[0] || 'there';
const lower = s => String(s || '').trim().toLowerCase();

// ---- settings (all editable in Settings → Online estimator) ----------------------------
const DEFAULTS = {
  close_small_under: '10000',     // closing out: suggest 'too small' under this ballpark
  close_large_over: '300000',     // and 'too large' over this
  est_enabled: '1',               // master switch: 0 = no automatic emails, estimator paused
  est_url: 'https://www.estatelandscapers.com.au/estimate/',
  est_code_days: '7',            // the code works for this long; the rep can reissue
  est_lockout_tries: '5',        // wrong code + email attempts before a lockout
  est_lockout_min: '15',
  est_slots_per_half: '2',       // Friday bookings accepted per AM / PM half
  est_hot_sessions: '2',         // sessions in the hot window = hot
  est_hot_window_h: '48',
  est_hot_toggles: '2',          // Basic/Standard/Premium comparisons after the ballpark = hot
  est_warm_active_sec: '60',
  est_warm_answer_pct: '60',     // answered this much of the questions in one session = warm
  est_hot_fade_days: '3',
  est_warm_fade_days: '7',
  est_intro_subject: 'Your landscaping estimate, {{first}}: your access code inside',
};
// Auto lead processing on/off. Off: no lead gets a code automatically, the public estimator
// answers "paused" to every call, and the website falls back to the plain acknowledgement.
// Leads keep flowing in exactly as before the estimator existed.
function enabled() { return settingGet('est_enabled') !== '0'; }
// The three automatic doors (website form, hipages/email ingest, typed-in lead) call this.
async function autoInvite(leadId, opts) {
  if (!enabled()) return { ok: false, paused: true };
  return invite(leadId, opts);
}
function seedDefaults() {
  Object.entries(DEFAULTS).forEach(([k, v]) => { if (settingGet(k) == null) settingSet(k, v); });
}

// ---- the questions, in the client's words ------------------------------------------------
// Keys and option values are IDENTICAL to the call script's, so an answer set from the
// estimator is an answer set from the call: ballpark(), the answers panel and the quote
// comparison read it without knowing who typed it. Only the wording changes.
const SAY = {
  address:  { title: 'What is the address of the property?', hint: 'Street number and suburb is enough. This is where we will come for the site visit.' },
  property: { title: 'Is this a new build, or an existing home?', hint: 'This decides which questions come next.' },
  builder:  { title: 'Who is the builder?', hint: 'Pick one, or type the name.' },
  handover: { title: 'When is handover?', hint: 'Roughly is fine.' },
  start:    { title: 'When would you want us on site?', hint: '' },
  plans:    { title: 'Which drawings do you have?', hint: 'Tap all that apply. You can upload them at the end, or email them later.' },
  existing: { title: 'Is there anything that needs to come out first?', hint: 'Old paving, a shed, dead lawn, an existing wall.' },
  scope:    { title: 'What would you like done?', hint: 'Tap everything that applies. You will size each one next.' },
  area:     { title: 'Which part of the block?', hint: '' },
  sizes:    { title: 'Roughly how much of each?', hint: 'Rough is fine. If you do not know, tap "Not sure" and we will measure it on the visit.' },
  access:   { title: 'How wide is the side access at its narrowest point?', hint: 'Usually the gate. If you are not sure, is it wider or narrower than a wheelie bin? A bin is about 600 mm wide.' },
  steps:    { title: 'How many steps will we have to work across to reach the furthest work area?', hint: 'Count the steps on the side access or the main access, from where a vehicle can park to the far end of the job. Zero if it is all on the flat.' },
  fall:     { title: 'Stand on the front boundary. How much higher or lower is the back boundary?', hint: 'Your best guess is fine. One step is about 0.15 m; a standard fence is about 1.8 m.' },
  vehicle:  { title: 'Can a ute and trailer get to where the work is?', hint: '' },
  services: { title: 'Anything underground or in the way we should know about?', hint: 'Tap all that apply.' },
  timing:   { title: 'When are you hoping to start?', hint: '' },
  driver:   { title: 'Is anything driving that date?', hint: '' },
  quotes:   { title: 'Have you had other quotes?', hint: 'Optional. It helps us pitch the right level of detail.' },
  decision: { title: 'Who is deciding?', hint: 'Optional.' },
};
// Option wording that reads as the rep's shorthand gets the client's version here.
const OPT = {
  scope: { unsure: 'Not sure, I want advice' }, existing: { nothing: 'Nothing, it is bare' },
  plans: { unknown: 'Not sure' }, services: { unknown: 'Not sure', neighbour: 'Retaining wall shared with a neighbour' },
  quotes: { first: "No, you're the first", wontsay: 'Rather not say' },
  decision: { them: 'Just me', partner: 'My partner too', builder: 'The builder', owner: 'The landlord / owner' },
  vehicle: { drive: 'Yes, drives right in', side: 'No, side access only', house: 'No, through the house only', unknown: 'Not sure' },
};
const ONLINE_SKIP = ['open', 'ballpark', 'book', 'source'];
const OPTIONAL = ['quotes', 'decision'];
// Body-scale answers map to a fall in mm the calculator understands. The script's slider
// is 0 to 2500 in 100 mm steps; these are the same marks the rep uses on the phone.
// Metres, as asked on the front boundary; stored in mm like the rep's slider. 0.8 m and
// above is the script's steep-slope surcharge, 1.2 m and above its engineering line.
const FALL_SCALE = [
  { v: 0, label: 'Level (0 m)' }, { v: 300, label: '0.3 m' }, { v: 600, label: '0.6 m' }, { v: 900, label: '0.9 m' },
  { v: 1200, label: '1.2 m' }, { v: 1500, label: '1.5 m' }, { v: 2000, label: '2 m' }, { v: 2500, label: '2.5 m or more' },
];
function onlineSteps() {
  return CS.STEPS.filter(s => !ONLINE_SKIP.includes(s.id)).map(s => {
    const o = SAY[s.id] || {};
    const out = { id: s.id, key: s.key, type: s.type, section: s.section, title: o.title || s.title, hint: o.hint || '',
      showIf: s.showIf || null, optional: OPTIONAL.includes(s.id), other: !!s.other };
    if (s.options) out.options = s.options.map(x => ({ v: x.v, label: ((OPT[s.id] || {})[x.v]) || x.label || x.v }));
    if (s.type === 'slider') Object.assign(out, { min: s.min, max: s.max, step: s.step, def: s.def, unit: s.unit, unknown: !!s.unknown });
    if (s.id === 'fall') { out.type = 'scale'; out.scale = FALL_SCALE; }
    return out;
  });
}
function sizesFor() {
  return CS.SIZES.map(s => ({ id: s.id, label: s.label, unit: s.unit, max: s.max, step: s.step, ask: s.ask, typical: TYPICAL[s.id] || '' }));
}
const TYPICAL = {
  turf: 'A typical Sydney backyard is 60 to 120 m².', aturf: 'A courtyard is usually 20 to 50 m².',
  beds: 'A bed along one fence is usually 10 to 30 m².', wall: 'Across the back of a block is usually 10 to 15 m.',
  drive: 'A double driveway is usually 40 to 70 m².', rock: 'Side strips are usually 10 to 30 m².',
  fence: 'One side boundary is usually 30 to 40 m.', gates: '', steppers: '',
  removal: 'One 10-tonne truck load is roughly a trailer-and-a-half of material, six or seven times over.',
  excav: 'Most yards are one or two excavator shifts.',
};
// Which questions this client actually sees, given their answers. Used for the "answered
// X of Y" progress measure in the signal rules.
function applicable(steps, a) {
  return steps.filter(s => !s.showIf || Object.entries(s.showIf).every(([k, vals]) => vals.includes(a[k])));
}
function answeredCount(a) {
  const steps = applicable(onlineSteps(), a || {});
  const done = steps.filter(s => s.type === 'sizes' ? Object.keys(a.sizes || {}).length > 0 : a[s.key] != null && a[s.key] !== '' && !(Array.isArray(a[s.key]) && !a[s.key].length));
  return { answered: done.length, total: steps.length };
}

// ---- the access code -----------------------------------------------------------------------
function codeFor() {
  // 4 digits, never shared with another live code. Leading zeros allowed: "0417" is fine.
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const clash = db.prepare("SELECT 1 FROM leads WHERE est_code=? AND est_code_expires > datetime('now')").get(c);
    if (!clash) return c;
  }
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
function expiryFor() {
  const d = new Date(Date.now() + n('est_code_days', 7) * 864e5);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
// A lead with no email cannot be invited: there is nowhere to send the code. The lead card
// says so, and the rep adds the email and taps Send.
function canInvite(l) { return !!(l && lower(l.email) && /@/.test(l.email)); }

// Give the lead a code (or a fresh one) and send the intro email. Returns what happened so
// callers can log it; never throws for a mail failure, because the lead already exists and
// the rep can resend from the card.
async function invite(leadId, { reason = 'new', by = '' } = {}) {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!l) return { ok: false, error: 'lead not found' };
  if (!canInvite(l)) {
    db.prepare("UPDATE leads SET est_status='noemail' WHERE id=?").run(l.id);
    return { ok: false, error: 'no email address on the lead' };
  }
  if (!l.enquiry_ref) { const ref = nextRef(); db.prepare('UPDATE leads SET enquiry_ref=? WHERE id=?').run(ref, l.id); l.enquiry_ref = ref; }
  const code = codeFor(), exp = expiryFor(), tok = newToken();
  db.prepare("UPDATE leads SET est_code=?, est_code_expires=?, est_token=?, est_status=?, est_invited_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
    .run(code, exp, tok, 'invited', l.id);
  l.est_code = code; l.est_code_expires = exp;
  const mail = introEmail(l);
  let outcome = 'sent', err = null;
  try { const r = await sendMail({ to: l.email, subject: mail.subject, html: mail.html }); if (r && r.skipped) { outcome = 'failed'; err = r.reason; } }
  catch (e) { outcome = 'failed'; err = e.message; console.log(`[estimator] intro email failed for ${l.name}: ${e.message}`); }
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'email', 'estinvite', mail.subject, mail.text, by || 'auto', outcome,
      `Online estimator ${reason === 'resend' ? 'code resent' : 'invitation'} · code ${code} · valid to ${exp.slice(0, 10)}${err ? ' · NOT SENT: ' + err : ''}`);
  return { ok: outcome === 'sent', code, expires: exp, error: err };
}

// ---- the intro email -----------------------------------------------------------------------
// The sample quote link: needs a quote marked "sample" with its link on, and the tool's
// public address in Settings (tool_url). A pasted address missing https:// or carrying a
// trailing /admin is repaired rather than producing a dead link.
function toolBase() {
  let b = String(settingGet('tool_url') || process.env.PUBLIC_URL || '').trim();
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/(admin|q)(\/.*)?$/i, '').replace(/\/+$/, '');
  return b;
}
function sampleQuote() {
  return db.prepare("SELECT token, quote_number FROM quotes WHERE COALESCE(is_sample,0)=1 AND COALESCE(link_off,0)=0 ORDER BY created_at DESC LIMIT 1").get() || null;
}
function sampleQuoteLink() {
  const s = sampleQuote(), base = toolBase();
  return s && base ? `${base}/q/${s.token}` : '';
}
// For the Settings page: says plainly why the sample link would be missing.
function sampleStatus() {
  const s = sampleQuote(), base = toolBase();
  return { ok: !!(s && base), sampleNumber: s ? s.quote_number : null, base, link: sampleQuoteLink(),
    why: !s ? 'No quote is marked as the sample (open a quote → Make sample copy), or its link is switched off.' : !base ? 'Set "This tool\'s public URL" below.' : '' };
}
function estimatorLink(l) {
  const u = new URL(settingGet('est_url') || DEFAULTS.est_url);
  if (l.email) u.searchParams.set('e', l.email);
  return u.toString();
}
const STEPS7 = [
  ['Enquiry', 'Done. Your reference is {{ref}}.'],
  ['Your estimate, online', 'About 8 minutes. You tell us what you want done, roughly how much, and what the access is like. You get a ballpark range straight away, at three levels of finish.'],
  ['Site visit', 'Fridays. Pick one at the end of the estimate. We measure, check falls and access, and photograph the site.'],
  ['Quote in 48 hours', 'Itemised, element by element, so you can add, cut or stage it.'],
  ['Contract and scheduling', 'Written contract, HBC cover where required, and a start date you can plan around.'],
  ['Construction', 'Set-out and levels first, drainage before surfaces, progress photos as we go, one point of contact.'],
  ['Handover', 'Walk-through, engineer certification where walls need it, and care notes for the first season.'],
];
function introEmail(l) {
  const f = first(l), ref = l.enquiry_ref || '', phone = settingGet('company_phone') || '0414 147 008';
  const link = estimatorLink(l), sample = sampleQuoteLink();
  const subject = (settingGet('est_intro_subject') || DEFAULTS.est_intro_subject).replace('{{first}}', f);
  const where = l.suburb ? ` about your ${esc(l.suburb.split(',')[0])} project` : '';
  const steps = STEPS7.map(([t, d], i) => `<tr><td style="vertical-align:top;padding:6px 10px 6px 0;color:#1E5BFF;font-weight:800;">${i + 1}</td><td style="padding:6px 0;"><b>${esc(t)}.</b> ${esc(d.replace('{{ref}}', ref))}</td></tr>`).join('');
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(f)},</p>
    <p style="margin:0 0 14px;">Thanks for getting in touch${where}. Here is how it works from here, and the first step is one you can do right now, on your phone.</p>
    <div style="background:#F5F5F5;border-radius:10px;padding:16px 18px;margin:0 0 16px;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#888;font-weight:800;">Your access code</div>
      <div style="font-size:30px;font-weight:800;letter-spacing:10px;margin:6px 0 4px;color:#000;">${esc(l.est_code)}</div>
      <div style="font-size:12px;color:#5A6068;">Use it with this email address. It works as many times as you like for ${n('est_code_days', 7)} days, and your answers are saved as you go.</div>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="border-radius:999px;background:#1E5BFF;">
      <a href="${esc(link)}" style="display:inline-block;padding:14px 28px;color:#fff;text-decoration:none;font-weight:800;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Start your estimate</a></td></tr></table>
    <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#1E5BFF;margin:0 0 6px;">The seven steps</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13.5px;line-height:1.55;">${steps}</table>
    ${sample ? `<p style="margin:16px 0 0;font-size:13px;color:#5A6068;">Curious what the quote looks like at step 4? <a href="${esc(sample)}" style="color:#1E5BFF;font-weight:700;">Here is a sample quote</a> from another job, so you know what to expect.</p>` : ''}
    <p style="margin:16px 0 0;font-size:13px;color:#5A6068;">Rather talk it through? Call ${esc(phone)}, Monday to Saturday, 7am to 5pm.</p>
    <p style="margin:18px 0 0;">Estate Landscapers<br><span style="color:#888;font-size:12px;">Licensed Landscapers · LIC 487076C · enquiry@estatelandscapers.com.au</span></p>`);
  const text = `Hi ${f},\n\nThanks for getting in touch. Your access code for the online estimate is ${l.est_code} (use it with this email address, valid ${n('est_code_days', 7)} days).\n\n${link}\n\n` +
    STEPS7.map(([t, d], i) => `${i + 1}. ${t}. ${d.replace('{{ref}}', ref)}`).join('\n') + (sample ? `\n\nSample quote: ${sample}` : '') + `\n\nEstate Landscapers · ${phone}`;
  return { subject, html, text };
}

// ---- verifying a code -----------------------------------------------------------------------
const TRIES = new Map();   // ip → [timestamps of wrong attempts]
function lockedOut(ip) {
  const win = n('est_lockout_min', 15) * 60e3, now = Date.now();
  const arr = (TRIES.get(ip) || []).filter(t => now - t < win); TRIES.set(ip, arr);
  return arr.length >= n('est_lockout_tries', 5);
}
function wrongTry(ip) { const a = TRIES.get(ip) || []; a.push(Date.now()); TRIES.set(ip, a); }
setInterval(() => { const now = Date.now(); for (const [k, v] of TRIES) { const a = v.filter(t => now - t < 3600e3); a.length ? TRIES.set(k, a) : TRIES.delete(k); } }, 600e3).unref();

function verify(code, email, ip) {
  if (lockedOut(ip)) return { ok: false, locked: true };
  const c = String(code || '').replace(/\D/g, '');
  const rows = db.prepare("SELECT * FROM leads WHERE est_code=? AND est_code_expires > datetime('now')").all(c);
  const l = rows.find(r => lower(r.email) === lower(email));
  if (!l || c.length !== 4) { wrongTry(ip); return { ok: false }; }
  if (['Won', 'Lost'].includes(l.status)) return { ok: false, closed: true };
  TRIES.delete(ip);
  return { ok: true, lead: l };
}
function byToken(tok) {
  if (!tok || String(tok).length < 16) return null;
  const l = db.prepare("SELECT * FROM leads WHERE est_token=? AND est_code_expires > datetime('now')").get(String(tok));
  return l && !['Won', 'Lost'].includes(l.status) ? l : null;
}

// ---- answers: saved as they go, versioned when a run completes -----------------------------
function answersOf(l) {
  let a = {}; try { a = JSON.parse(l.est_answers || '{}') || {}; } catch (e) {}
  if (!a.current) a.current = {};
  if (!a.versions) a.versions = [];
  return a;
}
function prefillFrom(l) {
  // Start the client off with what we already know: the address, and the scope words
  // from a hipages or website enquiry, if the lead carried them.
  let ca = {}; try { ca = JSON.parse(l.call_answers || '{}') || {}; } catch (e) {}
  const out = {};
  if (l.address) out.siteAddress = l.address;
  else if (l.suburb) out.siteAddress = l.suburb;
  if (Array.isArray(ca.scope) && ca.scope.length) out.scope = ca.scope;
  return out;
}
function saveAnswers(l, incoming) {
  const a = answersOf(l);
  a.current = { ...(a.current || {}), ...(incoming || {}) };
  a.updatedAt = nowIso();
  db.prepare("UPDATE leads SET est_answers=?, est_status=CASE WHEN COALESCE(est_status,'')='invited' THEN 'started' ELSE est_status END, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(a), l.id);
  return a;
}
function sameAnswers(x, y) { return JSON.stringify(x || {}) === JSON.stringify(y || {}); }
const DIFF_LABEL = { siteAddress: 'address', propertyType: 'property', builder: 'builder', handover: 'handover', startWhen: 'start', plans: 'drawings', toRemove: 'to remove', scope: 'scope', areaOfBlock: 'part of block',
  sizes: 'sizes', accessMm: 'access', steps: 'steps', fallMm: 'fall', vehicle: 'vehicle access', services: 'services', timing: 'timing', driver: 'driver', otherQuotes: 'other quotes', decisionMaker: 'decision', notes: 'notes', priceReaction: 'reaction' };
function diffKeys(prev, cur) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  return [...keys].filter(k => k !== 'priceReaction' && JSON.stringify(prev[k]) !== JSON.stringify(cur[k])).map(k => DIFF_LABEL[k] || k);
}

// The client reached the ballpark: freeze a version, mirror into call_answers, move the lead.
function complete(l, visitorKey) {
  const a = answersOf(l);
  const cur = a.current || {};
  const bp = CS.ballpark(cur);
  const last = a.versions[a.versions.length - 1];
  let changed = [];
  if (!last || !sameAnswers(last.answers, cur)) {
    changed = last ? diffKeys(last.answers, cur) : [];
    a.versions.push({ at: nowIso(), answers: JSON.parse(JSON.stringify(cur)), changed,
      ballpark: bp.decline ? { decline: true } : { lo: bp.incLo, hi: bp.incHi, tooUnknown: !!bp.tooUnknown }, emailed: false, visitor: visitorKey || null });
  }
  a.completedAt = a.completedAt || nowIso(); a.lastCompletedAt = nowIso();
  // Mirror into call_answers so the rest of the tool sees it as discovery done. _prefill
  // (hipages / website facts) is kept; the client's answers win on every real key.
  let ca = {}; try { ca = JSON.parse(l.call_answers || '{}') || {}; } catch (e) {}
  const merged = { ...ca, ...cur, _prefill: ca._prefill || {}, _estimator: { at: nowIso(), version: a.versions.length } };
  const { stageById, phaseOf } = require('./leadTemplates');
  const cur_stage = l.stage || 'call1';
  const sets = ['est_answers=?', 'call_answers=?', "est_status=CASE WHEN est_status='booked' THEN 'booked' ELSE 'completed' END", "updated_at=datetime('now')"];
  const vals = [JSON.stringify(a), JSON.stringify(merged)];
  // Only a lead still at step 1 moves. One already past discovery (drawings in, visit
  // booked, quote out) keeps its place: the new answers show on the card either way.
  if (phaseOf(cur_stage) <= 1 && !['Won', 'Lost'].includes(l.status)) {
    sets.push("stage='estimatedone'", "next_followup=?", "status=CASE WHEN status='New' THEN 'Contacted' ELSE status END");
    vals.push(require('./refs').sydneyParts().ymd);
  }
  if (cur.scope && cur.scope.length) { sets.push('job_type=?'); vals.push(cur.scope.map(s => (CS.SIZES.find(x => x.id === s) || { label: s }).label).join(', ')); }
  if (cur.siteAddress && cur.siteAddress !== l.address) { sets.push('address=?'); vals.push(String(cur.siteAddress).slice(0, 200)); }
  vals.push(l.id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  if (bp.decline) db.prepare('UPDATE leads SET declined_reason=? WHERE id=?').run(bp.reason, l.id);
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'note', 'estimatedone', null, null, 'client', 'logged',
      `Online estimate completed (version ${a.versions.length})${changed.length ? ' · changed: ' + changed.join(', ') : ''} · ${bp.decline ? 'DECLINED: ' + bp.reason : bp.tooUnknown ? 'too little known for a number' : `ballpark $${bp.incLo.toLocaleString()} to $${bp.incHi.toLocaleString()} inc GST`}`);
  return { answers: a, ballpark: bp, version: a.versions.length };
}

// ---- the number, in the client's words ---------------------------------------------------
// Same structure and the same figures as ballparkScript(), which is what the rep reads out.
// Second person, no "I", and the site visit offered in every case, as agreed.
function clientText(bp, a) {
  const sizeNames = bp.inc ? bp.inc.filter(i => !/Establishment/.test(i.name)).map(i => i.name.toLowerCase()) : [];
  const scope = sizeNames.length > 1 ? sizeNames.slice(0, -1).join(', ') + ' and ' + sizeNames[sizeNames.length - 1] : (sizeNames[0] || 'the works');
  if (bp.decline) {
    return { headline: 'We need to be upfront with you.', body:
      `With access under ${CS.T().minAccess} mm we cannot get any machinery down the side at all, so everything would be hand-carried. That pushes the cost up to a point where it stops being fair value for you, so it is not a job we would normally take on.\n\nIf the access can be opened up, a fence panel out or through the neighbour for a day, we would be glad to take another look. You can still book a site visit below and we will check it on the day.` };
  }
  if (bp.tooUnknown) {
    return { headline: 'There is a bit we need to see first.', body:
      `From what you have told us there is not enough to put a fair number on yet, and we would rather look at it properly than give you a figure that turns out to be wrong.\n\nSite visits are Fridays. Pick one below and we will measure it up and give you a proper range on the day.` };
  }
  const excl = bp.exc.length
    ? `\n\nThat does not include the ${bp.exc.map(e => e.split(' — ')[0].toLowerCase()).join(' or the ')}. We need to see ${bp.exc.length > 1 ? 'those' : 'that'} on site before we can put a number on ${bp.exc.length > 1 ? 'them' : 'it'}.`
    : '';
  return { headline: `Based on what you have told us, the ${scope} usually lands between $${bp.incLo.toLocaleString()} and $${bp.incHi.toLocaleString()}.`,
    body: `That is including GST, at Basic finishes on the low side and Premium on the high side.${excl}\n\nIt is a ballpark from your answers, subject to the site visit, final measurements and which finishes you choose. Does that sound about right for you?` };
}

// The fork after the ballpark. "Yes, that works" and "lower than I expected" go on to book a
// Friday. Everything else is not a fit for now: the lead is closed as declined (the rep can
// step it back), the client is thanked and offered advice by email. A decline on access or a
// run with too little to price skips the reaction and goes straight to booking.
const FIT_REACTIONS = ['works', 'low'];
function isFit(reaction, bp) {
  if (bp && (bp.decline || bp.tooUnknown)) return true;
  return !reaction || FIT_REACTIONS.includes(reaction);
}
const NOT_FIT_TEXT = 'Thank you for reaching out and taking the time to fill in the estimator. From what you have told us, we are not the right fit for your project at the moment.';
const NOT_FIT_HELP = 'We can still help if you need expert advice on your project: just drop us an email and we will take it from there.';
function applyReaction(l, v) {
  const a = answersOf(l); const bp = CS.ballpark(a.current || {});
  const fit = isFit(v, bp);
  const REACT_LABEL = { works: 'that works', high: 'higher than expected', low: 'lower than expected', cheaper: 'wants it cheaper', nocommit: 'not sure yet', 'definite-no': 'out of budget' };
  if (!fit && !['Won'].includes(l.status)) {
    db.prepare("UPDATE leads SET stage='disqualified', status='Lost', next_followup=NULL, declined_reason=?, updated_at=datetime('now') WHERE id=?")
      .run('Online estimate: reaction "' + (REACT_LABEL[v] || v) + '" to the ballpark', l.id);
  }
  return { fit, label: REACT_LABEL[v] || v, NOT_FIT_TEXT, NOT_FIT_HELP };
}

// The ballpark email: the same words, sent once per reaction, logged on the lead.
async function sendBallparkEmail(l, bp, a, version) {
  if (!canInvite(l)) return { ok: false };
  const f = first(l), t = clientText(bp, a), sample = sampleQuoteLink(), link = estimatorLink(l);
  const phone = settingGet('company_phone') || '0414 147 008';
  const incRows = (bp.inc || []).filter(i => !/Establishment/.test(i.name)).map(i => `<tr><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;">✓ ${esc(i.name)}</td><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;text-align:right;color:#5A6068;">${esc(i.qty)}</td></tr>`).join('');
  const surRows = (bp.sur || []).map(s => `<tr><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;">✓ ${esc(s.name.replace(/ — /g, ', '))}</td><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;text-align:right;color:#5A6068;">allowed for</td></tr>`).join('');
  const excRows = (bp.exc || []).map(e => `<tr><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;color:#8A8A8A;">— ${esc(e.split(' — ')[0])}</td><td style="padding:5px 0;border-bottom:1px solid #E4E7EC;text-align:right;color:#8A8A8A;">${esc(e.split(' — ')[1] || 'checked on site')}</td></tr>`).join('');
  const range = (!bp.decline && !bp.tooUnknown)
    ? `<div style="background:#0B1220;color:#fff;border-radius:12px;padding:18px 20px;margin:0 0 16px;"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9fb3e8;font-weight:800;">Your ballpark</div>
       <div style="font-size:28px;font-weight:800;margin:4px 0 2px;">$${bp.incLo.toLocaleString()} <span style="color:#7FA3FF;">to</span> $${bp.incHi.toLocaleString()}</div><div style="font-size:12px;color:#c9d3ee;">Including GST. Basic finishes to Premium finishes.</div></div>` : '';
  const fit = isFit(a.priceReaction, bp);
  const next = fit
    ? `<p style="margin:0 0 14px;"><b>What happens next.</b> A site visit on a Friday, then an itemised quote within 48 hours of it. ${sample ? `<a href="${esc(sample)}" style="color:#1E5BFF;font-weight:700;">Here is a sample quote</a> from another job so you know what to expect.` : ''}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr><td style="border-radius:999px;background:#1E5BFF;">
      <a href="${esc(link)}" style="display:inline-block;padding:13px 26px;color:#fff;text-decoration:none;font-weight:800;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Back to your estimate</a></td></tr></table>`
    : `<p style="margin:0 0 14px;">${esc(NOT_FIT_TEXT)}</p>
    <p style="margin:0 0 14px;">${esc(NOT_FIT_HELP)} <a href="mailto:enquiry@estatelandscapers.com.au" style="color:#1E5BFF;font-weight:700;">enquiry@estatelandscapers.com.au</a></p>`;
  const html = shell(`
    <p style="margin:0 0 14px;">Hi ${esc(f)},</p>
    <p style="margin:0 0 14px;">Thanks for completing your online estimate. Here is a copy of what you saw, so you have it in writing.</p>
    ${range}
    <p style="margin:0 0 14px;font-weight:700;">${esc(t.headline)}</p>
    ${t.body.split('\n\n').map(p => `<p style="margin:0 0 12px;">${esc(p)}</p>`).join('')}
    ${incRows || excRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;margin:6px 0 16px;">${incRows}${surRows}${excRows}</table>` : ''}
    ${next}
    <p style="margin:0;font-size:13px;color:#5A6068;">${fit ? `Your code ${esc(l.est_code)} keeps working until ${esc(String(l.est_code_expires).slice(0, 10))}, so you can change answers or book a Friday any time. ` : ''}Questions? Call ${esc(phone)}.</p>
    <p style="margin:18px 0 0;">Estate Landscapers<br><span style="color:#888;font-size:12px;">Licensed Landscapers · LIC 487076C</span></p>`);
  const subject = bp.decline ? 'Your landscaping estimate: a note about access' : bp.tooUnknown ? 'Your landscaping estimate: next step is the site visit' : `Your landscaping ballpark: $${bp.incLo.toLocaleString()} to $${bp.incHi.toLocaleString()}`;
  const text = `${t.headline}\n\n${t.body}` + (bp.inc && bp.inc.length ? '\n\nIncluded: ' + bp.inc.filter(i => !/Establishment/.test(i.name)).map(i => `${i.name} (${i.qty})`).join('; ') : '') + (bp.exc.length ? '\nTo check on site: ' + bp.exc.join('; ') : '') + (fit ? (sample ? `\n\nSample quote: ${sample}` : '') : `\n\n${NOT_FIT_TEXT} ${NOT_FIT_HELP}`);
  let outcome = 'sent', err = null;
  try { const r = await sendMail({ to: l.email, subject, html }); if (r && r.skipped) { outcome = 'failed'; err = r.reason; } } catch (e) { outcome = 'failed'; err = e.message; }
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'email', 'estimatedone', subject, text, 'auto', outcome, `Ballpark email after online estimate (version ${version})${err ? ' · NOT SENT: ' + err : ''}`);
  const a2 = answersOf(db.prepare('SELECT est_answers FROM leads WHERE id=?').get(l.id));
  if (a2.versions[version - 1]) { a2.versions[version - 1].emailed = outcome === 'sent'; db.prepare('UPDATE leads SET est_answers=? WHERE id=?').run(JSON.stringify(a2), l.id); }
  return { ok: outcome === 'sent', error: err };
}

// ---- Friday booking: AM or PM, real rows in site_visits --------------------------------------
const HALF = { AM: { time: '9:00am', slots: ['7:30am', '9:00am', '10:30am'] }, PM: { time: '1:30pm', slots: ['12:00pm', '1:30pm', '3:00pm'] } };
// Dates in Sydney time, whatever the server's clock says. The call script's nextFridays()
// uses the server's UTC date, which is a day behind Sydney every evening.
function nextFridaysSydney(count = 3) {
  const out = []; const d = new Date();
  for (let i = 1; out.length < count && i < 40; i++) {
    const t = new Date(d.getTime() + i * 864e5);
    const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (p.weekday !== 'Friday') continue;
    const iso = `${p.year}-${p.month}-${p.day}`;
    if (out.some(o => o.iso === iso)) continue;
    out.push({ iso, label: new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) });
  }
  return out;
}
function fridaySlots() {
  const cap = n('est_slots_per_half', 2);
  return nextFridaysSydney(3).map(f => {
    const taken = db.prepare("SELECT visit_time FROM site_visits WHERE visit_date=? AND status='booked'").all(f.iso).map(r => String(r.visit_time || '').toLowerCase());
    const count = h => taken.filter(t => HALF[h].slots.includes(t)).length;
    return { date: f.iso, label: f.label, am: count('AM') < cap, pm: count('PM') < cap };
  });
}
function book(l, date, half, by = 'client') {
  const h = HALF[String(half || '').toUpperCase()];
  const ok = fridaySlots().find(s => s.date === date);
  if (!h || !ok) return { ok: false, error: 'That date is not available.' };
  if (!(half.toUpperCase() === 'AM' ? ok.am : ok.pm)) return { ok: false, error: 'That half of the day is now full. Pick another.' };
  const existing = db.prepare("SELECT id FROM site_visits WHERE lead_id=? AND status='booked'").get(l.id);
  if (existing) db.prepare("UPDATE site_visits SET visit_date=?, visit_time=?, note=?, updated_at=datetime('now') WHERE id=?").run(date, h.time, 'Booked online via the estimator (' + half.toUpperCase() + ')', existing.id);
  else db.prepare('INSERT INTO site_visits (id,lead_id,quote_id,visit_date,visit_time,note,booked_by) VALUES (?,?,?,?,?,?,?)')
    .run(newId(), l.id, l.quote_id || null, date, h.time, 'Booked online via the estimator (' + half.toUpperCase() + ')', by);
  db.prepare("UPDATE leads SET stage='visitbooked', status=CASE WHEN status IN ('Won','Lost') THEN status ELSE 'Contacted' END, next_followup=?, est_status='booked', updated_at=datetime('now') WHERE id=?").run(date, l.id);
  const nice = new Date(date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'note', 'visitbooked', null, null, 'client', 'logged', `Site visit booked online: ${nice}, ${half.toUpperCase()}`);
  try { require('./push').notify({ title: `Site visit booked online: ${l.name}`, body: `${nice} ${half.toUpperCase()} · ${l.suburb || l.address || ''}`, url: '/admin/?lead=' + l.id, tag: 'visit-' + l.id }).catch(() => {}); } catch (e) {}
  return { ok: true, date, half: half.toUpperCase(), label: nice };
}
async function sendBookingEmail(l, bk) {
  if (!canInvite(l)) return;
  const f = first(l), phone = settingGet('company_phone') || '0414 147 008';
  const when = `${bk.label}, ${bk.half === 'AM' ? 'morning' : 'afternoon'}`;
  const html = shell(`<p style="margin:0 0 14px;">Hi ${esc(f)},</p>
    <p style="margin:0 0 14px;">Thanks, your site visit request is in for <b>${esc(when)}</b>.</p>
    <p style="margin:0 0 14px;">We have a high number of enquiries at the moment and will do our best to accommodate this time. We will confirm the visit the day before, with an ETA.</p>
    <p style="margin:0 0 14px;">On the day we measure up, check the access and falls, and photograph the site. Your itemised quote follows within 48 hours.</p>
    <p style="margin:0;font-size:13px;color:#5A6068;">Need to change it? Reply to this email or call ${esc(phone)}.</p>
    <p style="margin:18px 0 0;">Estate Landscapers<br><span style="color:#888;font-size:12px;">Licensed Landscapers · LIC 487076C</span></p>`);
  const subject = `Site visit request: ${when}`;
  let outcome = 'sent', err = null;
  try { const r = await sendMail({ to: l.email, subject, html }); if (r && r.skipped) { outcome = 'failed'; err = r.reason; } } catch (e) { outcome = 'failed'; err = e.message; }
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId(), l.id, 'email', 'visitbooked', subject, `Site visit request received for ${when}. We will confirm the day before with an ETA.`, 'auto', outcome, err ? 'NOT SENT: ' + err : null);
}

// ---- tracking: events → sessions → signal -----------------------------------------------------
const GAP = 30 * 60e3;
function logEvent(leadId, visitorKey, type, payload) {
  db.prepare('INSERT INTO estimate_events (id,lead_id,visitor_key,event_type,payload) VALUES (?,?,?,?,?)')
    .run(newId(), leadId, visitorKey || 'unknown', String(type).slice(0, 40), JSON.stringify(payload || {}).slice(0, 4000));
}
function sessionsFor(leadId) {
  const rows = db.prepare('SELECT * FROM estimate_events WHERE lead_id=? ORDER BY created_at ASC').all(leadId);
  const by = {};
  rows.forEach(r => {
    let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch (e) {}
    const list = by[r.visitor_key] || (by[r.visitor_key] = []);
    let s = list[list.length - 1];
    if (!s || ms(r.created_at) - ms(s.ended_at) > GAP) {
      s = { visitor_key: r.visitor_key, started_at: r.created_at, ended_at: r.created_at, active_seconds: 0, screens: {}, answers: 0, unknowns: [], reached_ballpark: false, toggles: 0, booked: false, reaction: null, uploads: 0, events: 0, furthest: '' };
      list.push(s);
    }
    s.ended_at = r.created_at; s.events++;
    switch (r.event_type) {
      case 'heartbeat': s.active_seconds += Number(p.seconds) || 0; Object.entries(p.screens || {}).forEach(([k, v]) => s.screens[k] = (s.screens[k] || 0) + (Number(v) || 0)); break;
      case 'answer': s.answers++; if (p.step) s.furthest = p.step; break;
      case 'unknown': if (p.step && !s.unknowns.includes(p.step)) s.unknowns.push(p.step); break;
      case 'ballpark': s.reached_ballpark = true; s.furthest = 'ballpark'; break;
      case 'tier': s.toggles++; break;
      case 'booked': s.booked = true; s.furthest = 'booked'; break;
      case 'reaction': s.reaction = p.v || null; break;
      case 'upload': s.uploads += Number(p.count) || 0; break;
    }
  });
  const all = [].concat(...Object.values(by));
  all.forEach(s => { const m = visitorMeta(s.visitor_key); s.device = m.device; s.city = m.city; });
  return all.sort((a, b) => ms(b.started_at) - ms(a.started_at));
}
function visitorMeta(k) {
  const r = db.prepare('SELECT device, city FROM visitor_geo WHERE visitor_key=?').get(k) || {};
  return { device: r.device || '', city: r.city || '' };
}
// Rules (all in Settings):
//   hot    booked a Friday; or reached the ballpark and compared tiers est_hot_toggles+ times;
//          or est_hot_sessions+ sessions inside est_hot_window_h
//   warm   reached the ballpark; or answered est_warm_answer_pct % of the questions with
//          est_warm_active_sec+ seconds in one session
//   cold   everything else; "out of budget" reaction is cold whatever else happened
//   hot fades to warm after est_hot_fade_days without a session; warm to cold after est_warm_fade_days
function signalFor(l, sessions) {
  if (!sessions.length) return { signal: 'unopened', why: l.est_status === 'noemail' ? 'no email to send a code to' : l.est_invited_at ? 'code sent, not used yet' : 'not invited' };
  const now = Date.now(), last = ms(sessions[0].started_at), since = now - last;
  const a = answersOf(l), ac = answeredCount(a.current || {});
  const pct = ac.total ? Math.round(100 * ac.answered / ac.total) : 0;
  const reaction = (a.current || {}).priceReaction;
  if (reaction === 'definite-no') return { signal: 'cold', why: 'said the ballpark is out of budget' };
  const inWin = sessions.filter(s => now - ms(s.started_at) <= n('est_hot_window_h', 48) * 3600e3);
  const reached = sessions.some(s => s.reached_ballpark) || !!a.completedAt;
  const toggles = sessions.reduce((t, s) => t + s.toggles, 0);
  let hot = false, why = '';
  if (sessions.some(s => s.booked) || l.est_status === 'booked') { hot = true; why = 'booked a Friday site visit'; }
  else if (reached && toggles >= n('est_hot_toggles', 2)) { hot = true; why = `reached the ballpark, compared tiers ${toggles}×`; }
  else if (inWin.length >= n('est_hot_sessions', 2)) { hot = true; why = `${inWin.length} sessions in ${n('est_hot_window_h', 48)} h`; }
  if (hot && since > n('est_hot_fade_days', 3) * 864e5 && !sessions.some(s => s.booked)) { hot = false; why = `was hot, no session for ${Math.floor(since / 864e5)} d`; }
  if (hot) return { signal: 'hot', why };
  let warm = false;
  if (reached) { warm = true; why = why || 'reached the ballpark, did not book'; }
  else if (sessions.some(s => s.active_seconds >= n('est_warm_active_sec', 60)) && pct >= n('est_warm_answer_pct', 60)) { warm = true; why = why || `answered ${pct}% of the questions`; }
  if (warm && since > n('est_warm_fade_days', 7) * 864e5) { warm = false; why = `was warm, last session ${Math.floor(since / 864e5)} d ago`; }
  if (warm) return { signal: 'warm', why };
  return { signal: 'cold', why: why || (since > 864e5 ? `last session ${Math.floor(since / 864e5)} d ago, ${pct}% answered` : `started, ${pct}% answered`) };
}
const fmt = LA.fmt;
const SCREEN = { gate: 'code entry', address: 'address', property: 'property', builder: 'builder', handover: 'handover', start: 'start', plans: 'drawings', existing: 'to remove', scope: 'scope', area: 'part of block', sizes: 'sizes', access: 'access', steps: 'steps', fall: 'fall', vehicle: 'vehicle', services: 'services', timing: 'timing', driver: 'driver', quotes: 'other quotes', decision: 'decision', review: 'review', ballpark: 'ballpark', reaction: 'reaction', book: 'booking', files: 'uploads', done: 'done' };
function describe(s) {
  const bits = [];
  const top = Object.entries(s.screens).sort((a, b) => b[1] - a[1])[0];
  if (s.booked) bits.push('BOOKED a Friday');
  else if (s.reached_ballpark) bits.push('reached the ballpark');
  else if (s.furthest) bits.push('got to ' + (SCREEN[s.furthest] || s.furthest));
  else bits.push('entered the code, left');
  if (s.answers) bits.push(`${s.answers} answers`);
  if (s.toggles) bits.push(`compared tiers ${s.toggles}×`);
  if (s.reaction) bits.push('reaction: ' + s.reaction);
  if (s.unknowns.length) bits.push(`not sure on ${s.unknowns.map(u => SCREEN[u] || u).join(', ')}`);
  if (top && top[1] >= 20) bits.push(`longest on ${SCREEN[top[0]] || top[0]} (${fmt(top[1])})`);
  if (s.uploads) bits.push(`${s.uploads} file${s.uploads > 1 ? 's' : ''} uploaded`);
  return bits.join(' · ');
}

// Everything the lead card needs, in one object.
function summary(l) {
  const sessions = sessionsFor(l.id);
  const sig = signalFor(l, sessions);
  const a = answersOf(l);
  const ac = answeredCount(a.current || {});
  const live = !!(l.est_code && l.est_code_expires && ms(l.est_code_expires) > Date.now());
  const last = a.versions[a.versions.length - 1];
  return {
    enabled: enabled(),
    invited: !!l.est_invited_at, invitedAt: l.est_invited_at || null, canInvite: canInvite(l),
    code: l.est_code || null, expires: l.est_code_expires || null, live, status: l.est_status || null,
    signal: sig.signal, why: sig.why,
    sessions: sessions.map(s => ({ startedAt: s.started_at, activeLabel: fmt(s.active_seconds), device: s.device, city: s.city, summary: describe(s) })),
    opens: sessions.length, activeLabel: fmt(sessions.reduce((t, s) => t + s.active_seconds, 0)),
    lastSession: sessions.length ? sessions[0].started_at : null,
    answered: ac.answered, total: ac.total, versions: a.versions.length,
    changed: last ? last.changed || [] : [], lastCompletedAt: a.lastCompletedAt || null,
    ballpark: last ? last.ballpark : null, reaction: (a.current || {}).priceReaction || null,
    notes: (a.current || {}).notes || '',
    history: a.versions.map((v, i) => ({ n: i + 1, at: v.at, changed: v.changed || [], ballpark: v.ballpark, emailed: !!v.emailed })),
  };
}
// Compact form for the pipeline board chip.
function quick(l) {
  if (!l.est_invited_at && !l.est_status) return null;
  const sessions = sessionsFor(l.id);
  const sig = signalFor(l, sessions);
  return { signal: sig.signal, why: sig.why, opens: sessions.length, lastSession: sessions.length ? sessions[0].started_at : null, status: l.est_status || null };
}

module.exports = { isFit, applyReaction, sampleStatus, toolBase, NOT_FIT_TEXT, NOT_FIT_HELP, enabled, autoInvite, nextFridaysSydney, seedDefaults, DEFAULTS, onlineSteps, sizesFor, applicable, answeredCount, FALL_SCALE,
  invite, canInvite, introEmail, verify, byToken, answersOf, prefillFrom, saveAnswers, complete, clientText, sendBallparkEmail,
  fridaySlots, book, sendBookingEmail, logEvent, sessionsFor, signalFor, summary, quick, estimatorLink, sampleQuoteLink };
