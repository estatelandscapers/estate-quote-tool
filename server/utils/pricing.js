const TIERS = ['Basic','Standard','Premium'];

// Resolve a quote item at a tier. Prefers the item's LOCKED snapshot (captured when
// it was added to the quote) so later pricing-sheet edits never move an existing quote.
// Falls back to the live price item (for legacy items with no snapshot), then custom.
function resolveItem(item, pi, tier) {
  const p = tier.toLowerCase();
  const lockedSpec = item[`locked_${p}_spec`];
  const lockedSell = item[`locked_${p}_sell`];
  if (lockedSell !== null && lockedSell !== undefined) {
    return {
      code: item.custom_code || (pi ? pi.code : 'C?'),
      name: item.custom_name || (pi ? pi.name : 'Item'),
      unit: item.custom_unit || (pi ? pi.unit : 'ea'),
      spec: lockedSpec || (pi ? pi[`${p}_spec`] : ''), rate: lockedSell,
      behaviour: item.behaviour_override || item.locked_behaviour || (pi ? pi.behaviour : 'none') || 'none',
    };
  }
  if (item.price_item_id && pi) {
    return {
      code: pi.code, name: pi.name, unit: pi.unit,
      spec: pi[`${p}_spec`] || pi.name, rate: pi[`${p}_sell`] || 0,
      behaviour: item.behaviour_override || pi.behaviour || 'none',
    };
  }
  return {
    code: item.custom_code || 'C?', name: item.custom_name || 'Custom item', unit: item.custom_unit || 'ea',
    spec: item.custom_name || '', rate: item.custom_rate || 0,
    // A custom line has no price-list entry, so its behaviour lives on the line itself.
    // This was falling through to 'none', which is why "Optional" did nothing.
    behaviour: item.behaviour_override || item.custom_behaviour || 'none',
  };
}

// Snapshot a price item's current tiers into lock fields (called at add-time).
function snapshotFromPriceItem(pi) {
  if (!pi) return {};
  return {
    locked_basic_spec: pi.basic_spec, locked_basic_sell: pi.basic_sell,
    locked_standard_spec: pi.standard_spec, locked_standard_sell: pi.standard_sell,
    locked_premium_spec: pi.premium_spec, locked_premium_sell: pi.premium_sell,
    locked_behaviour: pi.behaviour,
  };
}

function lineTotal(item, resolved, tier) {
  const T = String(tier || 'Standard').toLowerCase();
  // A site-specific value. Two modes:
  //   value_lump = 1  -> the figure IS the line total, whatever the quantity (a lump sum,
  //                      a plant schedule priced as one number)
  //   otherwise       -> the figure is a UNIT rate, so qty x rate applies and setting the
  //                      quantity to zero correctly gives zero. This was the bug: the
  //                      stored total was returned regardless of quantity.
  if (item.value_override) {
    const v = item['val_' + T];
    if (v != null) {
      let t0 = item.value_lump ? v : (item.qty || 0) * v;
      if (resolved.behaviour === 'rate_only' || resolved.behaviour === 'optional') t0 = 0;
      if (item.shared_enabled) t0 = t0 * ((item.shared_pct || 50) / 100);
      if (t0 > 0) t0 += (item['waste_uplift_' + T] || 0);
      return t0;
    }
  }
  let t = item.qty * resolved.rate;
  if (resolved.behaviour === 'rate_only' || resolved.behaviour === 'optional') t = 0;
  if (item.shared_enabled) t = t * ((item.shared_pct || 50) / 100);
  // Site-specific wastage above the recipe standard costs us more, so the price carries
  // it at the target margin — otherwise a difficult block quietly eats the margin.
  // Absorbed into this line's price; the client sees one figure.
  if (t > 0) t += (item['waste_uplift_' + String(tier || 'Standard').toLowerCase()] || 0);
  return t;
}

// Total = (Scope 1 + Scope 2) x (1 + sum of % surcharges) + fixed surcharges, then GST.
//
// A percentage surcharge charges on the whole works subtotal by default (mode 'whole').
// Set mode 'targeted' and it charges only on the deliverables you pick, and only on the
// portion of each that is actually affected:
//
//   base = SUM over chosen lines of  (line value or its labour portion) x portion%
//
//   s.mode   'whole' | 'targeted'
//   s.basis  'full'  | 'labour'          (labour includes subcontract labour)
//   s.lines  { <quoteItemId>: portionPercent }
//
// Fixed-dollar surcharges are unaffected — $750 is $750 wherever it lands.
function surchargeBase(s, worksSubtotal, lineBases) {
  if (s.mode !== 'targeted' || !lineBases) return worksSubtotal;
  let base = 0;
  Object.entries(s.lines || {}).forEach(([itemId, pct]) => {
    const lb = lineBases[itemId];
    if (!lb) return;
    const value = s.basis === 'labour' ? (lb.labour || 0) : (lb.full || 0);
    base += value * ((Number(pct) || 0) / 100);
  });
  return base;
}
function surchargeAmount(applied, worksSubtotal, lineBases) {
  let total = 0;
  (applied || []).forEach(s => {
    if (s.kind !== 'percent') { total += Number(s.rate) || 0; return; }
    total += surchargeBase(s, worksSubtotal, lineBases) * (s.rate / 100);
  });
  return total;
}
// A targeted surcharge must say what it does about every Scope 1 deliverable — including
// ones added after it was set up. Anything unanswered makes the quote incomplete.
function surchargeGaps(applied, scope1Items) {
  const gaps = [];
  (applied || []).forEach((s, i) => {
    if (s.kind !== 'percent' || s.mode !== 'targeted') return;
    const missing = scope1Items.filter(it => !(s.lines || {}).hasOwnProperty(it.id));
    if (missing.length) gaps.push({ code: 'SS' + (i + 1), name: s.name, missing: missing.map(m => ({ id: m.id, code: m.code, name: m.name })) });
  });
  return gaps;
}
// Site-specific surcharge codes: SS1, SS2... in applied order.
// Optional and rate-only lines are shown to the client with their price but sit OUTSIDE
// the total. This tells the view layer how to present each line.
function lineDisplay(item, resolved, tier) {
  const b = resolved.behaviour;
  const T = String(tier || 'Standard').toLowerCase();
  const raw = item.value_override && item['val_' + T] != null
    ? (item.value_lump ? item['val_' + T] : (item.qty || 0) * item['val_' + T])
    : (item.qty || 0) * resolved.rate;
  return {
    behaviour: b,
    inTotal: !(b === 'optional' || b === 'rate_only'),
    shownPrice: raw,
    label: b === 'optional' ? 'Optional — not included in the total'
      : b === 'rate_only' ? 'Rate only — charged if used'
      : b === 'allowance' ? 'Allowance — provisional sum'
      : b === 'remeasurable' ? 'Remeasurable — measured on completion' : null,
  };
}

function surchargeList(applied) {
  return (applied || []).map((s, i) => ({ code: 'SS' + (i + 1), name: s.name, kind: s.kind, rate: s.rate,
    mode: s.mode || 'whole', basis: s.basis || 'full', lines: s.lines || {} }));
}

module.exports = { TIERS, resolveItem, snapshotFromPriceItem, lineTotal, lineDisplay, surchargeAmount, surchargeBase, surchargeGaps, surchargeList };
