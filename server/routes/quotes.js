const express = require('express');
const { db, settingGet } = require('../db');
const { newId, newToken } = require('../utils/ids');
const { TIERS, resolveItem, snapshotFromPriceItem, lineTotal, surchargeAmount, surchargeBase, surchargeGaps, surchargeList } = require('../utils/pricing');
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
    TIERS.forEach(t => { const r = resolveItem(it, pi, t); perTier[t] = { spec: r.spec, rate: r.rate, total: lineTotal(it, r, t) }; });
    const eff = it.tier_override || q.default_package;
    const rEff = resolveItem(it, pi, eff);
    const row = {
      id: it.id, scope: it.scope, code: rEff.code, name: rEff.name, unit: rEff.unit,
      qty: it.qty, behaviour: rEff.behaviour, tierOverride: it.tier_override,
      method: it.method || null, subDays: it.sub_days, wastageOverride: it.wastage_override,
      description: it.desc_override || (pi ? pi.description : '') || it.custom_desc || '', descIsCustom: !!it.desc_override,
      valueOverride: !!it.value_override,
      value: { Basic: it.val_basic, Standard: it.val_standard, Premium: it.val_premium },
      lineCost: { Basic: it.cost_basic, Standard: it.cost_standard, Premium: it.cost_premium },
      isCustom: !it.price_item_id,
      customBehaviour: it.custom_behaviour || 'none', customTiered: !!it.custom_tiered,
      customDesc: it.custom_desc || '',
      customSpec: { Basic: it.custom_spec_basic, Standard: it.custom_spec_standard, Premium: it.custom_spec_premium },
      promoStatus: it.promo_status || 'none', promotedPriceItemId: it.promoted_price_item_id || null,
      sharedEnabled: !!it.shared_enabled, sharedPct: it.shared_pct,
      priceItemId: it.price_item_id, customRate: it.custom_rate,
      perTier, effectiveTier: eff, effectiveTotal: lineTotal(it, rEff, eff), effectiveRate: rEff.rate, effectiveSpec: rEff.spec,
    };
    if (it.scope === 2) { scope2Total += row.effectiveTotal; out.scope2.push(row); }
    else { TIERS.forEach(t => scope1TierTotals[t] += perTier[t].total); out.scope1.push(row); }
  });

  const s1 = scope1TierTotals[q.default_package];
  // Per-line bases for targeted surcharges: full value and labour portion, per tier.
  const lineBasesByTier = {}; TIERS.forEach(t => lineBasesByTier[t] = {});
  try {
    const cq = costQuote(q);
    (cq.perLine || []).forEach(l => TIERS.forEach(t => {
      lineBasesByTier[t][l.id] = { full: l.tiers[t].sell, labour: l.tiers[t].labourValue || 0 };
    }));
  } catch (e) { console.error('[surcharge] line bases unavailable:', e.message); }
  const baseTier = q.default_package || 'Standard';
  const sur = surchargeAmount(applied, s1 + scope2Total, lineBasesByTier[baseTier]);
  const surPerTier = {}; TIERS.forEach(t => surPerTier[t] = surchargeAmount(applied, scope1TierTotals[t] + scope2Total, lineBasesByTier[t]));
  const grandExGst = s1 + scope2Total + sur;
  const gaps = surchargeGaps(applied, out.scope1.map(r => ({ id: r.id, code: r.code, name: r.name })));
  return {
    items: out, appliedSurcharges: applied,
    scope1TierTotals, scope2Total, surcharge: sur, surchargePerTier: surPerTier,
    surchargeList: surchargeList(applied).map((s, i) => ({ ...s,
      base: Math.round(s.kind === 'percent' ? surchargeBase(applied[i], scope1TierTotals[baseTier] + scope2Total, lineBasesByTier[baseTier]) : 0),
      amount: Math.round(s.kind === 'percent'
        ? surchargeBase(applied[i], scope1TierTotals[baseTier] + scope2Total, lineBasesByTier[baseTier]) * (s.rate / 100)
        : Number(s.rate) || 0) })),
    surchargeGaps: gaps, surchargesIncomplete: gaps.length > 0,
    lineBases: lineBasesByTier[baseTier],
    grandExGst, gst: grandExGst * 0.1, grandIncGst: grandExGst * 1.1,
  };
}

