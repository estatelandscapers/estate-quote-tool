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

// Gross margin of a quote from its own costing: sell − materials, labour, subcontract,
// plant — the figure the quote page shows. Overheads come off at year end (Projects).
// A quote with no costing (cost 0) is reported but flagged, and left out of averages.
function marginOf(q) {
  try {
    const c = require('../utils/costing').costQuote(q, { useSelections: true });
    const sell = Math.round(c.selected.sell || 0), cost = Math.round(c.selected.cost || 0);
    return { sell, cost, margin: sell - cost, pct: sell > 0 ? Math.round((sell - cost) / sell * 1000) / 10 : null, priced: cost > 0 };
  } catch (e) { return { sell: 0, cost: 0, margin: 0, pct: null, priced: false }; }
}
const withMargin = (r, q) => { const m = marginOf(q); return { ...r, sell: m.sell, cost: m.cost, margin: m.margin, marginPct: m.pct, priced: m.priced }; };
const sumMargin = rows => Math.round(rows.reduce((a, r) => a + (r.margin || 0), 0));
const avgPct = rows => { const p = rows.filter(r => r.priced); const S = p.reduce((a, r) => a + r.sell, 0), C = p.reduce((a, r) => a + r.cost, 0); return { pct: S > 0 ? Math.round((S - C) / S * 1000) / 10 : null, n: p.length, margin: Math.round(S - C), excluded: rows.filter(r => !r.priced).map(r => r.quoteNumber) }; };

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
      // Secured rows carry their margin, so the tiles can show it beside the value.
      if (at >= fy) { const r = withMargin(row(q, q.accepted_at, note), q); F.securedFY.push(r); if (at >= mo) F.securedMonth.push(r); if (at >= wk) F.securedWeek.push(r); }
      else { if (at >= mo) F.securedMonth.push(row(q, q.accepted_at, note)); if (at >= wk) F.securedWeek.push(row(q, q.accepted_at, note)); }
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
    // Margin on the secured jobs (admin sees these on the tiles)
    marginWeek: sumMargin(F.securedWeek), marginMonth: sumMargin(F.securedMonth), marginFY: sumMargin(F.securedFY),
    marginWeekPct: avgPct(F.securedWeek).pct, marginMonthPct: avgPct(F.securedMonth).pct, marginFYPct: avgPct(F.securedFY).pct,
  });
});

