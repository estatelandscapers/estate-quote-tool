// ---------------------------------------------------------------------------
// Client-link behaviour: what a client did with their quote link, and what it means.
//
// Raw material is quote_events (client views only — internal views are filtered out).
// A heartbeat every 15 s carries the seconds just spent on each section and each
// deliverable line, so dwell is real "page in front of them" time. Events are grouped
// into SESSIONS by device (visitor_key) with a 30-minute gap, and after
// events_rollup_days the raw rows are folded into one quote_sessions row each, so the
// table stays small while the record is kept forever.
//
// The SIGNAL (hot / warm / cold / unopened) is a rule set with every number in Settings,
// so it can be tuned from real data without a deploy.
// ---------------------------------------------------------------------------

const { db, settingGet2 } = require('../db');
const { newId } = require('./ids');

const GAP_MS = 30 * 60 * 1000;
const n = (k, d) => { const v = parseFloat(settingGet2(k)); return isNaN(v) ? d : v; };

// ---- device + place ---------------------------------------------------------
function deviceLabel(info) {
  const ua = String((info && info.ua) || '');
  let os = 'Unknown';
  if (/iPhone/.test(ua)) os = 'iPhone'; else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && info && info.touch)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android'; else if (/Windows/.test(ua)) os = 'Windows'; else if (/Macintosh|Mac OS/.test(ua)) os = 'Mac'; else if (/Linux/.test(ua)) os = 'Linux';
  let br = 'browser';
  if (/Edg\//.test(ua)) br = 'Edge'; else if (/OPR\//.test(ua)) br = 'Opera'; else if (/SamsungBrowser/.test(ua)) br = 'Samsung';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) br = 'Chrome'; else if (/Firefox\//.test(ua)) br = 'Firefox'; else if (/Safari\//.test(ua)) br = 'Safari';
  return `${os} · ${br}`;
}

const geoInFlight = new Set();
// City from the IP, once per device, cached for good. The raw IP is not stored anywhere.
// Private/loopback addresses (local testing) are skipped. Two free lookup services are
// tried; a miss leaves the city blank rather than failing anything.
async function lookupGeo(ip) {
  if (!ip || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc|fd|fe80)/.test(ip)) return null;
  const tries = [
    { url: `https://ipwho.is/${encodeURIComponent(ip)}`, pick: j => j && j.success !== false && { city: j.city, region: j.region, country: j.country } },
    { url: `https://ipapi.co/${encodeURIComponent(ip)}/json/`, pick: j => j && !j.error && { city: j.city, region: j.region, country: j.country_name } },
  ];
  for (const t of tries) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(t.url, { signal: ctl.signal, headers: { 'User-Agent': 'estate-quote-tool' } }); clearTimeout(tm);
      if (!r.ok) continue;
      const g = t.pick(await r.json());
      if (g && (g.city || g.country)) return g;
    } catch (e) {}
  }
  return null;
}
function noteVisitor(vkey, info, ip) {
  const have = db.prepare('SELECT city, device FROM visitor_geo WHERE visitor_key=?').get(vkey);
  const device = deviceLabel(info);
  if (!have) db.prepare('INSERT OR IGNORE INTO visitor_geo (visitor_key, device, looked_up_at) VALUES (?,?,NULL)').run(vkey, device);
  else if (!have.device) db.prepare('UPDATE visitor_geo SET device=? WHERE visitor_key=?').run(device, vkey);
  if ((have && have.city) || geoInFlight.has(vkey)) return;
  geoInFlight.add(vkey);
  lookupGeo(ip).then(g => {
    if (g) db.prepare("UPDATE visitor_geo SET city=?, region=?, country=?, looked_up_at=datetime('now') WHERE visitor_key=?").run(g.city || '', g.region || '', g.country || '', vkey);
    else db.prepare("UPDATE visitor_geo SET looked_up_at=datetime('now') WHERE visitor_key=? AND looked_up_at IS NULL").run(vkey);
  }).catch(() => {}).finally(() => geoInFlight.delete(vkey));
}
function visitorMeta(vkey) {
  const g = db.prepare('SELECT * FROM visitor_geo WHERE visitor_key=?').get(vkey) || {};
  const place = [g.city, g.region && g.region !== g.city ? g.region : null].filter(Boolean).join(', ') || (g.country || '');
  return { device: g.device || 'Unknown device', city: place };
}

