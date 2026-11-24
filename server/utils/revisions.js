// Revisions of a WON job (v57).
//
// A job is one quote family (same parent_number). Three rules, in one place:
//
//   1. Only a signed revision (e-signed, or marked won by PO/contract) is a won job. A newer
//      revision that has gone to the client but is not signed is still a QUOTE: it sits in
//      step 4 and counts for nothing. The signed revision stays the job until then.
//   2. When a newer revision IS signed, the older signed one stops counting at once, so the
//      job is never in the figures twice. It is not silently filed away though: it is held
//      "to close" until someone in the office confirms it.
//   3. Confirming the close makes the old revision the PREDECESSOR on record. Its signed
//      contract is kept untouched, and what was attached to it (selections, purchase orders)
//      moves to the revision that replaced it. Photos and files belong to the enquiry, so
//      they already follow the job and keep the revision they were added under.
const { db } = require('../db');
const { newId } = require('./ids');

const isSent = q => !!(q && (q.sent_at || ['sent', 'viewed'].includes(q.status)));

// Where a quote family stands: the signed revision that is the job (if any), and a newer
// revision that is with the client but not signed (if any).
function familyState(parentNumber) {
  if (!parentNumber) return { accepted: null, pendingRev: null };
  const fam = db.prepare(`SELECT id, quote_number, status, created_at, accepted_at, sent_at, lost_at, is_sample
    FROM quotes WHERE parent_number=? ORDER BY created_at, quote_number`).all(parentNumber).filter(q => !q.is_sample);
  const accepted = fam.filter(q => q.status === 'accepted')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  let pendingRev = null;
  if (accepted) {
    pendingRev = fam.filter(q => q.id !== accepted.id && String(q.created_at) > String(accepted.created_at)
      && !['accepted', 'superseded'].includes(q.status) && !q.lost_at && isSent(q)).pop() || null;
  }
  return { accepted, pendingRev };
}

// What a quote was worth as a signed job, whatever its status is now.
function signedValue(q) {
  if (!q) return null;
  if (q.won_method === 'manual' && q.won_value != null) return q.won_value;
  if (q.contract_ex != null) return q.contract_ex;
  if (q.quoted_sell != null) return q.quoted_sell;
  return q.cached_value_ex != null ? q.cached_value_ex : null;
}

// Two revisions do not share line ids. Lines are paired by what they are (price item or
// custom code/name, plus the instance number), then in order within that.
function pairItems(oldId, newId_) {
  const key = it => `${it.price_item_id || ('c:' + (it.custom_code || '') + '|' + (it.custom_name || ''))}#${it.instance_no || 1}`;
  const olds = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY sort_order, rowid').all(oldId);
  const news = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY sort_order, rowid').all(newId_);
  const pool = {};
  news.forEach(n => { (pool[key(n)] = pool[key(n)] || []).push(n); });
  return olds.map(o => ({ o, n: (pool[key(o)] || []).shift() || null }));
}

// What closing `old` would carry across to `nw`. Read-only; the office sees this before
// confirming, and carryOver() below does exactly this.
function carryPreview(old, nw) {
  if (!old || !nw) return { selections: 0, po: null, poKept: null, locked: false };
  const sel = pairItems(old.id, nw.id).filter(({ o, n }) => n
    && (o.sel_method != null || o.sel_vendor_id != null || o.sel_sub_days != null)
    && n.sel_method == null && n.sel_vendor_id == null && n.sel_sub_days == null).length;
  const oldPo = db.prepare('SELECT id, po_number, revision FROM purchase_orders WHERE quote_id=? AND superseded=0').get(old.id);
  const newPo = db.prepare('SELECT id, po_number, revision FROM purchase_orders WHERE quote_id=? AND superseded=0').get(nw.id);
  const label = p => p ? p.po_number + (p.revision > 1 ? '-R' + p.revision : '') : null;
  return { selections: sel, po: oldPo && !newPo ? { id: oldPo.id, number: label(oldPo) } : null,
    poKept: oldPo && newPo ? label(oldPo) : null, locked: !!old.selections_locked };
}

function carryOver(old, nw) {
  const out = { selections: 0, po: null, poKept: null, locked: false };
  if (!old || !nw) return out;
  // Selections: how each deliverable is done and who supplies it. A choice already made on
  // the new revision is never overwritten.
  const upd = db.prepare('UPDATE quote_items SET sel_method=?, sel_vendor_id=?, sel_sub_days=? WHERE id=?');
  pairItems(old.id, nw.id).forEach(({ o, n }) => {
    if (!n) return;
    if (o.sel_method == null && o.sel_vendor_id == null && o.sel_sub_days == null) return;
    if (n.sel_method != null || n.sel_vendor_id != null || n.sel_sub_days != null) return;
    upd.run(o.sel_method, o.sel_vendor_id, o.sel_sub_days, n.id); out.selections++;
  });
  // Purchase orders: every revision of the PO moves, so the order history stays in one piece.
  // If the new revision already has a PO of its own, nothing is moved over the top of it.
  const oldPo = db.prepare('SELECT id, po_number, revision FROM purchase_orders WHERE quote_id=? AND superseded=0').get(old.id);
  const newPo = db.prepare('SELECT id FROM purchase_orders WHERE quote_id=? AND superseded=0').get(nw.id);
  const label = p => p.po_number + (p.revision > 1 ? '-R' + p.revision : '');
  if (oldPo && !newPo) {
    db.prepare('UPDATE purchase_orders SET quote_id=? WHERE quote_id=?').run(nw.id, old.id);
    out.po = { id: oldPo.id, number: label(oldPo) };
    if (old.selections_locked) { db.prepare('UPDATE quotes SET selections_locked=1 WHERE id=?').run(nw.id); out.locked = true; }
  } else if (oldPo && newPo) out.poKept = label(oldPo);
  return out;
}

