// Text messages — the Settings card. Sending lives on the server (utils/sms.js).
// Mode (Off / Trial / Live), the trial numbers, one switch and one wording per message,
// a test button, and a list of what has been sent or held.
const SMS_STATUS = { sent: ['Sent', 'tag-accepted'], failed: ['Failed', 'tag-superseded'], held: ['Held (trial)', 'tag-viewed'], skipped: ['Skipped', 'tag-draft'] };
const SMS_TYPE = { manual: 'Sent by hand', test: 'Test' };
async function smsSettings(host) {
  if (!host) return;
  host.innerHTML = '<div class="card"><h2>Text messages (SMS)</h2><p class="muted">Loading…</p></div>';
  const s = await api('/sms').catch(() => null);
  if (!s || s.error) { host.innerHTML = `<div class="card"><h2>Text messages (SMS)</h2><p class="muted">${esc((s && s.error) || 'Could not load.')}</p></div>`; return; }
  const label = k => (s.types.find(t => t.key === k) || {}).label || SMS_TYPE[k] || k;
  const count = k => (s.counts.find(c => c.status === k) || {}).n || 0;
  const meas = m => `${m.chars} characters · ${m.parts} text${m.parts === 1 ? '' : 's'} each${m.unicode ? ' · contains a special character, which shortens each text to 70' : ''}`;
  host.innerHTML = `<div class="card">
    <div class="cardhead"><h2>Text messages (SMS)</h2><span class="tag ${s.mode === 'live' ? 'tag-accepted' : s.mode === 'trial' ? 'tag-viewed' : 'tag-draft'}">${s.mode === 'live' ? 'Live' : s.mode === 'trial' ? 'Trial' : 'Off'}</span></div>
    <div class="sub">Sent through Mobile Message as <b>${esc(s.sender || 'no sender set')}</b>. Clients cannot reply to a sender name, so every message should carry your phone number.</div>
    ${s.configured ? '' : '<div class="inv-banner err"><b>Not connected yet.</b> In Railway, add MOBILEMESSAGE_USERNAME, MOBILEMESSAGE_PASSWORD and SMS_SENDER, then come back here.</div>'}
    <div class="sms-top">
      <div class="field" style="margin:0;"><label>Mode</label>
        <div class="seg" id="smsMode">${[['off', 'Off'], ['trial', 'Trial'], ['live', 'Live']].map(m => `<button data-m="${m[0]}" class="${s.mode === m[0] ? 'on' : ''}">${m[1]}</button>`).join('')}</div>
        <div class="hint" id="smsModeHint"></div></div>
      <div class="field" style="margin:0;flex:1;min-width:240px;"><label for="smsTrial">Trial numbers</label>
        <input id="smsTrial" value="${esc(s.trialNumbers)}" placeholder="0412 345 678, 0498 765 432">
        <div class="hint">In Trial mode only these mobiles receive anything. Use your own phone and the dummy leads' numbers.</div></div>
      <div class="field" style="margin:0;width:150px;"><label for="smsSign">Sign-off name</label><input id="smsSign" maxlength="30" value="${esc(s.signName || '')}">
        <div class="hint">The name under "Thanks".</div></div>
    </div>
    <div class="sms-actions">
      <button class="btn btn-ghost btn-sm" id="smsCheck">Check connection</button>
      <input id="smsTestTo" placeholder="Mobile for a test text" style="max-width:200px;">
      <button class="btn btn-ghost btn-sm" id="smsTest">Send test text</button>
      <span class="muted" id="smsCheckOut" style="font-size:11.5px;"></span>
    </div>
    <div class="alab" style="margin-top:16px;">Messages</div>
    <div class="muted" style="font-size:11.5px;margin-bottom:4px;">You write the middle only. Every text is sent as: <b>Hi (first name),</b> your wording, then <b>Thanks / ${esc(s.signName || 'Smit')} / Estate Landscapers / phone</b>. The counts below include those lines.</div>
    ${s.types.map(t => `<div class="sms-type" data-k="${t.key}">
      <div class="sms-head">
        <label class="inv-switch"><input type="checkbox" class="smsOn" ${t.on ? 'checked' : ''}><span class="track"></span><span><b>${esc(t.label)}</b> <span class="muted" style="font-weight:500;">${esc(t.when)}</span></span></label>
        ${t.days != null ? `<label class="sms-days">after <input type="number" class="smsDays" min="1" max="30" step="1" value="${esc(t.days)}"> days</label>` : ''}
      </div>
      <textarea class="smsText" rows="2" maxlength="600">${esc(t.text)}</textarea>
      <details class="sms-prev"><summary>See it as the client gets it</summary><pre>${esc(t.preview || '')}</pre></details>
      <div class="sms-foot"><span class="muted smsMeas">${meas(t.measure)}</span><span class="muted">Fills in: ${t.vars.map(v => `{{${v}}}`).join(' ')}</span><a href="#" class="smsReset">Reset wording</a></div>
    </div>`).join('')}
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap;"><button class="btn btn-blue" id="smsSave">Save text message settings</button>
      <span class="muted" style="font-size:11.5px;">Reminders only go between 9 am and 6 pm, once each, and only for enquiries and quotes from after you switch them on.</span></div>
    <div class="alab" style="margin-top:18px;">Last 30 days: ${count('sent')} sent · ${count('held')} held in trial · ${count('failed')} failed · ${count('skipped')} skipped</div>
    ${s.recent.length ? `<div style="overflow-x:auto;"><table class="feedtbl"><thead><tr><th>When</th><th>Message</th><th>To</th><th>Status</th><th>Text</th></tr></thead><tbody>
      ${s.recent.map(r => `<tr><td style="white-space:nowrap;">${esc(typeof sydTime === 'function' ? sydTime(r.created_at) : r.created_at)}</td><td>${esc(label(r.type))}${r.lead ? `<br><span class="muted">${esc(r.lead)}</span>` : ''}</td><td style="white-space:nowrap;">${esc(r.to_number ? '+' + r.to_number : '—')}</td>
        <td><span class="tag ${(SMS_STATUS[r.status] || ['', 'tag-draft'])[1]}">${esc((SMS_STATUS[r.status] || [r.status])[0])}</span>${r.error && r.status !== 'held' ? `<br><span class="muted" style="font-size:10.5px;">${esc(r.error)}</span>` : ''}</td>
        <td style="min-width:240px;font-size:11.5px;">${esc(r.body || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:12px;">Nothing sent yet.</p>'}
  </div>`;
  let modeNow = s.mode;
  const hints = { off: 'Nothing is sent, automatic or by hand.', trial: 'Only the trial numbers receive texts. Everything else is listed below as held, so you can read what would have gone.', live: 'Every switched-on message goes to every client with an Australian mobile.' };
  const paintMode = () => { host.querySelectorAll('#smsMode button').forEach(b => b.classList.toggle('on', b.dataset.m === modeNow)); host.querySelector('#smsModeHint').textContent = hints[modeNow]; };
  paintMode();
  host.querySelectorAll('#smsMode button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.m === 'live' && modeNow !== 'live' && !confirm('Go live?\n\nEvery switched-on message will go to real clients from now on. Press Save afterwards to apply.')) return;
    modeNow = b.dataset.m; paintMode();
  }));
  host.querySelectorAll('.sms-type').forEach(box => {
    const t = s.types.find(x => x.key === box.dataset.k), ta = box.querySelector('.smsText');
    let timer = null;
    const remeasure = () => { clearTimeout(timer); timer = setTimeout(async () => { const m = await api('/sms/measure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ta.value }) }).catch(() => null); if (m && !m.error) box.querySelector('.smsMeas').textContent = meas(m) + ' (with a typical name and link)'; }, 350); };
    ta.addEventListener('input', remeasure);
    box.querySelector('.smsReset').addEventListener('click', e => { e.preventDefault(); ta.value = t.def; remeasure(); });
  });
  host.querySelector('#smsSave').addEventListener('click', async () => {
    const body = { mode: modeNow, signName: host.querySelector('#smsSign').value, trialNumbers: host.querySelector('#smsTrial').value,
      types: [...host.querySelectorAll('.sms-type')].map(box => ({ key: box.dataset.k, on: box.querySelector('.smsOn').checked, text: box.querySelector('.smsText').value, days: box.querySelector('.smsDays') ? box.querySelector('.smsDays').value : undefined })) };
    const r = await api('/sms', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || r.error) return toast((r && r.error) || 'Could not save');
    toast('Text message settings saved'); smsSettings(host);
  });
  const out = host.querySelector('#smsCheckOut');
  host.querySelector('#smsCheck').addEventListener('click', async () => {
    out.textContent = 'Checking…';
    const r = await api('/sms/check').catch(() => null);
    out.textContent = !r ? 'No answer from the server.' : !r.ok ? `Not working: ${r.error}${r.hint ? ' ' + r.hint : ''}`
      : `Connected. ${r.balance != null ? r.balance + ' credits left. ' : ''}Sender ${r.sender}: ${r.senderApproved === true ? 'approved' : r.senderApproved === false ? 'NOT on the account yet, texts will be refused until it is approved' : 'could not be checked'}.`;
  });
  host.querySelector('#smsTest').addEventListener('click', async () => {
    const to = host.querySelector('#smsTestTo').value.trim(); if (!to) return toast('Enter a mobile number for the test');
    out.textContent = 'Sending…';
    const r = await api('/sms/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) }).catch(() => null);
    out.textContent = !r ? 'No answer from the server.' : r.ok ? 'Test text sent. It should arrive within a minute.' : `Not sent: ${r.error || r.status}${r.hint ? ' ' + r.hint : ''}`;
  });
}
