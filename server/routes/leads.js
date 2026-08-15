// Leads / enquiries. Manual entry now; a public website form can POST to /api/public/lead later
// without any rework (same table, same fields).
const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const STATUS = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];

function view(l) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(l.created_at + 'Z').getTime()) / 864e5));
  let q = null;
  if (l.quote_id) q = db.prepare('SELECT quote_number, status FROM quotes WHERE id=?').get(l.quote_id);
  const today = new Date().toISOString().slice(0, 10);
  return { id: l.id, name: l.name, phone: l.phone, email: l.email, address: l.address,
    source: l.source, notes: l.notes, status: l.status, ageDays,
    stage: l.stage || 'noanswer', nextFollowup: l.next_followup || null,
    followupOverdue: !!(l.next_followup && l.next_followup < today && !['Won', 'Lost'].includes(l.status)),
    jobType: l.job_type || '', suburb: l.suburb || '',
    msgCount: db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(l.id).c,
    quoteId: l.quote_id, quoteNumber: q ? q.quote_number : null, quoteStatus: q ? q.status : null,
    createdAt: l.created_at };
}
// literal path must be declared before any '/:id' route
router.get('/stages', (req, res) => res.json({ stages: STAGES, phases: PHASES }));
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const open = rows.filter(l => !['Won', 'Lost'].includes(l.status));
  res.json({ leads: rows.map(view), openCount: open.length, statuses: STATUS });
});
router.post('/', (req, res) => {
  const b = req.body || {}; const id = newId();
  db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name || '', b.phone || '', b.email || '', b.address || '', b.source || 'Phone',
      b.notes || '', b.status || 'New', b.stage || 'noanswer',
      // A new enquiry is due NOW — that's the whole point of "call within 2 hours".
      b.nextFollowup || new Date().toISOString().slice(0, 10),
      b.jobType || '', b.suburb || '');
  res.status(201).json({ id });
});
router.put('/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare(`UPDATE leads SET name=?,phone=?,email=?,address=?,source=?,notes=?,status=?,
      stage=?,next_followup=?,job_type=?,suburb=?,updated_at=datetime('now') WHERE id=?`)
    .run(b.name ?? l.name, b.phone ?? l.phone, b.email ?? l.email, b.address ?? l.address,
      b.source ?? l.source, b.notes ?? l.notes, b.status ?? l.status,
      b.stage ?? l.stage, b.nextFollowup !== undefined ? b.nextFollowup : l.next_followup,
      b.jobType ?? l.job_type, b.suburb ?? l.suburb, l.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id); res.status(204).end(); });

// Convert a lead into a quote — carries the details across, links both ways.
router.post('/:id/convert', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  // Self-heal: a quote deleted outside this route (or by an older build) leaves a
  // dangling link. Only block if the quote is genuinely still there.
  if (l.quote_id) {
    const existing = db.prepare('SELECT id, quote_number FROM quotes WHERE id=?').get(l.quote_id);
    if (existing) return res.status(400).json({ error: `Already linked to quote ${existing.quote_number}.`, quoteId: existing.id });
    db.prepare('UPDATE leads SET quote_id=NULL WHERE id=?').run(l.id);
  }
  const { createQuote } = require('./quotes');
  const q = createQuote({ client: l.name, clientEmail: l.email, address: l.address, projectTitle: 'Landscape Works', leadId: l.id });
  // Converting means the site visit is behind you — move to Phase 3's end and
  // diarise building the quote.
  db.prepare("UPDATE leads SET quote_id=?, status='Quoted', stage='aftervisit', next_followup=?, updated_at=datetime('now') WHERE id=?")
    .run(q.id, nextDueFrom('aftervisit'), l.id);
  res.status(201).json({ quoteId: q.id, quoteNumber: q.quote_number });
});

// ---- Follow-up console ------------------------------------------------------
const { STAGES, PHASES, buildMessage, gapsFor, stageById, phaseOf, nextDueFrom } = require('../utils/leadTemplates');



// ---- Today's list: the single view that makes follow-up consistent -------------
router.get('/board', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const wk = new Date(); wk.setDate(wk.getDate() + 7);
  const weekEnd = wk.toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM leads WHERE status NOT IN ('Won','Lost') ORDER BY next_followup").all();
  const decorate = l => {
    const s = stageById(l.stage || 'noanswer');
    let quote = null;
    if (l.quote_id) quote = db.prepare('SELECT quote_number, status FROM quotes WHERE id=?').get(l.quote_id);
    return { id: l.id, name: l.name, suburb: l.suburb || l.address || '', jobType: l.job_type || '',
      phone: l.phone, email: l.email, stage: s.id, stageLabel: s.label, phase: s.phase,
      nextAction: s.nextAction || 'Review this enquiry', due: l.next_followup,
      quoteNumber: quote ? quote.quote_number : null, quoteStatus: quote ? quote.status : null };
  };
  const overdue = rows.filter(l => l.next_followup && l.next_followup < today).map(decorate);
  const dueToday = rows.filter(l => l.next_followup === today).map(decorate);
  const thisWeek = rows.filter(l => l.next_followup && l.next_followup > today && l.next_followup <= weekEnd).map(decorate);
  const undated = rows.filter(l => !l.next_followup).map(decorate);
  // How many enquiries sit in each phase
  const phaseCounts = {};
  PHASES.forEach(p => phaseCounts[p.id] = 0);
  rows.forEach(l => { const p = phaseOf(l.stage || 'noanswer'); phaseCounts[p] = (phaseCounts[p] || 0) + 1; });
  res.json({ overdue, dueToday, thisWeek, undated, phaseCounts, phases: PHASES });
});

// Everything one lead screen needs: where it is, what's missing, what to do next.
router.get('/:id/state', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const s = stageById(l.stage || 'noanswer');
  const phase = s.phase;
  const nextPhase = Math.min(5, phase + 1);
  let quote = null;
  if (l.quote_id) quote = db.prepare('SELECT id, quote_number, status FROM quotes WHERE id=?').get(l.quote_id);
  const today = new Date().toISOString().slice(0, 10);
  // How many chasing messages have gone out at this phase without a reply
  const chases = db.prepare("SELECT COUNT(*) c FROM lead_messages WHERE lead_id=? AND stage IN ('follow1','follow2')").get(l.id).c;
  res.json({
    stage: s.id, stageLabel: s.label, phase, phases: PHASES,
    nextAction: s.nextAction || 'Review this enquiry',
    due: l.next_followup, overdue: !!(l.next_followup && l.next_followup < today),
    gaps: gapsFor({ ...l, quote_id: quote ? l.quote_id : null }, nextPhase),
    nextPhaseLabel: (PHASES.find(p => p.id === nextPhase) || {}).label,
    quote: quote ? { id: quote.id, number: quote.quote_number, status: quote.status } : null,
    chases, suggestCloseout: chases >= 2 && phase === 2,
  });
});

// Snooze — the client asked you to come back later.
router.post('/:id/snooze', (req, res) => {
  const days = Math.max(1, Math.min(120, parseInt((req.body || {}).days, 10) || 3));
  const d = new Date(); d.setDate(d.getDate() + days);
  db.prepare("UPDATE leads SET next_followup=?, updated_at=datetime('now') WHERE id=?")
    .run(d.toISOString().slice(0, 10), req.params.id);
  res.json({ ok: true, until: d.toISOString().slice(0, 10) });
});

// Move a lead to a stage directly — skipping ahead, or closing it out.
router.put('/:id/stage', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const s = stageById((req.body || {}).stage);
  if (!s) return res.status(400).json({ error: 'unknown stage' });
  // Won is the one hard gate: it feeds the secured figures, so it needs a signed quote.
  if (s.id === 'won') {
    const q = l.quote_id ? db.prepare('SELECT status FROM quotes WHERE id=?').get(l.quote_id) : null;
    if (!q || q.status !== 'accepted') {
      return res.status(400).json({ error: 'A lead can only be marked Won once its quote has been accepted and signed — the secured figures depend on it.' });
    }
  }
  const status = s.id === 'won' ? 'Won' : s.id === 'lost' || s.id === 'closeout' ? 'Lost'
    : s.phase >= 4 ? 'Quoted' : s.phase >= 2 ? 'Contacted' : l.status;
  db.prepare("UPDATE leads SET stage=?, status=?, next_followup=?, updated_at=datetime('now') WHERE id=?")
    .run(s.id, status, (req.body || {}).nextFollowup || nextDueFrom(s.id), l.id);
  res.json({ ok: true, stage: s.id, status });
});


// ---- CALL SCRIPT -------------------------------------------------------------
const CS = require('../utils/callScript');

router.get('/call/script', (req, res) => {
  res.json({ steps: CS.STEPS, sizes: CS.SIZES, thresholds: CS.T(), fridays: CS.nextFridays(2) });
});

// Everything the rep has tapped so far, plus the live ballpark.
router.post('/:id/call', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const a = (req.body || {}).answers || {};
  db.prepare("UPDATE leads SET call_answers=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(a), l.id);
  const bp = CS.ballpark(a);
  res.json({ ok: true, ballpark: bp, script: CS.ballparkScript(bp, a) });
});

router.get('/:id/call', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  let a = {}; try { a = JSON.parse(l.call_answers || '{}'); } catch (e) {}
  const bp = CS.ballpark(a);
  res.json({ answers: a, ballpark: bp, script: CS.ballparkScript(bp, a), fridays: CS.nextFridays(2) });
});

// Finish the call: write the follow-up, move the lead, diarise the next step.
router.post('/:id/call/finish', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const a = b.answers || {};
  const bp = CS.ballpark(a);
  const who = req.user ? (req.user.name || req.user.username) : '';
  const first = String(l.name || 'there').trim().split(/\s+/)[0];
  const me = settingGet('company_contact_name') || who || 'Smit';
  const phone = settingGet('company_phone') || '';

  let stage = l.stage || 'noanswer', status = l.status, next = null, msg = '', subject = '';

  if (b.outcome && b.outcome !== 'talk') {
    const map = { callback: 'callback', noanswer: 'noanswer', notint: 'closeout', wrong: 'closeout' };
    stage = map[b.outcome] || stage;
    if (b.outcome === 'callback') { next = b.callbackDate || null; msg = `Hi ${first},\n\nThanks for taking my call — I'll give you a ring back ${b.callbackWhen || 'as arranged'}.\n\n${me}`; }
    if (b.outcome === 'noanswer') { const d = new Date(); d.setDate(d.getDate() + 1); next = d.toISOString().slice(0, 10);
      msg = `Hi ${first},\n\n${me} from Estate Landscapers here. I tried calling about your enquiry — when would suit for a quick chat?\n\n${phone}`; }
    if (b.outcome === 'notint') { status = 'Lost'; msg = `Hi ${first},\n\nNo problem at all — I'll close it off. If it comes back around, just give me a call.\n\n${me}`; }
    if (b.outcome === 'wrong') { status = 'Lost'; msg = ''; }
  } else if (bp.decline) {
    stage = 'closeout'; status = 'Lost';
    db.prepare('UPDATE leads SET declined_reason=? WHERE id=?').run(bp.reason, l.id);
    msg = `Hi ${first},\n\nThanks for your time on the phone. As we discussed, with the access under 800mm we can't get machinery down the side, so it isn't a job we're able to take on.\n\nIf the access can be opened up at all, give me a call and we'll take another look.\n\nAll the best,\n${me}`;
    subject = 'Your landscaping enquiry — Estate Landscapers';
  } else if (b.visitOutcome === 'booked' && b.visitDate) {
    stage = 'confirm'; status = 'Contacted'; next = b.visitDate;
    const d = new Date(b.visitDate + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
    const plansWanted = (a.plans || []).filter(p => ['architectural', 'hydraulic', 'da', 'landscape'].includes(p));
    const pn = { architectural: 'architectural drawings', hydraulic: 'hydraulic drawings', da: 'DA consent', landscape: 'landscape plan' };
    const plansLine = plansWanted.length
      ? `\n\nBefore then, could you send through the ${plansWanted.map(p => pn[p]).join(' and the ')}? It means I can give you a proper number on the day rather than going away to work it out.`
      : '';
    const range = bp.tooUnknown ? '' : `\n\nFrom what you've told me it would usually land somewhere between $${bp.incLo.toLocaleString()} and $${bp.incHi.toLocaleString()} including GST. That's indicative only and subject to the site visit, final measurements and finish selections.${bp.exc.length ? ` It excludes: ${bp.exc.join('; ')}.` : ''}`;
    msg = `Hi ${first},\n\nThanks for your time on the phone just now.\n\nI'll come out ${d} to measure up and take a proper look.${range}${plansLine}\n\nAny questions in the meantime, just give me a call.\n\nThanks,\n${me}\n${phone}`;
    subject = `Site visit ${d} — Estate Landscapers`;
  } else {
    stage = 'details'; status = 'Contacted';
    const d = new Date(); d.setDate(d.getDate() + 2); next = d.toISOString().slice(0, 10);
    msg = `Hi ${first},\n\nThanks for your time on the phone. I'll follow up shortly about getting out to measure up.\n\n${me}\n${phone}`;
    subject = 'Following up — Estate Landscapers';
  }

  const sets = ['stage=?', 'status=?', 'next_followup=?', 'call_answers=?'];
  const vals = [stage, status, next, JSON.stringify(a)];
  if (a.source) { sets.push('source=?'); vals.push(a.source); }
  if (b.referredBy) { sets.push('referred_by=?'); vals.push(b.referredBy); }
  if (a.propertyType) { sets.push('job_type=?'); vals.push((a.scope || []).join(', ') || l.job_type); }
  vals.push(l.id);
  db.prepare(`UPDATE leads SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals);

  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId(), l.id, 'call', stage, null, null, who, 'logged',
    bp.decline ? 'DECLINED — ' + bp.reason : 'Call completed via script');

  res.json({ ok: true, stage, status, nextFollowup: next, message: msg, subject, ballpark: bp, declined: !!bp.decline });
});

// The message for a lead at a given stage, ready to edit and send.
router.get('/:id/message', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const stage = req.query.stage || l.stage || 'noanswer';
  let quoteLink = '';
  if (l.quote_id) {
    const q = db.prepare('SELECT token FROM quotes WHERE id=?').get(l.quote_id);
    if (q) quoteLink = `${req.protocol}://${req.get('host')}/q/${q.token}`;
  }
  const msg = buildMessage({ lead: l, stage, sender: req.user ? (req.user.name || req.user.username) : '',
    date: req.query.date, time: req.query.time, quoteLink });
  // Australian mobiles: 04xx -> 614xx for WhatsApp's international format.
  const digits = String(l.phone || '').replace(/[^\d+]/g, '');
  let intl = digits.replace(/^\+/, '');
  if (intl.charAt(0) === '0') intl = '61' + intl.slice(1);
  const usable = digits.replace(/\D/g, '').length >= 8;
  res.json({ ...msg, stage, quoteLink,
    phoneOk: usable, emailOk: !!l.email,
    waUrl: usable ? `https://wa.me/${intl}?text=${encodeURIComponent(msg.body)}` : null,
    smsUrl: usable ? `sms:${digits}?&body=${encodeURIComponent(msg.body)}` : null });
});