// ---- Forecast -----------------------------------------------------------------------
// What is in play, how fast it decides, and what today's rates say about the months
// ahead. Like figures(), every number is built from a LIST so a tap can show exactly
// which quotes or leads are behind it. Only three inputs are settings: the FY target,
// the stale cut-off (days since sending) and the win rate assumed for stale quotes.
function forecast() {
  const { settingGet } = require('../db');
  const n = (k, d) => { const v = parseFloat(settingGet(k)); return isNaN(v) ? d : v; };
  const target = n('fy_target', 0), staleDays = n('fc_stale_days', 14), staleRate = n('fc_stale_rate', 5) / 100;
  const now = Date.now(), fy = fyStart(), fyT = fy.getTime();
  const fyEnd = new Date(fy.getFullYear() + 1, 6, 1);
  const monthsLeft = Math.max(1, Math.round((fyEnd - now) / (30.44 * 864e5) * 10) / 10);
  const T = s => new Date(String(s || '').replace(' ', 'T') + 'Z').getTime();
  const days = (a, b) => (T(b) - T(a)) / 864e5;
  const ymd = s => String(s || '').slice(0, 10);
  const quotes = db.prepare('SELECT * FROM quotes WHERE COALESCE(is_sample,0)=0').all();
  const current = quotes.filter(q => q.status !== 'superseded' && !isSuperseded(q));
  const fyQ = current.filter(q => T(q.created_at) >= fyT);
  const won = fyQ.filter(q => q.status === 'accepted');
  const lost = fyQ.filter(q => q.lost_at && q.status !== 'accepted');
  // A job whose earlier revision was signed is won, not open — a later revision issued
  // after signing is a variation, and counting it as pipeline double-counts the job.
  const wonParents = new Set(quotes.filter(q => q.status === 'accepted').map(q => q.parent_number));
  const open = fyQ.filter(q => q.status !== 'accepted' && !q.lost_at && !wonParents.has(q.parent_number));
  const val = q => Math.round(quoteValue(q) || 0);
  const sum = l => l.reduce((a, q) => a + val(q), 0);
  const row = (q, note, value, extra) => ({ quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, package: q.accepted_package || q.default_package, note, value: value != null ? value : val(q), ...(extra || {}) });

  // Win rates (FY, current revisions)
  const quotedV = sum(fyQ), wonV = sum(won);
  const winValue = quotedV > 0 ? wonV / quotedV : 0;
  const winCount = fyQ.length ? won.length / fyQ.length : 0;

  // Open quotes by age band
  const LA = require('../utils/linkAnalytics');
  const ageOf = q => q.sent_at ? (now - T(q.sent_at)) / 864e5 : null;
  const band = q => { const a = ageOf(q); return a == null ? 'unsent' : a > staleDays ? 'stale' : 'fresh'; };
  const fresh = open.filter(q => band(q) === 'fresh'), stale = open.filter(q => band(q) === 'stale'), unsent = open.filter(q => band(q) === 'unsent');
  const lastOpen = q => { try { return LA.quick(q).lastOpened; } catch (e) { return null; } };
  const openRows = [...fresh, ...stale, ...unsent].map(q => { const b = band(q); const a = ageOf(q); const lo = lastOpen(q);
    return row(q, b === 'unsent' ? 'not sent yet' : `${b} · sent ${ymd(q.sent_at)} (${Math.round(a)} d)${lo ? ' · last opened ' + ymd(lo) : ' · never opened'}`); });
  const rateFor = q => band(q) === 'stale' ? staleRate : winValue;
  const expectedRows = open.map(q => row(q, `${band(q)} · ${val(q).toLocaleString('en-AU')} × ${Math.round(rateFor(q) * 100)}%`, Math.round(val(q) * rateFor(q))));
  const expected = expectedRows.reduce((a, r) => a + r.value, 0);
  // Jobs use the win rate BY COUNT (a $200k quote is not three wins).
  const expectedJobs = open.reduce((a, q) => a + (band(q) === 'stale' ? staleRate : winCount), 0);
  const staleRows = stale.map(q => { const lo = lastOpen(q); return row(q, `sent ${ymd(q.sent_at)} · ${Math.round(ageOf(q))} d${lo ? ' · last opened ' + ymd(lo) : ' · never opened'}`); });

  // Decision window — all-time, because a single FY rarely has enough signed quotes
  const median = l => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const wonAll = current.filter(q => q.status === 'accepted' && q.sent_at && q.accepted_at);
  const lostAll = current.filter(q => q.lost_at && q.sent_at && q.status !== 'accepted');
  const wonDays = wonAll.map(q => days(q.sent_at, q.accepted_at)), lostDays = lostAll.map(q => days(q.sent_at, q.lost_at));
  const windowRows = [...wonAll.map(q => row(q, `won · ${Math.round(days(q.sent_at, q.accepted_at))} d after sending`)),
    ...lostAll.map(q => row(q, `lost · ${Math.round(days(q.sent_at, q.lost_at))} d after sending${q.lost_reason ? ' · ' + q.lost_reason : ''}`))];

  // Run rate and target. Secured this FY = accepted this FY, the same set as the
  // Secured — FY tile on Current, so the two cards never disagree. (The win rate is a
  // different question — quotes BUILT this FY — and stays on fyQ.)
  const d90 = now - 90 * 864e5;
  const secured90 = quotes.filter(q => q.status === 'accepted' && T(q.accepted_at || q.updated_at) >= d90);
  const wonFY = quotes.filter(q => q.status === 'accepted' && T(q.accepted_at || q.updated_at) >= fyT);
  const runRate = sum(secured90) / 3;
  const securedFY = sum(wonFY);
  const projected = Math.round(securedFY + runRate * monthsLeft);
  const needed = target > 0 ? Math.max(0, (target - securedFY) / monthsLeft) : null;
  const avgWon = won.length ? wonV / won.length : 0, avgQuote = fyQ.length ? quotedV / fyQ.length : 0;

  // Leads
  const leads = db.prepare('SELECT * FROM leads').all();
  const quotedLead = l => !!(l.quote_id || quotes.some(q => q.lead_id === l.id));
  const leadsFY = leads.filter(l => T(l.created_at) >= fyT), leads30 = leads.filter(l => T(l.created_at) >= now - 30 * 864e5);
  const l2qFY = leadsFY.length ? leadsFY.filter(quotedLead).length / leadsFY.length : 0;
  const l2q30 = leads30.length ? leads30.filter(quotedLead).length / leads30.length : 0;
  const wonLeadsFY = leadsFY.filter(l => l.status === 'Won' || quotes.some(q => q.lead_id === l.id && q.status === 'accepted'));
  const l2w = leadsFY.length ? wonLeadsFY.length / leadsFY.length : 0;
  const leadRow = (l, note) => { const q = l.quote_id ? quotes.find(x => x.id === l.quote_id) : quotes.find(x => x.lead_id === l.id);
    return { leadId: l.id, quoteId: q ? q.id : null, quoteNumber: q ? q.quote_number : '—', client: l.name, package: l.suburb || l.address || '', note, value: q ? val(q) : null }; };
  const needWins = needed != null && avgWon > 0 ? needed / avgWon : null;
  const needQuotes = needWins != null && winCount > 0 ? needWins / winCount : null;
  const needLeads = needQuotes != null && l2qFY > 0 ? needQuotes / l2qFY : null;

  // Month by month (quotes built that month, and how many of those were won)
  const months = {};
  const ymLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  for (let d = new Date(fy); d <= new Date(); d.setMonth(d.getMonth() + 1)) months[ymLocal(d)] = { quotes: 0, won: 0, value: 0, wonValue: 0 };
  fyQ.forEach(q => { const k = ymd(q.created_at).slice(0, 7); if (!months[k]) months[k] = { quotes: 0, won: 0, value: 0, wonValue: 0 }; months[k].quotes++; months[k].value += val(q); if (q.status === 'accepted') { months[k].won++; months[k].wonValue += val(q); } });

  // Why we lose (one row per job, latest lost revision)
  const reasons = {};
  lost.forEach(q => { const r = q.lost_reason || 'No reason recorded'; reasons[r] = (reasons[r] || 0) + 1; });
  const reasonList = Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

  // Margins: won jobs, open quotes, quotes built in the last 30 days
  const mRow = q => withMargin(row(q, ''), q);
  const wonM = wonFY.map(mRow), openM = open.map(mRow), built30 = fyQ.filter(q => T(q.created_at) >= now - 30 * 864e5).map(mRow);
  const aWon = avgPct(wonM), aOpen = avgPct(openM), aBuilt = avgPct(built30);
  const wonMarginPct = aWon.pct != null ? aWon.pct / 100 : 0;
  const profit = {
    banked: aWon.margin, perJob: aWon.n ? Math.round(aWon.margin / aWon.n) : 0,
    atTarget: target > 0 ? Math.round(target * wonMarginPct) : null,
    atRunRate: Math.round(projected * wonMarginPct),
    needed: needed != null ? Math.round(needed * wonMarginPct) : null,
    expected: Math.round(expected * (aOpen.pct != null ? aOpen.pct / 100 : wonMarginPct)),
  };
  const marginRows = [...wonM.map(r => ({ ...r, note: 'won · accepted ' + ymd(quotes.find(q => q.id === r.quoteId).accepted_at) })),
    ...openM.map(r => ({ ...r, note: 'open' + (r.priced ? '' : ' · no costing yet — not counted') })),
    ...built30.filter(r => !wonM.some(w => w.quoteId === r.quoteId) && !openM.some(o => o.quoteId === r.quoteId)).map(r => ({ ...r, note: 'built last 30 d · lost' }))];

  const pct = x => Math.round(x * 100);
  return {
    fyStart: ymLocal(fy) + '-01', monthsLeft, staleDays, staleRate: pct(staleRate), target,
    open: { count: open.length, value: sum(open), fresh: { count: fresh.length, value: sum(fresh) }, stale: { count: stale.length, value: sum(stale) }, unsent: { count: unsent.length, value: sum(unsent) } },
    expected: { value: Math.round(expected), jobs: Math.round(expectedJobs * 10) / 10 },
    window: { wonMedian: median(wonDays) != null ? Math.round(median(wonDays)) : null, wonMax: wonDays.length ? Math.round(Math.max(...wonDays)) : null, lostMedian: median(lostDays) != null ? Math.round(median(lostDays)) : null, wonN: wonDays.length, lostN: lostDays.length },
    stale: { count: stale.length, value: sum(stale), rows: staleRows },
    runRate: Math.round(runRate), secured90: sum(secured90), securedFY: Math.round(securedFY), projected,
    needed: needed != null ? Math.round(needed) : null, needWins, needQuotes, needLeads,
    avgWon: Math.round(avgWon), avgQuote: Math.round(avgQuote), wonCount: won.length, quotedCount: fyQ.length,
    winValue: pct(winValue), winCount: pct(winCount),
    leadToQuote: { fy: pct(l2qFY), fyN: leadsFY.length, fyQ: leadsFY.filter(quotedLead).length, d30: pct(l2q30), d30N: leads30.length, d30Q: leads30.filter(quotedLead).length },
    leadToWin: { pct: pct(l2w), n: leadsFY.length, won: wonLeadsFY.length, leadsPerWin: wonLeadsFY.length ? Math.round(leadsFY.length / wonLeadsFY.length) : null },
    months, reasons: reasonList, lostCount: lost.length,
    margin: { won: { pct: aWon.pct, n: aWon.n, perJob: profit.perJob }, open: { pct: aOpen.pct, n: aOpen.n, excluded: aOpen.excluded }, built30: { pct: aBuilt.pct, n: aBuilt.n, excluded: aBuilt.excluded },
      target: parseFloat(settingGet('tier_' + String(settingGet('default_customer_tier') || 'Silver').toLowerCase()) || '25'), targetTier: settingGet('default_customer_tier') || 'Silver' },
    profit,
    lists: {
      fc_margin: { title: 'Average margin', rows: marginRows, note: `Gross margin from each quote's costing (sell − materials, labour, subcontract, plant). Won ${aWon.pct != null ? aWon.pct + '%' : '—'} over ${aWon.n} jobs; open ${aOpen.pct != null ? aOpen.pct + '%' : '—'} over ${aOpen.n} priced quotes; built last 30 d ${aBuilt.pct != null ? aBuilt.pct + '%' : '—'}. Quotes with no costing are listed but not counted.` },
      fc_profit: { title: 'Forecast profit, FY', rows: wonM.map(r => ({ ...r, note: 'won' })), note: `Margin banked on the ${wonM.length} jobs won this FY. Forecast = ${target > 0 ? 'FY target $' + target.toLocaleString('en-AU') + ' × ' : ''}average won margin ${aWon.pct != null ? aWon.pct + '%' : '—'}${target > 0 ? ' = $' + (profit.atTarget || 0).toLocaleString('en-AU') : ''}; at the run-rate projection $${projected.toLocaleString('en-AU')} → $${profit.atRunRate.toLocaleString('en-AU')}.` },
      fc_conv: { title: 'Lead conversion', rows: leadsFY.map(l => leadRow(l, (wonLeadsFY.includes(l) ? 'won' : quotedLead(l) ? 'quoted' : 'not quoted') + (l.status === 'Lost' ? ' · lost' : ''))), note: `Leads this FY: ${leadsFY.filter(quotedLead).length} of ${leadsFY.length} quoted (last 30 days ${leads30.filter(quotedLead).length} of ${leads30.length}), ${wonLeadsFY.length} won.` },
      fc_open: { title: 'Quotes out, awaiting decision', rows: openRows, note: `Open quotes this FY (current revisions). Fresh = sent within ${staleDays} days; stale = older; not sent = still being built.` },
      fc_expected: { title: 'Expected to land', rows: expectedRows, note: `Each open quote × the win rate for its age band: fresh and unsent at the FY win rate by value (${pct(winValue)}%), stale at ${pct(staleRate)}%.` },
      fc_window: { title: 'Decision window', rows: windowRows, note: 'Days between sending and the decision, every signed or lost quote on record (all time — one FY has too few to trust).' },
      fc_stale: { title: 'Stale — chase or close', rows: staleRows, note: `Sent more than ${staleDays} days ago with no decision. Chase once, then mark lost so the figures stay honest.` },
      fc_runrate: { title: 'Run rate — secured, last 90 days', rows: secured90.map(q => row(q, 'accepted ' + ymd(q.accepted_at))), note: `Secured in the last 90 days ÷ 3 = ${Math.round(runRate).toLocaleString('en-AU')} a month. Projection = secured this FY + run rate × ${monthsLeft} months left.` },
      fc_target: { title: 'FY target', rows: wonFY.map(q => row(q, 'accepted ' + ymd(q.accepted_at))), note: target > 0 ? `Secured this FY against the target of $${target.toLocaleString('en-AU')}. Set the target on the tile (admin).` : 'No target set yet — type one on the tile (admin).' },
      fc_needed: { title: 'Needed from here', rows: needed == null ? [] : [
        { quoteNumber: '1', client: `Target $${target.toLocaleString('en-AU')} − secured $${Math.round(securedFY).toLocaleString('en-AU')} = $${Math.round(target - securedFY).toLocaleString('en-AU')} to find`, value: null },
        { quoteNumber: '2', client: `÷ ${monthsLeft} months left`, value: Math.round(needed), note: 'a month' },
        { quoteNumber: '3', client: `÷ average won job $${Math.round(avgWon).toLocaleString('en-AU')} = ${needWins != null ? needWins.toFixed(1) : '—'} wins a month`, value: null },
        { quoteNumber: '4', client: `÷ win rate by count ${pct(winCount)}% = ${needQuotes != null ? needQuotes.toFixed(1) : '—'} quotes a month`, value: null },
        { quoteNumber: '5', client: `÷ lead-to-quote ${pct(l2qFY)}% = ${needLeads != null ? needLeads.toFixed(1) : '—'} leads a month`, value: null }], note: 'The arithmetic, step by step, from the figures on this card.' },
      fc_avgwon: { title: 'Average won job', rows: won.map(q => row(q, 'won · accepted ' + ymd(q.accepted_at))), note: `${won.length} won this FY, average $${Math.round(avgWon).toLocaleString('en-AU')}; average quote across all ${fyQ.length} current quotes $${Math.round(avgQuote).toLocaleString('en-AU')}.` },
      fc_l2q: { title: 'Lead → quote', rows: leadsFY.map(l => leadRow(l, quotedLead(l) ? 'quoted' : 'not quoted' + (l.status === 'Lost' ? ' · lost' : ''))), note: `Leads received this FY and whether a quote was built for them. Last 30 days: ${leads30.filter(quotedLead).length} of ${leads30.length}.` },
      fc_l2w: { title: 'Lead → win', rows: leadsFY.filter(l => wonLeadsFY.includes(l)).map(l => leadRow(l, 'won')), note: `${wonLeadsFY.length} of ${leadsFY.length} leads this FY became a signed job.` },
      fc_months: { title: 'Quotes built vs won, by month', rows: fyQ.map(q => row(q, `built ${ymd(q.created_at)} · ${q.status === 'accepted' ? 'won' : q.lost_at ? 'lost' : 'open'}`)), note: 'Current revision of every quote this FY, by the month it was built.' },
      fc_lost: { title: 'Why we lose', rows: lost.map(q => row(q, `${q.lost_reason || 'No reason recorded'} · ${ymd(q.lost_at)}`)), note: 'One row per job lost this FY, with the reason recorded when it was marked lost.' },
    },
  };
}
router.get('/forecast', (req, res) => {
  try { const f = forecast(); delete f.lists; res.json(f); }
  catch (e) { console.error('[forecast]', e); res.status(500).json({ error: e.message }); }
});

// What's inside a tile. Keys match the tiles on the Leads summary.
router.get('/figure/:key', (req, res) => {
  if (String(req.params.key).startsWith('fc_')) {
    const f = forecast().lists[req.params.key];
    if (!f) return res.status(404).json({ error: 'unknown figure' });
    // Lead lists and the arithmetic list carry no meaningful total.
    const noTotal = ['fc_needed', 'fc_l2q', 'fc_l2w', 'fc_conv', 'fc_margin', 'fc_profit'].includes(req.params.key);
    return res.json({ ...f, total: !noTotal && f.rows.some(r => r.value != null) ? Math.round(f.rows.reduce((a, r) => a + (r.value || 0), 0)) : null });
  }
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
