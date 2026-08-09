const express = require('express');
const { db } = require('../db');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const router = express.Router();

// Value of a quote, EXCLUDING GST.
// This used to be a second, private copy of the totals maths — and it drifted: it still
// applied percentage surcharges to Scope 1 only, and ignored site-specific line values.
// It now calls the same code the quote itself uses, so the figures can never disagree.
function quoteValue(q) {
  const { fullQuote } = require('./quotes');
  try {
    const fq = fullQuote(q);
    // For a won job use the price actually signed; otherwise the current build.
    return (q.quoted_sell != null && q.status === 'accepted') ? q.quoted_sell : fq.grandExGst;
  } catch (e) {
    console.error('[dashboard] quoteValue failed for', q.quote_number, e.message);
    return 0;
  }
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
