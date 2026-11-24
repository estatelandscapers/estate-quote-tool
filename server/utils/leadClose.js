// Enquiries and their quotes stay in step (v58).
//
//   1. Closing an enquiry closes EVERY unsigned revision of its quote, not only the first
//      quote the lead row points at. Before this, closing a lead whose quote had been revised
//      marked the superseded original lost and left the live revision in Quotes > Sent.
//   2. Reopening the enquiry reopens exactly what the close shut, with each link put back the
//      way it was.
//   3. A client opening a quote whose enquiry is closed sends a phone notification and leaves
//      a note on the enquiry. The enquiry stays closed until someone reopens it.
//   4. A quote started without an enquiry gets one, built from the quote's own details.
const { db } = require('../db');
const { newId } = require('./ids');

// Every quote that belongs to this enquiry: attached by lead_id, or in the same quote family
// (parent number) as the quote the lead row points at. Sample quotes are never part of a job.
function quotesOf(l) {
  const root = l.quote_id ? db.prepare('SELECT parent_number FROM quotes WHERE id=?').get(l.quote_id) : null;
  return db.prepare(`SELECT * FROM quotes WHERE (lead_id=? OR (? IS NOT NULL AND parent_number=?)) AND COALESCE(is_sample,0)=0
    ORDER BY created_at, quote_number`).all(l.id, root ? root.parent_number : null, root ? root.parent_number : null);
}

// The enquiry has been closed: mark every unsigned revision lost and switch its link off.
// A signed (accepted) revision is never touched. Returns the quote numbers closed just now.
function closeQuotes(leadOrId, reason) {
  const l = typeof leadOrId === 'string' ? db.prepare('SELECT * FROM leads WHERE id=?').get(leadOrId) : leadOrId;
  if (!l) return [];
  const done = [];
  for (const q of quotesOf(l)) {
    if (q.status === 'accepted' || q.lost_at) continue;
    db.prepare(`UPDATE quotes SET lost_at=datetime('now'), lost_reason=COALESCE(lost_reason, ?), lost_via_lead=?, lost_link_prev=COALESCE(link_off,0),
      link_off=1, updated_at=datetime('now') WHERE id=?`).run(reason || 'Enquiry closed', l.id, q.id);
    done.push(q.quote_number);
  }
  if (done.length) console.log(`[lead] ${l.name}: enquiry closed, quote${done.length === 1 ? '' : 's'} ${done.join(', ')} marked lost`);
  return done;
}

// The enquiry has been reopened: bring back what closing it shut. Quotes closed by an older
// version carry no marker, so the quote the lead row points at is reopened as before.
function reopenQuotes(l) {
  const back = [];
  for (const q of quotesOf(l)) {
    if (q.status === 'accepted' || !q.lost_at) continue;
    const byLead = q.lost_via_lead === l.id, legacy = !q.lost_via_lead && q.id === l.quote_id;
    if (!byLead && !legacy) continue;
    db.prepare("UPDATE quotes SET lost_at=NULL, lost_reason=NULL, lost_via_lead=NULL, link_off=?, lost_link_prev=NULL, updated_at=datetime('now') WHERE id=?")
      .run(byLead ? (q.lost_link_prev ? 1 : 0) : 0, q.id);
    back.push(q.quote_number);
  }
  return back;
}

// ---- a client opens the quote of a closed enquiry -----------------------------------------
// At most one alert per quote every 12 hours, so a client flicking back and forth is one buzz.
const ALERT_GAP_H = 12;
function closedViewAlert(q) {
  try {
    if (!q || q.is_sample || q.status === 'accepted') return false;
    let l = q.lead_id ? db.prepare('SELECT * FROM leads WHERE id=?').get(q.lead_id) : null;
    if (!l) l = db.prepare('SELECT l.* FROM leads l JOIN quotes o ON o.id=l.quote_id WHERE o.parent_number=? LIMIT 1').get(q.parent_number);
    if (!l || l.status !== 'Lost') return false;
    if (q.closed_view_alert_at) {
      const since = Date.now() - new Date(String(q.closed_view_alert_at).replace(' ', 'T') + 'Z').getTime();
      if (since < ALERT_GAP_H * 36e5) return false;
    }
    db.prepare("UPDATE quotes SET closed_view_alert_at=datetime('now') WHERE id=?").run(q.id);
    const first = String(l.name || q.client_name || 'Client').trim().split(/\s+/)[0];
    const sees = q.link_off ? 'they saw the "call us" page, not the price' : 'the link is still live';
    db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?)')
      .run(newId(), l.id, 'note', l.stage, 'auto', 'logged', `Client opened quote ${q.quote_number} after this enquiry was closed (${sees})`);
    require('./push').notify({ title: `${first} opened quote ${q.quote_number} — enquiry is closed`,
      body: `${l.declined_reason ? 'Closed as: ' + l.declined_reason + '. ' : ''}${q.link_off ? 'They saw the "call us" page. ' : ''}Tap to open the enquiry and reopen it if it is worth a call.`,
      url: '/admin/?lead=' + l.id, tag: 'closedview-' + q.id }).catch(() => {});
    console.log(`[lead] ${l.name}: client opened quote ${q.quote_number} after the enquiry was closed`);
    return true;
  } catch (e) { console.error('[lead] closed-view alert', e.message); return false; }
}

