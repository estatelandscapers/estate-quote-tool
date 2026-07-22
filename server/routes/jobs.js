// Jobs register: quotes the business has WON (accepted). Quoted vs ACTUAL gross margin,
// actuals sourced from the final (edited) PO cost lines. FY = Australian (1 Jul - 30 Jun).
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const adminGuard = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });
router.use(adminGuard);

function fyOf(dateStr) {
  const d = new Date((dateStr || '') + 'Z');
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const endYear = m >= 7 ? y + 1 : y;
  return 'FY' + String(endYear).slice(2);
}
function actualCostOf(quoteId) {
  const po = db.prepare('SELECT id FROM purchase_orders WHERE quote_id=?').get(quoteId);
  if (!po) return null;
  const r = db.prepare("SELECT SUM(qty*unit_cost) s FROM po_items WHERE po_id=? AND removed=0 AND kind IN ('material','labour','sub','delivery','plant')").get(po.id);
  return { poId: po.id, cost: r.s || 0 };
}
router.get('/', (req, res) => {
  const rows = db.prepare("SELECT * FROM quotes WHERE status='accepted' ORDER BY accepted_at DESC").all();
  const jobs = rows.map(q => {
    const fy = fyOf(q.accepted_at);
    const act = actualCostOf(q.id);
    const po = act ? db.prepare('SELECT status, closed_at FROM purchase_orders WHERE id=?').get(act.poId) : null;
    const sell = q.quoted_sell || 0, qc = q.quoted_cost || 0;
    const ac = act ? act.cost : null;
    return { id: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address,
      acceptedAt: q.accepted_at, fy, tier: q.accepted_package, mixed: !!(q.accepted_mixed && q.accepted_mixed !== '[]'),
      sellExGst: sell, quotedCost: qc, quotedGM: sell - qc, quotedGMPct: sell > 0 ? Math.round((sell - qc) / sell * 1000) / 10 : 0,
      actualCost: ac, actualGM: ac != null ? sell - ac : null, actualGMPct: ac != null && sell > 0 ? Math.round((sell - ac) / sell * 1000) / 10 : null,
      poId: act ? act.poId : null, jobStatus: po && po.status === 'closed' ? 'complete' : 'open' };
  });
  const fys = [...new Set(jobs.map(j => j.fy).filter(Boolean))].sort().reverse();
  const fy = req.query.fy && req.query.fy !== 'all' ? req.query.fy : null;
  res.json({ fys, jobs: fy ? jobs.filter(j => j.fy === fy) : jobs });
});
// Year-end: totals for an FY + overheads -> NET margin. Gross margin figures throughout are pre-overheads.
router.get('/yearend/:fy', (req, res) => {
  const fy = req.params.fy;
  const rows = db.prepare("SELECT * FROM quotes WHERE status='accepted'").all().filter(q => fyOf(q.accepted_at) === fy);
  let revenue = 0, quotedCost = 0, actualCost = 0, withActuals = 0;
  rows.forEach(q => {
    revenue += q.quoted_sell || 0; quotedCost += q.quoted_cost || 0;
    const a = actualCostOf(q.id);
    if (a) { actualCost += a.cost; withActuals++; } else { actualCost += q.quoted_cost || 0; }
  });
  const close = db.prepare('SELECT * FROM fy_close WHERE fy=?').get(fy);
  const overheads = close ? JSON.parse(close.overheads || '{}') : {};
  const ohTotal = Object.values(overheads).reduce((a, b) => a + (parseFloat(b) || 0), 0);
  const grossMargin = revenue - actualCost;
  res.json({ fy, jobs: rows.length, jobsWithActuals: withActuals, revenue, quotedCost, actualCost,
    grossMargin, grossMarginPct: revenue > 0 ? Math.round(grossMargin / revenue * 1000) / 10 : 0,
    overheads, overheadsTotal: ohTotal, netMargin: grossMargin - ohTotal,
    netMarginPct: revenue > 0 ? Math.round((grossMargin - ohTotal) / revenue * 1000) / 10 : 0,
    closed: !!(close && close.closed), closedAt: close ? close.closed_at : null });
});
router.put('/yearend/:fy/overheads', (req, res) => {
  const fy = req.params.fy;
  const existing = db.prepare('SELECT * FROM fy_close WHERE fy=?').get(fy);
  if (existing && existing.closed) return res.status(400).json({ error: 'year is closed — reopen first' });
  const oh = JSON.stringify(req.body || {});
  if (existing) db.prepare('UPDATE fy_close SET overheads=? WHERE fy=?').run(oh, fy);
  else db.prepare('INSERT INTO fy_close (id,fy,overheads) VALUES (?,?,?)').run(newId(), fy, oh);
  res.json({ ok: true });
});
router.post('/yearend/:fy/close', (req, res) => {
  const fy = req.params.fy;
  const existing = db.prepare('SELECT * FROM fy_close WHERE fy=?').get(fy);
  if (existing) db.prepare("UPDATE fy_close SET closed=1, closed_at=datetime('now') WHERE fy=?").run(fy);
  else db.prepare("INSERT INTO fy_close (id,fy,closed,closed_at) VALUES (?,?,1,datetime('now'))").run(newId(), fy);
  res.json({ ok: true });
});
router.post('/yearend/:fy/reopen', (req, res) => {
  db.prepare('UPDATE fy_close SET closed=0, closed_at=NULL WHERE fy=?').run(req.params.fy);
  res.json({ ok: true });
});
module.exports = router;
