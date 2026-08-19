// Leads / enquiries. Manual entry now; a public website form can POST to /api/public/lead later
// without any rework (same table, same fields).
const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const STATUS = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];

// Single place where a lead's true step is worked out AND written back.
//
// The stored `stage` column drifts: a quote gets sent from the quote builder and nothing
// updates the lead, so it sits on "call1" while a quote is live. Every read now recomputes
// from evidence and persists the correction, so the column is the source of truth again
// rather than a stale second opinion.
//
// Deliberately conservative: it never touches a lead whose derived stage already matches,
// and derivedStage preserves the chase position (quotechase1/2/final) rather than
// collapsing everything back to "quote sent".
function syncLeadStage(l) {
  const { derivedStage } = require('../utils/leadTemplates');
  const quote = l.quote_id ? db.prepare('SELECT id, quote_number, status FROM quotes WHERE id=?').get(l.quote_id) : null;
  let docs = []; try { docs = JSON.parse(l.docs_received || '[]') || []; } catch (e) {}
  const want = derivedStage(l, quote, docs.length > 0);
  if (want && want !== l.stage) {
    db.prepare("UPDATE leads SET stage=?, updated_at=datetime('now') WHERE id=?").run(want, l.id);
    console.log(`[lead] ${l.name}: stage ${l.stage} -> ${want}${!quote && l.quote_id ? ' (linked quote no longer exists)' : ''}`);
    l.stage = want;
  }
  return { stage: want, quote, docsIn: docs.length > 0 };
}

function view(l) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(l.created_at + 'Z').getTime()) / 864e5));
  const { stage, quote: q } = syncLeadStage(l);
  const today = new Date().toISOString().slice(0, 10);
  return { id: l.id, name: l.name, phone: l.phone, email: l.email, address: l.address,
    source: l.source, notes: l.notes, status: l.status, ageDays,
    stage, nextFollowup: l.next_followup || null,
    followupOverdue: !!(l.next_followup && l.next_followup < today && !['Won', 'Lost'].includes(l.status)),
    jobType: l.job_type || '', suburb: l.suburb || '',
    msgCount: db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(l.id).c,
    quoteId: l.quote_id, quoteNumber: q ? q.quote_number : null, quoteStatus: q ? q.status : null,
    quoteMissing: !!(l.quote_id && !q),
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
const { fullQuote } = require('./quotes');



// ---- Today's list: the single view that makes follow-up consistent -------------
router.get('/board', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const wk = new Date(); wk.setDate(wk.getDate() + 7);
  const weekEnd = wk.toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM leads WHERE status NOT IN ('Won','Lost') ORDER BY next_followup").all();
  const decorate = l => {
    const { stage, quote } = syncLeadStage(l);
    const s = stageById(stage);
    return { id: l.id, name: l.name, suburb: l.suburb || l.address || '', jobType: l.job_type || '',
      phone: l.phone, email: l.email, stage: s.id, stageLabel: s.label, phase: s.phase,
      nextAction: s.nextAction || 'Review this enquiry', due: l.next_followup,
      quoteMissing: !!(l.quote_id && !quote),
      quoteNumber: quote ? quote.quote_number : null, quoteStatus: quote ? quote.status : null };
  };
  const overdue = rows.filter(l => l.next_followup && l.next_followup < today).map(decorate);
  const dueToday = rows.filter(l => l.next_followup === today).map(decorate);
  const thisWeek = rows.filter(l => l.next_followup && l.next_followup > today && l.next_followup <= weekEnd).map(decorate);
  const undated = rows.filter(l => !l.next_followup).map(decorate);
  // How many enquiries sit in each phase
  const phaseCounts = {};
  PHASES.forEach(p => phaseCounts[p.id] = 0);
  rows.forEach(l => {
    // Not every row goes through decorate() — a follow-up dated beyond this week falls in
    // none of the four buckets — so sync here too. It is a no-op when already correct.
    const p = phaseOf(syncLeadStage(l).stage);
    phaseCounts[p] = (phaseCounts[p] || 0) + 1;
  });
  res.json({ overdue, dueToday, thisWeek, undated, phaseCounts, phases: PHASES });
});

