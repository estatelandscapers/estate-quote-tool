// Key-guarded endpoints other systems call: the Google Ads script (daily push) and,
// later, Meta lead-form webhooks. No login cookie here — the key is the credential.
const express = require('express');
const M = require('../utils/marketing');
const router = express.Router();

// Google Ads script → yesterday's campaign stats. Header X-Marketing-Key: <key>.
router.post('/google', express.json({ limit: '2mb' }), (req, res) => {
  if (!M.checkGoogleKey(req.get('x-marketing-key') || (req.body || {}).key)) return res.status(401).json({ error: 'bad key' });
  try { res.json({ ok: true, ...M.ingestGoogle(req.body || {}) }); }
  catch (e) { console.error('[marketing] google ingest', e); res.status(500).json({ error: e.message }); }
});
// Google lead form asset → webhook. Google sends the key in the body as google_key.
router.post('/google/lead', (req, res) => {
  const b = req.body || {};
  if (!M.checkGoogleKey(b.google_key || req.get('x-marketing-key'))) return res.status(401).json({ error: 'bad key' });
  try { const r = M.handleGoogleLead(b); console.log('[marketing] google lead', b.lead_id, r); res.json({}); }
  catch (e) { console.error('[marketing] google lead', e); res.status(500).json({ error: e.message }); }
});
// Connectivity check for the script's Preview run.
router.get('/google/ping', (req, res) => res.json({ ok: M.checkGoogleKey(req.get('x-marketing-key') || req.query.key) }));

// Meta lead ads webhook. GET = subscription handshake; POST = a new form submission.
router.get('/meta/webhook', (req, res) => {
  const { settingGet } = require('../db');
  const want = settingGet('meta_verify_token');
  if (want && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === want) return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  res.status(403).send('verify token mismatch');
});
router.post('/meta/webhook', async (req, res) => {
  if (!M.verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'bad signature' });
  // Answer Meta at once; it retries anything slower than a few seconds.
  res.json({ ok: true });
  const jobs = [];
  ((req.body || {}).entry || []).forEach(e => (e.changes || []).forEach(c => {
    if (c.field === 'leadgen' && c.value && c.value.leadgen_id) jobs.push([c.value.leadgen_id, c.value.page_id]);
  }));
  for (const [id, page] of jobs) {
    try { const r = await M.handleMetaLead(id, page); console.log('[marketing] meta lead', id, r); }
    catch (e) { console.error('[marketing] meta lead', id, e.message); }
  }
});

module.exports = router;
