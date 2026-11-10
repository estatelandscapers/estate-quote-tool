// ---------------------------------------------------------------------------
// Works timeline — every contracted job, its variations, and how much of its works
// happen in each month.
//
// A BLOCK is one item in one month and carries two percentages:
//   planned — the share of the item's works planned for that month. Planned shares of an
//             item add up to 100. A planned % you type locks; unlocked months share
//             whatever the locked months and the actuals already done leave.
//   actual  — what was really done that month, entered at month end. Locking an actual
//             marks it confirmed (it cannot be changed until unlocked).
// Done %  = the sum of an item's actuals.
// Revenue for a month = value × (actual if entered, else planned).
// Profit  = revenue × the item's margin. No margin, no profit — nothing is guessed:
//   a job signed in this tool takes its margin from its own costing (quoted_sell /
//   quoted_cost, else the costing engine); a job or variation added by hand has no margin
//   until one is typed, and is flagged.
// Signed and PO jobs (accepted quotes) join the timeline on their own; a later accepted
// revision of the same job takes over the existing row.
// ---------------------------------------------------------------------------

const { db, settingGet, settingGet2, settingSet2 } = require('../db');
const { newId } = require('./ids');

// ---- months ----------------------------------------------------------------------------------
function sydNow() {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, ym: `${p.year}-${p.month}` };
}
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ymRange = (a, b) => { const out = []; for (let x = a; x <= b; x = ymAdd(x, 1)) out.push(x); return out; };
const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const fyOf = ym => { const [y, m] = ym.split('-').map(Number); const s = m >= 7 ? y : y - 1; return { start: `${s}-07`, end: `${s + 1}-06`, label: `FY${String(s + 1).slice(2)}` }; };
const r1 = x => Math.round(x * 10) / 10;

// ---- job figures from the quote ------------------------------------------------------------------
function quoteValue(q) {
  if (q.won_method === 'manual' && q.won_value != null) return q.won_value;
  if (q.quoted_sell != null) return q.quoted_sell;
  try { return require('../routes/quotes').cachedTotals(q).ex; } catch (e) { return null; }
}
function quoteMargin(q) {
  if (q.quoted_sell > 0 && q.quoted_cost > 0) return r1((q.quoted_sell - q.quoted_cost) / q.quoted_sell * 100);
  try {
    const c = require('./costing').costQuote(q, { useSelections: true });
    if (c.selected && c.selected.sell > 0 && c.selected.cost > 0) return r1((c.selected.sell - c.selected.cost) / c.selected.sell * 100);
  } catch (e) {}
  return null;
}

// Every accepted, non-sample quote has a timeline job. A revision accepted later takes over
// the row of its earlier revision (same parent number) so its months are kept.
function syncToolJobs() {
  const won = db.prepare("SELECT * FROM quotes WHERE status='accepted' AND COALESCE(is_sample,0)=0").all();
  const ins = db.prepare(`INSERT INTO timeline_items (id,source,quote_id,quote_number,client,address,sort_order) VALUES (?,?,?,?,?,?,?)`);
  let n = 0;
  won.forEach(q => {
    const family = db.prepare('SELECT id FROM quotes WHERE parent_number=?').all(q.parent_number).map(r => r.id);
    const it = db.prepare(`SELECT * FROM timeline_items WHERE parent_id IS NULL AND quote_id IN (${family.map(() => '?').join(',')}) LIMIT 1`).get(...family);
    if (it) {
      if (it.quote_id !== q.id) db.prepare("UPDATE timeline_items SET quote_id=?, quote_number=?, client=?, address=COALESCE(NULLIF(address,''), ?), updated_at=datetime('now') WHERE id=?").run(q.id, q.quote_number, q.client_name, q.address, it.id);
      return;
    }
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM timeline_items WHERE parent_id IS NULL').get().m;
    ins.run(newId(), 'tool', q.id, q.quote_number, q.client_name, q.address || '', max + 1); n++;
  });
  return n;
}