// Everything one lead screen needs: where it is, what's missing, what to do next.
router.get('/:id/state', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  // Old databases carry pre-v21 stage names — map them onto the four-step process.
  const sync = syncLeadStage(l);
  const quoteRow = sync.quote;
  const s = stageById(sync.stage);
  const phase = s.phase;
  const nextPhase = Math.min(5, phase + 1);
  const quote = quoteRow;
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

// Undo an accidental Skip ahead — moves the lead back one stage and restores its date.
router.post('/:id/stepback', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const order = STAGES.map(s => s.id);
  const cur = require('../utils/leadTemplates').normalise(l.stage || 'call1');
  const i = order.indexOf(cur);
  if (i <= 0) return res.status(400).json({ error: 'Already at the first step.' });
  const prev = STAGES[i - 1];
  db.prepare("UPDATE leads SET stage=?, next_followup=?, status=CASE WHEN status IN ('Won','Lost') THEN 'Contacted' ELSE status END, updated_at=datetime('now') WHERE id=?")
    .run(prev.id, nextDueFrom(prev.id), l.id);
  res.json({ ok: true, stage: prev.id, label: prev.label });
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




// ---- CALL ANSWERS, AND CHECKING THEM AGAINST THE QUOTE -----------------------
// Before a quote goes out, the rep should be able to see what the client actually said
// beside what was built. Anything on the quote that never came up — or came up and is
// missing — is flagged.
router.get('/:id/answers', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  let a = {}; try { a = JSON.parse(l.call_answers || '{}'); } catch (e) {}
  const CS2 = require('../utils/callScript');
  const bp = CS2.ballpark(a);
  const label = (v) => Array.isArray(v) ? v.join(', ') : (v === 'unknown' ? 'not known' : v);
  const SIZE = {}; (CS2.SIZES || []).forEach(s => SIZE[s.id] = s);

  const rows = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push({ k, v: label(v) }); };
  push('Property', [a.propertyType, a.builder, a.handover && 'handover ' + a.handover].filter(Boolean).join(' · '));
  push('Drawings', a.plans);
  push('To remove', a.toRemove);
  push('Wants done', (a.scope || []).map(s => (SIZE[s] || {}).label || s));
  push('Part of block', a.areaOfBlock);
  Object.entries(a.sizes || {}).forEach(([k, v]) => {
    const s = SIZE[k]; if (!s) return;
    rows.push({ k: s.label, v: v === 'unknown' ? 'not known — excluded' : `${v} ${s.unit}`.trim() });
  });
  push('Access', a.accessMm === 'unknown' ? 'not measured' : (a.accessMm ? a.accessMm + ' mm' : null));
  push('Steps', a.steps === 'unknown' ? 'not counted' : (a.steps != null ? a.steps + ' steps' : null));
  push('Fall', a.fallMm === 'unknown' ? 'not assessed' : (a.fallMm != null ? (a.fallMm / 1000).toFixed(1) + ' m' : null));
  push('Vehicle access', a.vehicle);
  push('Services', a.services);
  push('Timing', a.timing || a.startWhen);
  push('Driver', a.driver);
  push('Other quotes', a.otherQuotes);
  push('Decision', a.decisionMaker);
  push('Source', a.source);
  if (!bp.decline && !bp.tooUnknown) rows.push({ k: 'Ballpark given', v: `$${bp.incLo.toLocaleString()} – $${bp.incHi.toLocaleString()} inc GST` });
  if (a.priceReaction) rows.push({ k: 'Their reaction', v: a.priceReaction });
  if (a.notes) rows.push({ k: 'Notes', v: a.notes });

  // Compare against the quote, if one exists.
  let compare = null;
  if (l.quote_id) {
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(l.quote_id);
    if (q) {
      const fq = fullQuote(q);
      const tier = q.default_package || 'Standard';
      const discussed = new Set((a.scope || []).map(s => ((SIZE[s] || {}).code) || null).filter(Boolean));
      const lines = [...(fq.items.scope1 || []), ...(fq.items.scope2 || [])];
      const onQuote = lines.map(it => {
        const code = String(it.code || '').replace(/-\d+$/, '');
        const said = discussed.has(code);
        // Quantity check where we captured a size on the call
        const sizeEntry = Object.entries(a.sizes || {}).find(([k]) => (SIZE[k] || {}).code === code);
        let qtyNote = null;
        if (sizeEntry && sizeEntry[1] !== 'unknown' && it.qty != null) {
          const told = Number(sizeEntry[1]);
          if (told && Math.abs(told - it.qty) / told > 0.1) qtyNote = `call said ${told}, quote has ${it.qty}`;
        }
        return { code: it.displayCode || it.code, name: it.name, qty: it.qty,
          discussed: said, qtyNote,
          status: !said ? 'not-discussed' : qtyNote ? 'differs' : 'ok' };
      });
      const missing = [...discussed].filter(c => !lines.some(it => String(it.code || '').replace(/-\d+$/, '') === c));
      const inBallpark = !bp.tooUnknown && fq.grandIncGst >= bp.incLo * 0.9 && fq.grandIncGst <= bp.incHi * 1.1;
      compare = { quoteId: q.id, quoteNumber: q.quote_number, tier,
        totalIncGst: Math.round(fq.grandIncGst), onQuote, missing,
        ballparkLo: bp.incLo, ballparkHi: bp.incHi, inBallpark,
        excludedOnCall: bp.exc || [] };
    }
  }
  res.json({ hasCall: Object.keys(a).length > 0, rows, compare, ballpark: bp });
});

