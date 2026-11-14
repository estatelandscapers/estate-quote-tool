// SMS settings, test and status. Sending itself lives in utils/sms.js.
const express = require('express');
const sms = require('../utils/sms');
const router = express.Router();
const admin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' });

// Light status for the lead screen: can a text be sent from the tool right now?
router.get('/status', (req, res) => res.json({ configured: sms.configured(), mode: sms.mode() }));
router.get('/', admin, (req, res) => res.json(sms.state()));
router.put('/', admin, (req, res) => { sms.save(req.body || {}); res.json(sms.state()); });
router.get('/check', admin, async (req, res) => res.json(await sms.check()));
// Message length as the wording is typed.
router.post('/measure', admin, (req, res) => res.json(sms.measureShaped(String((req.body || {}).text || ''))));
// One real text to a number you choose. Works in any mode: it is how you prove the link.
router.post('/test', admin, async (req, res) => {
  const to = sms.mobile((req.body || {}).to);
  if (!to) return res.json({ ok: false, error: 'Enter an Australian mobile number, e.g. 0412 345 678.' });
  const r = await sms.send({ type: 'test', to, by: req.user.name || req.user.username,
    body: sms.shape('there', 'This is a test from your quote tool. If you can read this, text messages are working.') });
  res.json(r);
});
module.exports = router;
