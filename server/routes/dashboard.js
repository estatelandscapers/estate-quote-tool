const express = require('express');
const { db } = require('../db');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const router = express.Router();

function quoteValue(q) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=?').all(q.id);
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const tier = q.accepted_package || q.default_package || 'Standard';
  let s1 = 0, s2 = 0;
  items.forEach(it => {
    const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
    const r = resolveItem(it, pi, tier);
    const t = lineTotal(it, r);
    if (it.scope === 2) s2 += t; else s1 += t;
  });
  return s1 + surchargeAmount(applied, s1) + s2;
}

// Australian FY start (1 Jul)
function fyStart(d = new Date()) {
  const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 6, 1);
}

router.get('/', (req, res) => {
  const quotes = db.prepare('SELECT * FROM quotes').all();
  const now = Date.now();
  const wk = now - 7 * 86400000, mo = now - 30 * 86400000, fy = fyStart().getTime();
  let securedWeek = 0, securedMonth = 0, securedFY = 0;
  let quotedMonth = 0, builtMonth = 0, quotedValueMonth = 0, securedCountFY = 0;

  quotes.forEach(q => {
    const created = new Date((q.created_at || '') + 'Z').getTime();
    const val = quoteValue(q);
    if (q.status === 'accepted') {
      const at = new Date((q.accepted_at || q.updated_at || '') + 'Z').getTime();
      if (at >= wk) securedWeek += val;
      if (at >= mo) securedMonth += val;
      if (at >= fy) { securedFY += val; securedCountFY++; }
    }
    if (created >= mo) { builtMonth++; quotedValueMonth += val; }
  });

  // Win rate (value) over FY: secured / all quoted this FY
  let fyQuoted = 0, fySecured = 0;
  quotes.forEach(q => {
    const created = new Date((q.created_at || '') + 'Z').getTime();
    if (created >= fy) { const v = quoteValue(q); fyQuoted += v; if (q.status === 'accepted') fySecured += v; }
  });

  const recent = db.prepare("SELECT * FROM quotes ORDER BY updated_at DESC LIMIT 8").all().map(q => {
    const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
    return { quoteNumber: q.quote_number, client: q.client_name, value: quoteValue(q),
      status: laterRev > 0 ? 'superseded' : (q.is_complete ? q.status : (q.status === 'draft' ? 'incomplete' : q.status)),
      updatedAt: q.updated_at };
  });

  res.json({
    securedWeek: Math.round(securedWeek), securedMonth: Math.round(securedMonth), securedFY: Math.round(securedFY),
    builtMonth, quotedValueMonth: Math.round(quotedValueMonth),
    winRateValue: fyQuoted > 0 ? Math.round(fySecured / fyQuoted * 100) : 0,
    avgQuote: builtMonth > 0 ? Math.round(quotedValueMonth / builtMonth) : 0,
    securedCountFY, recent,
  });
});

module.exports = router;
