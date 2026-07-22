const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const { sha, getUser, adminOnly } = require('../utils/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get((username || '').trim().toLowerCase());
  if (!u || u.pass_hash !== sha(password || '')) return res.status(401).json({ error: 'Wrong username or password' });
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (token,user_id,remember) VALUES (?,?,?)').run(token, u.id, remember ? 1 : 0);
  const maxAge = remember ? 30 * 864e5 : 12 * 36e5;
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
  res.json({ ok: true, user: { name: u.name, username: u.username, role: u.role } });
});
router.post('/logout', (req, res) => {
  const u = getUser(req);
  if (u) db.prepare('DELETE FROM sessions WHERE token=?').run(u.token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});
router.get('/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'not signed in' });
  res.json({ name: u.name, username: u.username, role: u.role });
});
// user management (admin)
router.get('/users', (req, res) => {
  const u = getUser(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(db.prepare('SELECT id,name,username,role,created_at FROM users ORDER BY role,name').all());
});
router.post('/users', (req, res) => {
  const u = getUser(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const { name, username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO users (id,name,username,pass_hash,role) VALUES (?,?,?,?,?)')
      .run(id, name || username, username.trim().toLowerCase(), sha(password), role === 'admin' ? 'admin' : 'estimator');
  } catch { return res.status(400).json({ error: 'username already exists' }); }
  res.status(201).json({ id });
});
router.put('/users/:id', (req, res) => {
  const u = getUser(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { name, password, role } = req.body || {};
  db.prepare('UPDATE users SET name=?, pass_hash=?, role=? WHERE id=?')
    .run(name ?? t.name, password ? sha(password) : t.pass_hash, role ?? t.role, t.id);
  res.json({ ok: true });
});
router.delete('/users/:id', (req, res) => {
  const u = getUser(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (t && t.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1)
    return res.status(400).json({ error: 'cannot delete the last admin' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.status(204).end();
});
module.exports = router;
