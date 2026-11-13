// SMS — automatic and hand-sent text messages, through Mobile Message (mobilemessage.com.au).
//
// Works like email.js: the login lives in Railway variables, never in the database.
//   MOBILEMESSAGE_USERNAME, MOBILEMESSAGE_PASSWORD   the API username and password
//   SMS_SENDER                                       the registered sender name, e.g. EstateLands
//
// Three safety rules this file exists to enforce:
//   1. MODE. Off = nothing is sent. Trial = only the mobile numbers on the trial list receive
//      anything; every other message is recorded as "held" so you can read what would have
//      gone, but nothing leaves. Live = everyone.
//   2. EACH MESSAGE TYPE HAS ITS OWN SWITCH, and every switch starts off.
//   3. NOTHING IS SENT TWICE. Each automatic message has a key (one enquiry text per lead,
//      one follow-up per quote, one reminder per site visit) and a second attempt is ignored.
//      Reminders only look at things that happened after their switch was turned on, so
//      turning one on never texts a backlog of old leads.
const { db, settingGet, settingSet } = require('../db');
const { newId } = require('./ids');
const { sydneyParts } = require('./refs');

db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
  id TEXT PRIMARY KEY, lead_id TEXT, quote_id TEXT, type TEXT, ref TEXT, to_number TEXT, body TEXT,
  status TEXT,            -- sent | failed | held (trial) | skipped (no mobile, switched off…)
  provider_id TEXT, parts INTEGER, cost REAL, error TEXT, sent_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_ref ON sms_log(ref);
CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_log(created_at);`);

const API = () => (process.env.SMS_API_URL || 'https://api.mobilemessage.com.au').replace(/\/+$/, '');
const sender = () => String(process.env.SMS_SENDER || '').trim();
const configured = () => !!(process.env.MOBILEMESSAGE_USERNAME && process.env.MOBILEMESSAGE_PASSWORD && sender());
const mode = () => { const m = settingGet('sms_mode'); return m === 'live' || m === 'trial' ? m : 'off'; };

// What can be sent, in the order the client meets them. `vars` is what the wording may use.
const TYPES = [
  { key: 'enquiry', label: 'Enquiry received', when: 'Straight after a website enquiry arrives.', vars: ['first', 'ref', 'phone'],
    def: 'Estate Landscapers: thanks {{first}}, we have your enquiry (ref {{ref}}) and will be in touch shortly. Questions? Call {{phone}}.' },
  { key: 'invite', label: 'Estimator invite', when: 'With the email that sends the online estimate code.', vars: ['first', 'link', 'code', 'phone'],
    def: 'Estate Landscapers: Hi {{first}}, get a ballpark for your project online in about 8 minutes: {{link}} Your code is {{code}}. Questions? Call {{phone}}.' },
  { key: 'est_reminder', label: 'Estimate reminder', when: 'If the online estimate is still not finished after the number of days below.', vars: ['first', 'link', 'code', 'phone'], days: 2,
    def: 'Estate Landscapers: Hi {{first}}, your online estimate is still waiting. It takes about 8 minutes: {{link}} Code {{code}}. Stuck on a question? Call {{phone}} and we will help.' },
  { key: 'visit', label: 'Site visit reminder', when: 'The afternoon before a booked site visit.', vars: ['first', 'when', 'phone'],
    def: 'Estate Landscapers: Hi {{first}}, a reminder that your site visit is tomorrow, {{when}}. Need to change it? Call {{phone}}.' },
  { key: 'quote', label: 'Quote sent', when: 'When you press Send to client on a quote.', vars: ['first', 'quote', 'link', 'phone'],
    def: 'Estate Landscapers: Hi {{first}}, your quote {{quote}} is ready to view: {{link}} Questions? Call {{phone}}.' },
  { key: 'quote_followup', label: 'Quote follow-up', when: 'If the quote is still not accepted after the number of days below.', vars: ['first', 'quote', 'link', 'phone'], days: 3,
    def: 'Estate Landscapers: Hi {{first}}, checking in on quote {{quote}}. Any questions, or changes you would like? Call {{phone}} or reply to our email. {{link}}' },
  { key: 'signed', label: 'Contract signed', when: 'When the client signs and the contract is emailed.', vars: ['first', 'quote', 'phone'],
    def: 'Estate Landscapers: thank you {{first}}. Your signed contract for quote {{quote}} has been emailed to you. We will call to confirm scheduling.' },
];
const typeOf = k => TYPES.find(t => t.key === k);
const isOn = k => settingGet('sms_on_' + k) === '1';
const textOf = k => { const s = settingGet('sms_text_' + k); return s && String(s).trim() ? String(s) : typeOf(k).def; };
const daysOf = k => { const d = parseFloat(settingGet('sms_days_' + k)); return isFinite(d) && d > 0 ? d : typeOf(k).days; };

// ---- numbers and text -------------------------------------------------------------------
// Australian mobiles only: 04xx xxx xxx in any spacing, with or without +61. Anything else
// (a landline, an overseas number, a typo) is refused rather than paid for and bounced.
function mobile(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('0061')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('04')) return '61' + d.slice(1);
  if (d.length === 9 && d.startsWith('4')) return '61' + d;
  if (d.length === 11 && d.startsWith('614')) return d;
  return null;
}
const trialNumbers = () => String(settingGet('sms_trial_numbers') || '').split(/[,\n;]+/).map(mobile).filter(Boolean);

// Curly quotes and long dashes force a text into the expensive 70-character format. Swap
// them for plain ones; anything else unusual is left alone and simply costs what it costs.
const plain = s => String(s || '').replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ');
const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
function measure(text) {
  const t = plain(text), uni = !GSM.test(t);
  const one = uni ? 70 : 160, multi = uni ? 67 : 153;
  return { chars: t.length, unicode: uni, parts: t.length <= one ? 1 : Math.ceil(t.length / multi) };
}
function fill(tpl, vars) {
  return plain(String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] == null ? '' : String(vars[k])))
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';
const companyPhone = () => settingGet('company_phone') || '0414 147 008';

// ---- the provider -----------------------------------------------------------------------
async function providerCall(path, opts = {}) {
  const auth = Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD}`).toString('base64');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API() + path, { ...opts, signal: ctl.signal, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
  } catch (e) {
    return { status: 0, ok: false, body: { error: e.name === 'AbortError' ? 'Mobile Message did not answer in time.' : 'Could not reach Mobile Message: ' + e.message } };
  } finally { clearTimeout(timer); }
}
const HINTS = [
  [/unauthor|401/i, 'The API username or password in Railway is wrong.'],
  [/insufficient credit/i, 'The Mobile Message account is out of credit. Top it up in their dashboard.'],
  [/no allowed senders|sender/i, 'The sender name is not approved on the Mobile Message account yet, or SMS_SENDER in Railway is spelt differently.'],
];
const hintFor = msg => (HINTS.find(h => h[0].test(msg || '')) || [])[1] || null;

async function deliver(to, body, id) {
  const r = await providerCall('/v1/messages', { method: 'POST', headers: { 'Idempotency-Key': id },
    body: JSON.stringify({ messages: [{ to: '+' + to, message: body, sender: sender(), custom_ref: id }], max_parts: 4 }) });
  if (!r.ok) { const e = (r.body && r.body.error) || `Mobile Message refused the request (${r.status}).`; return { ok: false, error: r.status === 401 ? 'Unauthorized (401)' : e }; }
  const res = (r.body.results || [])[0] || {};
  if (res.status && res.status !== 'success') return { ok: false, error: res.error || `Message ${res.status}` };
  return { ok: true, providerId: res.message_id || null, cost: res.cost != null ? Number(res.cost) : null };
}

