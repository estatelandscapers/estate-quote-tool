// Marketing tab API (admin). Structure in place; see MARKETING.md for what is finished.
const express = require('express');
const { db, settingGet } = require('../db');
const M = require('../utils/marketing');
const router = express.Router();
// The tool's own origin. tool_url is sometimes saved as a full page link (a sample quote) —
// only scheme + host are wanted here.
const baseOf = req => { const raw = settingGet('tool_url') || `${req.protocol}://${req.get('host')}`; try { return new URL(raw).origin; } catch (e) { return raw.replace(/\/$/, ''); } };

const adminOnly = (req, res, next) => (!req.user || req.user.role !== 'admin') ? res.status(403).json({ error: 'admin only' }) : next();
// Everyone signed in can READ the Marketing tab (summary, tile lists, connection status).
// Connecting, disconnecting, keys and re-attribution stay with the admin.

// Everything the tab shows. ?days=30 (default) | 7 | 90
router.get('/summary', (req, res) => {
  try { res.json(M.summary(Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30)))); }
  catch (e) { console.error('[marketing] summary', e); res.status(500).json({ error: e.message }); }
});
router.get('/figure/:key', (req, res) => {
  const f = M.figure(req.params.key, Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30)));
  if (!f) return res.status(404).json({ error: 'unknown figure' });
  res.json({ ...f, total: ['spend', 'cpl', 'ads'].includes(req.params.key) ? Math.round(f.rows.reduce((a, r) => a + (r.value || 0), 0)) : null });
});
router.get('/connections', (req, res) => {
  const admin = req.user && req.user.role === 'admin';
  res.json({ connections: M.connections(), googleKey: admin ? M.googleKey() : null, toolUrlSet: !!settingGet('tool_url'),
    metaWebhook: baseOf(req) + '/api/public/marketing/meta/webhook', metaVerifySet: !!settingGet('meta_verify_token') });
});

// The Google Ads script, with this tool's key and URL filled in.
router.get('/google/script', adminOnly, (req, res) => {
  res.type('text/plain').send(M.googleScript(baseOf(req)));
});
router.post('/google/reset-key', adminOnly, (req, res) => { M.setConnection('google', { secret: null }); res.json({ googleKey: M.googleKey() }); });

// Meta: step 1 — paste the system-user token, get the ad accounts it can see.
router.post('/meta/accounts', adminOnly, async (req, res) => {
  const token = String((req.body || {}).token || '').trim();
  if (!token) return res.status(400).json({ error: 'Paste the system-user token first.' });
  try { res.json({ accounts: await M.metaAccounts(token) }); }
  catch (e) { res.status(400).json({ error: 'Meta did not accept that token: ' + e.message }); }
});
// Step 2 — pick the account; the tool stores the token and pulls the last 90 days.
router.post('/meta/connect', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.token || !b.accountId) return res.status(400).json({ error: 'token and accountId required' });
  M.setConnection('meta', { secret: String(b.token).trim(), account_id: String(b.accountId), account_name: b.accountName || null, currency: b.currency || 'AUD', status: 'connected', last_error: null });
  const r = await M.pullMeta(90);
  res.json({ ok: r.ok, pull: r, connection: M.connections().find(c => c.platform === 'meta') });
});
router.post('/meta/pull', adminOnly, async (req, res) => res.json(await M.pullMeta(parseInt((req.body || {}).days, 10) || 3)));
router.post('/:platform/disconnect', adminOnly, (req, res) => {
  if (!M.PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'unknown platform' });
  M.setConnection(req.params.platform, { status: 'disconnected', secret: req.params.platform === 'google' ? M.connection('google').secret : null, account_id: null, account_name: null, last_error: null });
  res.json({ ok: true });
});
// Re-run attribution over every lead (after changing the rules, say).
router.post('/attribute', adminOnly, (req, res) => { db.prepare("UPDATE leads SET channel=NULL").run(); res.json({ attributed: M.attributeLeads() }); });

module.exports = router;
