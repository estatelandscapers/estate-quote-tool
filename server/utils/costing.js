// Costing engine v11 — three recipe variants per deliverable, materials from the shared library.
// Single source of truth used by quote costing, Selections, PO creation and the Projects register.
const { db, settingGet } = require('../db');
const { resolveItem } = require('./pricing');
const TIERS = ['Basic', 'Standard', 'Premium'];
const VARIANTS = ['in', 'sub', 'mixed'];

function crewHourRate() {
  const day = parseFloat(settingGet('crew_day_rate') || '1150');
  const people = Math.max(1, parseFloat(settingGet('crew_people') || '2'));
  const hpd = Math.max(1, parseFloat(settingGet('hours_per_day') || '8'));
  return day / people / hpd;
}

// Price of a library material from a specific vendor, else its default vendor, else any.
function materialPrice(materialId, vendorId) {
  if (!materialId) return null;
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
  if (!m) return null;
  let row = null;
  if (vendorId) row = db.prepare('SELECT * FROM material_vendors WHERE material_id=? AND vendor_id=?').get(materialId, vendorId);
  if (!row && m.default_vendor_id) row = db.prepare('SELECT * FROM material_vendors WHERE material_id=? AND vendor_id=?').get(materialId, m.default_vendor_id);
  if (!row) row = db.prepare('SELECT * FROM material_vendors WHERE material_id=? ORDER BY preferred DESC').get(materialId);
  const vname = row ? (db.prepare('SELECT name FROM vendors WHERE id=?').get(row.vendor_id) || {}).name : null;
  return { name: m.name, unit: m.unit, category: m.category, cost: row ? row.cost : 0,
    vendorId: row ? row.vendor_id : null, vendor: vname || 'Unassigned', deliveryRule: row ? row.delivery_rule : '' };
}

function recipesFor(priceItemId) {
  if (!priceItemId) return {};
  const rows = db.prepare('SELECT * FROM recipe_v2 WHERE price_item_id=?').all(priceItemId);
  const out = {};
  rows.forEach(r => {
    r.components = db.prepare('SELECT * FROM recipe_component WHERE recipe_id=? ORDER BY sort_order').all(r.id);
    out[r.variant] = r;
  });
  return out;
}
function defaultVariant(priceItemId) {
  const r = db.prepare('SELECT variant FROM recipe_v2 WHERE price_item_id=? AND is_default=1').get(priceItemId);
  return r ? r.variant : 'in';
}

// Cost one deliverable, at one tier, using one variant.
function costVariant({ qty, wastageOverride, subDaysOverride, vendorOverride }, recipe, tier) {
  const out = { cost: 0, hrs: 0, subDays: 0, matCost: 0, labCost: 0, subCost: 0, plantCost: 0, delivery: 0, lines: [] };
  if (!recipe) return out;
  const t = tier.toLowerCase();
  const rate = crewHourRate();
  (recipe.components || []).forEach(c => {
    if (c.kind === 'material' || c.kind === 'plant') {
      const mid = c.tiered ? (c[`mat_${t}`] || c.material_id) : c.material_id;
      const mp = materialPrice(mid, vendorOverride || c.vendor_id);
      if (!mp) return;
      const waste = (wastageOverride != null ? wastageOverride : c.wastage_pct) / 100;
      const orderQty = c.kind === 'plant' ? (c.ratio || 1) : qty * (c.ratio || 0) * (1 + waste);
      const lineCost = c.kind === 'plant' ? (c.amount || mp.cost) * (c.ratio || 1) : orderQty * mp.cost;
      if (c.kind === 'plant') out.plantCost += lineCost; else out.matCost += lineCost;
      out.lines.push({ kind: c.kind, vendor: mp.vendor, vendorId: mp.vendorId, name: mp.name,
        unit: mp.unit, qty: Math.round(orderQty * 100) / 100, unitCost: c.kind === 'plant' ? (c.amount || mp.cost) : mp.cost });
    } else if (c.kind === 'labour') {
      const hrs = qty * (c[`hrs_${t}`] || 0);
      out.hrs += hrs; out.labCost += hrs * rate;
    } else if (c.kind === 'sub') {
      const amt = c.sub_basis === 'lump' ? (c[`sub_${t}`] || 0) : qty * (c[`sub_${t}`] || 0);
      out.subCost += amt;
      out.subDays += (subDaysOverride != null ? subDaysOverride : (c.sub_days || 0));
      const sv = c.vendor_id ? db.prepare('SELECT name FROM vendors WHERE id=?').get(c.vendor_id) : null;
      out.lines.push({ kind: 'sub', vendor: (sv && sv.name) || c.label || 'Subcontractor', vendorId: c.vendor_id || null,
        name: c.label || 'Subcontract', unit: c.sub_basis === 'lump' ? 'job' : 'unit',
        qty: c.sub_basis === 'lump' ? 1 : qty, unitCost: c.sub_basis === 'lump' ? amt : (c[`sub_${t}`] || 0) });
    }
  });
  out.delivery = recipe.delivery_cost || 0;
  if (out.delivery > 0) {
    const first = out.lines.find(l => l.kind === 'material');
    out.lines.push({ kind: 'delivery', vendor: first ? first.vendor : 'Supplier', name: 'Delivery', unit: 'job', qty: 1, unitCost: out.delivery });
  }
  out.cost = out.matCost + out.plantCost + out.labCost + out.subCost + out.delivery;
  return out;
}

