const express = require('express');
const { db } = require('../db');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const router = express.Router();

// Value of a quote, EXCLUDING GST.
// This used to be a second, private copy of the totals maths — and it drifted: it still
// applied percentage surcharges to Scope 1 only, and ignored site-specific line values.
// It now calls the same code the quote itself uses, so the figures can never disagree.
// A quote is superseded when a LATER revision of the same job exists. Revisions share a
// parent_number and are distinguished by the .1 / .2 suffix — timestamps can't be used
// because several revisions are often created inside the same second.
function revNo(qn) {
  const parts = String(qn || '').split('.');
  return parts.length > 1 ? parseFloat('0.' + parts.slice(1).join('')) : 0;
}
function isSuperseded(q) {
  const family = db.prepare('SELECT quote_number FROM quotes WHERE parent_number=?').all(q.parent_number);
  const mine = revNo(q.quote_number);
  return family.some(f => revNo(f.quote_number) > mine);
}

// EX-GST value of a quote. Uses the cached total where possible — running the costing
// engine for every quote made this endpoint the slowest thing in the app.
function quoteValue(q) {
  // A job won by PO carries the value as approved on the PO; that is the contract figure.
  if (q.status === 'accepted' && q.won_method === 'manual' && q.won_value != null) return q.won_value;
  if (q.quoted_sell != null && q.status === 'accepted') return q.quoted_sell;
  try { return require('./quotes').cachedTotals(q).ex; }
  catch (e) { console.error('[dashboard] quoteValue failed for', q.quote_number, e.message); return 0; }
}

// Australian FY start (1 Jul)
function fyStart(d = new Date()) {
  const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 6, 1);
}

// Every figure is built as a LIST of the quotes inside it; the tile shows the list's
// total and count, so tapping a tile can never disagree with the number on it.
function figures() {
  const quotes = db.prepare('SELECT * FROM quotes WHERE COALESCE(is_sample,0)=0').all();
  const now = Date.now();
  const wk = now - 7 * 86400000, mo = now - 30 * 86400000, fy = fyStart().getTime();
  const T = s => new Date(String(s || '') .replace(' ', 'T') + 'Z').getTime();
  const row = (q, when, note, value) => ({ quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, package: q.accepted_package || q.default_package,
    when, note, value: Math.round(value != null ? value : quoteValue(q)), wonMethod: q.won_method || (q.status === 'accepted' ? 'esign' : null) });
  const F = { securedWeek: [], securedMonth: [], securedFY: [], builtMonth: [], quotedMonth: [], lostFY: [], fyQuoted: [], fySecured: [] };

  quotes.forEach(q => {
    const created = T(q.created_at);
    if (q.status === 'accepted') {
      const at = T(q.accepted_at || q.updated_at);
      const note = (q.won_method === 'manual' ? `won by ${q.won_how === 'po' ? 'client PO' : q.won_how === 'contract' ? 'returned contract' : 'email approval'}` : 'e-signed') + ' ' + String(q.accepted_at || '').slice(0, 10);
      if (at >= wk) F.securedWeek.push(row(q, q.accepted_at, note));
      if (at >= mo) F.securedMonth.push(row(q, q.accepted_at, note));
      if (at >= fy) F.securedFY.push(row(q, q.accepted_at, note));
    }
    const superseded = isSuperseded(q) || q.status === 'superseded';
    if (created >= mo && !superseded && !q.lost_at) {
      const fam = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=?').get(q.parent_number).n;
      const note = fam > 1 ? `current revision (${fam - 1} earlier not counted)` : 'built ' + String(q.created_at || '').slice(0, 10);
      F.builtMonth.push(row(q, q.created_at, note)); F.quotedMonth.push(row(q, q.created_at, note));
    }
    if (created >= fy && !superseded) {
      const v = quoteValue(q); F.fyQuoted.push(row(q, q.created_at, '', v));
      if (q.status === 'accepted') F.fySecured.push(row(q, q.accepted_at, '', v));
    }
  });
  // Lost: ONE row per job. A job marked lost on two revisions (1416, then 1416.1) used to
  // count twice; now the latest lost revision of each parent_number stands for the job.
  const lostByJob = {};
  quotes.filter(q => q.lost_at && T(q.lost_at) >= fy).forEach(q => {
    const cur = lostByJob[q.parent_number];
    if (!cur || revNo(q.quote_number) > revNo(cur.quote_number)) lostByJob[q.parent_number] = q;
  });
  Object.values(lostByJob).forEach(q => F.lostFY.push(row(q, q.lost_at, `lost ${String(q.lost_at || '').slice(0, 10)}${q.lost_reason ? ' · ' + q.lost_reason : ''}`)));
  Object.values(F).forEach(list => list.sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))));
  const sum = l => Math.round(l.reduce((a, r) => a + (r.value || 0), 0));
  return { F, totals: { securedWeek: sum(F.securedWeek), securedMonth: sum(F.securedMonth), securedFY: sum(F.securedFY), builtMonth: F.builtMonth.length,
    quotedValueMonth: sum(F.quotedMonth), lostFY: F.lostFY.length, lostValueFY: sum(F.lostFY), fyQuoted: sum(F.fyQuoted), fySecured: sum(F.fySecured),
    securedCountFY: F.securedFY.length, revisionsMonth: quotes.filter(q => T(q.created_at) >= mo && !q.lost_at).length } };
}

