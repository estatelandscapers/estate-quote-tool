// Client-facing API. Cost/margin never touches this code path.
const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const { TIERS, resolveItem, lineTotal, surchargeAmount, surchargeList } = require('../utils/pricing');
const { costQuote: cq2 } = require('../utils/costing');

// What sets Estate apart — shown on the client link above the price.
function credentials() {
  return {
    projects: settingGet('projects_delivered') || '300+',
    stars: settingGet('rating_stars') || '5.0',
    ratingSource: settingGet('rating_source') || 'Google',
    ratingCount: settingGet('rating_count') || '',
    licence: settingGet('company_lic') || '',
    association: settingGet('association_line') || '',
  };
}
const ESTATE_STANDARD = [
  { n: '01', title: 'Clear scope. Clear pricing.',
    body: 'A cheaper quote becomes an expensive project when works are excluded, underestimated or left unclear. You see what is included, what is excluded and what has been assumed — before construction begins.',
    commit: 'Transparency from quotation to completion.' },
  { n: '02', title: 'Precision from the ground up',
    body: 'Levels, drainage, excavation, compaction, reinforcement and soil preparation decide how a landscape performs years later — not the finish you see on handover day.',
    commit: 'Build it properly, not just beautifully.' },
  { n: '03', title: 'Quality without shortcuts',
    body: 'Straight lines. Correct levels. Clean finishes. Proper preparation. We would rather address something during construction than leave it for you to discover later.',
    commit: 'Quality is part of the process, not inspected in at the end.' },
  { n: '04', title: 'Professional project management',
    body: 'Earthworks, retaining, drainage, concrete, paving, fencing, turf and planting — coordinated by one organised team, so you deal with us rather than managing numerous trades.',
    commit: 'We manage the project so you don\'t have to manage us.' },
  { n: '05', title: 'Compliance & construction confidence',
    body: 'We treat landscaping as a construction service. Where drawings, engineering, approvals or certification are required, we identify them and bring in the right professionals.',
    commit: 'If something needs doing properly, we plan for it properly.' },
  { n: '06', title: 'We stand behind our work',
    body: 'We review the completed works with you, hand over care and maintenance information, and address any legitimate workmanship issue professionally.',
    commit: 'Proud of the project years later, not just on handover day.' },
];
const { sendMail } = require('../utils/email');
const { buildSignedPdf } = require('../utils/signedPdf');
const { costQuote } = require('../utils/costing');

const router = express.Router();
const getPI = id => id ? db.prepare('SELECT * FROM price_items WHERE id=?').get(id) : null;
const getQ = t => db.prepare('SELECT * FROM quotes WHERE token=?').get(t);

