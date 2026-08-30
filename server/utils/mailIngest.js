// Reads enquiry emails from a mailbox and turns them into leads, automatically.
//
// Design decisions worth knowing:
//  * Point this at a DEDICATED mailbox (leads@…), not the main business inbox. The
//    credential lives in Railway; if it ever leaked, exposure is limited to enquiries.
//  * Every message is deduplicated on its Message-ID, so a restart, a re-poll or a
//    second server can never create the same lead twice.
//  * A message that can't be parsed still creates a lead, flagged for review, with the
//    full text attached. Silently dropping an enquiry is the worst possible failure.
//  * Nothing is deleted from the mailbox. Messages are marked \Seen only.
const { db, settingGet } = require('../db');
const { newId } = require('./ids');

// ---- platform recognition ----------------------------------------------------
// Matched on the sender first (reliable), then the subject (fallback).
const PLATFORMS = [
  { name: 'hipages',        from: /hipages|hipages\.com\.au/i,        subject: /hipages/i },
  { name: 'ServiceSeeking', from: /serviceseeking/i,                  subject: /service ?seeking/i },
  { name: 'Airtasker',      from: /airtasker/i,                       subject: /airtasker/i },
  { name: 'Bark',           from: /bark\.com|barkteam/i,              subject: /\bbark\b/i },
  { name: 'Houzz',          from: /houzz/i,                           subject: /houzz/i },
  { name: 'Yellow Pages',   from: /yellowpages|sensis/i,              subject: /yellow ?pages/i },
  { name: 'Our website',    from: /estatelandscapers/i,               subject: /website|contact form|enquiry form/i },
];

function detectPlatform(from, subject) {
  const f = String(from || ''), s = String(subject || '');
  const byFrom = PLATFORMS.find(p => p.from.test(f));
  if (byFrom) return byFrom.name;
  const bySubject = PLATFORMS.find(p => p.subject.test(s));
  return bySubject ? bySubject.name : null;
}

// ---- field extraction --------------------------------------------------------
// Deliberately generic. Once real enquiry emails are available these become
// per-platform patterns, but the generic set already handles labelled fields.
const FIELD_PATTERNS = {
  name: [/(?:^|\n)\s*(?:customer|client|contact|name|from)\s*[:\-]\s*([^\n<]{2,60})/i],
  phone: [/(?:^|\n)\s*(?:phone|mobile|contact number|tel|ph)\s*[:\-]\s*([\d\s+()\-]{8,20})/i,
          /\b(0[45]\d{2}[\s\-]?\d{3}[\s\-]?\d{3})\b/],
  email: [/(?:^|\n)\s*(?:email|e-mail)\s*[:\-]\s*([\w.\-+]+@[\w\-]+\.[\w.\-]+)/i,
          /\b([\w.\-+]+@[\w\-]+\.[\w.\-]+)\b/],
  suburb: [/(?:^|\n)\s*(?:suburb|location|area|site address|address|postcode)\s*[:\-]\s*([^\n]{2,80})/i],
  description: [/(?:^|\n)\s*(?:description|job details|details|about the job|what.{0,12}needed|message)\s*[:\-]?\s*\n?([\s\S]{10,600}?)(?:\n\s*\n|when do you|budget|property type|preferred|$)/i],
  timing: [/(?:^|\n)\s*(?:when do you need[^:\-]*|timeframe|time frame|timing|start date|urgency)\s*[:\-]\s*([^\n]{2,60})/i],
  budget: [/(?:^|\n)\s*budget\s*[:\-]\s*([^\n]{2,60})/i],
  propertyType: [/(?:^|\n)\s*property type\s*[:\-]\s*([^\n]{2,40})/i],
};

// Words in the description that map onto price-list deliverables.
const SCOPE_WORDS = [
  ['turf', /\bturf|lawn|grass\b/i], ['beds', /garden bed|mulch|garden ?mix/i],
  ['wall', /retain/i], ['drive', /concrete|driveway|slab/i],
  ['rock', /decorative rock|pebble|gravel/i],
  // "along the back fence" is a location, not a job. Only count fencing when it reads
  // like work — new fence, replace the fence, X metres of fencing.
  ['fence', /fenc\w*/i],  // see fenceIsWork() — "back fence" as a location is filtered out
  ['gates', /\bgate\b/i], ['steppers', /stepping stone/i],
  ['planting', /plant(ing|s)?|shrub|tree/i], ['drainage', /drain|ag ?line|sump/i],
];

