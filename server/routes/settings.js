const express = require('express');
const { settingGet, settingSet } = require('../db');
const { hashPin } = require('../utils/ids');
const { configured } = require('../utils/email');
const router = express.Router();

const KEYS = ['company_name','company_abn','company_lic','company_address','company_email','company_phone',
  'association_line','tagline','pkg_desc_basic','pkg_desc_standard','pkg_desc_premium',
  'pay_sched_standard','pay_sched_small','warranty_text','protections_text','default_special_clauses','standard_conditions',
  // tiers, ageing, labour — these were missing, which is why the Editor fields showed blank and "didn't save"
  'tier_bronze','tier_silver','tier_gold','age_flag','age_chase','age_dead',
  'crew_day_rate','crew_people','extra_person_rate','hours_per_day','work_days_per_month','quote_number_start','default_crew_size','default_customer_tier','email_signature','quote_email_subject','quote_email_body','projects_delivered','rating_stars','rating_source','rating_count','link_off_message','access_min','access_difficult_to','access_narrow_to','step_rise_mm','slope_steep_mm','rw_max_height_mm','imap_host','imap_user','imap_folder','imap_port','imap_poll_minutes',
  // client-link signal rules (were missing here, so the Settings page could not save them)
  'sig_hot_opens','sig_hot_window_h','sig_hot_active_min','sig_hot_toggles','sig_warm_days','sig_warm_active_sec','sig_warm_opens','sig_hot_fade_days','sig_warm_fade_days','events_rollup_days',
  // online estimator
  'close_small_under','close_large_over',
  // forecast card
  'fy_target','fc_stale_days','fc_stale_rate',
  'est_enabled','est_invite_delay_min','est_warm_email_opens','pixel_url','est_url','tool_url','est_code_days','est_lockout_tries','est_lockout_min','est_slots_per_half','est_hot_sessions','est_hot_window_h','est_hot_toggles','est_warm_active_sec','est_warm_answer_pct','est_hot_fade_days','est_warm_fade_days','est_intro_subject'];

// Company details are needed by the client-facing pages, but margin targets and
// labour rates are not for general viewing.
const SENSITIVE = ['tier_bronze','tier_silver','tier_gold','crew_day_rate','crew_people',
  'extra_person_rate','hours_per_day','work_days_per_month','quote_number_start',
  'default_crew_size','default_customer_tier','age_flag','age_chase','age_dead']; // SENSITIVE KEYS
router.get('/', (req, res) => {
  const out = {}; KEYS.forEach(k => out[k] = settingGet(k));
  out.smtpConfigured = configured();
  try { out.emailProvider = require('../utils/email').provider(); } catch { out.emailProvider = null; }
  if (!req.user || req.user.role !== 'admin') SENSITIVE.forEach(k => delete out[k]);
  res.json(out);
});
router.put('/', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  KEYS.forEach(k => { if (req.body[k] !== undefined) settingSet(k, req.body[k]); });
  res.json({ ok: true });
});
// Why the sample-quote link in estimator emails would be missing, for the Settings page.
router.get('/estimator-status', (req, res) => {
  try { res.json(require('../utils/estimator').sampleStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
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