// ---- a quote with no enquiry gets one ------------------------------------------------------
function suburbFromAddress(addr) {
  const m = String(addr || '').match(/,\s*([A-Za-z][A-Za-z' -]+?)(?:\s+(?:NSW|QLD|VIC|ACT|SA|WA|TAS|NT))?\s*(\d{4})?\s*$/i);
  return m ? m[1].trim() + (m[2] ? ', ' + m[2] : '') : '';
}
const SOURCE = 'Direct quote';
// Needs at least a client name: a blank quote someone has only just opened is not an enquiry
// yet. No invitation, email or text goes to the client from here — this is filing only.
function ensureLeadForQuote(quoteOrId, by) {
  const q = typeof quoteOrId === 'string' ? db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteOrId) : quoteOrId;
  if (!q || q.is_sample) return null;
  if (q.lead_id) return q.lead_id;
  // A revision or sibling already attached: the whole family shares the one enquiry.
  const sib = db.prepare('SELECT lead_id FROM quotes WHERE parent_number=? AND lead_id IS NOT NULL LIMIT 1').get(q.parent_number);
  const owner = sib ? null : db.prepare('SELECT l.id FROM leads l JOIN quotes o ON o.id=l.quote_id WHERE o.parent_number=? LIMIT 1').get(q.parent_number);
  let leadId = sib ? sib.lead_id : owner ? owner.id : null;
  if (!leadId) {
    const name = String(q.client_name || '').trim();
    if (!name) return null;
    // The client already has an open enquiry with no quote on it (same email): this quote is
    // that enquiry's quote, so attach it instead of filing the same person twice.
    const em = String(q.client_email || '').trim().toLowerCase();
    const match = em ? db.prepare(`SELECT id FROM leads WHERE LOWER(TRIM(COALESCE(email,'')))=? AND quote_id IS NULL AND status NOT IN ('Won','Lost')
      ORDER BY created_at DESC LIMIT 1`).get(em) : null;
    if (match) {
      leadId = match.id;
      db.prepare("UPDATE leads SET quote_id=?, updated_at=datetime('now') WHERE id=?").run(q.id, leadId);
      db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?)')
        .run(newId(), leadId, 'note', 'quotesent', by || 'auto', 'logged', `Quote ${q.quote_number} attached (it was started from Quotes; matched on the client's email)`);
      console.log(`[lead] quote ${q.quote_number} attached to the existing enquiry for ${name}`);
    }
  }
  if (!leadId) {
    const name = String(q.client_name || '').trim();
    const sent = !!(q.sent_at || ['sent', 'viewed'].includes(q.status));
    const { nextDueFrom } = require('./leadTemplates');
    leadId = newId();
    db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb,quote_id,from_quote)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(leadId, name, '', q.client_email || '', q.address || '', SOURCE,
      `Created from quote ${q.quote_number}, which was started without an enquiry.`, sent ? 'Quoted' : 'Contacted', 'quotesent',
      sent ? nextDueFrom('quotesent') : null, q.project_title && q.project_title !== 'Landscape Works' ? q.project_title : '', suburbFromAddress(q.address), q.id, q.id);
    db.prepare('INSERT INTO lead_messages (id,lead_id,channel,stage,sent_by,outcome,note) VALUES (?,?,?,?,?,?,?)')
      .run(newId(), leadId, 'note', 'quotesent', by || 'auto', 'logged', `Enquiry created from quote ${q.quote_number} (the quote was started without one). Set the source and phone number when known.`);
    try { require('./leadFiles').numberAll(); } catch (e) {}
    console.log(`[lead] enquiry created for quote ${q.quote_number} (${name})`);
  }
  db.prepare('UPDATE quotes SET lead_id=? WHERE parent_number=? AND lead_id IS NULL AND COALESCE(is_sample,0)=0').run(leadId, q.parent_number);
  return leadId;
}
// The enquiry was made from this quote, and the quote has not gone out yet: the client details
// are still being typed, so the enquiry follows them. Once the quote is sent the enquiry is its
// own record and is no longer overwritten.
function syncLeadFromQuote(quoteId) {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);
  if (!q || !q.lead_id || q.sent_at || !['draft'].includes(q.status)) return false;
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(q.lead_id);
  if (!l || l.from_quote !== q.id) return false;
  const name = String(q.client_name || '').trim() || l.name;
  if (name === l.name && (q.client_email || '') === (l.email || '') && (q.address || '') === (l.address || '')) return false;
  db.prepare("UPDATE leads SET name=?, email=?, address=?, suburb=?, updated_at=datetime('now') WHERE id=?")
    .run(name, q.client_email || '', q.address || '', suburbFromAddress(q.address) || l.suburb || '', l.id);
  return true;
}
// Catch-up: open quotes that still have no enquiry (made before v58, or by a path that
// skipped the check). Signed and lost quotes are history and are left as they are.
function sweep() {
  let n = 0;
  try {
    const rows = db.prepare(`SELECT * FROM quotes WHERE lead_id IS NULL AND COALESCE(is_sample,0)=0 AND lost_at IS NULL
      AND status IN ('draft','sent','viewed') AND TRIM(COALESCE(client_name,''))<>''
      AND NOT EXISTS (SELECT 1 FROM quotes a WHERE a.parent_number=quotes.parent_number AND a.status='accepted') ORDER BY created_at`).all();
    for (const q of rows) { if (ensureLeadForQuote(q.id, 'auto')) n++; }
    if (n) console.log(`[lead] ${n} quote(s) without an enquiry given one`);
  } catch (e) { console.error('[lead] quote-enquiry sweep', e.message); }
  return n;
}
function start() {
  setTimeout(sweep, 20000).unref();
  setInterval(sweep, 30 * 60e3).unref();
}

module.exports = { quotesOf, closeQuotes, reopenQuotes, closedViewAlert, ensureLeadForQuote, syncLeadFromQuote, sweep, start, SOURCE };