// Client views only. Internal views are recorded but reported separately, and one
// visitor inside 30 minutes counts once — a client refreshing is one visit, not five.
function viewStats(quoteId) {
  const rows = db.prepare("SELECT viewer, visitor_key, created_at FROM quote_events WHERE quote_id=? AND event_type='view' ORDER BY created_at").all(quoteId);
  const legacy = rows.filter(r => !r.viewer).length;           // recorded before attribution existed
  const internal = rows.filter(r => r.viewer === 'internal').length;
  const client = rows.filter(r => r.viewer === 'client');
  const seen = new Map(); let counted = 0;
  client.forEach(r => {
    const t = new Date((r.created_at || '') + 'Z').getTime();
    const last = seen.get(r.visitor_key || 'anon');
    if (!last || (t - last) > 30 * 60 * 1000) counted++;
    seen.set(r.visitor_key || 'anon', t);
  });
  const first = client[0];
  return { clientViews: counted, clientVisitors: seen.size, internalViews: internal,
    legacyViews: legacy, firstViewedAt: first ? first.created_at : null };
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
    rev: q.rev_no || 0, linkOff: !!q.link_off,
    emailStatus: q.email_status || null, emailDetail: q.email_detail || null,
    ...viewStats(q.id),
    sentAt: q.sent_at || null, sentTo: q.sent_to || null, sentBy: q.sent_by || null, sendCount: q.send_count || 0,
    sentSubject: q.sent_subject || null, sentMessage: q.sent_message || null, ...c,
  };
}

// The list needs a total per quote, not a full costing. Recompute only when the
// quote has actually changed since we last cached it.
// Returns { inc, ex } — both stored, because ex-GST is not simply inc/1.1 once
// fixed-dollar surcharges are in play.
function cachedTotals(q) {
  const rev = q.rev_no || 0;
  if (q.cached_rev === rev && q.cached_value != null && q.cached_value_ex != null)
    return { inc: q.cached_value, ex: q.cached_value_ex };
  let inc = 0, ex = 0;
  try { const fq = fullQuote(q); inc = fq.grandIncGst; ex = fq.grandExGst; } catch (e) {}
  try { db.prepare('UPDATE quotes SET cached_value=?, cached_value_ex=?, cached_rev=? WHERE id=?').run(inc, ex, rev, q.id); } catch (e) {}
  return { inc, ex };
}
function cachedValue(q) { return cachedTotals(q).inc; }
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM quotes ORDER BY parent_number DESC, created_at DESC').all();
  const mapped = rows.map(q => {
    const views = db.prepare("SELECT COUNT(*) c FROM quote_events WHERE quote_id=? AND event_type='view'").get(q.id).c;
    const laterRev = db.prepare('SELECT COUNT(*) n FROM quotes WHERE parent_number=? AND created_at > ?').get(q.parent_number, q.created_at).n;
    // completeness: has at least one item, a surcharge decision, a siteplan decision, and no unchecked CRITICAL checklist items
    const itemCount = db.prepare('SELECT COUNT(*) c FROM quote_items WHERE quote_id=?').get(q.id).c;
    const uncheckedCritical = db.prepare("SELECT COUNT(*) c FROM quote_checklist WHERE quote_id=? AND critical=1 AND checked=0").get(q.id).c;
    const applied = JSON.parse(q.applied_surcharges || '[]');
    const surchargeDecided = (applied.length > 0) || !!q.surcharges_na;
    const siteplanDecided = !!q.siteplan_data || !!q.siteplan_na;
    const complete = itemCount > 0 && surchargeDecided && siteplanDecided && uncheckedCritical === 0;
    // Was: fullQuote(q) for every row — the whole costing engine, per quote.
    const value = cachedValue(q);
    const baseDate = new Date((q.quote_date ? q.quote_date + 'T00:00:00' : q.created_at) + 'Z');
    const ageDays = Math.max(0, Math.floor((Date.now() - baseDate.getTime()) / 864e5));
    const th = { flag: parseFloat(settingGet('age_flag') || '7'), chase: parseFloat(settingGet('age_chase') || '14'), dead: parseFloat(settingGet('age_dead') || '30') };
    let ageBand = 'fresh';
    if (q.status === 'accepted') ageBand = 'fresh';
    else if (ageDays >= th.dead) ageBand = 'dead';
    else if (ageDays >= th.chase) ageBand = 'chase';
    else if (ageDays >= th.flag) ageBand = 'flag';
    // Lost sits above everything except an actual acceptance — a lost job is lost
    // even if its checklist was never finished.
    let status = q.lost_at ? 'lost' : (laterRev > 0 ? 'superseded' : q.status);
    if (!['accepted', 'superseded', 'lost'].includes(status) && !complete) status = 'incomplete';
    return { id: q.id, token: q.token, parentNumber: q.parent_number, quoteNumber: q.quote_number,
      client: q.client_name, projectTitle: q.project_title,
      status, acceptedPackage: q.accepted_package,
      lostAt: q.lost_at || null, lostReason: q.lost_reason || null,
      value: Math.round(value), complete, uncheckedCritical, ageDays, ageBand, customerTier: q.customer_tier || 'Silver',
      views, updatedAt: q.updated_at };
  });
  // Superseded and lost quotes are kept forever but hidden from the working list,
  // so what you see is the work that's actually live.
  const showLost = req.query.lost === '1';
  const showSuperseded = req.query.superseded === '1';
  const lostCount = mapped.filter(x => x.status === 'lost').length;
  const supersededCount = mapped.filter(x => x.status === 'superseded').length;
  const visible = mapped.filter(x =>
    (x.status !== 'lost' || showLost) && (x.status !== 'superseded' || showSuperseded));
  res.json({ quotes: visible, lostCount, supersededCount, total: mapped.length });
});