// ---- blocks ------------------------------------------------------------------------------------
function blocksOf(itemId) {
  return db.prepare('SELECT * FROM timeline_blocks WHERE item_id=? ORDER BY month').all(itemId);
}
// Months with an actual are spent. Of the rest, locked planned months keep their %, and
// unlocked months share what is left of 100, evenly, to one decimal.
function rebalance(itemId) {
  const bl = blocksOf(itemId);
  const spent = bl.filter(b => b.actual_pct != null).reduce((a, b) => a + b.actual_pct, 0);
  const open = bl.filter(b => b.actual_pct == null);
  const locked = open.filter(b => b.planned_lock), free = open.filter(b => !b.planned_lock);
  if (!free.length) return;
  const left = Math.max(0, 100 - spent - locked.reduce((a, b) => a + (b.planned_pct || 0), 0));
  const each = Math.floor(left / free.length * 10) / 10;
  const up = db.prepare("UPDATE timeline_blocks SET planned_pct=?, updated_at=datetime('now') WHERE item_id=? AND month=?");
  free.forEach((b, i) => up.run(i === free.length - 1 ? r1(left - each * (free.length - 1)) : each, itemId, b.month));
}
// One call for everything a block edit can do. Returns { ok } or { error }.
function setBlock(itemId, month, b = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'bad month' };
  const it = db.prepare('SELECT id FROM timeline_items WHERE id=?').get(itemId);
  if (!it) return { error: 'not found' };
  if (b.remove) { db.prepare('DELETE FROM timeline_blocks WHERE item_id=? AND month=?').run(itemId, month); rebalance(itemId); return { ok: true }; }
  let cur = db.prepare('SELECT * FROM timeline_blocks WHERE item_id=? AND month=?').get(itemId, month);
  if (!cur) { db.prepare('INSERT INTO timeline_blocks (item_id, month, planned_pct) VALUES (?,?,0)').run(itemId, month); cur = { planned_pct: 0, planned_lock: 0, actual_pct: null, actual_lock: 0 }; }
  const pct = v => v === '' || v == null ? null : Math.max(0, Math.min(100, r1(Number(v))));
  let pl = cur.planned_pct, pk = cur.planned_lock, ac = cur.actual_pct, ak = cur.actual_lock;
  if (b.plannedLock !== undefined) pk = b.plannedLock ? 1 : 0;
  if (b.planned !== undefined) { pl = pct(b.planned) ?? 0; if (b.plannedLock === undefined) pk = 1; }
  if (b.actualLock !== undefined) ak = b.actualLock ? 1 : 0;
  if (b.actual !== undefined) {
    if (cur.actual_lock && b.actualLock !== false) return { error: 'This month\'s actual is locked — unlock it to change it.' };
    ac = pct(b.actual);
  }
  db.prepare("UPDATE timeline_blocks SET planned_pct=?, planned_lock=?, actual_pct=?, actual_lock=?, updated_at=datetime('now') WHERE item_id=? AND month=?").run(pl, pk, ac, ak, itemId, month);
  rebalance(itemId);
  return { ok: true };
}
// Month-end: record the actuals for one month in one go, locking each.
function confirmMonth(month, entries = []) {
  let n = 0;
  entries.forEach(e => { const r = setBlock(e.itemId, month, { actual: e.actual, actualLock: true }); if (r.ok) n++; });
  return n;
}