// ---- send -------------------------------------------------------------------------------
// The one way a text leaves the tool. Never throws: the caller's real work (the email, the
// quote, the signed contract) must not fail because a text could not be sent.
//   type      one of TYPES, or 'manual' / 'test'
//   ref       the once-only key for automatic messages
//   lead      lead row (for the number and the history entry); `to` overrides the number
//   history   false when the caller writes the lead history entry itself
async function send({ type, ref, lead, quoteId, to, body, by = 'auto', history = true }) {
  const auto = !!typeOf(type);
  const log = (status, extra = {}) => {
    const id = extra.id || newId();
    db.prepare('INSERT INTO sms_log (id,lead_id,quote_id,type,ref,to_number,body,status,provider_id,parts,cost,error,sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, lead ? lead.id : null, quoteId || null, type, ref || null, extra.to || null, body || null, status, extra.providerId || null, body ? measure(body).parts : null, extra.cost == null ? null : extra.cost, extra.error || null, by);
    return { ok: status === 'sent', status, error: extra.error || null, hint: hintFor(extra.error), id };
  };
  try {
    const m = mode();
    if (auto) {
      if (m === 'off' || !isOn(type)) return { ok: false, status: 'off' };            // not logged: nothing was attempted
      if (ref && db.prepare("SELECT 1 FROM sms_log WHERE ref=? AND status IN ('sent','held') LIMIT 1").get(ref)) return { ok: false, status: 'duplicate' };
    } else if (type !== 'test' && m === 'off') return { ok: false, status: 'off', error: 'SMS is switched off in Editor → Settings.' };
    if (!configured()) return auto ? { ok: false, status: 'unconfigured' } : { ok: false, status: 'unconfigured', error: 'SMS is not connected yet. Add the Mobile Message variables in Railway.' };
    const num = mobile(to || (lead && lead.phone));
    if (!num) return log('skipped', { error: 'No Australian mobile number on the lead' });
    body = plain(body || '').trim();
    if (!body) return log('skipped', { to: num, error: 'Empty message' });
    if (type !== 'test' && m === 'trial' && !trialNumbers().includes(num)) return log('held', { to: num, error: 'Trial mode: this number is not on the trial list, so it was not sent' });
    const id = newId();
    const r = await deliver(num, body, id);
    const out = log(r.ok ? 'sent' : 'failed', { id, to: num, providerId: r.providerId, cost: r.cost, error: r.error });
    if (lead && history) {
      db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(newId(), lead.id, 'sms', lead.stage || null, null, body, by, r.ok ? 'sent' : 'failed',
          `${auto ? 'Automatic text: ' + typeOf(type).label : 'Text message'}${r.ok ? '' : ' · NOT SENT: ' + r.error}`);
    }
    if (!r.ok) console.log(`[sms] ${type} to ${num} failed: ${r.error}`);
    return out;
  } catch (e) { console.error('[sms] send error:', e.message); return { ok: false, status: 'failed', error: e.message }; }
}

// ---- the automatic messages -------------------------------------------------------------
const toolBase = () => { try { return require('./estimator').toolBase(); } catch (e) { return ''; } };
const estLink = () => String(settingGet('est_url') || 'https://estatelandscapers.com.au/residential/quote/').split('?')[0];
const leadById = id => id ? db.prepare('SELECT * FROM leads WHERE id=?').get(id) : null;

function enquiry(lead) {
  if (!lead) return;
  return send({ type: 'enquiry', ref: 'enquiry:' + lead.id, lead, body: fill(textOf('enquiry'), { first: firstName(lead.name), ref: lead.enquiry_ref || '', phone: companyPhone() }) });
}
function invite(lead, { resend } = {}) {
  if (!lead) return;
  // A resend by hand is a new message, so it gets its own key; the automatic one is once only.
  return send({ type: 'invite', ref: 'invite:' + lead.id + (resend ? ':' + Date.now() : ''), lead,
    body: fill(textOf('invite'), { first: firstName(lead.name), link: estLink(), code: lead.est_code || '', phone: companyPhone() }) });
}
function quoteSent(q, link) {
  const lead = leadById(q && q.lead_id); if (!lead) return;
  return send({ type: 'quote', ref: `quote:${q.id}:${q.send_count || 0}`, lead, quoteId: q.id,
    body: fill(textOf('quote'), { first: firstName(q.client_name || lead.name), quote: q.quote_number || '', link, phone: companyPhone() }) });
}
function signed(q) {
  const lead = leadById(q && q.lead_id); if (!lead) return;
  return send({ type: 'signed', ref: 'signed:' + q.id, lead, quoteId: q.id,
    body: fill(textOf('signed'), { first: firstName(q.client_name || lead.name), quote: q.quote_number || '', phone: companyPhone() }) });
}

// ---- reminders (every 5 minutes, texts only between 9 am and 6 pm Sydney) ---------------
const sydneyHour = () => parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(new Date()), 10);
const sqlAgo = days => new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
// A reminder only considers events from after its switch was last turned on.
const sinceOn = k => settingGet('sms_on_at_' + k) || '9999';