// Mark a quote as lost (or bring it back). The quote is never deleted — the value,
// the packages and what the client saw all stay on record.
router.put('/:id/lost', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.lost === false) {
    db.prepare("UPDATE quotes SET lost_at=NULL, lost_reason=NULL, link_off=0, updated_at=datetime('now') WHERE id=?").run(q.id);
    return res.json({ ok: true, lost: false });
  }
  if (q.status === 'accepted') return res.status(400).json({ error: 'That quote has been accepted and signed — it can\'t be marked lost.' });
  db.prepare("UPDATE quotes SET lost_at=datetime('now'), lost_reason=?, link_off=1, updated_at=datetime('now') WHERE id=?")
    .run(String(b.reason || '').slice(0, 200), q.id);
  // Keep the lead in step, if this quote came from one.
  if (q.lead_id) { try { db.prepare("UPDATE leads SET status='Lost', stage='lost', next_followup=NULL, updated_at=datetime('now') WHERE id=?").run(q.lead_id); } catch (e) {} }
  console.log(`[lost] quote ${q.quote_number} marked lost${b.reason ? ' — ' + b.reason : ''}`);
  res.json({ ok: true, lost: true });
});

// NOTE: literal paths MUST be declared before the '/:id' wildcard below, otherwise
// Express matches them as a quote id and returns 404. This bit us on
// /next-custom-code and /pending/price-items.
router.get('/next-custom-code', (req, res) => res.json({ code: nextCustomCode() }));
router.get('/pending/price-items', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const rows = db.prepare(`SELECT qi.*, q.quote_number, q.client_name, q.created_at qdate
    FROM quote_items qi JOIN quotes q ON q.id=qi.quote_id
    WHERE qi.price_item_id IS NULL AND qi.promo_status='pending' ORDER BY q.created_at DESC`).all();
  res.json(rows.map(r => ({
    itemId: r.id, quoteId: r.quote_id, quoteNumber: r.quote_number, client: r.client_name, createdAt: r.qdate,
    code: r.custom_code, name: r.custom_name, unit: r.custom_unit, description: r.custom_desc,
    behaviour: r.custom_behaviour, tiered: !!r.custom_tiered,
    spec: { Basic: r.custom_spec_basic, Standard: r.custom_spec_standard, Premium: r.custom_spec_premium },
    value: { Basic: r.val_basic, Standard: r.val_standard, Premium: r.val_premium },
    cost: { Basic: r.cost_basic, Standard: r.cost_standard, Premium: r.cost_premium },
    marginPct: r.val_standard > 0 ? Math.round((r.val_standard - (r.cost_standard || 0)) / r.val_standard * 1000) / 10 : null,
  })));
});
router.get('/:id', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json(fullQuote(q));
});

