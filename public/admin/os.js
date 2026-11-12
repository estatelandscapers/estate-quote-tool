// v43 — the two new pieces of the app frame: the welcome screen and universal search.
// Both only READ. They use the same endpoints the tabs use, so every number here is the
// number you see when you open the list behind it.

// ---------------- welcome ----------------
// Shows after signing in, and the first time the tool is opened each day. It opens the
// tool by itself after a few seconds; tapping a card goes straight to that list, tapping
// anywhere else skips the wait.
const OSWEL_MS = 7000;
function osSydneyDay() { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } }
function osWelcomeDue() {
  let fresh = false, day = null;
  try { fresh = sessionStorage.getItem('estate-welcome') === '1'; day = localStorage.getItem('estate-welcome-day'); } catch (e) { return false; }
  return fresh || day !== osSydneyDay();
}
async function osWelcome(force) {
  if (!force && !osWelcomeDue()) return;
  try { sessionStorage.removeItem('estate-welcome'); localStorage.setItem('estate-welcome-day', osSydneyDay()); } catch (e) {}
  if (document.querySelector('.oswel')) return;
  const hour = parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(new Date()), 10);
  const hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = String((USER && USER.name) || '').trim().split(/\s+/)[0] || '';
  const el = document.createElement('div'); el.className = 'oswel';
  el.innerHTML = `<div class="in">
      <img class="logo" src="/assets/logo-icon.png" alt="">
      <div class="hi">${hi}</div><h1>${esc(first)}</h1>
      <div class="date" id="oswDate">${new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div class="cards" id="oswCards">${Array.from({ length: 6 }, (_, i) => `<button class="zero" disabled style="animation-delay:${0.42 + i * 0.07}s"><div class="n">·</div><div class="t skel" style="height:12px;width:70%;"></div><div class="d skel" style="height:10px;width:50%;margin-top:6px;"></div></button>`).join('')}</div>
      <div class="bar"><i></i></div><div class="skip">Opening the tool… tap anywhere to go now</div>
    </div>`;
  document.body.appendChild(el);
  let timer = null;
  const leave = go => {
    if (el.classList.contains('out')) return;
    clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 600);
    document.removeEventListener('keydown', onKey);
    if (go) go();
  };
  const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') leave(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', e => { if (!e.target.closest('.cards button')) leave(); });

  const today = osSydneyDay();
  const tmr = new Date(today + 'T00:00:00Z'); tmr.setUTCDate(tmr.getUTCDate() + 1);
  const safe = p => p.catch(() => null);
  const [hot, board, cal, quotes, slow] = await Promise.all([
    safe(api('/leads/hot')), safe(api('/leads/board')),
    safe(api(`/leads/calendar?from=${today}&to=${tmr.toISOString().slice(0, 10)}`)),
    safe(api('/quotes')), safe(api('/marketing/figure/slow?days=30'))]);
  if (!document.body.contains(el)) return;
  const toLeads = sub => () => { state.tab = 'leads'; state.leadId = null; state.leadFull = false; state.leadsSub = sub; state.leadPhase = null; route(); };
  const toQuotes = () => { state.tab = 'quotes'; state.quoteId = null; route(); };
  const hotRows = ((hot && hot.hot) || []).filter(x => !x.called);
  const due = board ? (board.overdue || []).length + (board.dueToday || []).length : 0;
  const overdue = board ? (board.overdue || []).length : 0;
  const visits = ((cal && cal.visits) || []).filter(v => v.date === today && v.status !== 'done');
  const qlist = (quotes && (quotes.quotes || quotes)) || [];
  const chase = Array.isArray(qlist) ? qlist.filter(q => !q.isSample && ['flag', 'chase'].includes(q.ageBand) && !['accepted', 'lost', 'superseded'].includes(q.status)) : [];
  const since = Date.now() - 48 * 3600e3;
  const won = ((board && board.won) || []).filter(w => w.acceptedAt && new Date(String(w.acceptedAt).replace(' ', 'T') + 'Z').getTime() > since);
  const uncalled = ((slow && slow.rows) || []).filter(r => /never contacted/i.test(r.note || ''));
  const cards = [
    ['hot', hotRows.length, 'Hot leads to call', hotRows.length ? hotRows.slice(0, 2).map(x => x.name).join(', ') + (hotRows.length > 2 ? ` +${hotRows.length - 2}` : '') : 'Nobody waiting on a call', toLeads('summary')],
    ['amb', uncalled.length, 'Ad leads not called yet', uncalled.length ? uncalled.slice(0, 2).map(x => x.client).join(', ') : 'Every ad lead has been contacted', () => { state.tab = 'marketing'; route(); }],
    ['bl', visits.length, visits.length === 1 ? 'Site visit today' : 'Site visits today', visits.length ? visits.map(v => [v.time, v.name].filter(Boolean).join(' ')).slice(0, 2).join(' · ') : 'Nothing booked today', toLeads('calendar')],
    ['amb', due, 'Lead follow-ups due', due ? (overdue ? `${overdue} overdue · ${due - overdue} today` : 'All due today') : 'Nothing due today', toLeads('summary')],
    ['amb', chase.length, 'Quotes to chase', chase.length ? chase.slice(0, 2).map(q => q.client || q.quoteNumber).join(', ') + (chase.length > 2 ? ` +${chase.length - 2}` : '') : 'No quotes past the follow-up age', toQuotes],
    ['gr', won.length, won.length === 1 ? 'Quote accepted, last 48 h' : 'Quotes accepted, last 48 h', won.length ? won.map(w => w.name).slice(0, 2).join(', ') : 'None in the last two days', toLeads('summary')]
  ];
  const total = hotRows.length + uncalled.length + visits.length + due + chase.length;
  el.querySelector('#oswDate').textContent += total ? ` · ${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you today` : ' · all clear';
  el.querySelector('#oswCards').innerHTML = cards.map((c, i) => `<button class="${c[1] ? c[0] : 'zero'}" data-i="${i}" style="animation-delay:${i * 0.06}s"><div class="n">${c[1]}</div><div class="t">${c[2]}</div><div class="d">${esc(c[3])}</div></button>`).join('');
  el.querySelectorAll('.cards button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); leave(cards[+b.dataset.i][4]); }));
  // The countdown starts once the figures are on screen, so there is time to read them.
  el.style.setProperty('--wel', OSWEL_MS + 'ms');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('run')));
  timer = setTimeout(() => leave(), OSWEL_MS);
}

