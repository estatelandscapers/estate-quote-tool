// ONE place that adds up a quote.
//
// Before this file, three code paths each summed the quote their own way — the admin
// contract preview, the client's quote page, and the signed contract on acceptance. Two
// of them ignored per-line package upgrades (tier_override) while still PRINTING the
// upgraded line prices, so a PDF could list lines that did not add up to its own subtotal
// and disagree with the client link by the value of the upgrades. Quote 1425.2 was out
// by $2,300 ex GST for exactly that reason.
//
// Every total — on screen, in the PDF, in the signed contract, in the jobs register —
// must come from quoteTotals(). Nothing else is allowed to add lines together.
const { db } = require('../db');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('./pricing');

const getPI = id => id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(id) : null;

// The package a line is actually priced at: its own override if the owner set one,
// otherwise the package the client is looking at.
const effectiveTier = (item, tier) => item.tier_override || tier;

// Totals for one package choice. `tier` is what the client selected (or the default).
function quoteTotals(q, tier) {
  tier = TIERS.includes(tier) ? tier : (q.default_package || 'Standard');
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY scope, sort_order').all(q.id);

  let s1 = 0, s2 = 0;
  const lineBases = {};   // per-line value at the line's EFFECTIVE tier — what surcharges apply to
  let labourShare = {};
  try {
    const { costQuote } = require('./costing');
    const cq = costQuote(q);
    (cq.perLine || []).forEach(l => { labourShare[l.id] = l.tiers; });
  } catch (e) { /* costing unavailable (no recipes yet) — surcharges fall back to full value */ }

  items.forEach(it => {
    const pi = getPI(it.price_item_id);
    const t = it.scope === 2 ? 'Standard' : effectiveTier(it, tier);
    const r = resolveItem(it, pi, t);
    const v = lineTotal(it, r, t);
    if (it.scope === 2) { s2 += v; return; }
    s1 += v;
    const ls = labourShare[it.id] && labourShare[it.id][t];
    lineBases[it.id] = { full: v, labour: ls ? (ls.labourValue || 0) : v };
  });

  const sur = surchargeAmount(applied, s1 + s2, lineBases);
  const grandExGst = s1 + s2 + sur;
  return {
    tier, scope1: s1, scope2: s2, surcharges: sur,
    grandExGst, gst: grandExGst * 0.1, grandIncGst: grandExGst * 1.1,
    // Rounded to the dollar — the figures that appear on paper. Rounding happens here,
    // once, so every document shows the same cents-free numbers.
    rounded: { grandExGst: Math.round(grandExGst), gst: Math.round(grandExGst * 1.1) - Math.round(grandExGst), grandIncGst: Math.round(grandExGst * 1.1) },
  };
}

// All three packages at once — the client page shows a price per package.
function totalsPerTier(q) {
  const o = {}; TIERS.forEach(t => o[t] = quoteTotals(q, t)); return o;
}

module.exports = { quoteTotals, totalsPerTier, effectiveTier };
