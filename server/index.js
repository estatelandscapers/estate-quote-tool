const express = require('express');
const path = require('node:path');

const app = express();
app.use(express.json({ limit: '15mb' })); // large limit so base64 site-plan drawings upload cleanly

// simple request logger (helps a developer see traffic in dev; swap for pino/morgan later)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// auth: sessions required for all admin APIs (public quote links + login + backup stay open)
const { requireAuth } = require('./utils/auth');
app.use(requireAuth);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/materials', require('./routes/materials'));
app.use('/api/selections', require('./routes/selections'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/price-list', require('./routes/priceList'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/checklist', require('./routes/checklist'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/public/quote', require('./routes/publicQuote'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/purchase-orders', require('./routes/purchaseOrders').router);

app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

app.use('/q/static', express.static(path.join(__dirname, '..', 'public', 'quote')));
app.get('/q/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'quote', 'index.html'));
});

app.get('/', (req, res) => res.redirect('/admin'));


// Nightly backup pull (used by the Synology scheduled task). Protect with BACKUP_KEY env var.
const path2 = require('node:path');
app.get('/api/backup', (req, res) => {
  const key = process.env.BACKUP_KEY || 'CHANGE-ME';
  if ((req.query.key || '') !== key) return res.status(403).send('forbidden');
  const dbPath = process.env.DB_PATH || path2.join(process.env.DATA_DIR || path2.join(__dirname,'..','data'),'estate.db');
  res.download(dbPath, 'estate-backup.db');
});

// Simple restore page + upload. Protected by the same key. Lets you re-load a
// downloaded estate-backup.db after moving to a persistent volume, WITHOUT
// re-entering anything. The uploaded file replaces the live DB; the app then
// re-runs migrations on next boot so old data gains any new columns.
const fs2 = require('node:fs');
app.get('/api/restore', (req, res) => {
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
  <body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px;color:#111">
  <h2 style="color:#1E5BFF">Restore data</h2>
  <p>Upload your saved <b>estate-backup.db</b> file to load your data back in. This replaces the current database.</p>
  <form method="post" action="/api/restore?key=${encodeURIComponent(req.query.key||'')}" enctype="multipart/form-data">
    <input type="file" name="f" accept=".db" required style="margin:12px 0">
    <br><button style="background:#1E5BFF;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer">Restore</button>
  </form>
  <p style="color:#888;font-size:13px">After it says success, restart the app in Railway (Deployments → Redeploy) so it loads the restored data.</p></body>`);
});
app.post('/api/restore', express.raw({ type: () => true, limit: '80mb' }), (req, res) => {
  const key = process.env.BACKUP_KEY || 'CHANGE-ME';
  if ((req.query.key || '') !== key) return res.status(403).send('forbidden');
  try {
    const buf = req.body;
    // extract the file bytes out of the multipart body (single-file, minimal parser)
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
    const marker = Buffer.from('\r\n\r\n');
    const start = raw.indexOf(marker);
    let fileData = start >= 0 ? raw.slice(start + marker.length) : raw;
    // strip trailing multipart boundary line
    const tail = fileData.lastIndexOf(Buffer.from('\r\n------'));
    if (tail >= 0) fileData = fileData.slice(0, tail);
    if (fileData.length < 100 || fileData.slice(0, 16).toString().indexOf('SQLite') !== 0) {
      return res.status(400).send('That does not look like a valid estate-backup.db file.');
    }
    const dbPath = process.env.DB_PATH || path2.join(process.env.DATA_DIR || path2.join(__dirname, '..', 'data'), 'estate.db');
    // clear WAL side-files then write the restored DB
    ['', '-wal', '-shm'].forEach(s => { try { fs2.unlinkSync(dbPath + s); } catch {} });
    fs2.writeFileSync(dbPath, fileData);
    res.type('html').send('<body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px"><h2 style="color:#2E7D46">Restored ✓</h2><p>Your data has been loaded. Now go to Railway → Deployments → <b>Redeploy</b> so the app restarts with your data.</p></body>');
  } catch (e) {
    console.error('restore failed', e);
    res.status(500).send('Restore failed: ' + e.message);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Estate Landscapers quote tool running on http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  Public quotes: http://localhost:${PORT}/q/<token>`);
});