// Reusable so Leads can convert an enquiry straight into a quote.
function createQuote(b = {}) {
  // Next number = highest existing, or the configured starting number if none yet.
  // `quote_number_start` is the FIRST number to be issued (not the last used).
  const start = parseInt(settingGet('quote_number_start') || '1410', 10);
  const maxNum = db.prepare("SELECT MAX(CAST(parent_number AS INTEGER)) m FROM quotes").get().m;
  const parent = b.parentNumber || String(maxNum ? maxNum + 1 : start);
  const id = newId();
  // crew_size is set explicitly: a column DEFAULT only applies to tables created fresh,
  // so upgraded databases would otherwise leave it null and break the duration maths.
  const defaultCrew = parseInt(settingGet('default_crew_size') || settingGet('crew_people') || '3', 10) || 3;
  db.prepare(`INSERT INTO quotes (id,token,parent_number,quote_number,project_title,client_name,client_email,address,quote_date,default_package,payment_schedule,site_notes,special_clauses,lead_id,crew_size,customer_tier)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, newToken(), parent, parent, b.projectTitle || 'Landscape Works', b.client || '', b.clientEmail || '',
    b.address || '', b.date || new Date().toISOString().slice(0, 10), b.defaultPackage || 'Standard',
    b.paymentSchedule || 'standard', '', settingGet('default_special_clauses') || '', b.leadId || null,
    b.crewSize || defaultCrew, b.customerTier || settingGet('default_customer_tier') || 'Silver');
  return db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
}
router.post('/', (req, res) => {
  res.status(201).json(fullQuote(createQuote(req.body || {})));
});


// ---- Send the quote to the client -------------------------------------------------
// Prefills an editable message (QuickBooks style); nothing goes out until /send is called.
router.get('/:id/send-preview', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const fill = (t) => String(t || '')
    .replace(/\{\{number\}\}/g, q.quote_number)
    .replace(/\{\{firstname\}\}/g, String(q.client_name || '').trim().split(/\s+/)[0] || 'there')
    .replace(/\{\{client\}\}/g, q.client_name || '')
    .replace(/\{\{address\}\}/g, q.address || '');
  const validDays = parseInt(settingGet('validity_days') || '14', 10);
  const until = new Date(Date.now() + validDays * 864e5).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  res.json({
    to: q.sent_to || q.client_email || '',
    cc: settingGet('company_email') || '',
    subject: q.sent_subject || fill(settingGet('quote_email_subject')),
    message: q.sent_message || fill(settingGet('quote_email_body')),
    link: `${req.protocol}://${req.get('host')}/q/${q.token}`,
    quoteNumber: q.quote_number, validUntil: until,
    alreadySent: !!q.sent_at, sendCount: q.send_count || 0, sentAt: q.sent_at,
  });
});
router.post('/:id/send', async (req, res) => {
  if (!req.user) return res.status(403).json({ error: 'sign in required' });
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const { validateEmail } = require('../utils/email');
  const to = String(b.to || q.client_email || '').trim();
  const badTo = validateEmail(to);
  if (badTo) return res.status(400).json({ error: badTo, field: 'to' });
  const ccRaw = String(b.cc || '').trim();
  if (ccRaw) { const badCc = validateEmail(ccRaw); if (badCc) return res.status(400).json({ error: 'Copy-to address: ' + badCc, field: 'cc' }); }
  if (q.lost_at) return res.status(400).json({ error: 'This quote is marked as lost. Reopen it before sending.' });
  // Two people pressing Send at the same moment would email the client twice.
  if (q.sent_at) {
    const since = Date.now() - new Date(q.sent_at.replace(' ', 'T') + 'Z').getTime();
    if (since < 30000 && !(req.body || {}).force) {
      return res.status(409).json({
        error: `This quote was sent ${Math.round(since / 1000)} seconds ago${q.sent_by ? ' by ' + q.sent_by : ''}.`,
        alreadySent: true, sentTo: q.sent_to, sentBy: q.sent_by,
        hint: 'Check with the team before sending again, or press Send once more to force it.' });
    }
  }
  // A targeted surcharge with unanswered deliverables means the price is wrong.
  // Refuse to send rather than let it go out.
  const fqCheck = fullQuote(q);
  if (fqCheck.surchargesIncomplete) {
    const g = fqCheck.surchargeGaps.map(x => `${x.code} ${x.name} (${x.missing.map(m => m.code).join(', ')})`).join('; ');
    return res.status(400).json({ error: `Finish the surcharge settings before sending — ${g} still has deliverables with no percentage set.`, field: 'surcharges' });
  }
  const link = `${req.protocol}://${req.get('host')}/q/${q.token}`;
  const { quoteEmailHtml } = require('../utils/quoteEmail');
  const { sendMail } = require('../utils/email');
  const html = quoteEmailHtml({ message: b.message || '', link, quoteNumber: q.quote_number, validUntil: b.validUntil });
  const subject = b.subject || `Quote ${q.quote_number} — Estate Landscapers`;
  const results = [];
  try {
    const r = await sendMail({ to, subject, html });
    if (r && r.skipped) throw new Error(r.reason);
    results.push('client: sent to ' + to);
  } catch (e) {
    return res.status(502).json({ error: e.message, hint: e.hint, field: e.kind === 'recipient' ? 'to' : null });
  }
  const cc = ccRaw;
  if (cc && cc.toLowerCase() !== to.toLowerCase()) {
    try { await sendMail({ to: cc, subject: `[Copy] ${subject}`, html }); results.push('office: copied'); }
    catch (e) { results.push('office copy FAILED: ' + e.message); }
  }
  // Keep the client's email address up to date, and remember what we said.
  db.prepare(`UPDATE quotes SET client_email=COALESCE(NULLIF(?,''), client_email),
      sent_at=datetime('now'), sent_to=?, sent_subject=?, sent_message=?, sent_by=?,
      send_count=COALESCE(send_count,0)+1,
      status=CASE WHEN status='draft' THEN 'sent' ELSE status END,
      updated_at=datetime('now') WHERE id=?`)
    .run(to, to, subject, b.message || '', req.user.name || req.user.username, q.id);
  // Sending the quote advances the lead to Phase 4 and diarises the chase.
  try {
    if (q.lead_id) {
      const { nextDueFrom } = require('../utils/leadTemplates');
      db.prepare("UPDATE leads SET stage='quotesent', status='Quoted', next_followup=?, updated_at=datetime('now') WHERE id=?")
        .run(nextDueFrom('quotesent'), q.lead_id);
    }
  } catch (e) { console.error('lead stage sync', e.message); }
  console.log(`[send] quote ${q.quote_number} -> ${to} by ${req.user.username} (${results.join(' | ')})`);
  res.json({ ok: true, results, sendCount: (q.send_count || 0) + 1 });
});