// ---------------- universal search ----------------
const OS_TAB_ICON = { leads: 'leads', quotes: 'quotes', jobs: 'jobs', po: 'po', inventory: 'inventory', materials: 'materials', pricing: 'pricing', vendors: 'vendors' };
function osOpenResult(r, tab) {
  state.quoteId = null; state.poId = null; state.selQuoteId = null;
  if (r.kind === 'lead') { state.tab = 'leads'; state.leadsSub = 'summary'; state.leadFull = false; state.leadPhase = null; state.leadId = r.id; return route(); }
  closeLeadDrawer();
  if (r.kind === 'quote') { state.tab = 'quotes'; state.quoteId = r.id; state.scrollY = 0; return route(); }
  if (r.kind === 'po') { state.tab = 'po'; state.poId = r.id; return route(); }
  if (r.kind === 'tab') { state.tab = r.id; if (r.id === 'leads') { state.leadId = null; state.leadsSub = 'summary'; } return route(); }
  state.tab = tab;
  const p = route();
  if (r.kind === 'inv' && typeof invOpen === 'function') Promise.resolve(p).then(() => invOpen(r.id, document.querySelector('#view')));
}
function osSearch() {
  if (document.querySelector('.ospal-bg')) return;
  const bg = document.createElement('div'); bg.className = 'ospal-bg';
  bg.innerHTML = `<div class="ospal" role="dialog" aria-label="Search">
      <div class="in"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.500-3.500"/></svg><input id="osQ" type="text" inputmode="search" enterkeyhint="search" placeholder="Search everything" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="hits" id="osHits"></div>
      <div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></div>
    </div>`;
  document.body.appendChild(bg);
  const q = bg.querySelector('#osQ'), hits = bg.querySelector('#osHits');
  let flat = [], sel = 0, seq = 0, timer = null;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); };
  const paintSel = () => hits.querySelectorAll('.res').forEach((b, i) => { b.classList.toggle('sel', i === sel); if (i === sel) b.scrollIntoView({ block: 'nearest' }); });
  const draw = groups => {
    flat = []; let html = '';
    groups.forEach(g => { html += `<div class="grp">${esc(g.label)}</div>`;
      g.rows.forEach(r => { html += `<button class="res" data-i="${flat.length}">${navIcon(OS_TAB_ICON[g.tab] || g.tab)}<b>${esc(r.title)}</b><small>${esc(r.sub || '')}</small></button>`; flat.push({ r, tab: g.tab }); }); });
    hits.innerHTML = html || `<div class="none">${q.value.trim().length < 2 ? 'Type a name, suburb, phone number, quote or order number, or an item.' : 'Nothing matches “' + esc(q.value.trim()) + '”. Try a name, suburb, quote number or item.'}</div>`;
    sel = 0; paintSel();
    hits.querySelectorAll('.res').forEach(b => { b.addEventListener('click', () => pick(+b.dataset.i)); b.addEventListener('mousemove', () => { if (sel !== +b.dataset.i) { sel = +b.dataset.i; paintSel(); } }); });
  };
  const pick = i => { const x = flat[i]; if (!x) return; close(); osOpenResult(x.r, x.tab); };
  // Sections you can jump to by name ("timeline", "pricing") come first, from what this user can open.
  const sections = v => { const rows = (typeof NAV_TABS !== 'undefined' ? NAV_TABS : []).filter(t => t[1].toLowerCase().includes(v)).slice(0, 4).map(t => ({ kind: 'tab', id: t[0], title: t[1], sub: 'Go to section' })); return rows.length ? [{ label: 'Sections', tab: rows[0].id, rows: rows.map(r => r) }] : []; };
  const run = async () => {
    const v = q.value.trim(); const my = ++seq;
    if (v.length < 2) return draw([]);
    const res = await api('/search?q=' + encodeURIComponent(v)).catch(() => null);
    if (my !== seq || !document.body.contains(bg)) return;
    const sec = sections(v.toLowerCase()).map(g => ({ ...g, rows: g.rows }));
    // each section row carries its own tab for the icon
    const groups = [...sec, ...((res && res.groups) || [])];
    draw(groups);
    if (sec.length) hits.querySelectorAll('.res').forEach((b, i) => { const x = flat[i]; if (x && x.r.kind === 'tab') b.querySelector('.nico').outerHTML = navIcon(x.r.id); });
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 140); });
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) { sel = (sel + 1) % flat.length; paintSel(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) { sel = (sel - 1 + flat.length) % flat.length; paintSel(); } }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  };
  document.addEventListener('keydown', onKey, true);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  draw([]); q.focus();
}
// Ctrl K / Cmd K from anywhere; "/" when not typing in a field.
document.addEventListener('keydown', e => {
  if (typeof USER === 'undefined' || !USER || !USER.role) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); osSearch(); }
  else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); osSearch(); }
});