router.get('/', (req, res) => {
  const { F, totals: t } = figures();
  const recent = db.prepare("SELECT * FROM quotes WHERE COALESCE(is_sample,0)=0 ORDER BY updated_at DESC LIMIT 8").all().map(q => {
    const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
    return { quoteNumber: q.quote_number, client: q.client_name, value: quoteValue(q),
      status: laterRev > 0 ? 'superseded' : (q.is_complete ? q.status : (q.status === 'draft' ? 'incomplete' : q.status)),
      updatedAt: q.updated_at };
  });
  res.json({
    securedWeek: t.securedWeek, securedMonth: t.securedMonth, securedFY: t.securedFY,
    securedWeekCount: F.securedWeek.length, securedMonthCount: F.securedMonth.length, securedManualFY: F.securedFY.filter(r => r.wonMethod === 'manual').length,
    builtMonth: t.builtMonth, revisionsMonth: t.revisionsMonth, quotedValueMonth: t.quotedValueMonth,
    lostFY: t.lostFY, lostValueFY: t.lostValueFY,
    winRateValue: t.fyQuoted > 0 ? Math.round(t.fySecured / t.fyQuoted * 100) : 0, fyQuoted: t.fyQuoted, fySecured: t.fySecured,
    avgQuote: t.builtMonth > 0 ? Math.round(t.quotedValueMonth / t.builtMonth) : 0,
    securedCountFY: t.securedCountFY, recent,
  });
});

// What's inside a tile. Keys match the tiles on the Leads summary.
router.get('/figure/:key', (req, res) => {
  const { F, totals } = figures();
  const k = req.params.key;
  const map = {
    wk: { title: 'Secured — this week', rows: F.securedWeek, note: 'Jobs accepted in the last 7 days (e-signed or marked won by PO/contract).' },
    mo: { title: 'Secured — month', rows: F.securedMonth, note: 'Jobs accepted in the last 30 days. Superseded revisions are never counted.' },
    fy: { title: 'Secured — FY', rows: F.securedFY, note: 'Jobs accepted since 1 July.' },
    built: { title: 'Quotes built (30D)', rows: F.builtMonth, note: `${totals.revisionsMonth} quote rows were created in the last 30 days; a revision replaces its earlier versions, so ${F.builtMonth.length} job${F.builtMonth.length === 1 ? '' : 's'} count.` },
    quoted: { title: 'Value quoted (30D)', rows: F.quotedMonth, note: 'Current revision of each job built in the last 30 days, ex GST. Lost quotes are excluded.' },
    lost: { title: 'Lost this FY', rows: F.lostFY, note: 'One row per job — the latest revision marked lost stands for the job.' },
    win: { title: 'Win rate (value, FY)', rows: [...F.fySecured.map(r => ({ ...r, note: 'won' })), ...F.fyQuoted.filter(r => !F.fySecured.some(s => s.quoteId === r.quoteId)).map(r => ({ ...r, note: 'quoted, open or lost' }))],
      note: `Won ${'$' + totals.fySecured.toLocaleString('en-AU')} of ${'$' + totals.fyQuoted.toLocaleString('en-AU')} quoted this FY (current revisions).` },
  };
  if (k === 'open') {
    const rows = db.prepare("SELECT * FROM leads WHERE status NOT IN ('Won','Lost') AND COALESCE(parked,0)=0 ORDER BY next_followup").all().map(l => {
      const q = l.quote_id ? db.prepare('SELECT id, quote_number FROM quotes WHERE id=?').get(l.quote_id) : null;
      return { leadId: l.id, quoteId: q ? q.id : null, quoteNumber: q ? q.quote_number : '—', client: l.name, package: l.suburb || '', when: l.next_followup, note: 'next: ' + (l.next_followup || 'no date'), value: null };
    });
    return res.json({ title: 'Open enquiries', rows, note: 'Every enquiry not yet won, lost or parked.', total: null });
  }
  const f = map[k];
  if (!f) return res.status(404).json({ error: 'unknown figure' });
  res.json({ ...f, total: Math.round(f.rows.reduce((a, r) => a + (r.value || 0), 0)) });
});

module.exports = router;