// ---- sessions ---------------------------------------------------------------
const P = s => { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } };
const ms = t => new Date(String(t).replace(' ', 'T') + 'Z').getTime();

// Live sessions from raw events, newest first.
function sessionsFromEvents(quoteId) {
  const ev = db.prepare("SELECT * FROM quote_events WHERE quote_id=? AND COALESCE(viewer,'client')='client' AND event_type IN ('view','heartbeat','package_select','accept_open','sign_step','copy_attempt','print_attempt','print_click') ORDER BY created_at ASC, rowid ASC").all(quoteId);
  const byVisitor = {};
  ev.forEach(e => { (byVisitor[e.visitor_key || 'legacy'] = byVisitor[e.visitor_key || 'legacy'] || []).push(e); });
  const out = [];
  Object.entries(byVisitor).forEach(([vk, list]) => {
    let cur = null;
    list.forEach(e => {
      const t = ms(e.created_at);
      if (!cur || t - cur._last > GAP_MS) { cur = blank(quoteId, vk, e.created_at); out.push(cur); }
      absorb(cur, e); cur._last = t; cur.ended_at = e.created_at;
    });
  });
  out.forEach(s => { delete s._last; finish(s); });
  return out.sort((a, b) => ms(b.started_at) - ms(a.started_at));
}
function blank(quoteId, vk, at) {
  return { id: null, quote_id: quoteId, visitor_key: vk, started_at: at, ended_at: at, active_seconds: 0, sections: {}, lines: {},
    package_clicks: {}, max_scroll: 0, reached_accept: 0, sign_step: 0, copy_attempts: 0, print_attempts: 0, events: 0, opens: 0, signed: 0, _last: 0 };
}
function absorb(s, e) {
  const p = P(e.payload); s.events++;
  switch (e.event_type) {
    case 'view': s.opens++; break;
    case 'heartbeat':
      s.active_seconds += Number(p.seconds) || 0;
      Object.entries(p.sections || {}).forEach(([k, v]) => s.sections[k] = (s.sections[k] || 0) + (Number(v) || 0));
      Object.entries(p.lines || {}).forEach(([k, v]) => s.lines[k] = (s.lines[k] || 0) + (Number(v) || 0));
      if ((p.maxScroll || 0) > s.max_scroll) s.max_scroll = Math.min(100, Number(p.maxScroll) || 0);
      break;
    case 'package_select': if (p.accepted) s.signed = 1; else if (p.tier) s.package_clicks[p.tier] = (s.package_clicks[p.tier] || 0) + 1; break;
    case 'accept_open': s.reached_accept = 1; break;
    case 'sign_step': s.reached_accept = 1; s.sign_step = Math.max(s.sign_step, Number(p.step) || 0); if (s.sign_step >= 3) s.signed = 1; break;
    case 'copy_attempt': s.copy_attempts++; break;
    case 'print_attempt': case 'print_click': s.print_attempts++; break;
  }
}
// Old heartbeats (pre-v21) carried no dwell: credit a session with time but no sections.
function finish(s) {
  if (!s.opens) s.opens = 1;
  const m = visitorMeta(s.visitor_key); s.device = m.device; s.city = m.city;
}
function rolledSessions(quoteId) {
  return db.prepare('SELECT * FROM quote_sessions WHERE quote_id=? ORDER BY started_at DESC').all(quoteId).map(r => ({
    ...r, sections: P(r.sections), lines: P(r.lines), package_clicks: P(r.package_clicks), opens: 1, signed: r.sign_step >= 3 ? 1 : 0,
    device: r.device || visitorMeta(r.visitor_key).device, city: r.city || visitorMeta(r.visitor_key).city }));
}
function allSessions(quoteId) {
  return [...sessionsFromEvents(quoteId), ...rolledSessions(quoteId)].sort((a, b) => ms(b.started_at) - ms(a.started_at));
}

