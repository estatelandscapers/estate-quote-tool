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

// ---- hipages "Job Details" parser ---------------------------------------------
// Built from a real accepted-lead email (Sep 2026), not guessed. The HTML template is far
// more reliable than the plain text: the text part runs the client's name and suburb
// together on one line ("Chris Cordwell Burraneer, 2230") with no way to tell a two-word
// surname from a two-word suburb, while the HTML puts the name in its own <p> and anchors
// the suburb to a location-pin image. So: parse the HTML first, fall back to text.
function parseHipages(html, text) {
  const h = String(html || '');
  const t = String(text || '');
  const out = {};
  const decode = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, '\u2019').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // Name + suburb + postcode in one anchored shot: the <p> holding the name is immediately
  // followed by the <p> holding the location-pin image and "Suburb, 2230".
  let m = h.match(/<p[^>]*>\s*([^<>]{3,60}?)\s*<\/p>\s*<p[^>]*>\s*<img[^>]*location[^>]*>\s*([^<>,]{2,60}?),\s*(\d{4})\s*<\/p>/i);
  if (m) { out.name = decode(m[1]); out.suburb = decode(m[2]) + ', ' + m[3]; }
  else {
    // Text fallback: assume a two-word client name; the rest before ", NNNN" is the suburb.
    // Hipages leads carry first + last name; a three-word name costs a word to the suburb
    // and the lead is flagged for review rather than silently wrong.
    m = t.match(/\n\s*([A-Z][\w'\u2019-]+\s+[A-Z][\w'\u2019-]+)\s+([A-Za-z][A-Za-z'\u2019 -]{1,40}?),\s*(\d{4})\b/);
    if (m) { out.name = m[1].trim(); out.suburb = m[2].trim() + ', ' + m[3]; }
  }
  m = h.match(/Category:\s*<\/span>\s*([^<]{2,80})/i) || t.match(/\n\s*Category:\s*([^\n]{2,80})/i);
  if (m) out.category = decode(m[1]);
  m = h.match(/Description:\s*<\/span>\s*([\s\S]{5,1500}?)<\/p>/i);
  if (m) out.description = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  // The extra questions ("Approximate size of lawn: 100 - 250 sqm") are real scoping
  // answers — keep them, but separate from the description.
  const qa = [];
  const re = /<span[^>]*>\s*([A-Z][^<:]{2,60}?)\??:\s*<\/span>\s*([^<]{1,120})/gi;
  let q; while ((q = re.exec(h))) {
    const label = decode(q[1]);
    if (/^(category|description)$/i.test(label)) continue;
    qa.push(`${label}: ${decode(q[2])}`);
  }
  if (qa.length) out.extraAnswers = qa;
  return out;
}

// Platform-specific parsers, tried after the generic one; their fields win.
const PLATFORM_PARSERS = { hipages: parseHipages };

// ---- creating the lead -------------------------------------------------------
function alreadySeen(messageId) {
  if (!messageId) return false;
  return !!db.prepare('SELECT id FROM mail_ingest WHERE message_id=?').get(messageId);
}

function createFromEmail({ messageId, from, subject, text, html, receivedAt }) {
  const platform = detectPlatform(from, subject);
  const p = parseEnquiry(text, subject);
  // Platform-specific parser wins on any field it found. The generic patterns stay as the
  // safety net for platforms without a real sample yet.
  const pp = PLATFORM_PARSERS[String(platform || '').toLowerCase()];
  if (pp) {
    const extra = pp(html, text) || {};
    for (const k of ['name', 'suburb', 'description', 'category', 'extraAnswers']) {
      if (extra[k]) { if (!p[k]) p.confidence++; p[k] = extra[k]; }
    }
  }
  const needsReview = p.confidence < 3 || !p.phone;
  // "Lawn & Turf Laying" from the platform beats scope words guessed from prose.
  const jobType = p.category || (p.scope || []).join(', ');
  const noteParts = [p.description || '', ...(p.extraAnswers || [])].filter(Boolean);

  const id = newId();
  db.prepare(`INSERT INTO leads (id,name,phone,email,address,suburb,source,notes,status,stage,next_followup,job_type,call_answers)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, p.name || '(name not found)', p.phone || '', p.email || '',
    p.suburb || '', p.suburb || '', platform || 'Email enquiry',
    noteParts.join('\n'), 'New', 'call1',
    new Date().toISOString().slice(0, 10),          // call them today
    jobType,
    JSON.stringify({ scope: p.scope || [], _prefill: {
      name: p.name || null, phone: p.phone || null, email: p.email || null,
      suburb: p.suburb || null, description: p.description || null,
      timing: p.timing || null, budget: p.budget || null, propertyType: p.propertyType || null,
      category: p.category || null, extraAnswers: p.extraAnswers || null,
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
    // Sender filter, e.g. "mg.hipages.com.au". Without it the poller treats EVERY unseen
    // message as an enquiry — right for a dedicated leads@ mailbox, disastrous for a main
    // inbox. With it, only matching senders are read, and nothing is marked \Seen, so the
    // owner's unread state is untouched; Message-ID dedupe stops re-ingestion instead.
    fromFilter: process.env.IMAP_FROM || settingGet('imap_from') || '',
  };
}
const configured = () => { const c = mailConfig(); return !!(c.host && c.user && c.pass); };

// Actually log in to the mailbox and count matching mail — the difference between "the
// variables are set" and "Google accepts them". Same distinction as the ZeptoMail test.
async function testConnection() {
  const c = mailConfig();
  if (!configured()) return { ok: false, error: 'Not configured — set IMAP_HOST, IMAP_USER and IMAP_PASS in Railway.' };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass }, logger: false,
    // Without these a blocked or misrouted network leaves the button spinning for the
    // OS TCP timeout — minutes. Fail in seconds with a message instead.
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000 });
  const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out after 15s — Gmail did not respond. Check the host and that Railway can reach imap.gmail.com.')), 15000).unref());
  try {
    await Promise.race([client.connect(), deadline]);
    const lock = await client.getMailboxLock(c.folder);
    let matching = 0;
    try {
      const query = c.fromFilter
        ? { from: c.fromFilter, since: new Date(Date.now() - BACKFILL_DAYS * 864e5) }
        : { seen: false };
      matching = ((await client.search(query, { uid: true })) || []).length;
    } finally { lock.release(); }
    await client.logout();
    return { ok: true, user: c.user, host: c.host, folder: c.folder,
      fromFilter: c.fromFilter || null, matching, windowDays: c.fromFilter ? BACKFILL_DAYS : null,
      watching: !!timer };
  } catch (e) {
    try { client.close(); } catch (x) {}
    let hint = '';
    if (/auth|login|credentials/i.test(e.message)) hint = 'Gmail rejected the login. Use an App Password (not the account password), pasted without spaces, and check 2-Step Verification is on.';
    return { ok: false, user: c.user, host: c.host, error: e.message, hint, watching: !!timer };
  }
}

// How far back the filtered search looks. Two weeks: far enough that leads accepted while
// the tool was being set up (or down) are picked up, near enough not to resurrect history.
const BACKFILL_DAYS = 14;

// Read anything matching, create leads, never touch flags in filtered mode.
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
      // Filtered (shared inbox) mode searches by SENDER + DATE, deliberately ignoring the
      // read flag. Anything else with this mailbox open — the hipages bot, Gmail on a
      // phone — marks mail read the moment it's looked at, and an unseen-only search would
      // then silently skip that lead forever. Message-ID dedupe makes re-reads harmless.
      const query = c.fromFilter
        ? { from: c.fromFilter, since: new Date(Date.now() - BACKFILL_DAYS * 864e5) }
        : { seen: false };
      const uids = await client.search(query, { uid: true });
      const take = (uids || []).slice(-limit);
      // In filtered (main inbox) mode, never touch flags — the owner's unread markers are
      // theirs. Dedupe by Message-ID makes re-reading the same mail harmless.
      const mark = async uid => { if (!c.fromFilter) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); };
      for (const uid of take) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || (msg.envelope && msg.envelope.messageId) || null;
        if (alreadySeen(messageId)) { skipped.push('duplicate'); await mark(uid); continue; }
        const from = (parsed.from && parsed.from.text) || '';
        const subject = parsed.subject || '';
        const text = parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, '\n');
        // Ignore anything that clearly isn't an enquiry.
        if (/^(re:|fwd:)/i.test(subject) && !detectPlatform(from, subject)) {
          skipped.push('reply'); await mark(uid); continue;
        }
        created.push(createFromEmail({ messageId, from, subject, text, html: parsed.html || '', receivedAt: parsed.date }));
        await mark(uid);
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

module.exports = { pollOnce, startPolling, configured, mailConfig, parseEnquiry, detectPlatform, createFromEmail, PLATFORMS, parseHipages, testConnection };
