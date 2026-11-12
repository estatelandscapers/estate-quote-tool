// Universal search: one box that looks across the whole tool. Read-only — it only ever
// SELECTs. An estimator gets leads, quotes, projects, purchase orders and inventory; the
// rate card, vendors and costs lists are added for the admin, matching the tabs each can open.
const express = require('express');
const { db } = require('../db');
const router = express.Router();

const like = q => '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
const safe = (fn) => { try { return fn(); } catch (e) { console.error('[search]', e.message); return []; } };

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ q, groups: [] });
  const admin = req.user && req.user.role === 'admin';
  const L = like(q); const N = 6;
  const digits = q.replace(/\D/g, '');
  const PL = digits.length >= 4 ? '%' + digits + '%' : null;   // phone typed with or without spaces
  const groups = [];
  const add = (label, tab, rows) => { if (rows.length) groups.push({ label, tab, rows }); };

  add('Leads', 'leads', safe(() => db.prepare(`SELECT id, name, suburb, address, phone, source, status, enquiry_ref FROM leads
      WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR suburb LIKE ? ESCAPE '\\' OR enquiry_ref LIKE ? ESCAPE '\\'
        OR (? IS NOT NULL AND REPLACE(REPLACE(COALESCE(phone,''),' ',''),'-','') LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`).all(L, L, L, L, L, PL, PL, N)
    .map(r => ({ kind: 'lead', id: r.id, title: r.name || '(no name)', sub: [r.suburb || r.address, r.source, r.status].filter(Boolean).join(' · '), ref: r.enquiry_ref || '' }))));

  const quotes = safe(() => db.prepare(`SELECT id, quote_number, client_name, address, project_title, status FROM quotes
      WHERE quote_number LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\' OR client_email LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR project_title LIKE ? ESCAPE '\\'
      ORDER BY (status='superseded'), created_at DESC LIMIT ?`).all(L, L, L, L, L, N * 2));
  add('Quotes', 'quotes', quotes.slice(0, N).map(r => ({ kind: 'quote', id: r.id, title: `${r.quote_number || 'Quote'} · ${r.client_name || '(no client)'}`, sub: [r.address, r.status].filter(Boolean).join(' · ') })));
  add('Projects', 'jobs', quotes.filter(r => r.status === 'accepted').slice(0, N).map(r => ({ kind: 'job', id: r.id, title: `${r.client_name || ''} · ${r.quote_number || ''}`, sub: r.address || '' })));

  add('Purchase orders', 'po', safe(() => db.prepare(`SELECT id, po_number, revision, client_name, address, status FROM purchase_orders
      WHERE superseded=0 AND (po_number LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(L, L, L, N)
    .map(r => ({ kind: 'po', id: r.id, title: `${r.po_number}${r.revision > 1 ? '-R' + r.revision : ''} · ${r.client_name || ''}`, sub: [r.address, r.status].filter(Boolean).join(' · ') }))));

  add('Inventory', 'inventory', safe(() => db.prepare(`SELECT id, serial, description, status FROM inv_items
      WHERE archived_at IS NULL AND (serial LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') ORDER BY description LIMIT ?`).all(L, L, N)
    .map(r => ({ kind: 'inv', id: r.id, title: r.description, sub: [r.serial, r.status === 'out' ? 'checked out' : 'in store'].filter(Boolean).join(' · ') }))));

  add('Costs', 'materials', safe(() => db.prepare(`SELECT id, name, unit, category FROM materials WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`).all(L, N)
    .map(r => ({ kind: 'material', id: r.id, title: r.name, sub: [r.category, r.unit].filter(Boolean).join(' · ') }))));

  if (admin) {
    add('Pricing', 'pricing', safe(() => db.prepare(`SELECT id, code, name, unit FROM price_items WHERE name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' ORDER BY sort_order LIMIT ?`).all(L, L, N)
      .map(r => ({ kind: 'price', id: r.id, title: r.name, sub: [r.code, r.unit].filter(Boolean).join(' · ') }))));
    add('Vendors', 'vendors', safe(() => db.prepare(`SELECT id, name, contact, phone, area FROM vendors WHERE name LIKE ? ESCAPE '\\' OR contact LIKE ? ESCAPE '\\' OR area LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`).all(L, L, L, N)
      .map(r => ({ kind: 'vendor', id: r.id, title: r.name, sub: [r.contact, r.phone, r.area].filter(Boolean).join(' · ') }))));
  }
  res.json({ q, groups });
});

module.exports = router;