// ---- the whole picture ---------------------------------------------------------------------------
function itemView(it, nowYm) {
  const q = it.quote_id ? db.prepare('SELECT * FROM quotes WHERE id=?').get(it.quote_id) : null;
  const qValue = q ? quoteValue(q) : null, qMargin = q ? quoteMargin(q) : null;
  const value = it.value != null ? it.value : qValue;
  const margin = it.margin_pct != null ? it.margin_pct : qMargin;
  const bl = blocksOf(it.id);
  const blocks = {}; bl.forEach(b => blocks[b.month] = { planned: b.planned_pct || 0, plannedLock: !!b.planned_lock, actual: b.actual_pct, actualLock: !!b.actual_lock });
  const done = r1(bl.reduce((a, b) => a + (b.actual_pct || 0), 0));
  const ahead = r1(bl.filter(b => b.actual_pct == null).reduce((a, b) => a + (b.planned_pct || 0), 0));
  const awaiting = bl.filter(b => b.actual_pct == null && b.month < nowYm && (b.planned_pct || 0) > 0).map(b => b.month);
  return { id: it.id, parentId: it.parent_id, source: it.source, quoteId: it.quote_id, quoteNumber: it.quote_number || (q && q.quote_number) || '',
    client: it.client || (q && q.client_name) || '', address: it.address || (q && q.address) || '', label: it.label || '', notes: it.notes || '',
    value: value != null ? Math.round(value) : null, valueSource: it.value != null ? (q ? 'override' : 'entered') : (q ? 'quote' : null), quoteValue: qValue != null ? Math.round(qValue) : null,
    margin, marginSource: it.margin_pct != null ? (q ? 'override' : 'entered') : (qMargin != null ? 'costing' : null), quoteMargin: qMargin,
    quoteStatus: q ? q.status : null, archived: !!it.archived, sort: it.sort_order,
    blocks, done, plan: r1(done + ahead), awaiting, finished: done >= 99.95 };
}
// Revenue an item books in a month: actual if entered, else planned.
const share = (b) => b ? (b.actual != null ? b.actual : b.planned) : 0;

function build({ from, to, includeArchived } = {}) {
  syncToolJobs();
  const now = sydNow();
  const rows = db.prepare(`SELECT * FROM timeline_items ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY sort_order, created_at`).all();
  const views = rows.map(r => itemView(r, now.ym));
  // Jobs first, each followed by its items.
  const jobs = views.filter(v => !v.parentId);
  const kids = id => views.filter(v => v.parentId === id).sort((a, b) => a.sort - b.sort);
  const ordered = []; jobs.forEach(j => { ordered.push(j); kids(j.id).forEach(k => ordered.push(k)); });
  // Month window: what the caller asked for, else from the earliest block (max 18 months back) to 24 ahead.
  const allMonths = views.flatMap(v => Object.keys(v.blocks)).sort();
  const back3 = ymAdd(now.ym, -3), back18 = ymAdd(now.ym, -18);
  const earliest = allMonths[0];
  const start = from || (earliest && earliest < back3 ? (earliest < back18 ? back18 : earliest) : back3);
  const end = to || [ymAdd(now.ym, 24), allMonths[allMonths.length - 1] || now.ym].sort()[1];
  const months = ymRange(start, end);
  const per = {}; months.forEach(m => per[m] = { revenue: 0, profit: 0, noMargin: 0, awaiting: 0 });
  ordered.forEach(v => {
    if (v.value == null) return;
    Object.entries(v.blocks).forEach(([m, b]) => {
      if (!per[m]) return;
      const rev = v.value * share(b) / 100;
      per[m].revenue += rev;
      if (v.margin != null) per[m].profit += rev * v.margin / 100; else if (rev) per[m].noMargin++;
      if (b.actual == null && m < now.ym && b.planned > 0) per[m].awaiting++;
    });
  });
  Object.values(per).forEach(p => { p.revenue = Math.round(p.revenue); p.profit = Math.round(p.profit); });
  return { now: now.ym, months, items: ordered, perMonth: per, tiles: tiles(ordered, now), pending: pending(ordered, now) };
}

