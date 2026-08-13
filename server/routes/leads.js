// Leads / enquiries. Manual entry now; a public website form can POST to /api/public/lead later
// without any rework (same table, same fields).
const express = require('express');
const { db } = require('../db');
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
router.get('/stages', (req, res) => res.json(STAGES));
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
      b.notes || '', b.status || 'New', b.stage || 'noanswer', b.nextFollowup || null,
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
  if (l.quote_id) return res.status(400).json({ error: 'already converted', quoteId: l.quote_id });
  const { createQuote } = require('./quotes');
  const q = createQuote({ client: l.name, clientEmail: l.email, address: l.address, projectTitle: 'Landscape Works', leadId: l.id });
  db.prepare("UPDATE leads SET quote_id=?, status='Quoted', updated_at=datetime('now') WHERE id=?").run(q.id, l.id);
  res.status(201).json({ quoteId: q.id, quoteNumber: q.quote_number });
});

// ---- Follow-up console ------------------------------------------------------
const { STAGES, buildMessage } = require('../utils/leadTemplates');


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

  // Move the lead along, and diarise the next follow-up.
  const sets = [], vals = [];
  if (b.stage) { sets.push('stage=?'); vals.push(b.stage); }
  if (b.nextFollowup !== undefined) { sets.push('next_followup=?'); vals.push(b.nextFollowup || null); }
  if (b.status) { sets.push('status=?'); vals.push(b.status); }
  if (sets.length) {
    vals.push(l.id);
    db.prepare(`UPDATE leads SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals);
  }
  console.log(`[lead] ${channel} on ${l.name} by ${who} (${outcome})`);
  res.status(201).json({ ok: true, outcome });
});

router.get('/:id/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM lead_messages WHERE lead_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows.map(r => ({ id: r.id, channel: r.channel, stage: r.stage, subject: r.subject,
    body: r.body, sentBy: r.sent_by, outcome: r.outcome, note: r.note, at: r.created_at })));
});

module.exports = router;
