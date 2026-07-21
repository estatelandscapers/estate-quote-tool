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
      code: item.custom_code || (pi ? pi.code : 'XX'),
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
    code: item.custom_code || 'XX', name: item.custom_name || 'Custom item', unit: item.custom_unit || 'ea',
    spec: item.custom_name || '', rate: item.custom_rate || 0,
    behaviour: item.behaviour_override || 'none',
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

function lineTotal(item, resolved) {
  let t = item.qty * resolved.rate;
  if (resolved.behaviour === 'rate_only' || resolved.behaviour === 'optional') t = 0;
  if (item.shared_enabled) t = t * ((item.shared_pct || 50) / 100);
  return t;
}

function surchargeAmount(applied, scope1Total) {
  let total = 0;
  (applied || []).forEach(s => { total += s.kind === 'percent' ? scope1Total * (s.rate / 100) : Number(s.rate) || 0; });
  return total;
}

module.exports = { TIERS, resolveItem, snapshotFromPriceItem, lineTotal, surchargeAmount };
