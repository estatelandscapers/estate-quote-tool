// ---------------------------------------------------------------------------
// Service API — machine-to-machine access for the Site Management Tool.
//
// The admin API authenticates with a session cookie, so another Railway
// service could never call it: the login middleware 401s every /api/* request
// that lacks a signed-in user. This namespace exists for exactly that caller.
//
// Auth: a single shared key in the SERVICE_API_KEY environment variable,
// presented as  Authorization: Bearer <key>  (or X-Service-Key: <key>).
// No key configured => the whole namespace answers 503, so nothing is
// reachable by accident on an instance that hasn't opted in.
//
// Scope, deliberately: read jobs (accepted quotes), vendors and purchase
// orders; write only the PO fields the site team owns (per-line and
// per-vendor order status, close/reopen). Everything money-shaped — prices,
// quotes, signing — stays behind the human login. Writes are audit-logged
// with actor "service:<name>".
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const { db, settingGet } = require('../db');
const { newId } = require('../utils/ids');

const router = express.Router();

// ---- auth -----------------------------------------------------------------

function keyFromReq(req) {
  const h = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return (req.get('x-service-key') || '').trim();
}

function requireService(req, res, next) {
  const want = (process.env.SERVICE_API_KEY || '').trim();
  if (!want) return res.status(503).json({ error: 'Service API not enabled — set SERVICE_API_KEY on this deployment.' });
  const given = keyFromReq(req);
  // Constant-time compare; hashing first makes the buffers equal length.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid or missing service key. Send Authorization: Bearer <SERVICE_API_KEY>.' });
  req.serviceName = String(req.get('x-service-name') || 'site-tool').slice(0, 60);
  next();
}
router.use(requireService);

const audit = (req, type, id, action, detail) =>
  db.prepare('INSERT INTO audit_log (id,entity_type,entity_id,actor,action,detail) VALUES (?,?,?,?,?,?)')
    .run(newId(), type, id, 'service:' + req.serviceName, action, detail || '');

// ---- helpers --------------------------------------------------------------

// A "job" is an accepted, non-sample quote. Totals come from the configuration
// the client actually signed (package + their per-line changes + surcharges),
// the same acceptedTotals the contract itself is priced from — never a cached
// or plain-package figure, so this API can't disagree with the signed PDF.
function jobRow(q) {
  let totals = null;
  try {
    const { acceptedTotals } = require('./publicQuote');
    const at = acceptedTotals(q);
    totals = { exGst: Math.round(at.grandExGst), incGst: Math.round(at.grandIncGst) };
  } catch (e) {
    if (q.cached_value != null) totals = { exGst: Math.round(q.cached_value_ex || q.cached_value / 1.1), incGst: Math.round(q.cached_value) };
  }
  const lead = q.lead_id ? db.prepare('SELECT phone FROM leads WHERE id=?').get(q.lead_id) : null;
  const newer = q.superseded_by ? db.prepare('SELECT quote_number FROM quotes WHERE id=?').get(q.superseded_by) : null;
  return {
    id: q.id, quoteNumber: q.quote_number, parentNumber: q.parent_number, revNo: q.rev_no || 0,
    status: q.status,                                   // 'accepted' (live) or 'superseded'
    client: { name: q.client_name, email: q.signed_email || q.client_email, phone: (lead && lead.phone) || null },
    address: q.address, projectTitle: q.project_title,
    package: q.accepted_package, acceptedAt: q.accepted_at, signedBy: q.signed_name,
    selectionsLocked: !!q.selections_locked,
    totals,
    supersededAt: q.superseded_at || null, supersededBy: newer ? newer.quote_number : null,
    createdAt: q.created_at, updatedAt: q.updated_at,
  };
}

function poView(po, { items = false } = {}) {
  const q = db.prepare('SELECT quote_number, parent_number FROM quotes WHERE id=?').get(po.quote_id) || {};
  const out = {
    id: po.id,
    poNumber: po.po_number + (po.revision > 1 ? '-R' + po.revision : ''),
    quoteId: po.quote_id, quoteNumber: q.quote_number || null,
    client: po.client_name, address: po.address,
    status: po.status, revision: po.revision, superseded: !!po.superseded, supersedesId: po.supersedes_id,
    crewSize: po.crew_size, siteHours: po.site_hours, subDays: po.sub_days,
    siteChallenges: JSON.parse(po.site_challenges || '[]'),
    createdAt: po.created_at, closedAt: po.closed_at,
    vendors: db.prepare('SELECT id, vendor_name, suffix, status FROM po_vendors WHERE po_id=? ORDER BY suffix').all(po.id)
      .map(v => ({ id: v.id, vendorName: v.vendor_name, suffix: v.suffix, status: v.status })),
  };
  if (items) {
    out.items = db.prepare('SELECT * FROM po_items WHERE po_id=? AND COALESCE(removed,0)=0 ORDER BY sort_order, rowid').all(po.id)
      .map(it => ({ id: it.id, code: it.code, name: it.name, spec: it.spec, qty: it.qty, unit: it.unit,
        kind: it.kind, vendorName: it.vendor_name, unitCost: it.unit_cost, status: it.po_status || 'pending' }));
  }
  return out;
}

// ---- reads ----------------------------------------------------------------

// Connectivity check for the other service's setup step.
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'estate-quote-tool', company: settingGet('company_name') || 'Estate Landscapers', time: new Date().toISOString() });
});