// ---- SITE VISIT CALENDAR -----------------------------------------------------
// Standalone — no Google or Outlook connection. Fridays are the default visit day but
// any date can be booked.
const SLOTS = ['7:30am', '9:00am', '10:30am', '12:00pm', '1:30pm', '3:00pm'];

router.get('/calendar', (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 8) + '01';
  const to = req.query.to || (() => { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); })();
  const rows = db.prepare(`SELECT v.*, l.name, l.suburb, l.address, l.phone, q.quote_number
    FROM site_visits v LEFT JOIN leads l ON l.id=v.lead_id LEFT JOIN quotes q ON q.id=v.quote_id
    WHERE v.visit_date >= ? AND v.visit_date < ? AND v.status <> 'cancelled'
    ORDER BY v.visit_date, v.visit_time`).all(from, to);
  res.json({ from, to, slots: SLOTS,
    visits: rows.map(v => ({ id: v.id, leadId: v.lead_id, date: v.visit_date, time: v.visit_time,
      status: v.status, name: v.name, suburb: v.suburb || v.address || '', phone: v.phone,
      quoteNumber: v.quote_number, note: v.note, bookedBy: v.booked_by })) });
});

router.post('/calendar/book', (req, res) => {
  const b = req.body || {};
  if (!b.leadId || !b.date) return res.status(400).json({ error: 'Pick a lead and a date' });
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(b.leadId);
  if (!l) return res.status(404).json({ error: 'lead not found' });
  const clash = db.prepare("SELECT COUNT(*) n FROM site_visits WHERE visit_date=? AND visit_time=? AND status='booked'").get(b.date, b.time || '');
  if (clash.n && !b.force) return res.status(409).json({ error: `Something is already booked at ${b.time} on ${b.date}.` });
  const id = newId();
  db.prepare(`INSERT INTO site_visits (id,lead_id,quote_id,visit_date,visit_time,note,booked_by)
    VALUES (?,?,?,?,?,?,?)`).run(id, l.id, l.quote_id || null, b.date, b.time || '', b.note || '',
    req.user ? (req.user.name || req.user.username) : '');
  // Booking a visit moves the lead and diarises the reminder.
  db.prepare("UPDATE leads SET stage='visitbooked', status='Contacted', next_followup=?, updated_at=datetime('now') WHERE id=?")
    .run(b.date, l.id);
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId(), l.id, 'note', 'visitbooked', null, null,
    req.user ? (req.user.name || req.user.username) : '', 'logged', `Site visit booked ${b.date} ${b.time || ''}`);
  res.status(201).json({ ok: true, id });
});

