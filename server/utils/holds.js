// On hold — a job that is real but months away (the client asked for the quote at the
// start of a build and will not landscape for 8–12 months).
//
// A hold always has a wake-up date; there is no hold without one. While it runs:
//   - the lead leaves the five working columns (it is "parked", so every list that already
//     skips parked leads skips it: Hot right now, follow-ups, reminders, Quotes to build);
//   - its quote leaves Drafts and Sent, win rate, ageing and "Expected to land";
//   - the client's quote link stays open;
//   - nothing is marked lost.
// On the date it comes back to the step it was at with a follow-up due that day. Two weeks
// before, a warning goes out. If asked, the client gets a check-in by email and text
// halfway through and every three months.
const { db, settingGet } = require('../db');
const { newId } = require('./ids');
const { sydneyParts } = require('./refs');

db.exec(`CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY, lead_id TEXT, quote_parent TEXT,
  until TEXT NOT NULL, reason TEXT, warn INTEGER DEFAULT 1, checkin INTEGER DEFAULT 0,
  prev_stage TEXT, prev_followup TEXT,
  created_at TEXT DEFAULT (datetime('now')), created_by TEXT,
  warned_at TEXT, checkins TEXT DEFAULT '[]',
  ended_at TEXT, ended_by TEXT, ended_how TEXT
);
CREATE INDEX IF NOT EXISTS idx_holds_live ON holds(ended_at, until);`);

const WARN_DAYS = 14;
const today = () => sydneyParts().ymd;
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const addMonths = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1));
  t.setUTCDate(Math.min(d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate())); return t.toISOString().slice(0, 10); };
const niceDay = ymd => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const niceMonth = ymd => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' });

const live = () => db.prepare('SELECT * FROM holds WHERE ended_at IS NULL ORDER BY until').all();
const forLead = id => id ? db.prepare('SELECT * FROM holds WHERE lead_id=? AND ended_at IS NULL').get(id) || null : null;
// Every quote family that is on hold, by parent number: held directly, or through its lead.
function heldParents() {
  const out = new Map();
  live().forEach(h => {
    if (h.quote_parent) out.set(h.quote_parent, h);
    if (h.lead_id) db.prepare(`SELECT DISTINCT q.parent_number p FROM quotes q WHERE q.lead_id=? OR q.id=(SELECT quote_id FROM leads WHERE id=?)`).all(h.lead_id, h.lead_id)
      .forEach(r => { if (r.p) out.set(r.p, h); });
  });
  return out;
}
const forQuote = q => q ? heldParents().get(q.parent_number) || null : null;

// Check-in dates: every three months, plus the halfway point unless a quarterly one already
// falls within six weeks of it. Nothing in the first three weeks or the last three.
function checkinDates(start, until) {
  const total = dayDiff(start, until); if (total < 60) return [];
  const half = new Date(new Date(start + 'T00:00:00Z').getTime() + total / 2 * 864e5).toISOString().slice(0, 10);
  const q = []; for (let k = 1; k < 60; k++) { const d = addMonths(start, 3 * k); if (d >= until) break; q.push(d); }
  const all = q.slice(); if (!q.some(d => Math.abs(dayDiff(d, half)) <= 45)) all.push(half);
  return all.sort().filter(d => dayDiff(start, d) >= 21 && dayDiff(d, until) >= 21);
}

const note = (leadId, stage, by, text) => { if (!leadId) return; db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?)').run(newId(), leadId, 'note', stage || null, by || 'auto', 'logged', text); };

function validUntil(until) {
  if (!isYmd(until)) return 'Enter the date this should come back. A job cannot go on hold without one.';
  if (until <= today()) return 'The date has to be in the future.';
  if (dayDiff(today(), until) > 366 * 3) return 'That is more than three years away. Pick a nearer date.';
  return null;
}

