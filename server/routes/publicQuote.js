// Client-facing API. Cost/margin never touches this code path.
const express = require('express');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');
const { TIERS, resolveItem, lineTotal, surchargeAmount } = require('../utils/pricing');
const { sendMail } = require('../utils/email');
const { buildSignedPdf } = require('../utils/signedPdf');

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
    TIERS.forEach(t => { const r = resolveItem(it, pi, t); perTier[t] = { spec: r.spec, price: lineTotal(it, r), rate: r.rate }; });
    const anyR = resolveItem(it, pi, 'Standard');
    const row = {
      code: anyR.code, name: anyR.name, unit: anyR.unit, behaviour: anyR.behaviour,
      qty: it.qty, sharedEnabled: !!it.shared_enabled, sharedPct: it.shared_pct, perTier,
    };
    if (it.scope === 2) { s2 += perTier.Standard.price; scope2.push(row); }
    else { TIERS.forEach(t => tierTotals[t] += perTier[t].price); scope1.push(row); }
  });
  const surPerTier = {}; TIERS.forEach(t => surPerTier[t] = surchargeAmount(applied, tierTotals[t]));

  return {
    quoteNumber: q.quote_number, projectTitle: q.project_title, client: q.client_name, address: q.address,
    date: q.quote_date, validUntil: validUntil.toISOString().slice(0, 10), validityDays: q.validity_days,
    expired, superseded: laterRev > 0,
    defaultPackage: q.default_package, status: q.status, acceptedPackage: q.accepted_package,
    paymentScheduleText: settingGet(q.payment_schedule === 'small' ? 'pay_sched_small' : 'pay_sched_standard'),
    siteNotes: q.site_notes, hasSiteplan: !!q.siteplan_data,
    surcharges: applied.map(s => ({ name: s.name, kind: s.kind, rate: s.rate })),
    surchargePerTier: surPerTier,
    scope1, scope2, tierTotals, scope2Total: s2,
    company: {
      name: settingGet('company_name'), abn: settingGet('company_abn'), lic: settingGet('company_lic'),
      email: settingGet('company_email'), phone: settingGet('company_phone'),
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

router.get('/:token', (req, res) => {
  const q = getQ(req.params.token);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  res.json(clientView(q));
});

router.get('/:token/siteplan', (req, res) => {
  const q = getQ(req.params.token);
  if (!q || !q.siteplan_data) return res.status(404).end();
  res.setHeader('Content-Type', q.siteplan_mime || 'image/png');
  res.send(Buffer.from(q.siteplan_data, 'base64'));
});

router.post('/:token/event', (req, res) => {
  const q = getQ(req.params.token);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { type, payload } = req.body || {};
  if (!['view', 'section_view', 'package_select', 'heartbeat', 'print_click'].includes(type)) return res.status(400).json({ error: 'Bad type' });
  db.prepare('INSERT INTO quote_events (id,quote_id,event_type,payload) VALUES (?,?,?,?)').run(newId(), q.id, type, JSON.stringify(payload || {}));
  if (type === 'view' && q.status === 'draft') db.prepare("UPDATE quotes SET status='viewed' WHERE id=?").run(q.id);
  res.status(201).json({ ok: true });
});

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

  const fresh = db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id);
  const cv = clientView(fresh);
  const s1 = cv.tierTotals[tier], sur = cv.surchargePerTier[tier];
  const grandExGst = s1 + sur + cv.scope2Total;
  const totals = { grandExGst: Math.round(grandExGst), grandIncGst: Math.round(grandExGst * 1.1) };

  const settings = {};
  ['company_abn','company_lic','company_address','tagline','warranty_text','standard_conditions','default_special_clauses'].forEach(k => settings[k] = settingGet(k));
  let pdf = null;
  try { pdf = await buildSignedPdf({ quote: fresh, totals, settings }); } catch (e) { console.error('pdf failed', e); }

  const attachments = pdf ? [{ filename: `Estate-Landscapers-Signed-Contract-${fresh.quote_number}.pdf`, content: pdf }] : [];
  const html = `<p>Contract signed and accepted.</p>
    <p><b>Quote:</b> ${fresh.quote_number} — ${fresh.project_title}<br>
    <b>Client:</b> ${fresh.client_name} · ${fresh.address}<br>
    <b>Package:</b> ${tier} · <b>Total:</b> $${totals.grandIncGst.toLocaleString()} inc. GST<br>
    <b>Signed by:</b> ${name} at ${fresh.accepted_at} (UTC)</p>
    <p style="color:#888">Integrity. Precision. Value. — Estate Landscapers</p>`;
  const results = { client: null, office: null };
  const clientEmail = email || fresh.client_email;
  try { if (clientEmail) results.client = await sendMail({ to: clientEmail, subject: `Your signed contract — Quote ${fresh.quote_number}`, html, attachments }); } catch (e) { console.error('client email failed', e.message); }
  try { results.office = await sendMail({ to: settingGet('company_email'), subject: `SIGNED: Quote ${fresh.quote_number} — ${fresh.client_name} (${tier})`, html, attachments }); } catch (e) { console.error('office email failed', e.message); }

  res.json({ ok: true, emailed: { client: !!(results.client && !results.client.skipped), office: !!(results.office && !results.office.skipped) } });
});

module.exports = router;
