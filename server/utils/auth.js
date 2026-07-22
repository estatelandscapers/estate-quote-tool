const crypto = require('node:crypto');
const { db } = require('../db');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function getUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const s = db.prepare('SELECT s.token, s.remember, s.created_at, u.id, u.name, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(m[1]);
  if (!s) return null;
  // expiry: remembered = 30 days, otherwise 12 hours
  const ageMs = Date.now() - new Date(s.created_at + 'Z').getTime();
  const maxMs = s.remember ? 30 * 864e5 : 12 * 36e5;
  if (ageMs > maxMs) { db.prepare('DELETE FROM sessions WHERE token=?').run(s.token); return null; }
  return { id: s.id, name: s.name, username: s.username, role: s.role, token: s.token };
}

// Require a signed-in user for all /api routes except public/auth/backup/restore.
function requireAuth(req, res, next) {
  const p = req.path;
  if (p.startsWith('/api/public/') || p.startsWith('/api/auth/') || p.startsWith('/api/backup') || p.startsWith('/api/restore')) return next();
  if (!p.startsWith('/api/')) return next();
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'auth required' });
  req.user = u; next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}
module.exports = { sha, getUser, requireAuth, adminOnly };
