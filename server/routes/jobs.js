// Jobs register: quotes the business has WON (accepted). Quoted vs ACTUAL gross margin,
// actuals sourced from the final (edited) PO cost lines. FY = Australian (1 Jul - 30 Jun).
const express = require('express');
const { db } = require('../db');
const { newId } = require('../utils/ids');
const router = express.Router();
const adminGuard = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });
const isAdmin = req => req.user && req.user.role === 'admin';
// Non-admins can see WHICH jobs are running and how they're tracking, but never the
// money. Every figure below is removed for them, not just hidden in the interface.
const MONEY_FIELDS = ['sellExGst', 'quotedCost', 'quotedGM', 'quotedGMPct', 'actualCost', 'actualGM',
  'actualGMPct', 'forecastCost', 'forecastGMPct', 'costToDate', 'committed', 'remainingCost',
  'projectedCost', 'projectedGMPct', 'driftPts', 'ohAllocated', 'netGMPct', 'spentPct'];
function stripMoney(job) { const o = { ...job }; MONEY_FIELDS.forEach(k => delete o[k]); return o; }
// Reading is open to any signed-in user (money stripped below); changing anything
// — closing a year, reopening a job — stays admin-only.
router.use((req, res, next) => (req.method === 'GET' || isAdmin(req)) ? next() : adminGuard(req, res, next));

function fyOf(dateStr) {
  const d = new Date((dateStr || '') + 'Z');
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const endYear = m >= 7 ? y + 1 : y;
  return 'FY' + String(endYear).slice(2);
}
// FORECAST = the full current PO (the locked Selections plan).
// TO DATE   = only lines actually Delivered or Invoiced, plus any misc cost lines added on the job.
// Ordered-but-not-delivered is reported separately as "committed".
// Only the current (non-superseded) PO counts, so revisions never double-count.
const COST_KINDS = "('material','labour','sub','delivery','plant')";
function actualCostOf(quoteId) {
  const po = db.prepare('SELECT id FROM purchase_orders WHERE quote_id=? AND superseded=0').get(quoteId);
  if (!po) return null;
  const sum = (where, args = []) => db.prepare(
    `SELECT COALESCE(SUM(qty*unit_cost),0) s FROM po_items WHERE po_id=? AND removed=0 AND kind IN ${COST_KINDS} ${where}`
  ).get(po.id, ...args).s || 0;
  const forecast = sum('');                                     // whole plan
  const toDate = sum("AND po_status IN ('delivered','invoiced')"); // actually landed
  const committed = sum("AND po_status='ordered'");             // ordered, not yet in
  const remaining = sum("AND (po_status IS NULL OR po_status='pending')"); // still to come, at plan rates
  // Projected final cost = what has landed + what's committed + what's still to come at plan.
  // This is the honest "where will this job end up" figure — a raw cost-to-date margin
  // looks great at 10% spent and means nothing.
  const projected = toDate + committed + remaining;
  return { poId: po.id, cost: forecast, forecast, toDate, committed, remaining, projected };
}
// Business overheads (supervisor, office, vehicles, insurances — NOT direct site labour),
// entered monthly in Costs and spread across working days, then allocated by the job's crew-days.
function overheadDailyRate() {
  const { settingGet } = require('../db');
  const wd = Math.max(1, parseFloat(settingGet('work_days_per_month') || '21'));
  const pool = db.prepare(`SELECT COALESCE(SUM(monthly_cost),0) s FROM materials
    WHERE category='overhead' AND id NOT IN (SELECT material_id FROM recipe_component WHERE kind='overhead' AND material_id IS NOT NULL)`).get().s;
  return pool / wd;
}
router.get('/', (req, res) => {
  const rows = db.prepare("SELECT * FROM quotes WHERE status='accepted' ORDER BY accepted_at DESC").all();
  const ohDaily = overheadDailyRate();
  const jobs = rows.map(q => {
    const fy = fyOf(q.accepted_at);
    const act = actualCostOf(q.id);
    const po = act ? db.prepare('SELECT status, closed_at FROM purchase_orders WHERE id=?').get(act.poId) : null;
    const po2 = act ? db.prepare('SELECT site_hours, crew_size FROM purchase_orders WHERE id=?').get(act.poId) : null;
    const sell = q.quoted_sell || 0, qc = q.quoted_cost || 0;
    const ac = act ? act.cost : null;
    const pct = c => sell > 0 ? Math.round((sell - c) / sell * 1000) / 10 : null;
    const crewDays = po2 && po2.site_hours ? po2.site_hours / Math.max(1, po2.crew_size || 2) / 8 : 0;
    const ohAlloc = ohDaily * crewDays;
    const fcPct = act ? pct(act.forecast) : null;
    const projPct = act ? pct(act.projected) : null;
    return { id: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address,
      acceptedAt: q.accepted_at, fy, tier: q.accepted_package, mixed: !!(q.accepted_mixed && q.accepted_mixed !== '[]'),
      sellExGst: sell, quotedCost: qc, quotedGM: sell - qc, quotedGMPct: sell > 0 ? Math.round((sell - qc) / sell * 1000) / 10 : 0,
      actualCost: ac, actualGM: ac != null ? sell - ac : null, actualGMPct: pct(ac),
      forecastCost: act ? Math.round(act.forecast) : null, forecastGMPct: fcPct,
      costToDate: act ? Math.round(act.toDate) : null,
      committed: act ? Math.round(act.committed) : 0,
      remainingCost: act ? Math.round(act.remaining) : 0,
      projectedCost: act ? Math.round(act.projected) : null, projectedGMPct: projPct,
      spentPct: act && act.forecast > 0 ? Math.round(act.toDate / act.forecast * 100) : 0,
      driftPts: (fcPct != null && projPct != null) ? Math.round((projPct - fcPct) * 10) / 10 : null,
      ohAllocated: Math.round(ohAlloc),
      netGMPct: act && sell > 0 ? Math.round((sell - act.projected - ohAlloc) / sell * 1000) / 10 : null,
      poId: act ? act.poId : null, jobStatus: po && po.status === 'closed' ? 'complete' : 'open' };
  });
  const fys = [...new Set(jobs.map(j => j.fy).filter(Boolean))].sort().reverse();
  const fy = req.query.fy && req.query.fy !== 'all' ? req.query.fy : null;
  const list = fy ? jobs.filter(j => j.fy === fy) : jobs;
  const totSell = list.reduce((a, j) => a + j.sellExGst, 0);
  const totCost = list.reduce((a, j) => a + (j.projectedCost || 0), 0);
  const totOh = list.reduce((a, j) => a + (j.ohAllocated || 0), 0);
  if (!isAdmin(req)) return res.json({ fys, jobs: list.map(stripMoney), restricted: true });
  res.json({ fys, jobs: list, overheadDailyRate: Math.round(ohDaily),
    summary: { grossPct: totSell > 0 ? Math.round((totSell - totCost) / totSell * 1000) / 10 : 0,
      overhead: Math.round(totOh),
      netPct: totSell > 0 ? Math.round((totSell - totCost - totOh) / totSell * 1000) / 10 : 0 } });
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