// Totals over any month list, from the items directly (not limited to the grid window).
function sumMonths(items, months) {
  const set = new Set(months); let revenue = 0, profit = 0, noMargin = 0;
  items.forEach(v => { if (v.value == null) return; Object.entries(v.blocks).forEach(([m, b]) => { if (!set.has(m)) return; const r = v.value * share(b) / 100; revenue += r; if (v.margin != null) profit += r * v.margin / 100; else if (r) noMargin++; }); });
  return { revenue: Math.round(revenue), profit: Math.round(profit), noMargin };
}
function tiles(items, now) {
  const next12 = ymRange(now.ym, ymAdd(now.ym, 11));
  const n12 = sumMonths(items, next12);
  const remaining = items.reduce((a, v) => a + (v.value != null ? v.value * Math.max(0, 100 - v.done) / 100 : 0), 0);
  const unscheduled = items.filter(v => !v.parentId && !Object.keys(v.blocks).length && !v.finished);
  const behind = items.filter(v => v.awaiting.length);
  const noMargin = items.filter(v => v.margin == null && v.value);
  const offPlan = items.filter(v => Object.keys(v.blocks).length && !v.finished && Math.abs(v.plan - 100) > 0.5);
  let peak = null; next12.forEach(m => { const s = sumMonths(items, [m]).revenue; if (!peak || s > peak.revenue) peak = { month: m, revenue: s }; });
  const fy = fyOf(now.ym); const fyT = sumMonths(items, ymRange(fy.start, fy.end));
  return { next12: n12, remaining: Math.round(remaining), unscheduled: { count: unscheduled.length, value: Math.round(unscheduled.reduce((a, v) => a + (v.value || 0), 0)) },
    behind: behind.length, noMargin: noMargin.length, offPlan: offPlan.length, peak, fy: { label: fy.label, ...fyT, target: parseFloat(settingGet('fy_target') || '0') || 0 } };
}
// Month-end: which months still need actuals. Past months always; the current month from
// its last two days, so the prompt arrives at the end of the month, not the start of the next.
function pending(items, now) {
  const last2 = now.d >= daysIn(now.ym) - 1;
  const due = new Set();
  items.forEach(v => Object.entries(v.blocks).forEach(([m, b]) => {
    if (b.actual != null || v.finished || v.archived) return;
    if (m < now.ym || (last2 && m === now.ym)) due.add(m);
  }));
  const months = [...due].sort();
  return { months, rows: months.flatMap(m => items.filter(v => v.blocks[m] && v.blocks[m].actual == null && !v.finished).map(v => ({ month: m, itemId: v.id, client: v.client, label: v.label, quoteNumber: v.quoteNumber, planned: v.blocks[m].planned, done: v.done }))) };
}

// For the Costing tab: revenue and profit by month, three back to eleven ahead, plus FY.
function cashflow() {
  const b = build({});
  const now = b.now;
  const ms = ymRange(ymAdd(now, -3), ymAdd(now, 11));
  return { now, months: ms.map(m => ({ month: m, ...sumMonths(b.items, [m]) })), tiles: b.tiles, pendingMonths: b.pending.months };
}
function pendingCount() { try { return build({}).pending.rows.length; } catch (e) { return 0; } }

// ---- reminder: push on the last day of the month, 4 pm Sydney --------------------------------------
function start() {
  const tick = async () => {
    try {
      const n = sydNow();
      if (n.d !== daysIn(n.ym) || n.h < 16 || settingGet2('tl_eom_notified') === n.ym) return;
      const p = build({}).pending;
      settingSet2('tl_eom_notified', n.ym);
      if (!p.rows.length) return;
      await require('./push').notify({ title: 'Month end: works actuals', body: `${p.rows.length} job month${p.rows.length === 1 ? '' : 's'} to confirm on the Timeline — what was actually done this month.`, url: '/admin/?tab=timeline', tag: 'tl-eom' });
    } catch (e) { console.error('[timeline] reminder', e.message); }
  };
  setInterval(tick, 30 * 60e3).unref();
}

module.exports = { build, setBlock, confirmMonth, rebalance, syncToolJobs, cashflow, pendingCount, itemView, start, ymAdd, sydNow };