// Put a lead (and its quote), or a quote with no lead, on hold.
function create({ leadId, quoteId, until, reason, warn, checkin, by }) {
  const bad = validUntil(until); if (bad) return { error: bad, field: 'until' };
  let q = quoteId ? db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId) : null;
  let l = leadId ? db.prepare('SELECT * FROM leads WHERE id=?').get(leadId) : null;
  if (!l && q) l = (q.lead_id && db.prepare('SELECT * FROM leads WHERE id=?').get(q.lead_id)) || db.prepare('SELECT l.* FROM leads l JOIN quotes x ON x.id=l.quote_id WHERE x.parent_number=?').get(q.parent_number) || null;
  if (!q && l && l.quote_id) q = db.prepare('SELECT * FROM quotes WHERE id=?').get(l.quote_id) || null;
  if (!l && !q) return { error: 'Nothing to put on hold.' };
  if (q) {
    if (db.prepare("SELECT 1 FROM quotes WHERE parent_number=? AND status='accepted'").get(q.parent_number)) return { error: 'This job is already won. A won job cannot go on hold.' };
  }
  if (l && ['Won', 'Lost'].includes(l.status)) return { error: l.status === 'Lost' ? 'This enquiry is closed. Reopen it first, then put it on hold.' : 'This job is already won.' };
  const existing = (l && forLead(l.id)) || (q && heldParents().get(q.parent_number));
  if (existing) return update(existing.id, { until, reason, warn, checkin, by });
  const id = newId();
  db.prepare('INSERT INTO holds (id,lead_id,quote_parent,until,reason,warn,checkin,prev_stage,prev_followup,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, l ? l.id : null, q ? q.parent_number : null, until, String(reason || '').trim().slice(0, 200), warn === false ? 0 : 1, checkin ? 1 : 0, l ? l.stage : null, l ? l.next_followup : null, by || '');
  if (l) {
    db.prepare("UPDATE leads SET parked=1, parked_at=datetime('now'), next_followup=NULL, updated_at=datetime('now') WHERE id=?").run(l.id);
    try { require('./estimator').cancelPending(l.id, 'put on hold'); } catch (e) {}
    note(l.id, l.stage, by, `On hold until ${niceDay(until)}${reason ? ' — ' + String(reason).trim() : ''}${checkin ? ' · check-in messages on' : ''}`);
  }
  return { ok: true, id, until };
}
function update(id, { until, reason, warn, checkin, by }) {
  const h = db.prepare('SELECT * FROM holds WHERE id=? AND ended_at IS NULL').get(id);
  if (!h) return { error: 'That hold has already ended.' };
  if (until !== undefined) { const bad = validUntil(until); if (bad) return { error: bad, field: 'until' }; }
  const nu = until !== undefined ? until : h.until;
  db.prepare('UPDATE holds SET until=?, reason=?, warn=?, checkin=?, warned_at=CASE WHEN ?<>until THEN NULL ELSE warned_at END WHERE id=?')
    .run(nu, reason !== undefined ? String(reason || '').trim().slice(0, 200) : h.reason, warn === undefined ? h.warn : (warn ? 1 : 0), checkin === undefined ? h.checkin : (checkin ? 1 : 0), nu, id);
  if (nu !== h.until && h.lead_id) note(h.lead_id, null, by, `Hold moved to ${niceDay(nu)} (was ${niceDay(h.until)})`);
  return { ok: true, id, until: nu };
}
// Bring it back: same step as before, follow-up due today.
function wake(id, by, how) {
  const h = db.prepare('SELECT * FROM holds WHERE id=? AND ended_at IS NULL').get(id);
  if (!h) return { error: 'That hold has already ended.' };
  db.prepare("UPDATE holds SET ended_at=datetime('now'), ended_by=?, ended_how=? WHERE id=?").run(by || 'auto', how || 'manual', id);
  if (h.lead_id) {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(h.lead_id);
    if (l) {
      db.prepare("UPDATE leads SET parked=0, parked_at=NULL, next_followup=?, updated_at=datetime('now') WHERE id=?").run(['Won', 'Lost'].includes(l.status) ? null : today(), l.id);
      note(l.id, l.stage, by, how === 'due' ? `Back from hold (set ${niceDay(String(h.created_at).slice(0, 10))}${h.reason ? ', ' + h.reason : ''}) — follow up today` : 'Taken off hold');
    }
  }
  return { ok: true };
}