// Jobs = accepted quotes. ?include=superseded adds closed-out revisions;
// ?since=<ISO or "YYYY-MM-DD HH:MM:SS" UTC> returns only jobs updated after it.
router.get('/jobs', (req, res) => {
  const statuses = String(req.query.include || '').split(',').includes('superseded')
    ? ['accepted', 'superseded'] : ['accepted'];
  let rows = db.prepare(`SELECT * FROM quotes WHERE status IN (${statuses.map(() => '?').join(',')})
    AND COALESCE(is_sample,0)=0 ORDER BY accepted_at DESC`).all(...statuses);
  const since = String(req.query.since || '').replace('T', ' ').replace(/Z$/, '').slice(0, 19);
  if (since) rows = rows.filter(r => (r.updated_at || r.created_at) > since);
  res.json({ jobs: rows.map(jobRow), asOf: new Date().toISOString() });
});

router.get('/jobs/:id', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=? OR quote_number=?').get(req.params.id, req.params.id);
  if (!q || q.is_sample) return res.status(404).json({ error: 'not found' });
  if (!['accepted', 'superseded'].includes(q.status)) return res.status(404).json({ error: 'not a job (quote not accepted)' });
  const out = jobRow(q);
  const tierOf = it => it.tier_override || q.accepted_package || q.default_package || 'Standard';
  out.items = db.prepare(`SELECT qi.*, pi.code pcode, pi.name pname, pi.unit punit FROM quote_items qi
    LEFT JOIN price_items pi ON pi.id = qi.price_item_id WHERE qi.quote_id=? ORDER BY qi.scope, qi.sort_order, qi.rowid`).all(q.id)
    .map(it => ({ id: it.id, scope: it.scope, code: it.custom_code || it.pcode, name: it.custom_name || it.pname,
      qty: it.qty, unit: it.custom_unit || it.punit, selectedTier: it.scope === 1 ? tierOf(it) : null,
      instanceNo: it.instance_no || 1, locationNote: it.location_note || null }));
  out.purchaseOrders = db.prepare('SELECT * FROM purchase_orders WHERE quote_id=? ORDER BY revision').all(q.id).map(p => poView(p));
  res.json(out);
});

router.get('/vendors', (req, res) => {
  res.json({ vendors: db.prepare('SELECT * FROM vendors ORDER BY name').all().map(v => ({
    id: v.id, codeNo: v.code_no, name: v.name, isSupplier: !!v.is_supplier, isSubcontractor: !!v.is_subcontractor,
    contact: v.contact, phone: v.phone, email: v.email, area: v.area, address: v.address,
    abn: v.abn, terms: v.terms, licence: v.licence, insuranceExpiry: v.insurance_expiry, swms: !!v.swms, notes: v.notes })) });
});

// ?job=<quote id or quote number> filters; ?all=1 includes superseded POs.
router.get('/purchase-orders', (req, res) => {
  let pos = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all();
  if (req.query.job) {
    const q = db.prepare('SELECT id FROM quotes WHERE id=? OR quote_number=?').get(req.query.job, req.query.job);
    pos = pos.filter(p => q && p.quote_id === q.id);
  }
  if (String(req.query.all || '') !== '1') pos = pos.filter(p => !p.superseded);
  res.json({ purchaseOrders: pos.map(p => poView(p)) });
});

router.get('/purchase-orders/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=? OR po_number=?').get(req.params.id, req.params.id);
  if (!po) return res.status(404).json({ error: 'not found' });
  res.json(poView(po, { items: true }));
});

// ---- writes (the site team's own fields, nothing money-shaped) -------------

// Same status vocabulary as the admin UI, so the two tools can't diverge.
router.put('/purchase-orders/:id/items/:itemId/status', (req, res) => {
  const it = db.prepare('SELECT * FROM po_items WHERE id=? AND po_id=?').get(req.params.itemId, req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const s = (req.body || {}).status;
  if (!['pending', 'ordered', 'delivered', 'invoiced'].includes(s)) return res.status(400).json({ error: 'bad status — pending | ordered | delivered | invoiced' });
  db.prepare('UPDATE po_items SET po_status=? WHERE id=?').run(s, it.id);
  audit(req, 'po_item', it.id, 'status', `${it.code || it.name}: ${it.po_status || 'pending'} -> ${s}`);
  res.json({ ok: true, id: it.id, status: s });
});

router.put('/purchase-orders/:id/vendor-status/:vid', (req, res) => {
  const v = db.prepare('SELECT * FROM po_vendors WHERE id=? AND po_id=?').get(req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  const s = (req.body || {}).status;
  if (!['ordered', 'delivered', 'invoiced'].includes(s)) return res.status(400).json({ error: 'bad status — ordered | delivered | invoiced' });
  db.prepare('UPDATE po_vendors SET status=? WHERE id=?').run(s, v.id);
  audit(req, 'po_vendor', v.id, 'status', `${v.vendor_name}: ${v.status} -> ${s}`);
  res.json({ ok: true, id: v.id, status: s });
});

router.post('/purchase-orders/:id/close', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE purchase_orders SET status='closed', closed_at=datetime('now') WHERE id=?`).run(po.id);
  audit(req, 'purchase_order', po.id, 'close', 'PO ' + po.po_number);
  res.json({ ok: true, id: po.id, status: 'closed' });
});

router.post('/purchase-orders/:id/reopen', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE purchase_orders SET status='open', closed_at=NULL WHERE id=?`).run(po.id);
  audit(req, 'purchase_order', po.id, 'reopen', 'PO ' + po.po_number);
  res.json({ ok: true, id: po.id, status: 'open' });
});

module.exports = router;
