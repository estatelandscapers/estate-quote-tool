(function () {
  const token = location.pathname.split('/q/')[1];
  const root = document.getElementById('root');
  const api = (p, opts) => fetch(`/api/public/quote/${token}${p}`, opts).then(r => r.json());
  const money = n => '$' + Math.round(n).toLocaleString('en-AU');
  const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TIERS = ['Basic', 'Standard', 'Premium'];
  let D = null, tier = 'Standard';

  function track(type, payload) { api('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }) }).catch(() => {}); }

  api('').then(d => {
    if (d.error) { root.innerHTML = smsg('Quote not found', 'This link may be incorrect. Please contact us on the number in your email.'); return; }
    D = d; tier = d.defaultPackage || 'Standard';
    if (d.superseded) { root.innerHTML = smsg('This quote has been updated', 'A newer version of this proposal has been issued. Please use the most recent link we sent you, or contact us.', true); return; }
    if (d.expired) { root.innerHTML = smsg('This quote has expired', `This proposal was valid for ${d.validityDays} days. Contact us and we'll be happy to refresh it for you.`, true); return; }
    render();
    track('view', {});
    setInterval(() => { if (!document.hidden) track('heartbeat', { seconds: 15 }); }, 15000);
  });

  function smsg(h, p, warn) { return `<div class="state-msg ${warn ? 'warn' : ''}"><h2>${esc(h)}</h2><p class="muted">${esc(p)}</p></div>`; }

  function eoFor(t) {
    const base = D.tierTotals.Basic + (D.surchargePerTier ? D.surchargePerTier.Basic : 0);
    const val = D.tierTotals[t] + (D.surchargePerTier ? D.surchargePerTier[t] : 0);
    return val - base;
  }

  function render() {
    const c = D.company;
    const accepted = D.status === 'accepted';
    const badges = [];
    if (c.lic) badges.push(`<span class="badge green">&#10003; Licensed &mdash; ${esc(c.lic)}</span>`);
    if (c.association) badges.push(`<span class="badge green">&#10003; ${esc(c.association)}</span>`);
    badges.push(`<span class="badge amber">Valid ${D.validityDays} days &mdash; until ${esc(D.validUntil)}</span>`);
    const heading = `${esc(D.projectTitle || 'Landscape Works')} Fee Proposal &mdash; Quote ${esc(D.quoteNumber)}`;

    root.innerHTML = `
    <div class="frame" oncontextmenu="return false">
      <div class="hero">
        <img class="logo-full" src="/assets/logo-full.png" alt="Estate Landscapers">
        <div class="eyebrow">${heading}</div>
        <div class="who">${esc(D.client || '')}</div>
        <div class="addr">${esc(D.address || '')}</div>
        <div class="badges">${badges.join('')}</div>
        <div class="company-addr">${esc(c.name || 'Estate Landscapers')} &middot; ${esc(c.address || '')}${c.abn ? ' &middot; ' + esc(c.abn) : ''}</div>
      </div>
      ${accepted ? `<div class="accepted-banner">&#10003; Accepted &mdash; ${esc(D.acceptedPackage)} package. Thank you! A signed copy has been emailed to you.</div>` : ''}
      ${D.mixed ? `<div class="mixed-box">
        <div class="mb-t">Your selection</div>
        <div class="mb-h">${esc(D.mixed.base)} package, with ${D.mixed.changes.length} change${D.mixed.changes.length > 1 ? 's' : ''}</div>
        ${D.mixed.changes.map(c => `<div class="mb-line"><span>${c.up ? '&uarr;' : '&darr;'} ${esc(c.code)} ${esc(c.name)} &mdash; <b>${esc(c.to)}</b></span><span class="${c.up ? 'mb-up' : 'mb-down'}">${c.delta >= 0 ? '+' : '&minus;'}$${Math.abs(c.delta).toLocaleString('en-AU')}</span></div>`).join('')}
      </div><div class="pkg-desc" id="pkgDesc" style="display:none;"></div>` : `<div class="pkg-row" id="pkgRow">
        ${TIERS.map(t => `<div class="pkg ${t === tier ? 'on' : ''}" data-t="${t}"><b>${t}</b><div class="eo">${t === 'Basic' ? 'Entry spec' : '+' + money(eoFor(t)) + ' vs Basic'}</div></div>`).join('')}
      </div>
      <div class="pkg-desc" id="pkgDesc"></div>`}
      <div class="split-area">
        ${D.hasSiteplan ? `<div class="siteplan-wrap"><img id="siteplan" src="/api/public/quote/${token}/siteplan" alt="Site plan" draggable="false"><div class="siteplan-cap">Your site plan &mdash; tap to enlarge</div></div>` : ''}
        <div class="box deliv-box"><div class="box-title">Scope 1 &mdash; Landscaping Works Deliverables</div><div id="delivs"></div></div>
      </div>
      ${D.scope2 && D.scope2.length ? `<div class="box s2"><div class="box-title">Scope 2 &mdash; Disposal of Construction Waste</div>
        <div style="font-size:12.5px;color:var(--grey);line-height:1.6;">Estimated ${esc(String(D.scope2[0].qty))} m&sup3; at <b style="color:var(--ink)">${money(D.scope2[0].perTier.Standard.rate)}/m&sup3; &mdash; remeasurable</b>. Completed at cost + 15%, substantiated by disposal invoices. Final cost adjusted on actual quantities removed.</div></div>` : ''}
      ${D.siteNotes ? `<div class="notes-box"><div class="nt">Site-specific notes from our team</div><div class="nb">${esc(D.siteNotes)}</div></div>` : ''}
      <div class="total-card" id="totalCard"></div>
      <div class="pay"><b>Payment schedule</b><br>${esc(D.paymentScheduleText || '')}</div>
      ${accepted ? '' : `<div class="cta-wrap"><button class="btn btn-blue" id="acceptBtn">Accept <span id="acceptTier">${tier}</span> package &amp; review contract &rarr;</button>
        <div class="cta-sub">You'll review the full contract, warranty and your protections before signing.</div></div>`}
      <footer>${esc(c.tagline || 'Integrity. Precision. Value.')}</footer>
    </div>`;

    if (D.mixed) tier = D.mixed.base; // price shown = base package with per-line overrides already applied server-side
    document.querySelectorAll('.pkg').forEach(p => {
      p.addEventListener('click', () => { tier = p.dataset.t; track('package_select', { tier }); renderDynamic(); });
      p.addEventListener('mouseenter', () => { document.getElementById('pkgDesc').innerHTML = descHtml(p.dataset.t); });
      p.addEventListener('mouseleave', () => { document.getElementById('pkgDesc').innerHTML = descHtml(tier); });
    });
    protectDrawing();
    const ab = document.getElementById('acceptBtn');
    if (ab) ab.addEventListener('click', openEsign);
    renderDynamic();
  }

  function protectDrawing() {
    const sp = document.getElementById('siteplan');
    if (!sp) return;
    sp.addEventListener('contextmenu', e => e.preventDefault());
    sp.addEventListener('dragstart', e => e.preventDefault());
    sp.addEventListener('click', () => {
      const lb = document.createElement('div'); lb.className = 'lightbox';
      lb.innerHTML = `<img src="/api/public/quote/${token}/siteplan" draggable="false" oncontextmenu="return false">`;
      lb.addEventListener('click', () => lb.remove());
      lb.addEventListener('contextmenu', e => e.preventDefault());
      document.body.appendChild(lb);
    });
  }

  function descHtml(t) { return `<b>${t}:</b> ${esc(D.pkgDesc[t] || '')}`; }

  function renderDynamic() {
    document.querySelectorAll('.pkg').forEach(p => p.classList.toggle('on', p.dataset.t === tier));
    if (!D.mixed) document.getElementById('pkgDesc').innerHTML = descHtml(tier);
    const at = document.getElementById('acceptTier'); if (at) at.textContent = tier;
    document.getElementById('delivs').innerHTML = D.scope1.map(d => {
      const lineTier = (D.mixed && d.tierOverride) ? d.tierOverride : tier;
      const pt = d.perTier[lineTier];
      const eo = pt.price - d.perTier.Basic.price;
      const isRem = d.behaviour === 'remeasurable';
      const shared = d.sharedEnabled ? ` &middot; shared ${d.sharedPct}% with neighbour` : '';
      return `<div class="deliv"><div class="t"><span class="code">${esc(d.code)}</span>${esc(d.name)}</div>
        <div class="spec-line"><div class="n">${esc(pt.spec || d.name)}</div><div class="p">${money(pt.price)}</div></div>
        ${isRem ? `<div class="rem-line">&#9878; ${esc(String(d.qty))} ${esc(d.unit)} @ ${money(pt.rate)}/${esc(d.unit)} &mdash; remeasurable: final quantity measured on site${shared}</div>` : ''}
        ${eo > 0 ? `<div class="eo-line">+${money(eo)} over the Basic spec for this item</div>` : ''}</div>`;
    }).join('');
    const sub = D.mixed ? D.mixed.sellExGst : D.tierTotals[tier];
    const sur = D.surchargePerTier ? D.surchargePerTier[tier] : 0;
    const s2 = D.scope2Total || 0;
    const exGst = sub + sur + s2;
    let rows = `<div class="r"><span>Scope 1 subtotal &mdash; ${D.mixed ? D.mixed.base + ' + changes' : tier}</span><span>${money(sub)}</span></div>`;
    if (sur > 0 && D.surcharges && D.surcharges.length) rows += `<div class="r"><span>Site conditions &mdash; ${D.surcharges.map(s => esc(s.name)).join(', ')}</span><span>${money(sur)}</span></div>`;
    if (s2 > 0) rows += `<div class="r"><span>Scope 2 disposal (est. &mdash; remeasurable)</span><span>${money(s2)}</span></div>`;
    rows += `<div class="r"><span>GST (10%)</span><span>${money(exGst * 0.1)}</span></div>`;
    rows += `<div class="r g"><span>Total inc. GST</span><span>${money(exGst * 1.1)}</span></div>`;
    document.getElementById('totalCard').innerHTML = rows;
  }

  function openEsign() {
    let step = 1, reviewed = false, sigMode = 'type', sigDrawn = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    document.body.appendChild(overlay);
    const cc = D.contract;
    const autofill = s => `<span class="autofill">${esc(s)}</span>`;
    function stepsBar() {
      const s = [['1', 'Review contract'], ['2', 'Sign'], ['3', 'Done']];
      return `<div class="steps">${s.map((x, i) => { const n = i + 1; const cls = n < step ? 'done' : (n === step ? 'on' : ''); return `<div class="step ${cls}"><div class="dot">${n < step ? '&#10003;' : x[0]}</div> ${x[1]}</div>`; }).join('')}</div>`;
    }
    function draw(res) {
      if (step === 1) {
        overlay.querySelector('.modal').innerHTML = stepsBar() + `
          <h2 style="margin:0 0 4px;font-size:16px;text-transform:uppercase;letter-spacing:.5px;">Review before signing</h2>
          <p class="muted" style="margin:0 0 14px;">Please read all four parts. They form your contract with us.</p>
          <div class="doc-tabs"><div class="doc-tab on" data-d="std">Standard Conditions</div><div class="doc-tab" data-d="spec">Special Clauses</div><div class="doc-tab" data-d="warranty">Warranty</div><div class="doc-tab" data-d="protect">Your Protections</div></div>
          <div class="contract-box" id="docbox"></div>
          <label class="gate"><input type="checkbox" id="gate"> <span>I confirm I have reviewed the <b>Standard Conditions, Special Clauses, Warranty and Your Protections</b> in full.</span></label>
          <div style="display:flex;gap:8px;justify-content:space-between;"><button class="btn btn-ghost" id="cancel">Cancel</button><button class="btn btn-blue" id="next1" ${reviewed ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>Agree &amp; continue</button></div>`;
        const docs = {
          std: `<b>STANDARD CONTRACT TERMS &amp; CONDITIONS</b>\n\nBetween ${autofill(D.company.name + ' (' + D.company.abn + ', ' + D.company.lic + ')')} and ${autofill(D.client)}, ${autofill(D.address)}.\nPackage: ${autofill(tier)} &middot; Quote ${autofill(D.quoteNumber)}\n\n${esc(cc.standardConditions || '')}`,
          spec: `<b>SPECIAL CLAUSES &mdash; Quote ${esc(D.quoteNumber)}</b>\n\n${esc(cc.specialClauses || 'None for this quote.')}`,
          warranty: `<b>WARRANTY</b>\n\n${esc(cc.warranty || '')}`,
          protect: `<div style="font-weight:800;margin-bottom:8px;">WHY YOU'RE IN SAFE HANDS</div>` + (cc.protections || []).map(p => `<div class="protect"><div class="ic">&#10003;</div><div><b>${esc(p.title)}</b><span>${esc(p.detail)}</span></div></div>`).join('')
        };
        const box = overlay.querySelector('#docbox');
        const setDoc = k => { box.innerHTML = docs[k]; };
        setDoc('std');
        overlay.querySelectorAll('.doc-tab').forEach(t => t.addEventListener('click', () => { overlay.querySelectorAll('.doc-tab').forEach(x => x.classList.toggle('on', x === t)); setDoc(t.dataset.d); }));
        overlay.querySelector('#gate').checked = reviewed;
        overlay.querySelector('#gate').addEventListener('change', e => { reviewed = e.target.checked; const b = overlay.querySelector('#next1'); b.disabled = !reviewed; b.style.opacity = reviewed ? '1' : '.5'; b.style.cursor = reviewed ? 'pointer' : 'not-allowed'; });
        overlay.querySelector('#cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#next1').addEventListener('click', () => { if (reviewed) { step = 2; draw(); } });
      } else if (step === 2) {
        overlay.querySelector('.modal').innerHTML = stepsBar() + `
          <h2 style="margin:0 0 14px;font-size:16px;text-transform:uppercase;letter-spacing:.5px;">Your details &amp; signature</h2>
          <div class="field"><label>Full name</label><input id="fname" value="${esc(D.client || '')}" placeholder="Your full name"></div>
          <div class="field"><label>Email (for your signed copy)</label><input id="femail" type="email" placeholder="you@example.com"></div>
          <div class="field"><label>Signature</label><div class="sig-tabs"><div class="sig-tab on" data-m="type">Type</div><div class="sig-tab" data-m="draw">Draw</div></div><div id="sigArea"></div></div>
          <div class="err" id="err" style="display:none;"></div>
          <div style="display:flex;gap:8px;justify-content:space-between;"><button class="btn btn-ghost" id="back2">Back</button><button class="btn btn-blue" id="signBtn">Apply signature &amp; accept</button></div>`;
        const sigArea = overlay.querySelector('#sigArea');
        function renderSig() {
          if (sigMode === 'type') sigArea.innerHTML = `<div class="sig-type" id="sigType" contenteditable="true">${esc(D.client || '')}</div>`;
          else { sigArea.innerHTML = `<canvas class="sig-pad" id="sigCanvas"></canvas><div style="text-align:right;margin-top:4px;"><button class="btn btn-ghost" id="clearSig" style="padding:5px 10px;font-size:10px;">Clear</button></div>`; initCanvas(); }
        }
        function initCanvas() {
          const cv = overlay.querySelector('#sigCanvas'); const ctx = cv.getContext('2d');
          const dpr = window.devicePixelRatio || 1; const rect = cv.getBoundingClientRect();
          cv.width = rect.width * dpr; cv.height = 150 * dpr; ctx.scale(dpr, dpr);
          ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.lineCap = 'round';
          let drawing = false, last = null;
          const pos = e => { const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
          const start = e => { drawing = true; last = pos(e); e.preventDefault(); };
          const move = e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; sigDrawn = true; e.preventDefault(); };
          const end = () => { drawing = false; };
          cv.addEventListener('mousedown', start); cv.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
          cv.addEventListener('touchstart', start); cv.addEventListener('touchmove', move); cv.addEventListener('touchend', end);
          overlay.querySelector('#clearSig').addEventListener('click', () => { ctx.clearRect(0, 0, cv.width, cv.height); sigDrawn = false; });
        }
        renderSig();
        overlay.querySelectorAll('.sig-tab').forEach(t => t.addEventListener('click', () => { overlay.querySelectorAll('.sig-tab').forEach(x => x.classList.toggle('on', x === t)); sigMode = t.dataset.m; renderSig(); }));
        overlay.querySelector('#back2').addEventListener('click', () => { step = 1; draw(); });
        overlay.querySelector('#signBtn').addEventListener('click', () => {
          const name = overlay.querySelector('#fname').value.trim();
          const email = overlay.querySelector('#femail').value.trim();
          const errEl = overlay.querySelector('#err');
          if (!name) { errEl.textContent = 'Please enter your full name.'; errEl.style.display = 'block'; return; }
          let signature = name;
          if (sigMode === 'type') signature = overlay.querySelector('#sigType').textContent.trim() || name;
          else { if (!sigDrawn) { errEl.textContent = 'Please draw your signature, or switch to Type.'; errEl.style.display = 'block'; return; } signature = overlay.querySelector('#sigCanvas').toDataURL('image/png'); }
          errEl.style.display = 'none';
          const btn = overlay.querySelector('#signBtn'); btn.disabled = true; btn.textContent = 'Submitting...';
          api('/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier, name, signature, email }) })
            .then(r => { if (r.ok) { step = 3; draw(r); } else { errEl.textContent = r.error || 'Something went wrong.'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Apply signature & accept'; } })
            .catch(() => { errEl.textContent = 'Network error - please try again.'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Apply signature & accept'; });
        });
      } else if (step === 3) {
        const emailedClient = res && res.emailed && res.emailed.client;
        overlay.querySelector('.modal').innerHTML = stepsBar() + `
          <div class="done-box">&#10003; Signed &amp; accepted &mdash; ${tier} package<br>
          <span class="muted">${emailedClient ? 'A signed copy has been emailed to you and to our office.' : 'Your acceptance is recorded. We\'ll be in touch shortly with your signed copy.'}</span></div>
          <div style="text-align:center;margin-top:16px;"><button class="btn btn-ghost" id="closeDone">Close</button></div>`;
        overlay.querySelector('#closeDone').addEventListener('click', () => { overlay.remove(); location.reload(); });
      }
    }
    overlay.innerHTML = `<div class="modal"></div>`;
    draw();
  }
})();