// Configure how a percentage surcharge is targeted.
router.put('/:id/surcharges/:index', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const applied = JSON.parse(q.applied_surcharges || '[]');
  const i = parseInt(req.params.index, 10);
  if (!applied[i]) return res.status(404).json({ error: 'surcharge not applied to this quote' });
  const b = req.body || {};
  if (b.mode !== undefined) applied[i].mode = b.mode === 'targeted' ? 'targeted' : 'whole';
  if (b.basis !== undefined) applied[i].basis = b.basis === 'labour' ? 'labour' : 'full';
  if (b.lines !== undefined) {
    const clean = {};
    Object.entries(b.lines || {}).forEach(([k, v]) => {
      const n = Number(v);
      if (!isNaN(n)) clean[k] = Math.max(0, Math.min(100, n));
    });
    applied[i].lines = clean;
  }
  if (applied[i].mode === 'whole') { delete applied[i].lines; delete applied[i].basis; }
  db.prepare("UPDATE quotes SET applied_surcharges=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(applied), q.id);
  res.json(fullQuote(db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id)));
});

// Switch the client link off (and back on). Used when a client won't answer — they get
// a "please call us" page instead of the price.
router.put('/:id/link', (req, res) => {
  if (!req.user) return res.status(403).json({ error: 'sign in required' });
  const on = (req.body || {}).on !== false;
  db.prepare("UPDATE quotes SET link_off=?, updated_at=datetime('now') WHERE id=?").run(on ? 0 : 1, req.params.id);
  res.json({ ok: true, linkOff: !on });
});