// ---- the signal ---------------------------------------------------------------
// Rules (all tunable in Settings):
//   hot    3+ opens in 48 h, OR reached Accept / contract review, OR 5+ min active with 2+
//          package comparisons in the last 7 days
//   warm   opened in the last 7 days with 60+ s active, OR 2+ opens in 7 days
//   cold   last open more than 7 days ago, or a single short look
//   hot fades to warm after 3 days without a new open; warm to cold after 7.
function signalFor(sessions, sentAt) {
  if (!sessions.length) return { signal: sentAt ? 'unopened' : 'unsent', why: sentAt ? 'Sent, not opened yet' : 'Not sent yet' };
  const now = Date.now();
  const hotWin = n('sig_hot_window_h', 48) * 3600e3, warmWin = n('sig_warm_days', 7) * 864e5;
  const recent = sessions.filter(s => now - ms(s.started_at) <= warmWin);
  const inHotWin = sessions.filter(s => now - ms(s.started_at) <= hotWin);
  const last = sessions[0]; const sinceLast = now - ms(last.started_at);
  const activeRecent = recent.reduce((a, s) => a + s.active_seconds, 0);
  const togglesRecent = recent.reduce((a, s) => a + Object.values(s.package_clicks).reduce((x, y) => x + y, 0), 0);
  const reached = recent.some(s => s.reached_accept);
  let hot = false, why = '';
  if (inHotWin.length >= n('sig_hot_opens', 3)) { hot = true; why = `${inHotWin.length} opens in ${n('sig_hot_window_h', 48)} h`; }
  else if (reached) { hot = true; why = 'reached the Accept step'; }
  else if (activeRecent >= n('sig_hot_active_min', 5) * 60 && togglesRecent >= n('sig_hot_toggles', 2)) { hot = true; why = `${Math.round(activeRecent / 60)} min reading, compared packages ${togglesRecent}×`; }
  if (hot && sinceLast > n('sig_hot_fade_days', 3) * 864e5) { hot = false; why = `was hot, no open for ${Math.floor(sinceLast / 864e5)} d`; }
  if (hot) return { signal: 'hot', why };
  let warm = false;
  if (recent.length && activeRecent >= n('sig_warm_active_sec', 60)) { warm = true; why = why || `opened ${recent.length}× this week, ${Math.round(activeRecent / 60)} min reading`; }
  else if (recent.length >= n('sig_warm_opens', 2)) { warm = true; why = why || `${recent.length} opens this week`; }
  if (warm && sinceLast > n('sig_warm_fade_days', 7) * 864e5) warm = false;
  if (warm) return { signal: 'warm', why };
  return { signal: 'cold', why: sinceLast > warmWin ? `last opened ${Math.floor(sinceLast / 864e5)} d ago` : 'one short look' };
}

// ---- words for a session --------------------------------------------------------
const SECTION_NAMES = { hero: 'Hero & packages', siteplan: 'Site plan', howto: 'How to read', packages: 'Package switcher', scope1: 'Scope 1 deliverables',
  scope2: 'Scope 2 disposal', notes: 'Site notes', estate_standard: 'Estate Standard', totals: 'Totals & payment', payment: 'Payment schedule', accept: 'Accept button' };