function clientView(q) {
  const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
  const validUntil = new Date(new Date(q.quote_date).getTime() + q.validity_days * 86400000);
  const expired = Date.now() > validUntil.getTime() && q.status !== 'accepted';

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id=? ORDER BY scope, sort_order').all(q.id);
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const scope1 = [], scope2 = [];
  const tierTotals = { Basic: 0, Standard: 0, Premium: 0 };
  let s2 = 0;
  items.forEach(it => {
    const pi = getPI(it.price_item_id);
    const perTier = {};
    TIERS.forEach(t => { const r = resolveItem(it, pi, t); perTier[t] = { spec: r.spec, price: lineTotal(it, r, t), rate: r.rate }; });
    const anyR = resolveItem(it, pi, 'Standard');
    const row = {
      code: anyR.code, name: anyR.name, unit: anyR.unit, behaviour: anyR.behaviour,
      description: it.desc_override || (pi ? pi.description : '') || it.custom_desc || '',
      qty: it.qty, sharedEnabled: !!it.shared_enabled, sharedPct: it.shared_pct, perTier, tierOverride: it.tier_override || null,
      changes: (() => { const a = perTier.Basic, b = perTier.Premium; return a.spec !== b.spec || a.price !== b.price; })(),
      alternates: (() => { const o = {}; TIERS.forEach(t => o[t] = perTier[t].spec); return o; })(),
    };
    if (it.scope === 2) { s2 += perTier.Standard.price; scope2.push(row); }
    else { TIERS.forEach(t => tierTotals[t] += perTier[t].price); scope1.push(row); }
  });
  // Same targeted bases the admin side uses, so the client total always agrees.
  const lb = {}; TIERS.forEach(t => lb[t] = {});
  try {
    (cq2(q).perLine || []).forEach(l => TIERS.forEach(t => {
      lb[t][l.id] = { full: l.tiers[t].sell, labour: l.tiers[t].labourValue || 0 };
    }));
  } catch (e) { console.error('[client surcharge] bases unavailable:', e.message); }
  const surPerTier = {}; TIERS.forEach(t => surPerTier[t] = surchargeAmount(applied, tierTotals[t] + s2, lb[t]));

  return {
    quoteNumber: q.quote_number, projectTitle: q.project_title, client: q.client_name, address: q.address,
    date: q.quote_date, validUntil: validUntil.toISOString().slice(0, 10), validityDays: q.validity_days,
    expired, superseded: laterRev > 0,
    defaultPackage: q.default_package, status: q.status, acceptedPackage: q.accepted_package, clientEmail: q.client_email || '',
    mixed: (() => { try { const c = costQuote(q); return c.mixed ? { base: c.base, changes: c.changes.map(x => ({ code: x.code, name: x.name, to: x.to, delta: Math.round(x.delta), up: x.up })), sellExGst: Math.round(c.selected.sell) } : null; } catch { return null; } })(),
    paymentScheduleText: settingGet(q.payment_schedule === 'small' ? 'pay_sched_small' : 'pay_sched_standard'),
    siteNotes: q.site_notes, hasSiteplan: !!q.siteplan_data,
    surcharges: surchargeList(applied).map(s => ({ code: s.code, name: s.name, kind: s.kind, rate: s.rate })),
    credentials: credentials(), estateStandard: ESTATE_STANDARD,
    surchargePerTier: surPerTier,
    scope1, scope2, tierTotals, scope2Total: s2,
    company: {
      name: settingGet('company_name'), abn: settingGet('company_abn'), lic: settingGet('company_lic'),
      email: settingGet('company_email'), phone: settingGet('company_phone'), address: settingGet('company_address'),
      association: settingGet('association_line'), tagline: settingGet('tagline'),
    },
    pkgDesc: { Basic: settingGet('pkg_desc_basic'), Standard: settingGet('pkg_desc_standard'), Premium: settingGet('pkg_desc_premium') },
    contract: {
      standardConditions: settingGet('standard_conditions'),
      specialClauses: q.special_clauses || settingGet('default_special_clauses'),
      warranty: settingGet('warranty_text'),
      protections: (settingGet('protections_text') || '').split('\n').filter(Boolean).map(l => { const [t, d] = l.split('|'); return { title: t, detail: d || '' }; }),
    },
  };
}

// The quote can be switched off without being deleted — the client gets a "call us"
// page instead of the price, and the same link works again when it's switched back on.
router.get('/:token', (req, res) => {
  const q = getQ(req.params.token);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  // Switched off: the client gets a "call us" page, never the price. The quote itself
  // is untouched and the same link works again the moment it's switched back on.
  if (q.link_off) {
    return res.json({ linkOff: true, clientName: q.client_name, quoteNumber: q.quote_number,
      company: { name: settingGet('company_name'), phone: settingGet('company_phone'),
        email: settingGet('company_email'), tagline: settingGet('tagline') },
      message: settingGet('link_off_message') || '',
      // The Estate Standard matters MORE here, not less — this is the page a hesitant
      // client sees, and it's the only thing selling us while they decide whether to ring.
      estateStandard: ESTATE_STANDARD,
      credentials: credentials() });
  }
  res.json(clientView(q));
});

router.get('/:token/siteplan', (req, res) => {
  const q = getQ(req.params.token);
  if (!q || !q.siteplan_data) return res.status(404).end();
  res.setHeader('Content-Type', q.siteplan_mime || 'image/png');
  res.send(Buffer.from(q.siteplan_data, 'base64'));
});