// ---- Renumbering -------------------------------------------------------------
// Quote numbers are cosmetic identifiers, not keys — the client link uses the token,
// so renumbering never breaks a link that has already been sent. Revisions of the same
// job share a parent_number (1413, 1413.1, 1413.2), so renumbering moves the whole family.
function numberInUse(parentNumber, exceptQuoteId) {
  const rows = db.prepare('SELECT id FROM quotes WHERE parent_number=?').all(String(parentNumber));
  return rows.some(r => r.id !== exceptQuoteId);
}
router.put('/:id/number', (req, res) => {
  if (!req.user) return res.status(403).json({ error: 'sign in required' });
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const raw = String((req.body || {}).number || '').trim();
  if (!/^\d+$/.test(raw)) return res.status(400).json({ error: 'Quote number must be digits only, e.g. 1413' });

  const family = db.prepare('SELECT * FROM quotes WHERE parent_number=? ORDER BY created_at').all(q.parent_number);
  const clash = db.prepare('SELECT id FROM quotes WHERE parent_number=?').all(raw).filter(r => !family.find(f => f.id === r.id));
  if (clash.length) return res.status(400).json({ error: `Quote ${raw} already exists — pick another number.` });

  // Move the whole revision family, preserving each one's .1 / .2 suffix.
  family.forEach(f => {
    const suffix = String(f.quote_number).includes('.') ? '.' + String(f.quote_number).split('.').slice(1).join('.') : '';
    db.prepare("UPDATE quotes SET parent_number=?, quote_number=?, updated_at=datetime('now') WHERE id=?")
      .run(raw, raw + suffix, f.id);
  });
  // Keep any purchase orders aligned with their quote.
  family.forEach(f => {
    db.prepare("UPDATE purchase_orders SET po_number=? WHERE quote_id=?").run(raw, f.id);
  });
  console.log(`[renumber] ${q.parent_number} -> ${raw} (${family.length} revision(s)) by ${req.user.username}`);
  res.json({ ok: true, from: q.parent_number, to: raw, moved: family.length });
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

function recalcAllUplifts(quoteId) {
  try {
    const { recalcWasteUplift } = require('../utils/costing');
    db.prepare('SELECT id FROM quote_items WHERE quote_id=?').all(quoteId).forEach(r => recalcWasteUplift(r.id));
  } catch (e) { console.error('uplift recalc all', e.message); }
}
// Two people can have the same quote open. A save carrying a stale updated_at means
// someone else changed it in between — we refuse rather than silently overwrite them.
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT rev_no FROM quotes WHERE id=?').get(req.params.id);
  const seen = (req.body || {}).seenRev;
  if (existing && seen != null && Number(seen) !== (existing.rev_no || 0)) {
    return res.status(409).json({
      error: 'Someone else changed this quote while you had it open.',
      conflict: true, serverRev: existing.rev_no || 0,
      hint: 'Your screen is out of date. Reload to see their changes, then make yours again.' });
  }
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
  if ((req.body || {}).customerTier !== undefined) recalcAllUplifts(req.params.id);
  db.prepare('UPDATE quotes SET rev_no=COALESCE(rev_no,0)+1 WHERE id=?').run(req.params.id);
  res.json(fullQuote(db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  // Release any lead pointing at this quote, or it stays stuck on "already converted"
  // with a link to a quote that no longer exists.
  try { db.prepare("UPDATE leads SET quote_id=NULL, status=CASE WHEN status='Quoted' THEN 'Contacted' ELSE status END WHERE quote_id=?").run(req.params.id); } catch (e) {}
  db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/siteplan', (req, res) => {
  const { data, mime } = req.body || {};
  db.prepare("UPDATE quotes SET siteplan_data=?, siteplan_mime=?, updated_at=datetime('now') WHERE id=?").run(data || null, mime || null, req.params.id);
  res.json({ ok: true });
});

// items
// Next custom code: C1, C2, C3... across the whole system, so codes never repeat.
function nextCustomCode() {
  const fromItems = db.prepare("SELECT custom_code c FROM quote_items WHERE custom_code LIKE 'C%'").all();
  const fromPrice = db.prepare("SELECT code c FROM price_items WHERE code LIKE 'C%'").all();
  const n = [...fromItems, ...fromPrice]
    .map(r => parseInt(String(r.c).replace(/^C/i, ''), 10))
    .filter(x => !isNaN(x));
  return 'C' + ((n.length ? Math.max(...n) : 0) + 1);
}

// ---- Custom line -> Pricing -> Recipe -------------------------------------------
// A custom line already works on its own quote. Promotion only decides whether it
// joins the reusable deliverable list.
router.post('/pending/:itemId/promote', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const it = db.prepare('SELECT * FROM quote_items WHERE id=?').get(req.params.itemId);
  if (!it) return res.status(404).json({ error: 'not found' });
  if (it.promoted_price_item_id) return res.status(400).json({ error: 'already added to Pricing' });
  if (db.prepare('SELECT id FROM price_items WHERE code=?').get(it.custom_code))
    return res.status(400).json({ error: `Code ${it.custom_code} is already in Pricing` });
  const q = db.prepare('SELECT quote_number FROM quotes WHERE id=?').get(it.quote_id);
  const maxSort = db.prepare('SELECT MAX(sort_order) m FROM price_items').get().m || 0;
  const pid = newId();
  const tiered = !!it.custom_tiered;
  const v = t => tiered ? it['val_' + t] : it.val_standard;
  const c = t => tiered ? it['cost_' + t] : it.cost_standard;
  const sp = t => (tiered ? it['custom_spec_' + t] : it.custom_spec_standard) || it.custom_name;
  db.prepare(`INSERT INTO price_items (id,code,name,unit,behaviour,description,
      basic_spec,basic_sell,standard_spec,standard_sell,premium_spec,premium_sell,
      sort_order,status,from_custom,origin_quote,recipe_status,
      entered_cost_basic,entered_cost_standard,entered_cost_premium)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    pid, it.custom_code, it.custom_name, it.custom_unit || 'ea', it.custom_behaviour || 'none', it.custom_desc || '',
    sp('basic'), v('basic') ?? 0, sp('standard'), v('standard') ?? 0, sp('premium'), v('premium') ?? 0,
    maxSort + 1, 'live', 1, q ? q.quote_number : null, 'pending',
    c('basic') ?? null, c('standard') ?? null, c('premium') ?? null);
  db.prepare("UPDATE quote_items SET promoted_price_item_id=?, promo_status='promoted' WHERE id=?").run(pid, it.id);
  res.status(201).json({ priceItemId: pid, code: it.custom_code });
});
router.post('/pending/:itemId/dismiss', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  db.prepare("UPDATE quote_items SET promo_status='declined' WHERE id=?").run(req.params.itemId);
  res.json({ ok: true });
});

router.post('/:id/items', (req, res) => {
  try { db.prepare('UPDATE quotes SET rev_no=COALESCE(rev_no,0)+1 WHERE id=?').run(req.params.id); } catch (e) {}
  const b = req.body || {};
  const id = newId();
  const pi = b.priceItemId ? db.prepare('SELECT * FROM price_items WHERE id=?').get(b.priceItemId) : null;
  const snap = snapshotFromPriceItem(pi); // lock current rates onto this quote line
  db.prepare(`INSERT INTO quote_items (id,quote_id,scope,price_item_id,custom_code,custom_name,custom_unit,custom_rate,qty,tier_override,shared_enabled,shared_pct,
    locked_basic_spec,locked_basic_sell,locked_standard_spec,locked_standard_sell,locked_premium_spec,locked_premium_sell,locked_behaviour)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.params.id, b.scope || 1, b.priceItemId || null,
    (b.priceItemId ? null : (b.customCode || nextCustomCode())), b.customName || null, b.customUnit || null, b.customRate ?? null,
    b.qty ?? 1, b.tierOverride || null, b.sharedEnabled ? 1 : 0, b.sharedPct ?? 50,
    snap.locked_basic_spec ?? null, snap.locked_basic_sell ?? null, snap.locked_standard_spec ?? null,
    snap.locked_standard_sell ?? null, snap.locked_premium_spec ?? null, snap.locked_premium_sell ?? null, snap.locked_behaviour ?? null);
  // A custom line is effectively a new price item being drafted on a job — record the
  // extra spec now so it can be promoted to Pricing later without re-typing.
  if (!b.priceItemId) {
    db.prepare(`UPDATE quote_items SET custom_desc=?, custom_behaviour=?, custom_tiered=?,
      custom_spec_basic=?, custom_spec_standard=?, custom_spec_premium=?,
      val_basic=?, val_standard=?, val_premium=?, cost_basic=?, cost_standard=?, cost_premium=?,
      value_override=?, promo_status=? WHERE id=?`).run(
      b.customDesc || '', b.customBehaviour || 'none', b.customTiered ? 1 : 0,
      (b.customSpec || {}).Basic || null, (b.customSpec || {}).Standard || null, (b.customSpec || {}).Premium || null,
      (b.value || {}).Basic ?? null, (b.value || {}).Standard ?? null, (b.value || {}).Premium ?? null,
      (b.cost || {}).Basic ?? null, (b.cost || {}).Standard ?? null, (b.cost || {}).Premium ?? null,
      1, b.saveToPricing === false ? 'declined' : 'pending', id);
  }
  res.status(201).json({ id, code: db.prepare('SELECT custom_code c FROM quote_items WHERE id=?').get(id).c });
});
router.put('/:id/items/:itemId', (req, res) => {
  try { db.prepare('UPDATE quotes SET rev_no=COALESCE(rev_no,0)+1 WHERE id=?').run(req.params.id); } catch (e) {}
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
  // Anything that moves the extra-wastage cost also moves the price uplift.
  if (['wastageOverride', 'qty', 'method', 'tierOverride'].some(k => b[k] !== undefined)) {
    try { require('../utils/costing').recalcWasteUplift(req.params.itemId); } catch (e) { console.error('uplift recalc', e.message); }
  }
  if (b.description !== undefined) db.prepare('UPDATE quote_items SET desc_override=? WHERE id=?').run(b.description || null, req.params.itemId);
  // Site-specific value: sell AND cost together, so margin stays honest.
  if (b.valueOverride !== undefined)
    db.prepare('UPDATE quote_items SET value_override=? WHERE id=?').run(b.valueOverride ? 1 : 0, req.params.itemId);
  ['Basic', 'Standard', 'Premium'].forEach(t => {
    const k = t.toLowerCase();
    if (b.value && b.value[t] !== undefined)
      db.prepare(`UPDATE quote_items SET val_${k}=? WHERE id=?`).run(b.value[t] === '' ? null : Number(b.value[t]), req.params.itemId);
    if (b.cost && b.cost[t] !== undefined)
      db.prepare(`UPDATE quote_items SET cost_${k}=? WHERE id=?`).run(b.cost[t] === '' ? null : Number(b.cost[t]), req.params.itemId);
    if (b.customSpec && b.customSpec[t] !== undefined)
      db.prepare(`UPDATE quote_items SET custom_spec_${k}=? WHERE id=?`).run(b.customSpec[t], req.params.itemId);
  });
  ['customCode:custom_code', 'customName:custom_name', 'customUnit:custom_unit', 'customDesc:custom_desc',
   'customBehaviour:custom_behaviour'].forEach(pair => {
    const [key, col] = pair.split(':');
    if (b[key] !== undefined) db.prepare(`UPDATE quote_items SET ${col}=? WHERE id=?`).run(b[key], req.params.itemId);
  });
  if (b.customTiered !== undefined)
    db.prepare('UPDATE quote_items SET custom_tiered=? WHERE id=?').run(b.customTiered ? 1 : 0, req.params.itemId);
  res.json({ ok: true });
});
router.delete('/:id/items/:itemId', (req, res) => {
  try { db.prepare('UPDATE quotes SET rev_no=COALESCE(rev_no,0)+1 WHERE id=?').run(req.params.id); } catch (e) {} db.prepare('DELETE FROM quote_items WHERE id=?').run(req.params.itemId); res.status(204).end(); });

router.get('/:id/analytics', (req, res) => {
  const ev = db.prepare('SELECT * FROM quote_events WHERE quote_id=? ORDER BY created_at DESC LIMIT 300').all(req.params.id);
  const secs = ev.filter(e => e.event_type === 'heartbeat').reduce((s, e) => { try { return s + (JSON.parse(e.payload).seconds || 0); } catch { return s; } }, 0);
  const pkg = {}; ev.filter(e => e.event_type === 'package_select').forEach(e => { try { const t = JSON.parse(e.payload).tier; pkg[t] = (pkg[t] || 0) + 1; } catch {} });
  res.json({ views: ev.filter(e => e.event_type === 'view').length, activeSeconds: Math.round(secs), packageClicks: pkg });
});

// Full tier costing for a quote (recipes). Estimators get cost totals + site time but no margin.
// Estimators build and price quotes, but never see what anything costs us.
function stripCosting(c) {
  const o = { ...c };
  ['grossMargin', 'grossMarginPct', 'target', 'belowTarget', 'guidePrice', 'ohDailyRate',
   'ohAllocated', 'ohInRecipes', 'ohRecipeDays', 'netMarginPct', 'wastageSurcharge',
   'wasteUplift', 'takeoff'].forEach(k => delete o[k]);
  o.selected = { sell: c.selected ? c.selected.sell : 0, hrs: c.selected ? c.selected.hrs : 0 };
  o.tierTotals = {};
  Object.entries(c.tierTotals || {}).forEach(([t, v]) => o.tierTotals[t] = { sell: v.sell, hrs: v.hrs });
  o.perLine = (c.perLine || []).map(l => {
    const tiers = {};
    Object.entries(l.tiers || {}).forEach(([t, v]) => tiers[t] = { spec: v.spec, rate: v.rate, sell: v.sell });
    const { variantCost, ...rest } = l;
    return { ...rest, tiers };
  });
  o.restricted = true;
  return o;
}
router.get('/:id/costing', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const c = costQuote(q);
  res.json(req.user && req.user.role === 'admin' ? c : stripCosting(c));
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
module.exports.fullQuote = fullQuote;
module.exports.cachedTotals = cachedTotals;