// Take an accepted quote out of the figures because `newId_` replaced it.
//   opts.pending  true  → held "to close": nothing is moved until the office confirms
//                 false → closed now, attachments carried across
function supersedeQuote(oldId, newId_, who, opts = {}) {
  const old = db.prepare('SELECT * FROM quotes WHERE id=?').get(oldId);
  if (!old) return { error: 'not found' };
  if (old.status !== 'accepted') return { error: 'Only an accepted quote can be closed as superseded.' };
  const nw = newId_ ? db.prepare('SELECT * FROM quotes WHERE id=?').get(newId_) : null;
  const pending = !!(opts.pending && nw);
  db.prepare(`UPDATE quotes SET status='superseded', superseded_at=datetime('now'), superseded_by=?, supersede_pending=?, link_off=1, updated_at=datetime('now') WHERE id=?`)
    .run(nw ? nw.id : null, pending ? 1 : 0, old.id);
  if (nw) {
    db.prepare('UPDATE leads SET quote_id=? WHERE quote_id=?').run(nw.id, old.id);
    if (!nw.lead_id && old.lead_id) db.prepare('UPDATE quotes SET lead_id=? WHERE id=?').run(old.lead_id, nw.id);
  }
  console.log(`[quote] ${old.quote_number} superseded${nw ? ' by ' + nw.quote_number : ''}${pending ? ' — waiting for the office to close it' : ''}${who ? ' (' + who + ')' : ''}`);
  if (pending) return { ok: true, pending: true, closed: old.quote_number, by: nw.quote_number };
  return confirmClose(old.id, who, { direct: true });
}

// The office confirms the close: attachments move, and the old revision is filed as the
// predecessor. Its signature, signed PDF and terms snapshot are never touched.
function confirmClose(oldId, who, opts = {}) {
  const old = db.prepare('SELECT * FROM quotes WHERE id=?').get(oldId);
  if (!old) return { error: 'not found' };
  if (old.status !== 'superseded') return { error: 'This quote has not been replaced by a signed revision.' };
  if (!opts.direct && !old.supersede_pending) return { error: `${old.quote_number} is already closed.` };
  const nw = old.superseded_by ? db.prepare('SELECT * FROM quotes WHERE id=?').get(old.superseded_by) : null;
  const carried = carryOver(old, nw);
  db.prepare(`UPDATE quotes SET supersede_pending=0, superseded_closed_at=datetime('now'), superseded_closed_by=?, superseded_carried=?, updated_at=datetime('now') WHERE id=?`)
    .run(who || '', JSON.stringify(carried), old.id);
  const bits = [];
  if (carried.po) bits.push(`PO ${carried.po.number} moved`);
  if (carried.poKept) bits.push(`PO ${carried.poKept} left on ${old.quote_number} (the new revision has its own)`);
  if (carried.selections) bits.push(`${carried.selections} selection${carried.selections === 1 ? '' : 's'} carried`);
  try {
    db.prepare('INSERT INTO audit_log (id,entity_type,entity_id,actor,action,detail) VALUES (?,?,?,?,?,?)')
      .run(newId(), 'quote', old.id, who || '', 'close-superseded',
        `${old.quote_number} closed as predecessor${nw ? ' of ' + nw.quote_number : ''}${bits.length ? ' · ' + bits.join(' · ') : ''}`);
  } catch (e) {}
  console.log(`[quote] ${old.quote_number} closed as predecessor${nw ? ' of ' + nw.quote_number : ''}${who ? ' (' + who + ')' : ''}`);
  return { ok: true, closed: old.quote_number, by: nw ? nw.quote_number : null, byId: nw ? nw.id : null, carried };
}

// Replaced revisions the office has not closed yet, newest first.
function pendingCloses() {
  return db.prepare("SELECT * FROM quotes WHERE status='superseded' AND COALESCE(supersede_pending,0)=1 ORDER BY superseded_at DESC").all().map(old => {
    const nw = old.superseded_by ? db.prepare('SELECT * FROM quotes WHERE id=?').get(old.superseded_by) : null;
    return { id: old.id, quoteNumber: old.quote_number, client: old.client_name, address: old.address || '',
      value: signedValue(old), signedAt: old.accepted_at, at: old.superseded_at, leadId: old.lead_id || (nw && nw.lead_id) || null,
      by: nw ? { id: nw.id, quoteNumber: nw.quote_number, value: signedValue(nw), signedAt: nw.accepted_at,
        method: nw.won_method === 'manual' ? (nw.won_how || 'po') : 'esign' } : null,
      carry: carryPreview(old, nw) };
  });
}

module.exports = { familyState, signedValue, carryPreview, supersedeQuote, confirmClose, pendingCloses, isSent };
