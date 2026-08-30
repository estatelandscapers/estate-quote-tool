// Costing engine v11 — three recipe variants per deliverable, materials from the shared library.
// Single source of truth used by quote costing, Selections, PO creation and the Projects register.
const { db, settingGet } = require('../db');
const { resolveItem, lineTotal } = require('./pricing');
const TIERS = ['Basic', 'Standard', 'Premium'];
const VARIANTS = ['in', 'sub', 'mixed'];

// Total monthly overheads / working days = allocated cost per crew-day.
// Single source of truth: used by recipe overhead components AND job-level allocation.
function overheadDailyRate() {
  const wd = Math.max(1, parseFloat(settingGet('work_days_per_month') || '21'));
  const pool = db.prepare("SELECT COALESCE(SUM(monthly_cost),0) s FROM materials WHERE category='overhead'").get().s;
  return pool / wd;
}
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

// Delivery rules understood, in order of specificity:
//   "$180 / load · 80 per load"  -> per-load charge, loads derived from quantity
//   "$140 / load"                -> one load unless a per-load size is given
//   "$120 flat" / "$120"         -> once per job
//   "free" / "pickup" / ""       -> nothing
function deliveryFor(rule, qty) {
  if (!rule) return 0;
  const s = String(rule).toLowerCase();
  // A stated dollar amount always wins — "$60 delivery + pickup" is a $60 charge,
  // not a free collection. Only treat as free when there is no amount at all.
  const amt = parseFloat((s.match(/\$\s*([\d.,]+)/) || [])[1]?.replace(/,/g, '') || '0');
  if (!amt) return 0;
  if (/free|pick ?up|picked up|incl|no charge/.test(s) && !/\+|plus|and/.test(s)) return 0;
  if (/load/.test(s)) {
    const per = parseFloat((s.match(/([\d.,]+)\s*(?:per load|\/\s*load|per\b)/) || [])[1]?.replace(/,/g, '') || '0');
    const sizeMatch = s.match(/·\s*([\d.,]+)/);
    const loadSize = sizeMatch ? parseFloat(sizeMatch[1].replace(/,/g, '')) : per;
    if (loadSize > 0) return amt * Math.max(1, Math.ceil(qty / loadSize));
    return amt;
  }
  return amt;
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
  const out = { cost: 0, hrs: 0, subDays: 0, matCost: 0, labCost: 0, subCost: 0, plantCost: 0, ohCost: 0, ohDays: 0, delivery: 0, wastageSurcharge: 0, lines: [] };
  if (!recipe) return out;
  const t = tier.toLowerCase();
  const rate = crewHourRate();
  (recipe.components || []).forEach(c => {
    if (c.kind === 'overhead') {
      // An overhead component means "this deliverable occupies the crew for N days".
      // It charges the FULL pooled rate from every overhead in Costs — it deliberately
      // does NOT reference an individual O-item, which previously allowed the same
      // overhead to be charged twice if two recipes both linked it.
      const daily = overheadDailyRate();
      const days = c.ratio || 1;
      out.ohCost += daily * days;
      out.ohDays += days;
      out.lines.push({ kind: 'overhead', vendor: 'Overhead', name: 'Site supervision & business overhead',
        unit: 'crew-day', qty: days, unitCost: Math.round(daily * 100) / 100 });
    } else if (c.kind === 'material' || c.kind === 'plant') {
      const mid = c.tiered ? (c[`mat_${t}`] || c.material_id) : c.material_id;
      const mp = materialPrice(mid, vendorOverride || c.vendor_id);
      if (!mp) return;
      const stdWaste = (c.wastage_pct || 0) / 100;
      const effWaste = (wastageOverride != null ? wastageOverride : c.wastage_pct || 0) / 100;
      const orderQty = c.kind === 'plant' ? (c.ratio || 1) : qty * (c.ratio || 0) * (1 + effWaste);
      const lineCost = c.kind === 'plant' ? (c.amount || mp.cost) * (c.ratio || 1) : orderQty * mp.cost;
      // wastage above the recipe standard is tracked as an internal surcharge on the item
      if (c.kind === 'material' && effWaste > stdWaste)
        out.wastageSurcharge += qty * (c.ratio || 0) * (effWaste - stdWaste) * mp.cost;
      if (c.kind === 'plant') out.plantCost += lineCost; else out.matCost += lineCost;
      out.lines.push({ kind: c.kind, vendor: mp.vendor, vendorId: mp.vendorId, name: mp.name,
        unit: mp.unit, qty: Math.round(orderQty * 100) / 100, unitCost: c.kind === 'plant' ? (c.amount || mp.cost) : mp.cost });
      // Delivery belongs to the material/vendor pair, so a deliverable drawing on three
      // suppliers carries three real cartage charges instead of one averaged guess.
      const del = deliveryFor(mp.deliveryRule, orderQty);
      if (del > 0) {
        out.delivery += del;
        out.lines.push({ kind: 'delivery', vendor: mp.vendor, vendorId: mp.vendorId,
          name: `Delivery — ${mp.name}`, unit: 'job', qty: 1, unitCost: del });
      }
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
  // Legacy: a flat per-recipe delivery amount still works until it's moved onto the
  // materials — but only if no material carried its own delivery rule, otherwise the
  // same cartage is charged twice.
  const hasMaterialDelivery = out.lines.some(l => l.kind === 'delivery');
  if (recipe.delivery_cost > 0 && !hasMaterialDelivery) {
    out.delivery += recipe.delivery_cost;
    const first = out.lines.find(l => l.kind === 'material');
    out.lines.push({ kind: 'delivery', vendor: first ? first.vendor : 'Supplier',
      name: 'Delivery (recipe-level — move to materials)', unit: 'job', qty: 1, unitCost: recipe.delivery_cost, legacy: true });
  }
  out.cost = out.matCost + out.plantCost + out.labCost + out.subCost + (out.ohCost || 0) + out.delivery;
  return out;
}


// Recalculate the price uplift needed to cover extra wastage at the target margin.
// Called whenever wastage, qty, method or tier changes — the result is stored on the
// line so the quote, client link and contract all read the same number.
function recalcWasteUplift(itemId) {
  const it = db.prepare('SELECT * FROM quote_items WHERE id=?').get(itemId);
  if (!it) return;
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(it.quote_id);
  if (!q) return;
  const target = parseFloat(settingGet('tier_' + (q.customer_tier || 'Silver').toLowerCase()) || '25') / 100;
  const recs = recipesFor(it.price_item_id);
  const method = it.method || defaultVariant(it.price_item_id);
  const rec = recs[method];
  const out = {};
  const pi = it.price_item_id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(it.price_item_id) : null;
  TIERS.forEach(t => {
    let uplift = 0;
    if (rec && it.wastage_override != null) {
      // Measure the REAL extra cost: recipe-standard wastage vs site wastage. Using the
      // material surcharge alone missed knock-on costs — extra wastage can tip the order
      // into another delivery load, which the price then failed to cover.
      const withWaste = costVariant({ qty: it.qty, wastageOverride: it.wastage_override, subDaysOverride: it.sub_days }, rec, t);
      const atStandard = costVariant({ qty: it.qty, subDaysOverride: it.sub_days }, rec, t);
      const extra = Math.max(0, withWaste.cost - atStandard.cost);
      if (extra > 0) {
        // Recover at THIS LINE's own margin, not the tier target — otherwise a line
        // running above target gets diluted every time wastage is raised, and the
        // overall margin still drifts down. Fall back to the target when the line's
        // own margin isn't meaningful (zero/negative).
        let m = target;
        try {
          const r = resolveItem({ ...it, waste_uplift_basic: 0, waste_uplift_standard: 0, waste_uplift_premium: 0 }, pi, t);
          const baseSell = it.qty * r.rate;
          const baseCost = atStandard.cost;
          if (baseSell > 0 && baseCost >= 0 && baseSell > baseCost) m = (baseSell - baseCost) / baseSell;
        } catch (e) {}
        uplift = m < 1 ? extra / (1 - m) : extra;
      }
    }
    out[t] = Math.round(uplift * 100) / 100;
  });
  db.prepare('UPDATE quote_items SET waste_uplift_basic=?, waste_uplift_standard=?, waste_uplift_premium=? WHERE id=?')
    .run(out.Basic, out.Standard, out.Premium, itemId);
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
      // Honour a site-specific value here too, or custom lines and plant schedules
      // report a sell of zero and wreck the margin.
      const sell = lineTotal(it, r, t);
      let c = costVariant({ qty: it.qty, wastageOverride: it.wastage_override, subDaysOverride: subDaysOv, vendorOverride }, recs[method], t);
      // A hand-entered cost wins over the recipe: used for site-priced lines (plant
      // schedules) and for promoted custom items that don't have a recipe yet.
      const manual = it['cost_' + t.toLowerCase()];
      if (manual != null) c = { ...c, cost: manual, matCost: manual, plantCost: 0, labCost: 0, subCost: 0, ohCost: 0, delivery: 0, hrs: c.hrs, lines: c.lines };
      else if (!Object.keys(recs).length && pi && pi['entered_cost_' + t.toLowerCase()] != null)
        c = { ...c, cost: pi['entered_cost_' + t.toLowerCase()], matCost: pi['entered_cost_' + t.toLowerCase()] };
      line.tiers[t] = { spec: r.spec, rate: r.rate, sell, cost: c.cost, hrs: c.hrs, subDays: c.subDays };
      tierTot[t].cost += c.cost; tierTot[t].sell += sell; tierTot[t].hrs += c.hrs;
      line.tiers[t].wastageSurcharge = Math.round(c.wastageSurcharge);
      // Labour portion of this line, as a share of its SELL value. Includes subcontract
      // labour, because a difficult site raises the subbie's price too.
      const labCost = (c.labCost || 0) + (c.subCost || 0);
      line.tiers[t].labourShare = c.cost > 0 ? labCost / c.cost : 0;
      line.tiers[t].labourValue = Math.round(sell * (c.cost > 0 ? labCost / c.cost : 0));
      line.tiers[t].wasteUplift = it['waste_uplift_' + t.toLowerCase()] || 0;
      if (t === selTier) {
        selTot.cost += c.cost; selTot.sell += sell; selTot.hrs += c.hrs;
        selTot.matCost += c.matCost; selTot.plantCost += c.plantCost; selTot.labCost += c.labCost;
        selTot.subCost += c.subCost; selTot.delivery += c.delivery;
        selTot.ohCost = (selTot.ohCost || 0) + (c.ohCost || 0);
        selTot.ohDays = (selTot.ohDays || 0) + (c.ohDays || 0);
        selTot.wastageSurcharge = (selTot.wastageSurcharge || 0) + c.wastageSurcharge;
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
  // Overhead is recovered exactly once. Recipes that carry an overhead component have
  // already charged those crew-days; the job-level allocation covers only the remainder.
  const ohDailyRate = overheadDailyRate();
  const ohInRecipes = selTot.ohDays || 0;
  const ohRemainingDays = Math.max(0, crewDays - ohInRecipes);
  const ohAllocated = ohDailyRate * ohRemainingDays;
  const target = parseFloat(settingGet('tier_' + (q.customer_tier || 'Silver').toLowerCase()) || '25');
  const margin = selTot.sell - selTot.cost;
  const pct = selTot.sell > 0 ? margin / selTot.sell * 100 : 0;
  return { base, crew, perLine, tierTotals: tierTot, selected: selTot,
    crewDays: Math.round(crewDays * 10) / 10, subDays: Math.round(subDays * 10) / 10,
    days: Math.round(days * 10) / 10, hours: Math.round(selTot.hrs * 10) / 10,
    grossMargin: margin, grossMarginPct: Math.round(pct * 10) / 10,
    target, belowTarget: pct < target, guidePrice: target < 100 ? selTot.cost / (1 - target / 100) : selTot.cost, // margin-on-sell, NOT markup
    ohDailyRate: Math.round(ohDailyRate), ohAllocated: Math.round(ohAllocated),
    ohInRecipes: Math.round(selTot.ohCost || 0), ohRecipeDays: Math.round((selTot.ohDays || 0) * 10) / 10,
    netMarginPct: selTot.sell > 0 ? Math.round((selTot.sell - selTot.cost - ohAllocated) / selTot.sell * 1000) / 10 : 0,
    wastageSurcharge: Math.round(selTot.wastageSurcharge || 0),
    wasteUplift: Math.round(perLine.reduce((a, l) => a + (l.tiers[l.selected].wasteUplift || 0), 0)),
    changes, mixed: changes.length > 0, takeoff, selectionsLocked: !!q.selections_locked };
}
module.exports = { costQuote, costVariant, recalcWasteUplift, recipesFor, defaultVariant, materialPrice, crewHourRate, overheadDailyRate, deliveryFor, TIERS, VARIANTS };