// Record what was sent. WhatsApp and SMS hand off to the phone, so the tool logs what
// it prepared; email is actually sent here.
router.post('/:id/message', async (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const channel = ['whatsapp', 'sms', 'email', 'call', 'note'].includes(b.channel) ? b.channel : 'note';
  const who = req.user ? (req.user.name || req.user.username) : '';
  let outcome = 'logged';

  if (channel === 'email') {
    const { sendMail, validateEmail } = require('../utils/email');
    const to = String(b.to || l.email || '').trim();
    const bad = validateEmail(to);
    if (bad) return res.status(400).json({ error: bad, field: 'to' });
    const { shell, esc } = require('../utils/quoteEmail');
    const { signatureHtml } = require('../utils/quoteEmail');
    const html = shell(String(b.body || '').split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('') + signatureHtml());
    try {
      await sendMail({ to, subject: b.subject || 'Estate Landscapers', html });
      outcome = 'sent';
      if (!l.email) db.prepare('UPDATE leads SET email=? WHERE id=?').run(to, l.id);
    } catch (e) {
      return res.status(502).json({ error: e.message, hint: e.hint });
    }
  }

  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId(), l.id, channel, b.stage || l.stage || null,
    b.subject || null, b.body || null, who, outcome, b.note || null);

  // Advance the lead and diarise the next action automatically — this is what makes
  // follow-up consistent. The user never sets a reminder by hand.
  const doneStage = b.stage || l.stage || 'noanswer';
  const sets = ['stage=?'], vals = [doneStage];
  // An explicit date (a booked call-back, a site visit) always wins over the default gap.
  const explicit = b.nextFollowup !== undefined ? b.nextFollowup : undefined;
  const auto = nextDueFrom(doneStage);
  sets.push('next_followup=?'); vals.push(explicit !== undefined ? (explicit || null) : auto);
  if (b.status) { sets.push('status=?'); vals.push(b.status); }
  vals.push(l.id);
  db.prepare(`UPDATE leads SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals);
  console.log(`[lead] ${channel} on ${l.name} by ${who} (${outcome})`);
  res.status(201).json({ ok: true, outcome });
});

router.get('/:id/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM lead_messages WHERE lead_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows.map(r => ({ id: r.id, channel: r.channel, stage: r.stage, subject: r.subject,
    body: r.body, sentBy: r.sent_by, outcome: r.outcome, note: r.note, at: r.created_at })));
});

module.exports = router;