function costQuote(q, opts = {}) {
  const useSelections = !!opts.useSelections;
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? AND scope=1 ORDER BY sort_order').all(q.id);
  const crew = Math.max(1, q.crew_size || 2);
  const hpd = Math.max(1, parseFloat(settingGet('hours_per_day') || '8'));
  const base = q.default_package || 'Standard';
  const perLine = []; const changes = []; const takeoff = [];
  const tierTot = {}; TIERS.forEach(t => tierTot[t] = { cost: 0, sell: 0, hrs: 0 });
  const selTot = { cost: 0, sell: 0, hrs: 0, matCost: 0, plantCost: 0, labCost: 0, subCost: 0, delivery: 0 };
  let subDays = 0;

  items.forEach(it => {
    const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
    const recs = recipesFor(it.price_item_id);
    const def = defaultVariant(it.price_item_id);
    const quotedMethod = it.method || def;
    const method = useSelections ? (it.sel_method || quotedMethod) : quotedMethod;
    const vendorOverride = useSelections ? (it.sel_vendor_id || null) : null;
    const subDaysOv = useSelections
      ? (it.sel_sub_days != null ? it.sel_sub_days : it.sub_days)
      : it.sub_days;
    const selTier = it.tier_override || base;
    const line = { id: it.id, code: null, name: null, unit: null, qty: it.qty, selected: selTier,
      method, quotedMethod, defaultMethod: def, availableVariants: Object.keys(recs),
      wastageOverride: it.wastage_override, subDays: subDaysOv, selVendorId: it.sel_vendor_id || null,
      hasRecipe: Object.keys(recs).length > 0, tiers: {}, variantCost: {} };

    TIERS.forEach(t => {
      const r = resolveItem(it, pi, t);
      line.code = r.code; line.name = r.name; line.unit = r.unit;
      const sell = it.qty * r.rate;
      const c = costVariant({ qty: it.qty, wastageOverride: it.wastage_override, subDaysOverride: subDaysOv, vendorOverride }, recs[method], t);
      line.tiers[t] = { spec: r.spec, rate: r.rate, sell, cost: c.cost, hrs: c.hrs, subDays: c.subDays };
      tierTot[t].cost += c.cost; tierTot[t].sell += sell; tierTot[t].hrs += c.hrs;
      if (t === selTier) {
        selTot.cost += c.cost; selTot.sell += sell; selTot.hrs += c.hrs;
        selTot.matCost += c.matCost; selTot.plantCost += c.plantCost; selTot.labCost += c.labCost;
        selTot.subCost += c.subCost; selTot.delivery += c.delivery;
        subDays += c.subDays;
        c.lines.forEach(L => takeoff.push({ ...L, itemCode: r.code }));
      }
    });
    // what each variant would cost at the selected tier — powers Selections
    VARIANTS.forEach(v => {
      if (!recs[v]) return;
      const c = costVariant({ qty: it.qty, wastageOverride: it.wastage_override, subDaysOverride: subDaysOv }, recs[v], selTier);
      line.variantCost[v] = { cost: Math.round(c.cost), hrs: Math.round(c.hrs * 10) / 10, subDays: c.subDays };
    });
    line.tiered = line.tiers.Basic.sell !== line.tiers.Premium.sell || line.tiers.Basic.spec !== line.tiers.Premium.spec;
    if (selTier !== base) changes.push({ code: line.code, name: line.name, from: line.tiers[base].spec,
      to: line.tiers[selTier].spec, delta: line.tiers[selTier].sell - line.tiers[base].sell,
      up: TIERS.indexOf(selTier) > TIERS.indexOf(base) });
    perLine.push(line);
  });

  const crewDays = selTot.hrs / crew / hpd;
  const days = crewDays + subDays;
  const target = parseFloat(settingGet('tier_' + (q.customer_tier || 'Silver').toLowerCase()) || '25');
  const margin = selTot.sell - selTot.cost;
  const pct = selTot.sell > 0 ? margin / selTot.sell * 100 : 0;
  return { base, crew, perLine, tierTotals: tierTot, selected: selTot,
    crewDays: Math.round(crewDays * 10) / 10, subDays: Math.round(subDays * 10) / 10,
    days: Math.round(days * 10) / 10, hours: Math.round(selTot.hrs * 10) / 10,
    grossMargin: margin, grossMarginPct: Math.round(pct * 10) / 10,
    target, belowTarget: pct < target, guidePrice: selTot.cost * (1 + target / 100),
    changes, mixed: changes.length > 0, takeoff, selectionsLocked: !!q.selections_locked };
}
module.exports = { costQuote, costVariant, recipesFor, defaultVariant, materialPrice, crewHourRate, TIERS, VARIANTS };
