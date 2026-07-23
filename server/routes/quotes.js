const express = require('express');
const { db, settingGet } = require('../db');
const { newId, newToken } = require('../utils/ids');
const { TIERS, resolveItem, snapshotFromPriceItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const { costQuote } = require('../utils/costing');

const router = express.Router();
const getPI = id => id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(id) : null;

function computeQuote(q) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY scope, sort_order').all(q.id);
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const out = { scope1: [], scope2: [] };
  const scope1TierTotals = { Basic: 0, Standard: 0, Premium: 0 };
  let scope2Total = 0;

  items.forEach(it => {
    const pi = getPI(it.price_item_id);
    const perTier = {};
    TIERS.forEach(t => { const r = resolveItem(it, pi, t); perTier[t] = { spec: r.spec, rate: r.rate, total: lineTotal(it, r) }; });
    const eff = it.tier_override || q.default_package;
    const rEff = resolveItem(it, pi, eff);
    const row = {
      id: it.id, scope: it.scope, code: rEff.code, name: rEff.name, unit: rEff.unit,
      qty: it.qty, behaviour: rEff.behaviour, tierOverride: it.tier_override,
      method: it.method || null, subDays: it.sub_days, wastageOverride: it.wastage_override, sharedEnabled: !!it.shared_enabled, sharedPct: it.shared_pct,
      priceItemId: it.price_item_id, customRate: it.custom_rate,
      perTier, effectiveTier: eff, effectiveTotal: lineTotal(it, rEff), effectiveRate: rEff.rate, effectiveSpec: rEff.spec,
    };
    if (it.scope === 2) { scope2Total += row.effectiveTotal; out.scope2.push(row); }
    else { TIERS.forEach(t => scope1TierTotals[t] += perTier[t].total); out.scope1.push(row); }
  });

  const s1 = scope1TierTotals[q.default_package];
  const sur = surchargeAmount(applied, s1);
  const surPerTier = {}; TIERS.forEach(t => surPerTier[t] = surchargeAmount(applied, scope1TierTotals[t]));
  const grandExGst = s1 + sur + scope2Total;
  return {
    items: out, appliedSurcharges: applied,
    scope1TierTotals, scope2Total, surcharge: sur, surchargePerTier: surPerTier,
    grandExGst, gst: grandExGst * 0.1, grandIncGst: grandExGst * 1.1,
  };
}

