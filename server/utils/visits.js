// Site visits: the client gives a preference, the time is set the day before (v54).
//
// Nobody is promised a time when a visit is booked. The route for a visit day is worked
// out the afternoon before, once every visit for that day is in and their suburbs are
// known. So a booking records only a PREFERENCE (morning, afternoon, or none), and the
// client is told the date. The day before, from midday, locking in the arrival windows
// becomes the critical task: each visit gets a start time, the client gets a one-hour
// arrival window by email and text, and that message doubles as the reminder.
const { db, settingGet, settingSet } = require('../db');
// Sydney date and hour, whatever the server clock says.
function sydneyParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}
const newId = () => require('crypto').randomUUID();

for (const c of ['pref', 'win_from', 'win_to', 'win_sent_at', 'win_by']) { try { db.exec(`ALTER TABLE site_visits ADD COLUMN ${c} TEXT`); } catch (e) {} }

function timeKey(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10) % 12; if ((m[3] || '').toLowerCase() === 'pm') h += 12;
  return h * 60 + parseInt(m[2] || '0', 10);
}
const fmt = mins => { const h = Math.floor(mins / 60), m = mins % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
const TIMES = (() => { const out = []; for (let m = 7 * 60; m <= 16 * 60 + 30; m += 30) out.push(fmt(m)); return out; })();
const WINDOW_MIN = 60;
const PREFS = [{ id: 'AM', label: 'Morning' }, { id: 'PM', label: 'Afternoon' }, { id: '', label: 'No preference' }];
const cleanPref = p => { const x = String(p || '').trim().toUpperCase(); return x === 'AM' || x === 'MORNING' ? 'AM' : x === 'PM' || x === 'AFTERNOON' ? 'PM' : ''; };
const prefWord = p => p === 'AM' ? 'morning' : p === 'PM' ? 'afternoon' : '';
const niceDay = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Visits booked under the old rule had a clock time. Upcoming ones keep it as a preference
// and as a note, since that client was told a time; past ones are left exactly as they were.
if (!settingGet('visits_pref_v1')) {
  try {
    const today = sydneyParts().ymd;
    for (const v of db.prepare("SELECT id, visit_time, note FROM site_visits WHERE status='booked' AND visit_date >= ? AND COALESCE(visit_time,'')<>'' AND pref IS NULL").all(today)) {
      const k = timeKey(v.visit_time);
      db.prepare("UPDATE site_visits SET pref=?, visit_time='', note=? WHERE id=?").run(k >= 0 && k < 720 ? 'AM' : k >= 720 ? 'PM' : '',
        [v.note, `Client was told ${v.visit_time} when this was booked`].filter(Boolean).join(' · '), v.id);
    }
  } catch (e) { console.error('[visits] migration skipped:', e.message); }
  settingSet('visits_pref_v1', '1');
}

function row(v) {
  const locked = !!(v.win_from && v.win_to);
  return { id: v.id, leadId: v.lead_id, date: v.visit_date, status: v.status, pref: v.pref || '', prefLabel: prefWord(v.pref || ''),
    from: v.win_from || '', to: v.win_to || '', locked, sentAt: v.win_sent_at || null, note: v.note || '', bookedBy: v.booked_by || '',
    name: v.name || '', phone: v.phone || '', email: v.email || '',
    // A street address (one with a number) beats the suburb: it is what the crew drives to.
    suburb: (v.address && /\d/.test(v.address)) ? v.address : (v.suburb || v.address || ''), address: v.address || '',
    when: locked ? `${v.win_from} to ${v.win_to}` : (v.pref ? `prefers ${prefWord(v.pref)}` : 'no preference') };
}
const order = (a, b) => a.visit_date.localeCompare(b.visit_date)
  || (a.win_from ? timeKey(a.win_from) : 9000 + (a.pref === 'AM' ? 0 : a.pref === 'PM' ? 2 : 1)) - (b.win_from ? timeKey(b.win_from) : 9000 + (b.pref === 'AM' ? 0 : b.pref === 'PM' ? 2 : 1))
  || String(a.suburb || '').localeCompare(String(b.suburb || ''));
const SQL = `SELECT v.*, l.name, l.suburb, l.address, l.phone, l.email FROM site_visits v LEFT JOIN leads l ON l.id=v.lead_id`;

// The next visit day and whether its times are due. Due = from midday the day before
// (Thursday, for the usual Friday visits) until the visits are done, while any client
// has not been sent their window.
function lockin(now = new Date()) {
  const { ymd, hour } = sydneyParts(now);
  const next = db.prepare("SELECT MIN(visit_date) d FROM site_visits WHERE status='booked' AND visit_date >= ? AND lead_id IS NOT NULL").get(ymd).d;
  if (!next) return { date: null, visits: [], open: 0, due: false };
  const visits = db.prepare(SQL + " WHERE v.status='booked' AND v.visit_date=? AND v.lead_id IS NOT NULL").all(next).sort(order).map(row);
  const open = visits.filter(v => !v.sentAt).length;
  const dayBefore = addDays(next, -1);
  const due = open > 0 && ((ymd === dayBefore && hour >= 12) || ymd === next);
  return { date: next, label: niceDay(next), lockDay: niceDay(dayBefore).split(' ')[0], dueFrom: `${niceDay(dayBefore)}, midday`,
    isTomorrow: ymd === dayBefore, isToday: ymd === next, due, open, total: visits.length, visits, times: TIMES, windowMinutes: WINDOW_MIN };
}

// Tell one client their arrival window: email and text. Returns what went.
async function sendWindow(visitId, by) {
  const v = db.prepare(SQL + ' WHERE v.id=?').get(visitId);
  if (!v || !v.lead_id) return { ok: false, error: 'visit not found' };
  if (!v.win_from || !v.win_to) return { ok: false, error: 'No arrival time set' };
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(v.lead_id);
  const T = require('./leadTemplates');
  const today = sydneyParts().ymd;
  const dayWord = v.visit_date === addDays(today, 1) ? 'tomorrow, ' : v.visit_date === today ? 'today, ' : 'on ';
  const visitday = dayWord + niceDay(v.visit_date);
  const msg = T.buildMessage({ lead, stage: 'visitwindow', sender: by || settingGet('sms_sign_name') || 'Smit', date: v.visit_date,
    extra: { visitday, from: v.win_from, to: v.win_to } });
  const out = [];
  if (lead.email) {
    const { sendMail } = require('./email'); const { shell, esc, signatureHtml } = require('./quoteEmail');
    const html = shell(T.forEmail(msg.body, msg.signoff).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('') + signatureHtml());
    const mid = newId(); let outcome = 'sent', err = null;
    try { const r = await sendMail({ to: lead.email, subject: msg.subject, html, track: mid }); if (r && r.skipped) { outcome = 'failed'; err = r.reason; } } catch (e) { outcome = 'failed'; err = e.message; }
    db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,subject,body,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(mid, lead.id, 'email', 'visitwindow', msg.subject, msg.body, by || 'auto', outcome, 'Arrival window' + (err ? ' · NOT SENT: ' + err : ''));
    out.push({ channel: 'email', ok: outcome === 'sent', error: err });
  }
  if (lead.phone) {
    try {
      const sms = require('./sms');
      const body = sms.shape(sms.firstName(lead.name), sms.fill(sms.textOf('visit'), { first: sms.firstName(lead.name), day: visitday, from: v.win_from, to: v.win_to,
        when: `${niceDay(v.visit_date)}, between ${v.win_from} and ${v.win_to}`, phone: sms.companyPhone() }), sms.closeOf('visit'));
      const r = await sms.send({ type: 'visit', ref: `visit:${v.id}:${v.visit_date}:${v.win_from}`, lead, body, by: by || 'auto', history: true });
      out.push({ channel: 'text', ok: !!r.ok, status: r.status, error: r.error || null });
    } catch (e) { out.push({ channel: 'text', ok: false, error: e.message }); }
  }
  const went = out.some(o => o.ok);
  // Marked as told once anything reached them. With no email and no mobile on file there is
  // nothing to send, and the visit is marked so the task can close: it needs a phone call.
  if (went || !out.length) db.prepare("UPDATE site_visits SET win_sent_at=datetime('now'), win_by=? WHERE id=?").run(by || '', v.id);
  return { ok: went || !out.length, name: lead.name, sent: out, nothing: !out.length };
}

// Save the start times for a visit day and, if asked, send every window.
async function save({ items, send, by }) {
  const results = [];
  for (const it of items || []) {
    const v = db.prepare('SELECT * FROM site_visits WHERE id=?').get(it.id); if (!v) continue;
    const k = timeKey(it.from);
    if (k < 0) { if (send) results.push({ id: v.id, ok: false, error: 'No arrival time set' }); continue; }
    const from = fmt(k), to = fmt(k + WINDOW_MIN);
    // A window that changed after the client was told goes out again.
    const changed = v.win_from !== from;
    db.prepare("UPDATE site_visits SET win_from=?, win_to=?, visit_time=?, win_sent_at=CASE WHEN ? THEN NULL ELSE win_sent_at END, updated_at=datetime('now') WHERE id=?").run(from, to, from, changed ? 1 : 0, v.id);
    if (send && (changed || !v.win_sent_at)) results.push({ id: v.id, ...(await sendWindow(v.id, by)) });
  }
  return results;
}

// Midday and 3 pm the day before, while windows are still unsent.
async function tick() {
  const L = lockin(); if (!L.due || !L.isTomorrow) return;
  const { hour } = sydneyParts();
  const slot = hour >= 15 ? 15 : hour >= 12 ? 12 : 0; if (!slot || hour >= 19) return;
  const key = `lockin_push_${L.date}_${slot}`; if (settingGet(key)) return;
  settingSet(key, '1');
  try { await require('./push').notify({ title: slot === 12 ? `Lock in ${L.label.split(' ')[0]}'s site visit times` : `Still to do: ${L.open} site visit time${L.open === 1 ? '' : 's'} not sent`,
    body: `${L.open} of ${L.total} client${L.total === 1 ? '' : 's'} waiting on an arrival window for ${L.label}. Set the route and send them.`, url: '/admin/?tab=leads&view=calendar', tag: 'lockin-' + L.date }); } catch (e) {}
}
function start() { setInterval(() => { tick().catch(e => console.error('[visits]', e.message)); }, 5 * 60e3).unref(); }

module.exports = { lockin, save, sendWindow, tick, start, row, order, SQL, TIMES, PREFS, cleanPref, prefWord, timeKey, niceDay };