router.put('/calendar/:id', (req, res) => {
  const b = req.body || {};
  const v = db.prepare('SELECT * FROM site_visits WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE site_visits SET visit_date=?, visit_time=?, status=?, note=?, updated_at=datetime('now') WHERE id=?`)
    .run(b.date || v.visit_date, b.time !== undefined ? b.time : v.visit_time,
      b.status || v.status, b.note !== undefined ? b.note : v.note, v.id);
  // Visit done -> the clock starts on the 48-hour quote rule.
  if (b.status === 'done' && v.lead_id) {
    db.prepare("UPDATE leads SET stage='visitdone', next_followup=?, updated_at=datetime('now') WHERE id=?")
      .run(nextDueFrom('visitdone'), v.lead_id);
  }
  if (b.status === 'cancelled' && v.lead_id) {
    db.prepare("UPDATE leads SET stage='docsin', updated_at=datetime('now') WHERE id=?").run(v.lead_id);
  }
  res.json({ ok: true });
});

// Leads that could be booked in — anything past qualifying without a visit yet.
router.get('/calendar/bookable', (req, res) => {
  const rows = db.prepare(`SELECT l.* FROM leads l WHERE l.status NOT IN ('Won','Lost')
    AND l.id NOT IN (SELECT lead_id FROM site_visits WHERE status='booked') ORDER BY l.updated_at DESC`).all();
  res.json(rows.map(l => ({ id: l.id, name: l.name, suburb: l.suburb || l.address || '',
    stage: l.stage, jobType: l.job_type })));
});

// ---- AUTOMATIC EMAIL INGESTION ----------------------------------------------
const MAIL = require('../utils/mailIngest');

router.get('/ingest/status', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const c = MAIL.mailConfig();
  const recent = db.prepare(`SELECT m.*, l.name FROM mail_ingest m LEFT JOIN leads l ON l.id=m.lead_id
    ORDER BY m.created_at DESC LIMIT 20`).all();
  const counts = db.prepare(`SELECT platform, COUNT(*) n FROM mail_ingest GROUP BY platform`).all();
  res.json({ configured: MAIL.configured(), host: c.host, user: c.user, folder: c.folder,
    pollMinutes: parseInt(settingGet('imap_poll_minutes') || '10', 10),
    needsReview: db.prepare('SELECT COUNT(*) n FROM mail_ingest WHERE needs_review=1 AND reviewed=0').get().n,
    byPlatform: counts,
    recent: recent.map(r => ({ id: r.id, leadId: r.lead_id, name: r.name, platform: r.platform,
      subject: r.subject, needsReview: !!r.needs_review, reviewed: !!r.reviewed, at: r.created_at })) });
});

// Read the mailbox now, rather than waiting for the timer.
router.post('/ingest/run', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const r = await MAIL.pollOnce({ limit: 50 });
  res.json(r);
});

// Paste an enquiry by hand — for testing the parser, or a platform without email.
router.post('/ingest/paste', (req, res) => {
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ error: 'Nothing pasted' });
  const r = MAIL.createFromEmail({ messageId: null, from: b.from || '', subject: b.subject || '',
    text: b.text, receivedAt: new Date() });
  res.status(201).json(r);
});

// See what the parser makes of something, without creating anything.
router.post('/ingest/preview', (req, res) => {
  const b = req.body || {};
  res.json({ platform: MAIL.detectPlatform(b.from, b.subject), parsed: MAIL.parseEnquiry(b.text || '', b.subject) });
});

