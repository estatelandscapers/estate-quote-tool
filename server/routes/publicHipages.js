// The hipages bot pushes each accepted job's photos here. Key-guarded (header
// X-Hipages-Key = HIPAGES_FILES_KEY); the bytes go straight on to OneDrive.
const express = require('express');
const F = require('../utils/leadFiles');
const router = express.Router();

router.get('/ping', (req, res) => res.json({ ok: F.keyOk(req.get('x-hipages-key')), onedrive: require('../utils/onedrive').configured() }));
router.put('/photo', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  if (!F.keyOk(req.get('x-hipages-key'))) return res.status(401).json({ error: 'bad key' });
  const q = req.query, s = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const jobId = s(q.job, 20), index = parseInt(q.i, 10);
  if (!/^\d{4,15}$/.test(jobId) || !(index >= 1 && index <= 40)) return res.status(400).json({ error: 'job and i are required' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 200) return res.status(400).json({ error: 'empty file' });
  try {
    res.json(await F.ingestHip({ jobId, index, suburb: s(q.suburb, 60), postcode: s(q.postcode, 4).replace(/\D/g, ''),
      category: s(q.category, 80), description: s(q.description, 600), mime: s(req.get('content-type'), 40), buf: req.body }));
  } catch (e) { console.error('[files] hipages photo', jobId, e.message); res.status(502).json({ error: e.message }); }
});
module.exports = router;
