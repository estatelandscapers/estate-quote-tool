const TIERS = ['Basic','Standard','Premium'];

// Resolve one quote item at a tier → {code,name,spec,unit,rate,behaviour}
function resolveItem(item, pi, tier) {
  if (item.price_item_id && pi) {
    const p = tier.toLowerCase();
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

module.exports = { TIERS, resolveItem, lineTotal, surchargeAmount };