function describe(s) {
  const bits = [];
  const secs = Object.entries(s.sections).sort((a, b) => b[1] - a[1]);
  const reachedSecs = secs.filter(([k]) => k !== 'hero').map(([k]) => SECTION_NAMES[k] || k);
  if (reachedSecs.length) bits.push(reachedSecs.slice(0, 3).join(' → ')); else if (s.active_seconds < 20) bits.push('opened, left at the top');
  const tog = Object.entries(s.package_clicks).reduce((a, [, v]) => a + v, 0);
  if (tog) bits.push(`compared packages ${tog}×`);
  const lines = Object.entries(s.lines).sort((a, b) => b[1] - a[1]);
  if (lines.length && lines[0][1] >= 20) bits.push(`longest on ${lines[0][0]} (${fmt(lines[0][1])})`);
  if (s.signed) bits.push('SIGNED'); else if (s.sign_step >= 2) bits.push('reached the signature step, did not sign'); else if (s.reached_accept) bits.push('opened the contract review');
  if (s.print_attempts) bits.push(`tried to print ${s.print_attempts}×`);
  if (s.copy_attempts) bits.push(`tried to copy text ${s.copy_attempts}×`);
  return bits.join(' · ') || 'opened';
}
const fmt = sec => { sec = Math.round(sec || 0); return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`; };

// ---- the behaviour record for one quote ----------------------------------------------
function record(q) {
  const sessions = allSessions(q.id);
  const sig = signalFor(sessions, q.sent_at);
  const agg = { sections: {}, lines: {}, packages: {}, active: 0, copy: 0, print: 0 };
  sessions.forEach(s => {
    agg.active += s.active_seconds; agg.copy += s.copy_attempts; agg.print += s.print_attempts;
    Object.entries(s.sections).forEach(([k, v]) => agg.sections[k] = (agg.sections[k] || 0) + v);
    Object.entries(s.lines).forEach(([k, v]) => agg.lines[k] = (agg.lines[k] || 0) + v);
    Object.entries(s.package_clicks).forEach(([k, v]) => agg.packages[k] = (agg.packages[k] || 0) + v);
  });
  const devices = new Set(sessions.map(s => s.visitor_key)).size;
  const reachedAccept = sessions.some(s => s.reached_accept), signStep = Math.max(0, ...sessions.map(s => s.sign_step));
  const lineNames = {};
  db.prepare(`SELECT COALESCE(qi.custom_code, pi.code) code, COALESCE(qi.custom_name, pi.name) name FROM quote_items qi LEFT JOIN price_items pi ON pi.id=qi.price_item_id WHERE qi.quote_id=?`).all(q.id)
    .forEach(r => { if (r.code) lineNames[r.code] = r.name; });
  return {
    quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, address: q.address, sentAt: q.sent_at, sentBy: q.sent_by, status: q.status,
    opens: sessions.length, devices, activeSeconds: agg.active, activeLabel: fmt(agg.active),
    firstOpened: sessions.length ? sessions[sessions.length - 1].started_at : null, lastOpened: sessions.length ? sessions[0].started_at : null,
    signal: sig.signal, signalWhy: sig.why,
    sections: Object.entries(agg.sections).map(([k, v]) => ({ key: k, name: SECTION_NAMES[k] || k, seconds: v })).sort((a, b) => b.seconds - a.seconds),
    lines: Object.entries(agg.lines).map(([k, v]) => ({ code: k, name: lineNames[k] || '', seconds: v })).sort((a, b) => b.seconds - a.seconds).slice(0, 8),
    packages: agg.packages, reachedAccept, signStep, copyAttempts: agg.copy, printAttempts: agg.print,
    sessions: sessions.map(s => ({ startedAt: s.started_at, endedAt: s.ended_at, device: s.device, city: s.city, activeSeconds: s.active_seconds, activeLabel: fmt(s.active_seconds),
      maxScroll: s.max_scroll, summary: describe(s), reachedAccept: !!s.reached_accept, signStep: s.sign_step, packages: s.package_clicks,
      topLines: Object.entries(s.lines).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => ({ code: c, seconds: v })) })),
    read: suggestion(q, sessions, agg, sig, lineNames),
  };
}
// One plain-English read of the pattern, with a chase suggestion. Rule-based, labelled as such.
function suggestion(q, sessions, agg, sig, lineNames) {
  if (!sessions.length) return q.sent_at ? 'Not opened yet. If it has been more than two days, a short call to check the email arrived is the usual fix.' : 'Not sent yet.';
  const days = Math.max(1, Math.ceil((ms(sessions[0].started_at) - ms(sessions[sessions.length - 1].started_at)) / 864e5));
  const tog = Object.values(agg.packages).reduce((a, b) => a + b, 0);
  const topLine = Object.entries(agg.lines).sort((a, b) => b[1] - a[1])[0];
  const devices = new Set(sessions.map(s => s.visitor_key)).size;
  const parts = [`${sessions.length} open${sessions.length > 1 ? 's' : ''} over ${days} day${days > 1 ? 's' : ''} on ${devices} device${devices > 1 ? 's' : ''}, ${fmt(agg.active)} reading in total.`];
  if (sessions.some(s => s.signed)) parts.push('They signed.');
  else if (sessions.some(s => s.sign_step >= 2)) parts.push('They got as far as the signature step and stopped — usually a question about the terms or who signs, not the price. Suggested chase: call and ask what held them at the signature.');
  else if (sessions.some(s => s.reached_accept)) parts.push('They opened the contract review but did not continue. Suggested chase: offer to walk them through the contract on a call.');
  else if (tog >= 3) parts.push(`They compared packages ${tog} times${topLine ? ` and spent longest on ${topLine[0]}${lineNames[topLine[0]] ? ' (' + lineNames[topLine[0]] + ')' : ''}` : ''} — deciding between finishes rather than whether to proceed. Suggested chase: talk through the package options${topLine ? ' for ' + topLine[0] : ''}.`);
  else if (agg.print || agg.copy) parts.push('They tried to print or copy the quote — the pattern of someone taking it to a partner or comparing it. Suggested chase: ask who else is involved and offer to walk them through it together.');
  else if (devices > 1) parts.push('Opened on more than one device — being shown to someone else or read on the move. Suggested chase: call to answer questions while it is fresh.');
  else if (agg.active < 60) parts.push('Only a short look so far. Suggested chase: a quick call to confirm it arrived and whether the timing suits.');
  else parts.push(`Read properly${topLine ? ', longest on ' + topLine[0] : ''}. Suggested chase: call to confirm the scope and answer questions.`);
  return parts.join(' ');
}

// ---- cross-quote feed + per-quote quick stats -------------------------------------------
function feed(limit = 60) {
  const quotes = db.prepare("SELECT id, quote_number, client_name, sent_at, status, lead_id FROM quotes WHERE COALESCE(is_sample,0)=0 AND sent_at IS NOT NULL").all();
  const rows = [];
  quotes.forEach(q => allSessions(q.id).forEach(s => rows.push({ when: s.started_at, quoteId: q.id, quoteNumber: q.quote_number, client: q.client_name, leadId: q.lead_id,
    device: s.device, city: s.city, activeSeconds: s.active_seconds, activeLabel: fmt(s.active_seconds), summary: describe(s) })));
  rows.sort((a, b) => ms(b.when) - ms(a.when));
  const top = rows.slice(0, limit);
  const sigCache = {};
  top.forEach(r => { if (!sigCache[r.quoteId]) { const q = quotes.find(x => x.id === r.quoteId); sigCache[r.quoteId] = signalFor(allSessions(q.id), q.sent_at).signal; } r.signal = sigCache[r.quoteId]; });
  return top;
}
function quick(q) {
  const sessions = allSessions(q.id);
  const sig = signalFor(sessions, q.sent_at);
  return { opens: sessions.length, devices: new Set(sessions.map(s => s.visitor_key)).size, activeSeconds: sessions.reduce((a, s) => a + s.active_seconds, 0),
    activeLabel: fmt(sessions.reduce((a, s) => a + s.active_seconds, 0)), lastOpened: sessions.length ? sessions[0].started_at : null,
    firstOpened: sessions.length ? sessions[sessions.length - 1].started_at : null, signal: sig.signal, signalWhy: sig.why };
}

// ---- rollup: raw events older than N days become one row per session ----------------------
function rollup() {
  const days = n('events_rollup_days', 30);
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const qids = db.prepare("SELECT DISTINCT quote_id FROM quote_events WHERE created_at < ? AND COALESCE(viewer,'client')='client' AND event_type IN ('view','heartbeat','accept_open','sign_step','copy_attempt','print_attempt','print_click','package_select')").all(cutoff).map(r => r.quote_id);
  let sessions = 0, deleted = 0;
  const ins = db.prepare(`INSERT INTO quote_sessions (id,quote_id,visitor_key,started_at,ended_at,active_seconds,device,city,sections,lines,package_clicks,max_scroll,reached_accept,sign_step,copy_attempts,print_attempts,events)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  qids.forEach(qid => {
    // Only sessions that ENDED before the cutoff are folded; a session straddling it waits.
    sessionsFromEvents(qid).filter(s => s.ended_at < cutoff).forEach(s => {
      ins.run(newId(), qid, s.visitor_key, s.started_at, s.ended_at, s.active_seconds, s.device, s.city, JSON.stringify(s.sections), JSON.stringify(s.lines),
        JSON.stringify(s.package_clicks), s.max_scroll, s.reached_accept, s.sign_step, s.copy_attempts, s.print_attempts, s.events);
      sessions++;
      // The signing event (package_select with accepted:true) is part of the contract record and stays.
      deleted += db.prepare(`DELETE FROM quote_events WHERE quote_id=? AND COALESCE(visitor_key,'legacy')=? AND created_at >= ? AND created_at <= ?
        AND COALESCE(viewer,'client')='client' AND NOT (event_type='package_select' AND payload LIKE '%"accepted":true%')`).run(qid, s.visitor_key, s.started_at, s.ended_at).changes;
    });
  });
  if (sessions) console.log(`[links] rolled ${deleted} raw events into ${sessions} session rows (older than ${days} days)`);
  return { sessions, deleted };
}
function start() {
  setTimeout(() => { try { rollup(); } catch (e) { console.error('[links] rollup failed:', e.message); } }, 60000).unref();
  setInterval(() => { try { rollup(); } catch (e) { console.error('[links] rollup failed:', e.message); } }, 24 * 3600e3).unref();
}

module.exports = { noteVisitor, record, feed, quick, signalFor, allSessions, rollup, start, deviceLabel, fmt };