// "a retaining wall along the back fence" mentions a fence but isn't fencing work.
// Treat it as work only when a verb or a specification sits near the word.
function fenceIsWork(text) {
  const near = /(?:new|replace|replacing|install|installing|build|building|supply|repair|remove|removing|colorbond|paling|timber|glass|pool)\s+(?:\w+\s+){0,2}fenc|fenc\w*\s+(?:replaced|installed|removed|repaired|supplied|and gate)|\d+\s*(?:m|metre|meter)s?\s+of\s+fenc|fencing\b/i;
  const location = /(?:along|against|near|beside|behind|to|from)\s+(?:the\s+)?(?:back|side|front|rear|neighbou?r'?s?)\s+fence/i;
  if (near.test(text)) return true;
  if (location.test(text)) return false;
  return /\bfence\b/i.test(text) && !/back fence|side fence|existing fence/i.test(text);
}
const first = (text, pats) => {
  for (const re of pats) { const m = text.match(re); if (m && m[1]) return m[1].trim().replace(/\s+/g, ' '); }
  return null;
};

function parseEnquiry(text, subject) {
  const t = String(text || '');
  const out = { confidence: 0 };
  for (const [key, pats] of Object.entries(FIELD_PATTERNS)) {
    const v = first(t, pats);
    if (v) { out[key] = v; out.confidence++; }
  }
  const hay = (out.description || '') + ' ' + t;
  out.scope = SCOPE_WORDS.filter(([id, re]) => {
    if (!re.test(hay)) return false;
    if (id === 'fence') return fenceIsWork(hay);
    return true;
  }).map(([id]) => id);
  if (out.scope.length) out.confidence++;
  // A name in the subject line — "New lead: Michael Birch" — when the body has none.
  if (!out.name && subject) {
    const m = String(subject).match(/(?:lead|enquiry|request|job)[^:]*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
    if (m) out.name = m[1];
  }
  if (out.phone) out.phone = out.phone.replace(/[^\d+]/g, '').replace(/^(\+?61)?/, m => m ? '0' : '').slice(0, 15);
  return out;
}

// ---- creating the lead -------------------------------------------------------
function alreadySeen(messageId) {
  if (!messageId) return false;
  return !!db.prepare('SELECT id FROM mail_ingest WHERE message_id=?').get(messageId);
}

function createFromEmail({ messageId, from, subject, text, receivedAt }) {
  const platform = detectPlatform(from, subject);
  const p = parseEnquiry(text, subject);
  const needsReview = p.confidence < 3 || !p.phone;

  const id = newId();
  db.prepare(`INSERT INTO leads (id,name,phone,email,address,suburb,source,notes,status,stage,next_followup,job_type,call_answers)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, p.name || '(name not found)', p.phone || '', p.email || '',
    p.suburb || '', p.suburb || '', platform || 'Email enquiry',
    p.description || '', 'New', 'call1',
    new Date().toISOString().slice(0, 10),          // call them today
    (p.scope || []).join(', '),
    JSON.stringify({ scope: p.scope || [], _prefill: {
      name: p.name || null, phone: p.phone || null, email: p.email || null,
      suburb: p.suburb || null, description: p.description || null,
      timing: p.timing || null, budget: p.budget || null, propertyType: p.propertyType || null,
      platform, confirmed: {},
    } }));

  db.prepare(`INSERT INTO mail_ingest (id,message_id,lead_id,platform,subject,sender,raw,parsed,needs_review,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
    newId(), messageId || ('no-id-' + id), id, platform, subject || '', from || '',
    String(text || '').slice(0, 20000), JSON.stringify(p), needsReview ? 1 : 0);

  console.log(`[mail] lead created from ${platform || 'unknown'}: ${p.name || 'unnamed'}${needsReview ? ' (NEEDS REVIEW)' : ''}`);
  return { leadId: id, platform, parsed: p, needsReview };
}

// ---- the mailbox -------------------------------------------------------------
function mailConfig() {
  return {
    host: process.env.IMAP_HOST || settingGet('imap_host') || '',
    port: parseInt(process.env.IMAP_PORT || settingGet('imap_port') || '993', 10),
    user: process.env.IMAP_USER || settingGet('imap_user') || '',
    pass: process.env.IMAP_PASS || '',
    folder: process.env.IMAP_FOLDER || settingGet('imap_folder') || 'INBOX',
  };
}
const configured = () => { const c = mailConfig(); return !!(c.host && c.user && c.pass); };

// Read anything unseen, create leads, mark seen. Never deletes.
async function pollOnce({ limit = 25 } = {}) {
  const c = mailConfig();
  if (!configured()) return { ok: false, reason: 'Mailbox not configured — set IMAP_HOST, IMAP_USER and IMAP_PASS.' };

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass }, logger: false });

  const created = [], skipped = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(c.folder);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const take = (uids || []).slice(-limit);
      for (const uid of take) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || (msg.envelope && msg.envelope.messageId) || null;
        if (alreadySeen(messageId)) { skipped.push('duplicate'); await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); continue; }
        const from = (parsed.from && parsed.from.text) || '';
        const subject = parsed.subject || '';
        const text = parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, '\n');
        // Ignore anything that clearly isn't an enquiry.
        if (/^(re:|fwd:)/i.test(subject) && !detectPlatform(from, subject)) {
          skipped.push('reply'); await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); continue;
        }
        created.push(createFromEmail({ messageId, from, subject, text, receivedAt: parsed.date }));
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    console.error('[mail] poll failed:', e.message);
    return { ok: false, reason: e.message };
  }
  return { ok: true, created: created.length, skipped: skipped.length, leads: created };
}

// Poll on a timer once the app is up. Interval is a setting; 0 turns it off.
let timer = null;
function startPolling() {
  const mins = parseInt(process.env.IMAP_POLL_MINUTES || settingGet('imap_poll_minutes') || '10', 10);
  if (timer) clearInterval(timer);
  if (!mins || !configured()) return false;
  timer = setInterval(() => { pollOnce().catch(e => console.error('[mail]', e.message)); }, mins * 60000);
  console.log(`[mail] watching ${mailConfig().user} every ${mins} min`);
  setTimeout(() => pollOnce().catch(() => {}), 8000);   // one pass shortly after boot
  return true;
}

module.exports = { pollOnce, startPolling, configured, mailConfig, parseEnquiry, detectPlatform, createFromEmail, PLATFORMS };
