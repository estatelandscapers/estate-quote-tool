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
// Connectivity check for the script's Preview run.
router.get('/google/ping', (req, res) => res.json({ ok: M.checkGoogleKey(req.get('x-marketing-key') || req.query.key) }));

// TODO (Opus): Meta lead-form webhook — GET verify (hub.challenge) + POST leadgen → create enquiry.
router.get('/meta/webhook', (req, res) => res.status(501).send('not yet'));
router.post('/meta/webhook', (req, res) => res.status(501).json({ error: 'not yet' }));

module.exports = router;
