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

app.use('/api/price-list', require('./routes/priceList'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/checklist', require('./routes/checklist'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/public/quote', require('./routes/publicQuote'));

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
