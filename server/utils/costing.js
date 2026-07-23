// Costing engine: recipes -> per-tier cost, hours, take-off. Single source of truth
// used by the quote costing endpoint, PO creation, and the jobs register.
const { db, settingGet } = require('../db');
const { resolveItem } = require('./pricing');
const TIERS = ['Basic', 'Standard', 'Premium'];

function crewHourRate() {
  const day = parseFloat(settingGet('crew_day_rate') || '1150');
  const people = Math.max(1, parseFloat(settingGet('crew_people') || '2'));
  const hpd = Math.max(1, parseFloat(settingGet('hours_per_day') || '8'));
  return day / people / hpd; // cost per person-hour
}

function recipeFor(priceItemId) {
  if (!priceItemId) return null;
  const r = db.prepare('SELECT * FROM recipes WHERE price_item_id=?').get(priceItemId);
  if (!r) return null;
  r.materials = db.prepare('SELECT * FROM recipe_materials WHERE recipe_id=? ORDER BY sort_order').all(r.id);
  return r;
}

// Cost one quote item at one tier. Returns {cost, hrs, matCost, labCost, subCost, lines:[takeoff]}
function costItemAtTier(item, pi, recipe, tier) {
  const q = item.qty || 0;
  const t = tier.toLowerCase();
  const method = item.method || (recipe ? recipe.method_default : 'in');
  const out = { cost: 0, hrs: 0, matCost: 0, labCost: 0, subCost: 0, delivery: 0, plant: 0, lines: [], method };
  if (!recipe) return out; // no recipe -> no cost data (sell-only item)
  if (method === 'sub') {
    out.subCost = q * (recipe[`sub_${t}`] || 0);
    out.cost = out.subCost;
    if (out.subCost > 0) out.lines.push({ vendor: recipe.sub_vendor || 'Subcontractor', kind: 'sub',
      name: `${pi ? pi.name : 'Item'} — subcontract (${tier})`, unit: pi ? pi.unit : 'ea', qty: q, unitCost: recipe[`sub_${t}`] || 0 });
    return out;
  }
  const rate = crewHourRate();
  recipe.materials.forEach(m => {
    const waste = (item.wastage_override != null ? item.wastage_override : m.wastage_pct) / 100;
    const orderQty = q * (m.ratio || 0) * (1 + waste);
    const unitCost = m.kind === 'tiered' ? (m[`cost_${t}`] || 0) : (m.cost_standard || 0);
    const spec = m.kind === 'tiered' ? (m[`spec_${t}`] || m.name) : m.name;
    out.matCost += orderQty * unitCost;
    out.lines.push({ vendor: m.vendor_name || 'Supplier', kind: 'material', name: spec, unit: m.unit, qty: orderQty, unitCost });
  });
  out.delivery = recipe.delivery_cost || 0;
  out.plant = recipe.plant_cost || 0;
  if (out.delivery) out.lines.push({ vendor: recipe.materials[0]?.vendor_name || 'Supplier', kind: 'delivery', name: 'Delivery', unit: 'job', qty: 1, unitCost: out.delivery });
  if (out.plant) out.lines.push({ vendor: 'Plant hire', kind: 'plant', name: recipe.plant_note || 'Plant hire', unit: 'job', qty: 1, unitCost: out.plant });
  out.hrs = q * (recipe[`hrs_${t}`] || 0);
  out.labCost = out.hrs * rate;
  out.cost = out.matCost + out.delivery + out.plant + out.labCost;
  return out;
}

// Full quote costing: every line at every tier + selected (mixed) totals.
function costQuote(q) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? AND scope=1 ORDER BY sort_order').all(q.id);
  let subDays = 0;
  const crew = Math.max(1, q.crew_size || 2);
  const hpd = Math.max(1, parseFloat(settingGet('hours_per_day') || '8'));
  const base = q.default_package || 'Standard';
  const perLine = [];
  const tierTot = {}; TIERS.forEach(t => tierTot[t] = { cost: 0, sell: 0, hrs: 0 });
  const selTot = { cost: 0, sell: 0, hrs: 0, matCost: 0, labCost: 0, subCost: 0, delivery: 0, plant: 0 };
  const takeoff = []; const changes = [];
  items.forEach(it => {
    const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
    const recipe = recipeFor(it.price_item_id);
    const selTier = it.tier_override || base;
    const line = { id: it.id, code: null, name: null, unit: null, qty: it.qty, selected: selTier,
      method: it.method || (recipe ? recipe.method_default : 'in'), hasRecipe: !!recipe,
      wastageOverride: it.wastage_override, tiers: {} , tiered: false };
    TIERS.forEach(t => {
      const r = resolveItem(it, pi, t);
      const c = costItemAtTier(it, pi, recipe, t);
      line.code = r.code; line.name = r.name; line.unit = r.unit;
      const sell = it.qty * r.rate;
      line.tiers[t] = { spec: r.spec, rate: r.rate, sell, cost: c.cost, hrs: c.hrs };
      tierTot[t].cost += c.cost; tierTot[t].sell += sell; tierTot[t].hrs += c.hrs;
      if (t === selTier) {
        selTot.cost += c.cost; selTot.sell += sell; selTot.hrs += c.hrs;
        selTot.matCost += c.matCost; selTot.labCost += c.labCost; selTot.subCost += c.subCost;
        selTot.delivery += c.delivery; selTot.plant += c.plant;
        c.lines.forEach(L => takeoff.push({ ...L, itemCode: r.code }));
      }
    });
    if ((it.method === 'sub' || it.method === 'mixed') && it.sub_days) subDays += it.sub_days;
    line.subDays = it.sub_days || null;
    line.tiered = line.tiers.Basic.sell !== line.tiers.Premium.sell || line.tiers.Basic.spec !== line.tiers.Premium.spec;
    if (selTier !== base) changes.push({ code: line.code, name: line.name,
      from: line.tiers[base].spec, to: line.tiers[selTier].spec,
      delta: line.tiers[selTier].sell - line.tiers[base].sell,
      up: TIERS.indexOf(selTier) > TIERS.indexOf(base) });
    perLine.push(line);
  });
  const crewDays = selTot.hrs / crew / hpd;
  const days = crewDays + subDays;
  const target = parseFloat(settingGet('tier_' + (q.customer_tier || 'Silver').toLowerCase()) || '25');
  const margin = selTot.sell - selTot.cost;
  const pct = selTot.sell > 0 ? margin / selTot.sell * 100 : 0;
  return { base, crew, perLine, tierTotals: tierTot, selected: selTot,
    days: Math.round(days * 10) / 10, crewDays: Math.round(crewDays * 10) / 10,
    subDays: Math.round(subDays * 10) / 10, hours: Math.round(selTot.hrs * 10) / 10,
    grossMargin: margin, grossMarginPct: Math.round(pct * 10) / 10,
    target, belowTarget: pct < target,
    guidePrice: selTot.cost * (1 + target / 100),
    changes, mixed: changes.length > 0, takeoff };
}

module.exports = { costQuote, costItemAtTier, recipeFor, crewHourRate, TIERS };