// Is this us looking, rather than the client?
//  1. a valid admin/estimator session cookie is present, or
//  2. the link was opened from the tool's Preview button (?preview=1)
function viewerOf(req) {
  try {
    const { getUser } = require('../utils/auth');
    if (getUser(req)) return 'internal';          // signed in = one of us
  } catch (e) {}
  if (req.query.preview === '1' || (req.body && req.body.preview)) return 'internal';
  return 'client';
}
// Rough visitor fingerprint so one person refreshing isn't counted five times.
// Deliberately coarse — enough to de-dupe, not enough to identify anyone.
function visitorKey(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 80);
  return require('node:crypto').createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);
}
router.post('/:token/event', (req, res) => {
  const q = getQ(req.params.token);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { type, payload } = req.body || {};
  if (!['view', 'section_view', 'package_select', 'heartbeat', 'print_click'].includes(type)) return res.status(400).json({ error: 'Bad type' });
  const viewer = viewerOf(req);
  const vkey = visitorKey(req);
  db.prepare('INSERT INTO quote_events (id,quote_id,event_type,payload,viewer,visitor_key) VALUES (?,?,?,?,?,?)')
    .run(newId(), q.id, type, JSON.stringify(payload || {}), viewer, vkey);
  // Only a genuine client view moves the quote to "viewed".
  if (type === 'view' && viewer === 'client' && (q.status === 'draft' || q.status === 'sent'))
    db.prepare("UPDATE quotes SET status='viewed' WHERE id=?").run(q.id);
  res.status(201).json({ ok: true });
});


// Assemble everything the signed-contract PDF needs from a quote at a given tier.
function pdfPayload(q, tier) {
  const cv = clientView(q);
  const acc = tier || q.accepted_package || q.default_package || 'Standard';
  const deliverables = [];
  (cv.scope1 || []).forEach(d => {
    const lt = (cv.mixed && d.tierOverride) ? d.tierOverride : acc;
    const pt = d.perTier[lt] || d.perTier[acc];
    deliverables.push({ code: d.code, name: d.name, spec: pt.spec, description: d.description,
      qty: d.qty, unit: d.unit, price: pt.price, showQty: d.behaviour === 'remeasurable' });
  });
  (cv.scope2 || []).forEach(d => {
    const pt = d.perTier[acc];
    deliverables.push({ code: d.code, name: d.name + ' (remeasurable — cost + 15%)', spec: pt.spec,
      description: d.description, qty: d.qty, unit: d.unit, price: pt.price, showQty: true });
  });
  // Site-specific surcharges: their own coded section (SS1, SS2...), separate from Scope 2
  const surcharges = (cv.surcharges || []).map(s => ({ code: s.code, name: s.name,
    detail: s.kind === 'percent' ? `+${s.rate}% of works subtotal` : `+$${Number(s.rate).toLocaleString()} fixed` }));
  return { deliverables, surcharges, payment: cv.paymentScheduleText || '',
    sitePlan: q.siteplan_data ? { data: q.siteplan_data } : null };
}