function fullQuote(q) {
  const c = computeQuote(q);
  const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
  return {
    id: q.id, token: q.token, parentNumber: q.parent_number, quoteNumber: q.quote_number,
    projectTitle: q.project_title, client: q.client_name, clientEmail: q.client_email, address: q.address,
    date: q.quote_date, validityDays: q.validity_days, defaultPackage: q.default_package,
    paymentSchedule: q.payment_schedule, siteNotes: q.site_notes, specialClauses: q.special_clauses,
    hasSiteplan: !!q.siteplan_data, status: laterRev > 0 ? 'superseded' : q.status,
    acceptedPackage: q.accepted_package, acceptedAt: q.accepted_at, signedName: q.signed_name,
    updatedAt: q.updated_at, createdAt: q.created_at,
    customerTier: q.customer_tier || 'Silver', crewSize: q.crew_size || 2,
    siteplanNa: !!q.siteplan_na, surchargesNa: !!q.surcharges_na,
    emailStatus: q.email_status || null, emailDetail: q.email_detail || null, ...c,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM quotes ORDER BY parent_number DESC, created_at DESC').all();
  res.json(rows.map(q => {
    const views = db.prepare("SELECT COUNT(*) c FROM quote_events WHERE quote_id=? AND event_type='view'").get(q.id).c;
    const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
    // completeness: has at least one item, a surcharge decision, a siteplan decision, and no unchecked CRITICAL checklist items
    const itemCount = db.prepare('SELECT COUNT(*) c FROM quote_items WHERE quote_id=?').get(q.id).c;
    const uncheckedCritical = db.prepare("SELECT COUNT(*) c FROM quote_checklist WHERE quote_id=? AND critical=1 AND checked=0").get(q.id).c;
    const applied = JSON.parse(q.applied_surcharges || '[]');
    const surchargeDecided = (applied.length > 0) || !!q.surcharges_na;
    const siteplanDecided = !!q.siteplan_data || !!q.siteplan_na;
    const complete = itemCount > 0 && surchargeDecided && siteplanDecided && uncheckedCritical === 0;
    const fq = fullQuote(q);
    const baseDate = new Date((q.quote_date ? q.quote_date + 'T00:00:00' : q.created_at) + 'Z');
    const ageDays = Math.max(0, Math.floor((Date.now() - baseDate.getTime()) / 864e5));
    const th = { flag: parseFloat(settingGet('age_flag') || '7'), chase: parseFloat(settingGet('age_chase') || '14'), dead: parseFloat(settingGet('age_dead') || '30') };
    let ageBand = 'fresh';
    if (q.status === 'accepted') ageBand = 'fresh';
    else if (ageDays >= th.dead) ageBand = 'dead';
    else if (ageDays >= th.chase) ageBand = 'chase';
    else if (ageDays >= th.flag) ageBand = 'flag';
    let status = laterRev > 0 ? 'superseded' : q.status;
    if (status !== 'accepted' && status !== 'superseded' && !complete) status = 'incomplete';
    return { id: q.id, token: q.token, parentNumber: q.parent_number, quoteNumber: q.quote_number,
      client: q.client_name, projectTitle: q.project_title,
      status, acceptedPackage: q.accepted_package,
      value: Math.round(fq.grandIncGst), complete, uncheckedCritical, ageDays, ageBand, customerTier: q.customer_tier || 'Silver',
      views, updatedAt: q.updated_at };
  }));
});

router.get('/:id', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json(fullQuote(q));
});