async function runReminders() {
  if (mode() === 'off' || !configured()) return;
  const h = sydneyHour(); if (h < 9 || h >= 18) return;
  const now = sqlAgo(0);

  if (isOn('est_reminder')) {
    const d = daysOf('est_reminder');
    const rows = db.prepare(`SELECT * FROM leads WHERE est_invited_at IS NOT NULL AND est_invited_at <= ? AND est_invited_at >= ? AND est_invited_at >= ?
        AND COALESCE(est_status,'') IN ('invited','started') AND status NOT IN ('Won','Lost') AND COALESCE(parked,0)=0
        AND est_code IS NOT NULL AND COALESCE(est_code_expires,'') > ? LIMIT 20`).all(sqlAgo(d), sqlAgo(d + 7), sinceOn('est_reminder'), now);
    for (const l of rows) await send({ type: 'est_reminder', ref: 'est_reminder:' + l.id, lead: l,
      body: fill(textOf('est_reminder'), { first: firstName(l.name), link: estLink(), code: l.est_code, phone: companyPhone() }) });
  }

  if (isOn('quote_followup')) {
    const d = daysOf('quote_followup'), base = toolBase();
    const rows = db.prepare(`SELECT q.* FROM quotes q WHERE q.sent_at IS NOT NULL AND q.sent_at <= ? AND q.sent_at >= ? AND q.sent_at >= ?
        AND q.status IN ('sent','viewed','draft') AND q.lost_at IS NULL AND COALESCE(q.is_sample,0)=0 AND COALESCE(q.link_off,0)=0 AND q.lead_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM quotes n WHERE n.parent_number=q.parent_number AND n.created_at > q.created_at)
        AND NOT EXISTS (SELECT 1 FROM quotes a WHERE a.parent_number=q.parent_number AND a.status='accepted') LIMIT 20`).all(sqlAgo(d), sqlAgo(d + 7), sinceOn('quote_followup'));
    for (const q of rows) {
      const lead = leadById(q.lead_id); if (!lead || ['Won', 'Lost'].includes(lead.status) || lead.parked) continue;
      await send({ type: 'quote_followup', ref: 'quote_followup:' + q.id, lead, quoteId: q.id,
        body: fill(textOf('quote_followup'), { first: firstName(q.client_name || lead.name), quote: q.quote_number || '', link: base ? `${base}/q/${q.token}` : '', phone: companyPhone() }) });
    }
  }

  if (isOn('visit') && h >= 15) {
    const t = new Date(sydneyParts().ymd + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1);
    const tomorrow = t.toISOString().slice(0, 10);
    const rows = db.prepare("SELECT * FROM site_visits WHERE status='booked' AND visit_date=? AND lead_id IS NOT NULL AND created_at >= ? LIMIT 30").all(tomorrow, sinceOn('visit'));
    for (const v of rows) {
      const lead = leadById(v.lead_id); if (!lead || ['Won', 'Lost'].includes(lead.status)) continue;
      const day = new Date(v.visit_date + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
      await send({ type: 'visit', ref: `visit:${v.id}:${v.visit_date}`, lead,
        body: fill(textOf('visit'), { first: firstName(lead.name), when: [day, v.visit_time].filter(Boolean).join(' at '), phone: companyPhone() }) });
    }
  }
}
function start() {
  setInterval(() => { runReminders().catch(e => console.error('[sms] reminders:', e.message)); }, 5 * 60e3).unref();
}

// ---- for the Settings page --------------------------------------------------------------
function state() {
  return {
    configured: configured(), sender: sender() || null, mode: mode(), trialNumbers: String(settingGet('sms_trial_numbers') || ''),
    types: TYPES.map(t => ({ key: t.key, label: t.label, when: t.when, vars: t.vars, on: isOn(t.key), text: textOf(t.key), def: t.def,
      days: t.days ? daysOf(t.key) : null, measure: measure(fill(textOf(t.key), SAMPLE)) })),
    recent: db.prepare(`SELECT s.type, s.to_number, s.body, s.status, s.error, s.sent_by, s.created_at, s.parts, l.name AS lead FROM sms_log s LEFT JOIN leads l ON l.id=s.lead_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 25`).all(),
    counts: db.prepare("SELECT status, COUNT(*) n FROM sms_log WHERE created_at >= datetime('now','-30 days') GROUP BY status").all(),
  };
}
// What the wording is measured against on the Settings page: typical lengths, not a real client.
const SAMPLE = { first: 'Jonathan', ref: 'ENQ-2026-1101', phone: '0414 147 008', code: '4821', quote: '1437.1', when: 'Friday 20 November at 10:30am',
  link: 'https://quotes.estatelandscapers.com.au/q/abcdefghijklmnop' };

function save(b) {
  if (['off', 'trial', 'live'].includes(b.mode)) settingSet('sms_mode', b.mode);
  if (b.trialNumbers !== undefined) settingSet('sms_trial_numbers', String(b.trialNumbers || '').slice(0, 600));
  (b.types || []).forEach(t => {
    if (!typeOf(t.key)) return;
    if (t.on !== undefined) {
      const was = isOn(t.key);
      settingSet('sms_on_' + t.key, t.on ? '1' : '0');
      if (t.on && !was) settingSet('sms_on_at_' + t.key, sqlAgo(0));       // reminders start from now
    }
    if (t.text !== undefined) settingSet('sms_text_' + t.key, String(t.text || '').slice(0, 600));
    if (t.days !== undefined && typeOf(t.key).days) settingSet('sms_days_' + t.key, String(t.days || ''));
  });
}
// Ask Mobile Message directly: does the login work, how much credit, is the sender approved.
async function check() {
  if (!configured()) return { ok: false, error: 'Add MOBILEMESSAGE_USERNAME, MOBILEMESSAGE_PASSWORD and SMS_SENDER in Railway.' };
  const a = await providerCall('/v1/account');
  if (!a.ok) { const e = a.status === 401 ? 'Unauthorized (401)' : (a.body.error || `Mobile Message answered ${a.status}`); return { ok: false, error: e, hint: hintFor(e) }; }
  const s = await providerCall('/v1/senders');
  const senderOk = s.ok ? JSON.stringify(s.body).toLowerCase().includes('"' + sender().toLowerCase() + '"') : null;
  return { ok: true, balance: a.body.credit_balance != null ? a.body.credit_balance : null, sender: sender(), senderApproved: senderOk };
}

module.exports = { TYPES, configured, mode, mobile, measure, fill, send, enquiry, invite, quoteSent, signed, runReminders, start, state, save, check, trialNumbers };