// Accept + built-in sign. Generates the signed PDF and emails both parties via Zoho.
router.post('/:token/sign', async (req, res) => {
  const q = getQ(req.params.token);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { tier, name, signature, email } = req.body || {};
  if (!['Basic', 'Standard', 'Premium'].includes(tier)) return res.status(400).json({ error: 'Bad tier' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  db.prepare(`UPDATE quotes SET status='accepted', accepted_package=?, accepted_at=datetime('now'),
    signed_name=?, signed_sig=?, signed_ip=?, client_email=COALESCE(NULLIF(?, ''), client_email), updated_at=datetime('now') WHERE id=?`)
    .run(tier, name, signature || name, String(ip).slice(0, 60), email || '', q.id);
  db.prepare('INSERT INTO quote_events (id,quote_id,event_type,payload) VALUES (?,?,?,?)')
    .run(newId(), q.id, 'package_select', JSON.stringify({ tier, accepted: true }));

  // Snapshot QUOTED gross-margin baseline at the moment of acceptance (jobs register compares actuals against this)
  try {
    const qq = db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id);
    const cc = costQuote(qq);
    // sell for the accepted configuration: mixed selections if any, otherwise straight tier
    const sellSel = cc.mixed ? cc.selected.sell : Object.values(cc.perLine).reduce((a, l) => a + l.tiers[tier].sell, 0);
    const costSel = cc.mixed ? cc.selected.cost : Object.values(cc.perLine).reduce((a, l) => a + l.tiers[tier].cost, 0);
    db.prepare('UPDATE quotes SET quoted_sell=?, quoted_cost=?, accepted_mixed=? WHERE id=?')
      .run(Math.round(sellSel * 100) / 100, Math.round(costSel * 100) / 100, JSON.stringify(cc.changes || []), q.id);
  } catch (e) { console.error('quoted snapshot failed', e.message); }

  const fresh = db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id);
  const cv = clientView(fresh);
  const s1 = cv.tierTotals[tier], sur = cv.surchargePerTier[tier];
  const grandExGst = s1 + sur + cv.scope2Total;
  const totals = { grandExGst: Math.round(grandExGst), grandIncGst: Math.round(grandExGst * 1.1) };

  // Respond IMMEDIATELY — the slow work (PDF + two emails) runs in the background.
  // NOTE: the PO is NOT created here any more. A won job goes to Selections first, where the
  // delivery method and vendors are confirmed; locking those creates the PO.
  res.json({ ok: true, emailed: { client: 'sending', office: 'sending' } });

  setImmediate(async () => {
    try {
      const settings = {};
      ['company_abn','company_lic','company_address','tagline','warranty_text','standard_conditions','default_special_clauses'].forEach(k => settings[k] = settingGet(k));
      let pdf = null;
      const payload = pdfPayload(fresh, tier);
      try { pdf = await buildSignedPdf({ quote: fresh, totals, settings, ...payload }); } catch (e) { console.error('pdf failed', e); }
      const attachments = pdf ? [{ filename: `Estate-Landscapers-Signed-Contract-${fresh.quote_number}.pdf`, content: pdf }] : [];
      const html = `<p>Contract signed and accepted.</p>
        <p><b>Quote:</b> ${fresh.quote_number} — ${fresh.project_title}<br>
        <b>Client:</b> ${fresh.client_name} · ${fresh.address}<br>
        <b>Package:</b> ${tier} · <b>Total:</b> $${totals.grandIncGst.toLocaleString()} inc. GST<br>
        <b>Signed by:</b> ${name} at ${fresh.accepted_at} (UTC)</p>
        <p style="color:#888">Integrity. Precision. Value. — Estate Landscapers</p>`;
      const clientEmail = email || fresh.client_email;
      const outcome = [];
      let anySent = false, anyFail = false;
      try {
        if (clientEmail) {
          const r = await sendMail({ to: clientEmail, subject: `Your signed contract — Quote ${fresh.quote_number}`, html, attachments });
          if (r && r.skipped) { outcome.push('client: SMTP not configured'); anyFail = true; }
          else { outcome.push('client: sent to ' + clientEmail); anySent = true; }
        } else { outcome.push('client: no email address given'); anyFail = true; }
      } catch (e) { outcome.push('client FAILED: ' + e.message); anyFail = true; console.error('client email failed', e.message); }
      try {
        const r = await sendMail({ to: settingGet('company_email'), subject: `SIGNED: Quote ${fresh.quote_number} — ${fresh.client_name} (${tier})`, html, attachments });
        if (r && r.skipped) { outcome.push('office: SMTP not configured'); anyFail = true; }
        else { outcome.push('office: sent'); anySent = true; }
      } catch (e) { outcome.push('office FAILED: ' + e.message); anyFail = true; console.error('office email failed', e.message); }
      if (!pdf) outcome.push('WARNING: PDF could not be generated');
      // Winning the quote wins the lead — otherwise the two drift apart.
      try {
        if (fresh.lead_id) db.prepare("UPDATE leads SET stage='won', status='Won', next_followup=NULL, updated_at=datetime('now') WHERE id=?").run(fresh.lead_id);
      } catch (e) { console.error('lead win sync', e.message); }
      const status = anyFail ? (anySent ? 'partial' : 'failed') : 'sent';
      db.prepare('UPDATE quotes SET email_status=?, email_detail=? WHERE id=?').run(status, outcome.join(' | '), fresh.id);
      console.log(`[sign] quote ${fresh.quote_number} email ${status}: ${outcome.join(' | ')}`);
    } catch (e) { console.error('background sign work failed', e.message); }
  });
});

module.exports = router;
module.exports.pdfPayload = pdfPayload;