// Reusable so Leads can convert an enquiry straight into a quote.
function createQuote(b = {}) {
  const maxNum = db.prepare("SELECT MAX(CAST(parent_number AS INTEGER)) m FROM quotes").get().m;
  const parent = b.parentNumber || String((maxNum || 1409) + 1);
  const id = newId();
  db.prepare(`INSERT INTO quotes (id,token,parent_number,quote_number,project_title,client_name,client_email,address,quote_date,default_package,payment_schedule,site_notes,special_clauses,lead_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, newToken(), parent, parent, b.projectTitle || 'Landscape Works', b.client || '', b.clientEmail || '',
    b.address || '', b.date || new Date().toISOString().slice(0, 10), b.defaultPackage || 'Standard',
    b.paymentSchedule || 'standard', '', settingGet('default_special_clauses') || '', b.leadId || null);
  return db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
}
router.post('/', (req, res) => {
  res.status(201).json(fullQuote(createQuote(req.body || {})));
});

// New revision: copies everything, next suffix, older ones become superseded automatically
router.post('/:id/revision', (req, res) => {
  const src = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  const sibs = db.prepare('SELECT quote_number FROM quotes WHERE parent_number=?').all(src.parent_number);
  let maxSuffix = 0;
  sibs.forEach(s => { const m = String(s.quote_number).match(/\.(\d+)$/); if (m) maxSuffix = Math.max(maxSuffix, Number(m[1])); });
  const newNumber = `${src.parent_number}.${maxSuffix + 1}`;
  const id = newId();
  db.prepare(`INSERT INTO quotes (id,token,parent_number,quote_number,project_title,client_name,client_email,address,quote_date,validity_days,default_package,payment_schedule,site_notes,special_clauses,siteplan_data,siteplan_mime,applied_surcharges)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, newToken(), src.parent_number, newNumber, src.project_title, src.client_name, src.client_email, src.address,
    new Date().toISOString().slice(0, 10), src.validity_days, src.default_package, src.payment_schedule,
    src.site_notes, src.special_clauses, src.siteplan_data, src.siteplan_mime, src.applied_surcharges);
  db.prepare('SELECT * FROM quote_items WHERE quote_id=?').all(src.id).forEach(it => {
    db.prepare(`INSERT INTO quote_items (id,quote_id,scope,price_item_id,custom_code,custom_name,custom_unit,custom_rate,qty,tier_override,behaviour_override,shared_enabled,shared_pct,sort_order,
      locked_basic_spec,locked_basic_sell,locked_standard_spec,locked_standard_sell,locked_premium_spec,locked_premium_sell,locked_behaviour)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId(), id, it.scope, it.price_item_id, it.custom_code, it.custom_name, it.custom_unit, it.custom_rate, it.qty, it.tier_override, it.behaviour_override, it.shared_enabled, it.shared_pct, it.sort_order,
      it.locked_basic_spec, it.locked_basic_sell, it.locked_standard_spec, it.locked_standard_sell, it.locked_premium_spec, it.locked_premium_sell, it.locked_behaviour);
  });
  res.status(201).json(fullQuote(db.prepare('SELECT * FROM quotes WHERE id=?').get(id)));
});

router.put('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(`UPDATE quotes SET project_title=?,client_name=?,client_email=?,address=?,quote_date=?,validity_days=?,default_package=?,payment_schedule=?,site_notes=?,special_clauses=?,applied_surcharges=?,siteplan_na=?,surcharges_na=?,customer_tier=?,crew_size=?,updated_at=datetime('now') WHERE id=?`)
    .run(b.projectTitle ?? e.project_title, b.client ?? e.client_name, b.clientEmail ?? e.client_email,
      b.address ?? e.address, b.date ?? e.quote_date, b.validityDays ?? e.validity_days,
      b.defaultPackage ?? e.default_package, b.paymentSchedule ?? e.payment_schedule,
      b.siteNotes ?? e.site_notes, b.specialClauses ?? e.special_clauses,
      b.appliedSurcharges !== undefined ? JSON.stringify(b.appliedSurcharges) : e.applied_surcharges,
      b.siteplanNa !== undefined ? (b.siteplanNa ? 1 : 0) : e.siteplan_na,
      b.surchargesNa !== undefined ? (b.surchargesNa ? 1 : 0) : e.surcharges_na,
      b.customerTier ?? e.customer_tier, b.crewSize ?? e.crew_size,
      req.params.id);
  res.json(fullQuote(db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id)));
});

router.delete('/:id', (req, res) => { db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id); res.status(204).end(); });

router.post('/:id/siteplan', (req, res) => {
  const { data, mime } = req.body || {};
  db.prepare("UPDATE quotes SET siteplan_data=?, siteplan_mime=?, updated_at=datetime('now') WHERE id=?").run(data || null, mime || null, req.params.id);
  res.json({ ok: true });
});

// items
router.post('/:id/items', (req, res) => {
  const b = req.body || {};
  const id = newId();
  const pi = b.priceItemId ? db.prepare('SELECT * FROM price_items WHERE id=?').get(b.priceItemId) : null;
  const snap = snapshotFromPriceItem(pi); // lock current rates onto this quote line
  db.prepare(`INSERT INTO quote_items (id,quote_id,scope,price_item_id,custom_code,custom_name,custom_unit,custom_rate,qty,tier_override,shared_enabled,shared_pct,
    locked_basic_spec,locked_basic_sell,locked_standard_spec,locked_standard_sell,locked_premium_spec,locked_premium_sell,locked_behaviour)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.params.id, b.scope || 1, b.priceItemId || null,
    b.customCode || null, b.customName || null, b.customUnit || null, b.customRate ?? null,
    b.qty ?? 1, b.tierOverride || null, b.sharedEnabled ? 1 : 0, b.sharedPct ?? 50,
    snap.locked_basic_spec ?? null, snap.locked_basic_sell ?? null, snap.locked_standard_spec ?? null,
    snap.locked_standard_sell ?? null, snap.locked_premium_spec ?? null, snap.locked_premium_sell ?? null, snap.locked_behaviour ?? null);
  res.status(201).json({ id });
});
router.put('/:id/items/:itemId', (req, res) => {
  const e = db.prepare('SELECT * FROM quote_items WHERE id=?').get(req.params.itemId);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(`UPDATE quote_items SET qty=?,tier_override=?,shared_enabled=?,shared_pct=?,custom_name=?,custom_rate=?,scope=?,method=?,wastage_override=? WHERE id=?`)
    .run(b.qty ?? e.qty, b.tierOverride !== undefined ? b.tierOverride : e.tier_override,
      b.sharedEnabled !== undefined ? (b.sharedEnabled ? 1 : 0) : e.shared_enabled,
      b.sharedPct ?? e.shared_pct, b.customName ?? e.custom_name, b.customRate ?? e.custom_rate,
      b.scope ?? e.scope, b.method !== undefined ? b.method : e.method,
      b.wastageOverride !== undefined ? b.wastageOverride : e.wastage_override, req.params.itemId);
  if (b.subDays !== undefined) db.prepare('UPDATE quote_items SET sub_days=? WHERE id=?').run(b.subDays, req.params.itemId);
  res.json({ ok: true });
});
router.delete('/:id/items/:itemId', (req, res) => { db.prepare('DELETE FROM quote_items WHERE id=?').run(req.params.itemId); res.status(204).end(); });

router.get('/:id/analytics', (req, res) => {
  const ev = db.prepare('SELECT * FROM quote_events WHERE quote_id=? ORDER BY created_at DESC LIMIT 300').all(req.params.id);
  const secs = ev.filter(e => e.event_type === 'heartbeat').reduce((s, e) => { try { return s + (JSON.parse(e.payload).seconds || 0); } catch { return s; } }, 0);
  const pkg = {}; ev.filter(e => e.event_type === 'package_select').forEach(e => { try { const t = JSON.parse(e.payload).tier; pkg[t] = (pkg[t] || 0) + 1; } catch {} });
  res.json({ views: ev.filter(e => e.event_type === 'view').length, activeSeconds: Math.round(secs), packageClicks: pkg });
});

// Full tier costing for a quote (recipes). Estimators get cost totals + site time but no margin.
router.get('/:id/costing', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const c = costQuote(q);
  if (req.user && req.user.role !== 'admin') {
    // strip commercially sensitive figures for estimators
    const { grossMargin, grossMarginPct, target, belowTarget, guidePrice, tierTotals, ...rest } = c;
    rest.perLine = rest.perLine.map(l => { const t = {}; Object.keys(l.tiers).forEach(k => { const { cost, ...tv } = l.tiers[k]; t[k] = tv; }); return { ...l, tiers: t }; });
    const { matCost, labCost, subCost, delivery, plant, ...selRest } = rest.selected;
    rest.selected = selRest; rest.takeoff = [];
    return res.json(rest);
  }
  res.json(c);
});

