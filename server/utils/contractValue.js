// The value of a won job: the final contract price, EX GST.
//
// Until v50 a won job's value was read from quoted_sell, which is the deliverable lines
// only. It left out site surcharges and Scope 2 (disposal), so every accepted job showed
// less than the client signed for, and a quote lost value the moment it was accepted.
// quoted_sell and quoted_cost stay as they are (the deliverables baseline); this is the
// figure to show wherever a won job's value or revenue appears.
//
//   won by PO or returned contract  → the value entered when it was marked won
//   signed in the tool              → deliverables + surcharges + Scope 2 for the
//                                     configuration the client accepted (contract_ex)
const { db } = require('../db');

function compute(q) {
  // Lazy: publicQuote pulls in the costing engine and the routes that call this file.
  const t = require('../routes/publicQuote').acceptedTotals(q);
  return Math.round(t.grandExGst * 100) / 100;
}
// Snapshot at acceptance, so later price-list changes can never move a signed figure.
function snapshot(quoteId) {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);
  if (!q || q.status !== 'accepted') return null;
  try { const v = compute(q); db.prepare('UPDATE quotes SET contract_ex=? WHERE id=?').run(v, q.id); return v; }
  catch (e) { console.error('[contract] snapshot failed for', q.quote_number, e.message); return null; }
}
function contractEx(q) {
  if (!q || q.status !== 'accepted') return null;
  if (q.won_method === 'manual' && q.won_value != null) return q.won_value;
  if (q.contract_ex != null) return q.contract_ex;
  const v = snapshot(q.id);
  return v != null ? v : (q.quoted_sell != null ? q.quoted_sell : null);
}
// Jobs accepted before v50 have no snapshot yet. Fill them in once, at start-up.
function backfill() {
  const rows = db.prepare("SELECT id, quote_number FROM quotes WHERE status='accepted' AND contract_ex IS NULL").all();
  let n = 0; rows.forEach(r => { if (snapshot(r.id) != null) n++; });
  if (rows.length) console.log(`[contract] final price ex GST stored for ${n} of ${rows.length} accepted quote(s)`);
}
// For SQL that sums won value without loading each quote.
const SQL = "COALESCE(CASE WHEN q.won_method='manual' THEN q.won_value END, q.contract_ex, q.quoted_sell, q.cached_value_ex, 0)";

module.exports = { contractEx, snapshot, backfill, SQL };