router.post('/ingest/:id/reviewed', (req, res) => {
  db.prepare('UPDATE mail_ingest SET reviewed=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- DOCUMENTATION (Step 3) --------------------------------------------------
// Drawings live in OneDrive, not in this database — the tool records that they arrived,
// how they came in, and the exact filename to save them under so the naming stays
// consistent. Replying goes back down the channel they arrived on.
function docFileName(l) {
  const clean = s => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return `${clean(l.name)} - ${clean(l.address || l.suburb)}.pdf`;
}
router.get('/:id/docs', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  let a = {}; try { a = JSON.parse(l.call_answers || '{}'); } catch (e) {}
  const NAMES = { architectural: 'Architectural drawings', hydraulic: 'Hydraulic drawings',
    da: 'DA consent', landscape: 'Landscape plan' };
  const expected = (a.plans || []).filter(p => NAMES[p]).map(p => ({ key: p, label: NAMES[p] }));
  let got = []; try { got = JSON.parse(l.docs_received || '[]'); } catch (e) {}
  res.json({ expected, received: got, note: l.docs_note || '', channel: l.docs_channel || '',
    fileName: docFileName(l), allIn: expected.length > 0 && expected.every(e => got.includes(e.key)),
    fridays: CS.nextFridays(2) });
});
router.post('/:id/docs', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const got = Array.isArray(b.received) ? b.received : [];
  db.prepare("UPDATE leads SET docs_received=?, docs_note=?, docs_channel=?, updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(got), b.note || '', b.channel || l.docs_channel || '', l.id);
  // Everything in? Move to Step 3 and book the visit.
  if (b.allIn) {
    db.prepare("UPDATE leads SET stage='docsin', status='Contacted', next_followup=?, updated_at=datetime('now') WHERE id=?")
      .run(nextDueFrom('docsin'), l.id);
  }
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId(), l.id, b.channel || 'note', 'docsin', null, null,
    req.user ? (req.user.name || req.user.username) : '', 'logged',
    `Drawings received: ${got.join(', ') || 'none'}${b.note ? ' — ' + b.note : ''}`);
  res.json({ ok: true, fileName: docFileName(l) });
});

// Reply on the same channel the drawings arrived on, offering the next two Fridays.
router.get('/:id/docs/reply', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const f = CS.nextFridays(2);
  const first = String(l.name || 'there').trim().split(/\s+/)[0];
  const me = settingGet('company_contact_name') || (req.user ? req.user.name || req.user.username : 'Smit');
  const body = `Hi ${first},

Thanks for sending the drawings through — I've got everything I need to come and take a look.

Site visits are Fridays. I have ${f[0].label} or ${f[1].label} available. Which suits you better?

It takes about half an hour and there's no cost. Once I've measured up I'll have the detailed quote across to you within 48 hours.

Thanks,
${me}
${settingGet('company_phone') || ''}`;
  res.json({ subject: 'Thanks for the drawings — booking your site visit', body,
    channel: l.docs_channel || 'email', fridays: f });
});

// Client said no after hearing the ballpark. This needs a definite no, not a maybe.
router.post('/:id/disqualify', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (!b.confirmed) return res.status(400).json({ error: 'Needs a definite no from the client before closing this out.' });
  db.prepare("UPDATE leads SET stage='disqualified', status='Lost', next_followup=NULL, declined_reason=?, updated_at=datetime('now') WHERE id=?")
    .run(b.reason || 'Client declined after ballpark', l.id);
  if (l.quote_id) { try { db.prepare("UPDATE quotes SET link_off=1 WHERE id=?").run(l.quote_id); } catch (e) {} }
  db.prepare(`INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId(), l.id, 'note', 'disqualified', null, null,
    req.user ? (req.user.name || req.user.username) : '', 'logged', 'Disqualified — ' + (b.reason || ''));
  res.json({ ok: true });
});

// Lost / closed leads whose OneDrive folders can be cleared out.
router.get('/cleanup/onedrive', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const rows = db.prepare("SELECT * FROM leads WHERE status='Lost' AND docs_received IS NOT NULL AND docs_received <> '[]'").all();
  res.json(rows.map(l => ({ id: l.id, name: l.name, address: l.address, fileName: docFileName(l),
    reason: l.declined_reason || 'closed', closedAt: l.updated_at })));
});

// ---- CALL SCRIPT -------------------------------------------------------------
const CS = require('../utils/callScript');

router.get('/sources', (req, res) => {
  const { groups, REFERRAL } = require('../utils/sources');
  res.json({ groups: groups(), referral: REFERRAL });
});
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
