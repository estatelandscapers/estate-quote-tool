const express = require('express');
const { db } = require('../db');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const router = express.Router();
// Costing (Current + Forecast) is the admin's: secured value, margins, profit, targets.
router.use((req, res, next) => (!req.user || req.user.role !== 'admin') ? res.status(403).json({ error: 'admin only' }) : next());

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
  // A won job is worth its final contract price: deliverables, surcharges and Scope 2.
  if (q.status === 'accepted') { const v = require('../utils/contractValue').contractEx(q); if (v != null) return v; }
  try { return require('./quotes').cachedTotals(q).ex; }
  catch (e) { console.error('[dashboard] quoteValue failed for', q.quote_number, e.message); return 0; }
}

// Gross margin of a quote from its own costing: sell − materials, labour, subcontract,
// plant — the figure the quote page shows. Overheads come off at year end (Projects).
// A quote with no costing (cost 0) is reported but flagged, and left out of averages.
function marginOf(q) {
  try {
    const c = require('../utils/costing').costQuote(q, { useSelections: true });
    // Margin = the final price ex GST (surcharges and Scope 2 included) less the costed cost,
    // for won and open quotes alike, so the two can be compared.
    const full = Math.round(quoteValue(q) || 0);
    const sell = full > 0 ? full : Math.round(c.selected.sell || 0), cost = Math.round(c.selected.cost || 0);
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
      status: laterRev > 0 && q.status !== 'accepted' ? 'superseded' : (q.is_complete ? q.status : (q.status === 'draft' ? 'incomplete' : q.status)),
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
// ---- FORECAST ------------------------------------------------------------------------------
// v51 rework, after an audit of the old numbers. What changed and why:
//   - Counted per JOB (a quote and its revisions), not per revision. A job won and then
//     varied used to lose its win and count the variation as an unwon quote.
//   - Win rate is over DECIDED jobs (won ÷ won + lost). Open quotes are not losses.
//   - A quote the client has opened is "sent", even if it was shared by copying the link.
//   - Each open quote gets its own win chance: the win rate for jobs of its size, adjusted
//     for how long it has waited, both taken from this business's own decided quotes.
//   - Jobs on hold leave the open pipeline and are shown on their own.
//   - Lead conversion uses leads old enough to have had the chance to convert.
//   - A second projection (FY outlook) is built from the pipeline and lead flow, with a
//     low–high range, beside the run rate.
//   - Profit is shown after the year's overheads, and won jobs whose costing looks unfinished
//     are flagged and left out of the average margin.
const SIZE_BANDS = [[0, 30000, 'under $30k'], [30000, 60000, '$30k – $60k'], [60000, 120000, '$60k – $120k'], [120000, Infinity, 'over $120k']];
const MATURE_DAYS = 45;          // a lead this old has had time to be quoted and decided
const MARGIN_OK = [5, 60];       // outside this, a won job's costing is treated as unfinished
function forecast() {
  const { settingGet } = require('../db');
  const n = (k, d) => { const v = parseFloat(settingGet(k)); return isNaN(v) ? d : v; };
  const target = n('fy_target', 0), staleDays = n('fc_stale_days', 14), staleRate = n('fc_stale_rate', 5) / 100;
  const now = Date.now(), fy = fyStart(), fyT = fy.getTime();
  const fyEnd = new Date(fy.getFullYear() + 1, 6, 1);
  const monthsLeft = Math.max(1, Math.round((fyEnd - now) / (30.44 * 864e5) * 10) / 10);
  const T = s => new Date(String(s || '').replace(' ', 'T') + 'Z').getTime();
  const ymd = s => String(s || '').slice(0, 10);
  const LA = require('../utils/linkAnalytics');
  let heldMap = new Map(); try { heldMap = require('../utils/holds').heldParents(); } catch (e) {}

  // ---- jobs: one per quote family ----
  const quotes = db.prepare('SELECT * FROM quotes WHERE COALESCE(is_sample,0)=0').all();
  const fam = new Map(); quotes.forEach(q => { const k = q.parent_number || q.id; if (!fam.has(k)) fam.set(k, []); fam.get(k).push(q); });
  const briefOf = q => { try { return LA.brief(q); } catch (e) { return null; } };
  const jobs = [...fam.entries()].map(([parent, revs]) => {
    revs.sort((a, b) => revNo(a.quote_number) - revNo(b.quote_number) || String(a.created_at).localeCompare(String(b.created_at)));
    const latest = revs[revs.length - 1];
    const acc = revs.filter(r => r.status === 'accepted').sort((a, b) => String(b.accepted_at || '').localeCompare(String(a.accepted_at || '')))[0] || null;
    const q = acc || latest;
    const state = acc ? 'won' : latest.lost_at ? 'lost' : heldMap.has(parent) ? 'hold' : 'open';
    const j = { parent, q, state, value: Math.round(quoteValue(q) || 0), firstCreated: revs[0].created_at };
    // When did the client get it? The Send button, or the first time they opened the link.
    if (state !== 'won' && state !== 'lost') { const b = briefOf(q); j.sentAt = q.sent_at || (b && b.firstOpened) || null; j.byLink = !q.sent_at && !!j.sentAt; j.lastOpened = b ? b.lastOpened : null; }
    else j.sentAt = q.sent_at || null;
    j.decidedAt = state === 'won' ? (q.accepted_at || q.updated_at) : state === 'lost' ? q.lost_at : null;
    return j;
  });
  const won = jobs.filter(j => j.state === 'won'), lost = jobs.filter(j => j.state === 'lost'), open = jobs.filter(j => j.state === 'open'), held = jobs.filter(j => j.state === 'hold');
  const inFY = j => T(j.decidedAt) >= fyT;
  const wonFY = won.filter(inFY), lostFY = lost.filter(inFY);
  const sum = l => l.reduce((a, j) => a + j.value, 0);
  const row = (j, note, value, extra) => ({ quoteId: j.q.id, quoteNumber: j.q.quote_number, client: j.q.client_name, package: j.q.accepted_package || j.q.default_package, note, value: value != null ? value : j.value, ...(extra || {}) });
  const pct = x => Math.round(x * 100);
  const $ = x => '$' + Math.round(x).toLocaleString('en-AU');

  // ---- win rate: decided jobs only ----
  const decidedFY = wonFY.length + lostFY.length;
  const winCount = decidedFY ? wonFY.length / decidedFY : 0;
  const winValue = sum(wonFY) + sum(lostFY) > 0 ? sum(wonFY) / (sum(wonFY) + sum(lostFY)) : 0;
  // For the win chance of an open quote, every decided job on record is used: one FY is thin.
  const decidedAll = won.length + lost.length;
  const baseAll = decidedAll ? won.length / decidedAll : 0;
  const bandOf = v => SIZE_BANDS.findIndex(b => v >= b[0] && v < b[1]);
  const bands = SIZE_BANDS.map((b, i) => { const w = won.filter(j => bandOf(j.value) === i).length, l = lost.filter(j => bandOf(j.value) === i).length;
    // A band with few decided jobs leans on the overall rate (3 "borrowed" jobs), so 0 of 2 is not read as "never".
    return { label: b[2], won: w, lost: l, n: w + l, raw: w + l ? w / (w + l) : null, rate: (w + 3 * baseAll) / (w + l + 3) }; });
  // Age: how long won and lost jobs took from sending to the decision.
  const tWon = won.filter(j => j.sentAt && j.decidedAt).map(j => Math.max(0, (T(j.decidedAt) - T(j.sentAt)) / 864e5));
  const tLost = lost.filter(j => j.sentAt && j.decidedAt).map(j => Math.max(0, (T(j.decidedAt) - T(j.sentAt)) / 864e5));
  const after = (arr, a) => (arr.filter(t => t > a).length + 0.5) / (arr.length + 1);
  const bayes = (base, a) => { const w = base * after(tWon, a), l = (1 - base) * after(tLost, a); return w + l > 0 ? w / (w + l) : base; };
  // Never rises with age and never exceeds the size rate: past the oldest decision on record
  // there is no evidence a quote gets likelier by waiting.
  const chance = (base, age) => { if (age == null || !tWon.length || !tLost.length) return base;
    const pts = [...new Set([0, ...tWon, ...tLost].filter(t => t <= age).concat([age]))].sort((x, y) => x - y);
    return Math.min(base, ...pts.map(a => bayes(base, a))); };
  const ageOf = j => j.sentAt ? Math.max(0, (now - T(j.sentAt)) / 864e5) : null;
  open.forEach(j => { j.age = ageOf(j); j.band = bandOf(j.value); j.base = (bands[j.band] || { rate: baseAll }).rate; j.p = chance(j.base, j.age); j.expected = Math.round(j.value * j.p);
    j.ageBand = j.age == null ? 'unsent' : j.age > staleDays ? 'stale' : 'fresh'; });
  const fresh = open.filter(j => j.ageBand === 'fresh'), stale = open.filter(j => j.ageBand === 'stale'), unsent = open.filter(j => j.ageBand === 'unsent');
  const expected = open.reduce((a, j) => a + j.expected, 0), expectedJobs = open.reduce((a, j) => a + j.p, 0);
  const sentNote = j => j.age == null ? 'not sent yet' : `${j.byLink ? 'shared by link' : 'sent'} ${ymd(j.sentAt)} (${Math.round(j.age)} d)${j.lastOpened ? ' · last opened ' + ymd(j.lastOpened) : ' · never opened'}`;
  const order = l => [...l].sort((a, b) => b.expected - a.expected);
  const openRows = order(open).map(j => row(j, `${j.ageBand} · ${sentNote(j)}`));
  const expectedRows = order(open).map(j => row(j, `${$(j.value)} × ${pct(j.p)}% · ${SIZE_BANDS[j.band][2]} jobs win ${pct(j.base)}%${j.age != null && j.p < j.base - 0.005 ? `, waited ${Math.round(j.age)} d` : j.age == null ? ', not sent yet' : ''}`, j.expected));
  const staleRows = stale.sort((a, b) => b.age - a.age).map(j => row(j, `${sentNote(j)} · win chance now ${pct(j.p)}%`));

  // ---- decision window ----
  const median = l => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const windowRows = [...won.filter(j => j.sentAt && j.decidedAt).map(j => row(j, `won · ${Math.round((T(j.decidedAt) - T(j.sentAt)) / 864e5)} d after sending`)),
    ...lost.filter(j => j.sentAt && j.decidedAt).map(j => row(j, `lost · ${Math.round((T(j.decidedAt) - T(j.sentAt)) / 864e5)} d after sending${j.q.lost_reason ? ' · ' + j.q.lost_reason : ''}`))];

  // ---- run rate, target, pace ----
  const d90 = now - 90 * 864e5;
  const secured90 = won.filter(j => T(j.decidedAt) >= d90);
  const runRate = sum(secured90) / 3;
  const securedFY = sum(wonFY);
  const projected = Math.round(securedFY + runRate * monthsLeft);
  const elapsed = Math.min(1, Math.max(0, (now - fyT) / (fyEnd - fyT)));
  const pace = target > 0 ? { elapsedPct: pct(elapsed), shouldBe: Math.round(target * elapsed), gap: Math.round(securedFY - target * elapsed) } : null;
  const avgWon = wonFY.length ? sum(wonFY) / wonFY.length : (won.length ? sum(won) / won.length : 0);
  const quotedFY = [...wonFY, ...lostFY, ...open];
  const avgQuote = quotedFY.length ? sum(quotedFY) / quotedFY.length : 0;

  // ---- leads: only those old enough to judge ----
  const leads = db.prepare('SELECT * FROM leads').all();
  const jobOfLead = l => jobs.find(j => (l.quote_id && fam.get(j.parent).some(q => q.id === l.quote_id)) || fam.get(j.parent).some(q => q.lead_id === l.id)) || null;
  const quotedLead = l => !!jobOfLead(l);
  const wonLead = l => { const j = jobOfLead(l); return l.status === 'Won' || !!(j && j.state === 'won'); };
  const leadsFY = leads.filter(l => T(l.created_at) >= fyT);
  const mature = leadsFY.filter(l => T(l.created_at) <= now - MATURE_DAYS * 864e5);
  const pool = mature.length >= 10 ? mature : leadsFY;             // too few old leads yet: use them all, and say so
  const poolNote = mature.length >= 10 ? `leads ${MATURE_DAYS}+ days old` : 'all leads this FY (too few older ones yet)';
  const l2q = pool.length ? pool.filter(quotedLead).length / pool.length : 0;
  const l2w = pool.length ? pool.filter(wonLead).length / pool.length : 0;
  const leads30 = leads.filter(l => T(l.created_at) >= now - 30 * 864e5);
  const l2q30 = leads30.length ? leads30.filter(quotedLead).length / leads30.length : 0;
  const leadRate = leads.filter(l => T(l.created_at) >= now - 60 * 864e5).length / 2;      // a month
  const lagDays = median(leads.filter(wonLead).map(l => { const j = jobOfLead(l); return j && j.decidedAt ? (T(j.decidedAt) - T(l.created_at)) / 864e5 : null; }).filter(x => x != null && x >= 0)) || 30;
  const leadRow = (l, note) => { const j = jobOfLead(l); return { leadId: l.id, quoteId: j ? j.q.id : null, quoteNumber: j ? j.q.quote_number : '—', client: l.name, package: l.suburb || l.address || '', note, value: j ? j.value : null }; };
  // Enquiries in hand with no quote yet, still young enough to convert.
  const warmLeads = leads.filter(l => !['Won', 'Lost'].includes(l.status) && !l.parked && !quotedLead(l) && T(l.created_at) >= now - MATURE_DAYS * 864e5);

  // ---- FY outlook: secured + open quotes + enquiries in hand + enquiries still to come ----
  // 80% range on the two rates that drive it (Wilson interval), so thin history shows as a wide range.
  const wilson = (k, m) => { if (!m) return [0, 0]; const z = 1.2816, p = k / m, d = 1 + z * z / m, c = p + z * z / (2 * m), h = z * Math.sqrt(p * (1 - p) / m + z * z / (4 * m * m)); return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)]; };
  const [l2wLo, l2wHi] = wilson(pool.filter(wonLead).length, pool.length);
  const [wLo, wHi] = wilson(won.length, decidedAll);
  const qScale = baseAll > 0 ? [wLo / baseAll, wHi / baseAll] : [1, 1];
  const monthsEff = Math.max(0, monthsLeft - lagDays / 30.44);
  // Leads do not all convert alike (a referral is not a lead-site enquiry), and the mix
  // changes month to month. Each source gets its own lead-to-win rate, leaning on the overall
  // rate where it has few leads (5 "borrowed" leads), applied to the leads of that source.
  const srcOf = l => String(l.source || 'Unknown').trim() || 'Unknown';
  const srcRate = {}; [...new Set(leads.map(srcOf))].forEach(sr => { const p = pool.filter(l => srcOf(l) === sr); srcRate[sr] = (p.filter(wonLead).length + 5 * l2w) / (p.length + 5); });
  const recent = leads.filter(l => T(l.created_at) >= now - 60 * 864e5);
  const winsFrom = ls => ls.reduce((a, l) => a + (srcRate[srcOf(l)] != null ? srcRate[srcOf(l)] : l2w), 0);
  const winsInHand = winsFrom(warmLeads), winsPerMonth = winsFrom(recent) / 2;
  const blended = recent.length ? winsFrom(recent) / recent.length : l2w;       // lead-to-win for today's mix of sources
  const lScale = l2w > 0 ? [l2wLo / l2w, l2wHi / l2w] : [1, 1];
  const leadWins = winsInHand + winsPerMonth * monthsEff;
  const part = { secured: Math.round(securedFY), open: Math.round(expected),
    inHand: Math.round(winsInHand * avgWon), toCome: Math.round(winsPerMonth * monthsEff * avgWon) };
  const bySource = Object.entries(recent.reduce((a, l) => { a[srcOf(l)] = (a[srcOf(l)] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1])
    .map(([src, cnt]) => ({ source: src, perMonth: Math.round(cnt / 2 * 10) / 10, rate: pct(srcRate[src] != null ? srcRate[src] : l2w), seen: pool.filter(l => srcOf(l) === src).length }));
  const outlook = {
    likely: part.secured + part.open + part.inHand + part.toCome,
    low: Math.round(part.secured + part.open * qScale[0] + leadWins * lScale[0] * avgWon),
    high: Math.round(part.secured + Math.min(sum(open), part.open * qScale[1]) + leadWins * lScale[1] * avgWon),
    part, leadRate: Math.round(leadRate * 10) / 10, lagDays: Math.round(lagDays), warmLeads: warmLeads.length, l2w: pct(l2w), blended: Math.round(blended * 1000) / 10, poolNote, bySource,
  };

  // ---- needed from here: what the pipeline in hand will not cover ----
  const gap = target > 0 ? Math.max(0, target - securedFY - expected) : null;
  const needed = gap != null ? gap / monthsLeft : null;
  const needWins = needed != null && avgWon > 0 ? needed / avgWon : null;
  const needQuotes = needWins != null && winCount > 0 ? needWins / winCount : null;
  const needLeads = needQuotes != null && l2q > 0 ? needQuotes / l2q : null;

  // ---- why we lose ----
  const reasons = {}; lostFY.forEach(j => { const r = j.q.lost_reason || 'No reason recorded'; reasons[r] = (reasons[r] || 0) + 1; });
  const reasonList = Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

  // ---- margin and profit ----
  const mRow = j => withMargin(row(j, ''), j.q);
  const wonMall = wonFY.map(mRow), openM = open.map(mRow), built30 = quotedFY.filter(j => T(j.firstCreated) >= now - 30 * 864e5).map(mRow);
  // A won job at a margin outside 5–60% almost always has an unfinished or placeholder costing.
  const odd = r => r.priced && r.marginPct != null && (r.marginPct < MARGIN_OK[0] || r.marginPct > MARGIN_OK[1]);
  const wonM = wonMall.filter(r => !odd(r)), flagged = wonMall.filter(odd);
  const aWon = avgPct(wonM), aOpen = avgPct(openM), aBuilt = avgPct(built30);
  const wonMarginPct = aWon.pct != null ? aWon.pct / 100 : 0;
  // Overheads entered for this FY on Projects (office, insurance, vehicles, other).
  let overheads = 0; try { const lbl = 'FY' + String(fyEnd.getFullYear()).slice(2); const c = db.prepare('SELECT overheads FROM fy_close WHERE fy=?').get(lbl); if (c) overheads = Object.values(JSON.parse(c.overheads || '{}')).reduce((a, b) => a + (parseFloat(b) || 0), 0); } catch (e) {}
  const banked = Math.round(wonMall.filter(r => r.priced).reduce((a, r) => a + r.margin, 0));
  const net = g => g != null ? Math.round(g - overheads) : null;
  const profit = {
    banked, perJob: aWon.n ? Math.round(aWon.margin / aWon.n) : 0, overheads: Math.round(overheads),
    atTarget: target > 0 ? Math.round(target * wonMarginPct) : null, atRunRate: Math.round(projected * wonMarginPct), atOutlook: Math.round(outlook.likely * wonMarginPct),
    needed: needed != null ? Math.round(needed * wonMarginPct) : null,
    expected: Math.round(expected * (aOpen.pct != null ? aOpen.pct / 100 : wonMarginPct)),
    flagged: flagged.map(r => `${r.quoteNumber} (${r.marginPct}%)`),
  };
  profit.atTargetNet = net(profit.atTarget); profit.atRunRateNet = net(profit.atRunRate); profit.atOutlookNet = net(profit.atOutlook);
  const marginRows = [...wonMall.map(r => ({ ...r, note: 'won · accepted ' + ymd(wonFY.find(j => j.q.id === r.quoteId).decidedAt) + (odd(r) ? ' · costing looks unfinished — left out of the average' : '') })),
    ...openM.map(r => ({ ...r, note: 'open' + (r.priced ? '' : ' · no costing yet — not counted') })),
    ...built30.filter(r => !wonMall.some(w => w.quoteId === r.quoteId) && !openM.some(o => o.quoteId === r.quoteId)).map(r => ({ ...r, note: 'built last 30 d · lost' }))];

  // ---- on hold ----
  const holdRows = held.map(j => { const h = heldMap.get(j.parent); return { ...row(j, `on hold until ${h.until}${h.reason ? ' · ' + h.reason : ''}`), until: h.until }; }).sort((a, b) => String(a.until).localeCompare(String(b.until)));
  const holdMonths = {}; holdRows.forEach(r => { const k = String(r.until).slice(0, 7); holdMonths[k] = (holdMonths[k] || 0) + r.value; });

  return {
    fyStart: `${fy.getFullYear()}-07-01`, monthsLeft, staleDays, staleRate: pct(staleRate), target, pace,
    open: { count: open.length, value: sum(open), fresh: { count: fresh.length, value: sum(fresh) }, stale: { count: stale.length, value: sum(stale) }, unsent: { count: unsent.length, value: sum(unsent) } },
    expected: { value: Math.round(expected), jobs: Math.round(expectedJobs * 10) / 10 },
    window: { wonMedian: median(tWon) != null ? Math.round(median(tWon)) : null, wonMax: tWon.length ? Math.round(Math.max(...tWon)) : null, lostMedian: median(tLost) != null ? Math.round(median(tLost)) : null, wonN: tWon.length, lostN: tLost.length },
    stale: { count: stale.length, value: sum(stale), rows: staleRows },
    runRate: Math.round(runRate), secured90: sum(secured90), securedFY: Math.round(securedFY), projected, outlook,
    needed: needed != null ? Math.round(needed) : null, needGap: gap != null ? Math.round(gap) : null, needWins, needQuotes, needLeads,
    avgWon: Math.round(avgWon), avgQuote: Math.round(avgQuote), wonCount: wonFY.length, quotedCount: quotedFY.length, decidedCount: decidedFY, lostCount: lostFY.length,
    winValue: pct(winValue), winCount: pct(winCount), wonValue: sum(wonFY), decidedValue: sum(wonFY) + sum(lostFY), decidedAll, bands: bands.map(b => ({ label: b.label, won: b.won, lost: b.lost, n: b.n, raw: b.raw != null ? pct(b.raw) : null, rate: pct(b.rate) })),
    leadToQuote: { fy: pct(l2q), fyN: pool.length, fyQ: pool.filter(quotedLead).length, d30: pct(l2q30), d30N: leads30.length, d30Q: leads30.filter(quotedLead).length, basis: poolNote },
    leadToWin: { pct: pct(l2w), n: pool.length, won: pool.filter(wonLead).length, leadsPerWin: pool.filter(wonLead).length ? Math.round(pool.length / pool.filter(wonLead).length) : null },
    reasons: reasonList,
    hold: { count: held.length, value: sum(held), months: holdMonths, next: holdRows[0] ? holdRows[0].until : null },
    margin: { won: { pct: aWon.pct, n: aWon.n, perJob: profit.perJob, flagged: profit.flagged }, open: { pct: aOpen.pct, n: aOpen.n, excluded: aOpen.excluded }, built30: { pct: aBuilt.pct, n: aBuilt.n, excluded: aBuilt.excluded },
      target: parseFloat(settingGet('tier_' + String(settingGet('default_customer_tier') || 'Silver').toLowerCase()) || '25'), targetTier: settingGet('default_customer_tier') || 'Silver' },
    profit,
    lists: {
      fc_margin: { title: 'Average margin', rows: marginRows, note: `Gross margin = final price ex GST less the costed cost. Won ${aWon.pct != null ? aWon.pct + '%' : '—'} over ${aWon.n} jobs${flagged.length ? ` (${flagged.length} left out: costing looks unfinished)` : ''}; open ${aOpen.pct != null ? aOpen.pct + '%' : '—'} over ${aOpen.n} priced quotes; built last 30 d ${aBuilt.pct != null ? aBuilt.pct + '%' : '—'}.` },
      fc_profit: { title: 'Forecast profit, FY', rows: wonMall.map(r => ({ ...r, note: odd(r) ? 'won · costing looks unfinished' : 'won' })), note: `Gross margin banked on jobs won this FY: ${$(banked)}. Forecast gross = FY figure × average won margin ${aWon.pct != null ? aWon.pct + '%' : '—'}. Net = gross less this FY's overheads of ${$(overheads)}${overheads ? '' : ' (none entered yet — add them on Projects → Year-end)'}.` },
      fc_conv: { title: 'Lead conversion', rows: pool.map(l => leadRow(l, (wonLead(l) ? 'won' : quotedLead(l) ? 'quoted' : 'not quoted') + (l.status === 'Lost' ? ' · lost' : ''))), note: `Measured on ${poolNote}: ${pool.filter(quotedLead).length} of ${pool.length} quoted, ${pool.filter(wonLead).length} won. Newer leads are left out because they have not had time to convert. Last 30 days, for reference: ${leads30.filter(quotedLead).length} of ${leads30.length} quoted so far.` },
      fc_open: { title: 'Quotes out, awaiting decision', rows: openRows, note: `Every open job, one row each (latest revision). Fresh = with the client ${staleDays} days or less; stale = longer; not sent = never sent and never opened. Jobs on hold are not here.` },
      fc_expected: { title: 'Expected to land', rows: expectedRows, note: `Each open quote × its own win chance. The chance starts from how often jobs of that size were won (${decidedAll} decided jobs on record) and falls the longer the quote has waited, using how long past wins and losses took.` },
      fc_window: { title: 'Decision window', rows: windowRows, note: 'Days between the client getting the quote and the decision, every won or lost job on record.' },
      fc_stale: { title: 'Stale — chase or close', rows: staleRows, note: `With the client more than ${staleDays} days and no decision. Chase once, then mark lost or put on hold so the figures stay honest.` },
      fc_runrate: { title: 'Run rate — secured, last 90 days', rows: secured90.map(j => row(j, 'accepted ' + ymd(j.decidedAt))), note: `Secured in the last 90 days ÷ 3 = ${$(runRate)} a month. Projection = secured this FY + run rate × ${monthsLeft} months left. It assumes the last 90 days repeat; compare it with the FY outlook, which is built from the pipeline.` },
      fc_target: { title: 'FY target', rows: wonFY.map(j => row(j, 'accepted ' + ymd(j.decidedAt))), note: target > 0 ? `Secured this FY against the target of ${$(target)}. ${pace ? `${pace.elapsedPct}% of the year has gone, so on an even pace you would be at ${$(pace.shouldBe)}: ${pace.gap >= 0 ? $(pace.gap) + ' ahead' : $(-pace.gap) + ' behind'}.` : ''}` : 'No target set yet — type one on the tile (admin).' },
      fc_needed: { title: 'Needed from here', rows: needed == null ? [] : [
        { quoteNumber: '1', client: `Target ${$(target)} − secured ${$(securedFY)} − expected from open quotes ${$(expected)} = ${$(gap)} still to find`, value: null },
        { quoteNumber: '2', client: `÷ ${monthsLeft} months left`, value: Math.round(needed), note: 'a month' },
        { quoteNumber: '3', client: `÷ average won job ${$(avgWon)} = ${needWins != null ? needWins.toFixed(1) : '—'} wins a month`, value: null },
        { quoteNumber: '4', client: `÷ win rate ${pct(winCount)}% (won ÷ decided, by count) = ${needQuotes != null ? needQuotes.toFixed(1) : '—'} quotes a month`, value: null },
        { quoteNumber: '5', client: `÷ lead-to-quote ${pct(l2q)}% (${poolNote}) = ${needLeads != null ? needLeads.toFixed(1) : '—'} leads a month`, value: null }], note: 'The arithmetic, step by step. What the open quotes are expected to deliver is taken off first.' },
      fc_avgwon: { title: 'Average won job', rows: wonFY.map(j => row(j, 'won · accepted ' + ymd(j.decidedAt))), note: `${wonFY.length} won this FY, average ${$(avgWon)}; average across won, lost and open jobs ${$(avgQuote)}.` },
      fc_lost: { title: 'Why we lose', rows: lostFY.map(j => row(j, `${j.q.lost_reason || 'No reason recorded'} · ${ymd(j.q.lost_at)}`)), note: 'One row per job lost this FY, with the reason recorded when it was marked lost.' },
      fc_win: { title: 'Win rate — decided jobs, this FY', rows: [...wonFY.map(j => row(j, 'won · ' + ymd(j.decidedAt))), ...lostFY.map(j => row(j, 'lost · ' + ymd(j.decidedAt) + (j.q.lost_reason ? ' · ' + j.q.lost_reason : '')))], note: `${wonFY.length} won of ${decidedFY} decided = ${pct(winCount)}% by count; ${$(sum(wonFY))} of ${$(sum(wonFY) + sum(lostFY))} = ${pct(winValue)}% by value. Open quotes and jobs on hold are not counted either way. By size, all jobs on record: ${bands.map(b => `${b.label} ${b.won} of ${b.n}`).join(' · ')}.` },
      fc_outlook: { title: 'FY outlook — pipeline and leads', rows: [
        { quoteNumber: '1', client: 'Secured so far this FY', value: part.secured },
        { quoteNumber: '2', client: `Open quotes: ${open.length} worth ${$(sum(open))}, each × its win chance`, value: part.open },
        { quoteNumber: '3', client: `Enquiries in hand, not quoted yet: ${warmLeads.length} → ${winsInHand.toFixed(1)} expected wins × ${$(avgWon)} average job`, value: part.inHand },
        { quoteNumber: '4', client: `Enquiries still to come: ${outlook.leadRate} a month → ${winsPerMonth.toFixed(1)} wins a month (${outlook.blended}% for today's mix of sources) × ${monthsEff.toFixed(1)} months (${monthsLeft} left, less ${Math.round(lagDays)} days from enquiry to signing) × ${$(avgWon)}`, value: part.toCome },
        ...bySource.map(b => ({ quoteNumber: '·', client: `${b.source}: ${b.perMonth} leads a month, ${b.rate}% become a signed job${b.seen < 5 ? ' (few on record, leans on the overall rate)' : ''}`, value: null })),
        { quoteNumber: '=', client: `Likely FY total. Range ${$(outlook.low)} to ${$(outlook.high)}`, value: outlook.likely }],
        note: `Built from what is in the tool today, not from the last 90 days repeating. The range comes from how few decided jobs (${decidedAll}) and judged leads (${pool.length}) the rates rest on; it narrows as more are decided. Lead-to-win is measured on ${poolNote}.` },
      fc_hold: { title: 'On hold — future pipeline', rows: holdRows, note: 'Jobs put away until a date. Not counted in open quotes, expected to land, win rate or stale. Each comes back to its step on its date.' },
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
    const noTotal = ['fc_needed', 'fc_l2q', 'fc_l2w', 'fc_conv', 'fc_margin', 'fc_profit', 'fc_outlook'].includes(req.params.key);
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