// ---- what the screens need --------------------------------------------------------------
function describe(h) {
  const l = h.lead_id ? db.prepare('SELECT id,name,suburb,address,stage,phone,email,job_type FROM leads WHERE id=?').get(h.lead_id) : null;
  let q = h.quote_parent ? db.prepare('SELECT * FROM quotes WHERE parent_number=? ORDER BY created_at DESC, quote_number DESC LIMIT 1').get(h.quote_parent) : null;
  if (!q && l) { const lq = db.prepare('SELECT q.* FROM quotes q JOIN leads l ON l.quote_id=q.id WHERE l.id=?').get(l.id); if (lq) q = db.prepare('SELECT * FROM quotes WHERE parent_number=? ORDER BY created_at DESC, quote_number DESC LIMIT 1').get(lq.parent_number) || lq; }
  let value = null; if (q) { try { value = Math.round(require('../routes/quotes').cachedTotals(q).ex); } catch (e) {} }
  let stageLabel = ''; try { stageLabel = h.prev_stage ? require('./leadTemplates').stageById(require('./leadTemplates').normalise(h.prev_stage)).label : ''; } catch (e) {}
  const t = today(), start = String(h.created_at).slice(0, 10);
  return { id: h.id, leadId: l ? l.id : null, quoteId: q ? q.id : null, quoteNumber: q ? q.quote_number : null, parent: q ? q.parent_number : (h.quote_parent || null), name: (l && l.name) || (q && q.client_name) || '—',
    suburb: (l && (l.suburb || l.address)) || (q && q.address) || '', value, until: h.until, untilLabel: niceDay(h.until), daysLeft: dayDiff(t, h.until), soon: dayDiff(t, h.until) <= WARN_DAYS,
    since: start, sinceLabel: niceDay(start), reason: h.reason || '', warn: !!h.warn, checkin: !!h.checkin, by: h.created_by || '', stageLabel,
    checkinDates: h.checkin ? checkinDates(start, h.until) : [] };
}
function list() {
  const rows = live().map(describe);
  // Leads parked before holds existed have no date. They show so one can be set.
  const dated = new Set(rows.map(r => r.leadId).filter(Boolean));
  db.prepare("SELECT id,name,suburb,address,parked_at,quote_id FROM leads WHERE COALESCE(parked,0)=1 AND status NOT IN ('Won','Lost')").all().filter(l => !dated.has(l.id)).forEach(l => {
    const q = l.quote_id ? db.prepare('SELECT id, quote_number FROM quotes WHERE id=?').get(l.quote_id) : null;
    rows.push({ id: null, leadId: l.id, quoteId: q ? q.id : null, quoteNumber: q ? q.quote_number : null, name: l.name, suburb: l.suburb || l.address || '', value: null, until: null, noDate: true, reason: 'Parked before on-hold dates existed', since: String(l.parked_at || '').slice(0, 10) });
  });
  return rows;
}

