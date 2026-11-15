// On hold: put a job away until a date, change the date, bring it back. Any office login.
const express = require('express');
const H = require('../utils/holds');
const router = express.Router();
const who = req => (req.user && (req.user.name || req.user.username)) || '';
router.use((req, res, next) => req.user ? next() : res.status(403).json({ error: 'sign in required' }));

router.get('/', (req, res) => res.json({ holds: H.list(), warnDays: H.WARN_DAYS }));
// The dates a check-in would go out for a hold starting today — for the dialog's preview.
router.get('/preview', (req, res) => {
  const t = require('../utils/refs').sydneyParts().ymd, u = String(req.query.until || '');
  res.json({ today: t, checkins: /^\d{4}-\d{2}-\d{2}$/.test(u) && u > t ? H.checkinDates(t, u) : [] });
});
router.post('/', (req, res) => { const b = req.body || {}; const r = H.create({ leadId: b.leadId, quoteId: b.quoteId, until: b.until, reason: b.reason, warn: b.warn !== false, checkin: !!b.checkin, by: who(req) }); res.status(r.error ? 400 : 200).json(r); });
router.put('/:id', (req, res) => { const b = req.body || {}; const r = H.update(req.params.id, { until: b.until, reason: b.reason, warn: b.warn, checkin: b.checkin, by: who(req) }); res.status(r.error ? 400 : 200).json(r); });
router.post('/:id/wake', (req, res) => { const r = H.wake(req.params.id, who(req), 'manual'); res.status(r.error ? 400 : 200).json(r); });
module.exports = router;
