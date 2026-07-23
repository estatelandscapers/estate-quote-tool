const express = require('express');
const { settingGet, settingSet } = require('../db');
const { hashPin } = require('../utils/ids');
const { configured } = require('../utils/email');
const router = express.Router();

const KEYS = ['company_name','company_abn','company_lic','company_address','company_email','company_phone',
  'association_line','tagline','pkg_desc_basic','pkg_desc_standard','pkg_desc_premium',
  'pay_sched_standard','pay_sched_small','warranty_text','protections_text','default_special_clauses','standard_conditions'];

router.get('/', (req, res) => {
  const out = {}; KEYS.forEach(k => out[k] = settingGet(k));
  out.smtpConfigured = configured();
  try { out.emailProvider = require('../utils/email').provider(); } catch { out.emailProvider = null; }
  res.json(out);
});
router.put('/', (req, res) => {
  KEYS.forEach(k => { if (req.body[k] !== undefined) settingSet(k, req.body[k]); });
  res.json({ ok: true });
});
router.post('/management/check', (req, res) => {
  res.json({ ok: hashPin(req.body.pin) === settingGet('management_pin_hash') });
});
router.put('/management/pin', (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (hashPin(currentPin) !== settingGet('management_pin_hash')) return res.status(403).json({ error: 'Current PIN incorrect' });
  if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'PIN too short' });
  settingSet('management_pin_hash', hashPin(newPin));
  res.json({ ok: true });
});

// "Send test email" — proves SMTP end to end and returns the exact failure reason.
router.post('/test-email', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const { sendMail, verifyConnection } = require('../utils/email');
  const to = (req.body && req.body.to) || settingGet('company_email');
  const v = await verifyConnection();
  if (!v.ok) return res.json({ ok: false, stage: 'connection', error: v.error, hint: v.hint });
  try {
    await sendMail({ to, subject: 'Estate Landscapers — test email',
      html: '<p>This is a test from your quote tool. If you can read this, signed contracts will send correctly.</p>' });
    res.json({ ok: true, to, provider: v.provider });
  } catch (e) {
    res.json({ ok: false, stage: 'send', error: e.message,
      hint: e.hint || 'The provider rejected the message. Usually the sending domain is not verified with that provider yet, or the API key lacks send permission.' });
  }
});

module.exports = router;