// ---- the daily work: wake, warn, check in -----------------------------------------------
const sydneyHour = () => parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(new Date()), 10);
async function checkIn(h, date) {
  const l = h.lead_id ? db.prepare('SELECT * FROM leads WHERE id=?').get(h.lead_id) : null;
  const q = h.quote_parent ? db.prepare('SELECT * FROM quotes WHERE parent_number=? ORDER BY created_at DESC LIMIT 1').get(h.quote_parent) : null;
  const who = { name: (l && l.name) || (q && q.client_name) || '', job_type: l ? l.job_type : '', address: (l && l.address) || (q && q.address) || '' };
  const T = require('./leadTemplates');
  const msg = T.buildMessage({ lead: who, stage: 'holdcheckin', sender: h.created_by, extra: { holdmonth: niceMonth(h.until) } });
  const out = [];
  const email = (l && l.email) || (q && q.client_email) || '';
  if (email) {
    const { sendMail } = require('./email'); const { shell, esc, signatureHtml } = require('./quoteEmail');
    const html = shell(T.forEmail(msg.body, msg.signoff).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('') + signatureHtml());
    const mid = newId(); let outcome = 'sent', err = null;
    try { const r = await sendMail({ to: email, subject: msg.subject, html, track: mid }); if (r && r.skipped) { outcome = 'failed'; err = r.reason; } } catch (e) { outcome = 'failed'; err = e.message; }
    if (l) db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)').run(mid, l.id, 'email', 'holdcheckin', msg.subject, msg.body, 'auto', outcome, 'On-hold check-in' + (err ? ' · NOT SENT: ' + err : ''));
    out.push('email ' + outcome);
  }
  if (l && l.phone) { try { const r = await require('./sms').send({ type: 'manual', lead: l, body: msg.sms, by: 'auto', history: true }); out.push('text ' + (r.status || (r.ok ? 'sent' : 'failed'))); } catch (e) {} }
  const sent = JSON.parse(h.checkins || '[]'); sent.push(date);
  db.prepare('UPDATE holds SET checkins=? WHERE id=?').run(JSON.stringify(sent), h.id);
  console.log(`[hold] check-in for ${who.name}: ${out.join(', ') || 'no email or mobile on file'}`);
}
async function tick() {
  const t = today(), hour = sydneyHour();
  for (const h of live()) {
    try {
      if (h.until <= t) {
        const d = describe(h); wake(h.id, 'auto', 'due');
        try { await require('./push').notify({ title: 'Back from hold today', body: `${d.name}${d.quoteNumber ? ' · quote ' + d.quoteNumber : ''}${h.reason ? ' — ' + h.reason : ''}`, url: d.leadId ? '/admin/?lead=' + d.leadId : '/admin/?tab=quotes', tag: 'hold-' + h.id }); } catch (e) {}
        continue;
      }
      if (hour < 9 || hour >= 18) continue;
      if (h.warn && !h.warned_at && dayDiff(t, h.until) <= WARN_DAYS) {
        const d = describe(h);
        db.prepare("UPDATE holds SET warned_at=datetime('now') WHERE id=?").run(h.id);
        note(h.lead_id, null, 'auto', `Comes off hold on ${niceDay(h.until)} — worth a call before then`);
        try { await require('./push').notify({ title: `Off hold in ${dayDiff(t, h.until)} days`, body: `${d.name}${d.quoteNumber ? ' · quote ' + d.quoteNumber : ''} comes back on ${niceDay(h.until)}`, url: d.leadId ? '/admin/?lead=' + d.leadId : '/admin/?tab=quotes', tag: 'holdwarn-' + h.id }); } catch (e) {}
      }
      if (h.checkin) {
        const sent = JSON.parse(h.checkins || '[]');
        // Due, not sent, and not so old that it has lost its point (the tool was down, say).
        const due = checkinDates(String(h.created_at).slice(0, 10), h.until).find(d => d <= t && dayDiff(d, t) <= 14 && !sent.includes(d));
        if (due) await checkIn(h, due);
      }
    } catch (e) { console.error('[hold] tick failed for', h.id, e.message); }
  }
}
function start() { setInterval(() => { tick().catch(e => console.error('[hold]', e.message)); }, 10 * 60e3).unref(); setTimeout(() => tick().catch(() => {}), 20e3).unref(); }

module.exports = { create, update, wake, list, live, forLead, forQuote, heldParents, describe, checkinDates, tick, start, WARN_DAYS, addMonths };