// Signed-contract PREVIEW (admin): the exact PDF a client receives, before any send.
router.get('/:id/signed-preview', async (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { buildSignedPdf } = require('../utils/signedPdf');
  const { pdfPayload } = require('./publicQuote');
  const fq = fullQuote(q);
  const totals = { grandExGst: Math.round(fq.grandExGst), grandIncGst: Math.round(fq.grandIncGst) };
  const settings = {};
  ['company_abn','company_lic','company_address','tagline','warranty_text','standard_conditions','default_special_clauses'].forEach(k => settings[k] = settingGet(k));
  const signed = !!q.signed_name;
  const preview = { ...q,
    accepted_package: q.accepted_package || q.default_package,
    signed_name: q.signed_name || q.client_name || '(not yet signed)',
    signed_sig: q.signed_sig || q.client_name || '',
    accepted_at: q.accepted_at || new Date().toISOString().slice(0, 19).replace('T', ' ') };
  try {
    const payload = pdfPayload(preview, preview.accepted_package);
    const pdf = await buildSignedPdf({ quote: preview, totals, settings, ...payload, preview: !signed });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contract-${q.quote_number}.pdf"`);
    res.send(pdf);
  } catch (e) { res.status(500).json({ error: 'preview failed: ' + e.message }); }
});

module.exports = router;
module.exports.createQuote = createQuote;
