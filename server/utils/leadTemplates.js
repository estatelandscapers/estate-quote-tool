// Follow-up message templates, ported from Smit's standalone console so the wording
// is the wording that already works. Every template is editable in Editor → Settings;
// these are only the defaults used until one is edited.
const { settingGet } = require('../db');

// Five phases every enquiry travels in order. The 15 stages live inside them.
const PHASES = [
  { id: 1, key: 'enquiry', label: 'Enquiry',       blurb: 'Call until answered',        target: 'day 0 · 1 · 3 · 5' },
  { id: 2, key: 'qualify', label: 'Qualifying',    blurb: 'Discovery call · ballpark',  target: 'then request drawings' },
  { id: 3, key: 'docs',    label: 'Documentation', blurb: 'Drawings in, then site visit', target: 'Fridays' },
  { id: 4, key: 'quote',   label: 'Quote',         blurb: 'Sent within 48 hrs · chased', target: '3 · 5 · 14 days' },
  { id: 5, key: 'outcome', label: 'Won / Closed',  blurb: '',                           target: '' },
];

// nextIn: days until the next action falls due once this step is done.
// null = no automatic chase (the step itself sets a date, or the lead is finished).
const STAGES = [
  // STEP 1 — call at day 0, 1, 3 and 5. A message goes out after every unanswered call.
  { id: 'call1',      phase: 1, group: 'Enquiry', label: 'Call the client now',      when: 'Day 0', date: false, nextIn: 1, nextAction: 'Call the client now' },
  { id: 'call2',      phase: 1, group: 'Enquiry', label: '2nd call — no answer',     when: 'Day 1', date: false, nextIn: 2, nextAction: 'Call again (2nd attempt)' },
  { id: 'call3',      phase: 1, group: 'Enquiry', label: '3rd call — no answer',     when: 'Day 3', date: false, nextIn: 2, nextAction: 'Call again (3rd attempt)' },
  { id: 'call4',      phase: 1, group: 'Enquiry', label: 'Final call — no answer',   when: 'Day 5', date: false, nextIn: null, nextAction: 'Last call, then close it out' },
  { id: 'callback',   phase: 1, group: 'Enquiry', label: 'Call-back arranged',       when: 'Booked', date: true, nextIn: null, nextAction: 'Call back as arranged' },
  // STEP 2 — discovery call, ballpark, then ask for the drawings
  { id: 'qualified',  phase: 2, group: 'Qualifying', label: 'Discovery call done',   when: 'Answered', date: false, nextIn: 2, nextAction: 'Request the drawings' },
  // The client ran the discovery themselves in the online estimator. Same phase as a call,
  // but the next action is to confirm it by phone the same day, not to chase drawings.
  { id: 'estimatedone', phase: 2, group: 'Qualifying', label: 'Online estimate done', when: 'Self-served', date: false, nextIn: 0, nextAction: 'Call to confirm the online estimate — same day' },
  { id: 'docsasked',  phase: 2, group: 'Qualifying', label: 'Drawings requested',    when: 'Same day', date: false, nextIn: 3, nextAction: 'Chase the drawings' },
  { id: 'disqualified', phase: 5, group: 'Qualifying', label: 'Not proceeding — client declined', when: 'After ballpark', date: false, nextIn: null, nextAction: '' },
  // STEP 3 — drawings in, then the Friday visit
  { id: 'docsin',     phase: 3, group: 'Documentation', label: 'Drawings received',  when: 'Docs in', date: false, nextIn: 1, nextAction: 'Book the Friday site visit' },
  { id: 'visitbooked',phase: 3, group: 'Documentation', label: 'Site visit booked',  when: 'Booked', date: true, nextIn: null, nextAction: 'Reminder the day before' },
  { id: 'visitdone',  phase: 3, group: 'Documentation', label: 'Site visit done',    when: 'Visited', date: true, nextIn: 2, nextAction: 'Build and send the quote — due within 48 hrs' },
  // STEP 4 — quote out, then 3 / 5 / 14 days
  { id: 'quotesent',  phase: 4, group: 'Quote', label: 'Quote sent',                 when: 'Sent', date: false, nextIn: 0, nextAction: 'Call to confirm they received it' },
  { id: 'quotechase1',phase: 4, group: 'Quote', label: 'Chased — 3 days',            when: '+3 days', date: false, nextIn: 2, nextAction: 'Chase again (5 days)' },
  { id: 'quotechase2',phase: 4, group: 'Quote', label: 'Chased — 5 days',            when: '+5 days', date: false, nextIn: 9, nextAction: 'Final check-in (14 days)' },
  { id: 'quotefinal', phase: 4, group: 'Quote', label: 'Final check-in — 14 days',   when: '+14 days', date: false, nextIn: null, nextAction: 'Close it out and switch the link off' },
  // END
  { id: 'won',        phase: 5, group: 'Outcome', label: 'They said yes',            when: 'Won', date: false, nextIn: null, nextAction: '' },
  { id: 'lost',       phase: 5, group: 'Outcome', label: 'Not proceeding',           when: 'Closed', date: false, nextIn: null, nextAction: '' },
  { id: 'closeout',   phase: 5, group: 'Outcome', label: 'Closed — no contact',      when: 'Closed', date: false, nextIn: null, nextAction: '' },
];

// One message per stage — the message that belongs to the step the lead is on, so what the
// client reads matches what was just said or done. Each has a full version (email and
// WhatsApp) and a short one (SMS, kept near one text). No sign-off in the wording: email
// adds the signature, WhatsApp adds the sender's name and number.
//
// Fills in: {{name}} first name · {{job}} what they want done · {{address}} site address ·
// {{suburb}} · {{me}} who is sending · {{slot}} "on Friday 20 November at 9:00am" ·
// {{date}} {{time}} · {{email}} {{phone}} the office · {{quotelink}} {{quote}} the quote ·
// {{estlink}} {{code}} the online estimate · {{ref}} enquiry reference.
const DEFAULTS = {
  // ---- Step 1: enquiry — a message after every unanswered call -------------------------
  call1: {
    subject: 'Your {{jobshort}} enquiry — Estate Landscapers',
    body: `Hi {{name}},

{{me}} from Estate Landscapers here. Thanks for your enquiry about {{job}}{{at_address}}.

I tried to call you just now to run through the project — it takes about ten minutes and lets me give you a realistic ballpark before anyone spends time on a site visit.

When is a good time to call you back? You can reply here with a time, or ring me on {{phone}}.

If it is easier, you can also answer the same questions online in about 8 minutes and see a ballpark straight away: {{estlink}}`,
    sms: `Estate Landscapers: Hi {{name}}, {{me}} here. I tried calling about your {{jobshort}} enquiry. When suits for a quick call? Or ring me on {{phone}}.`,
  },
  call2: {
    subject: 'Tried you again — your {{jobshort}} enquiry',
    body: `Hi {{name}},

{{me}} from Estate Landscapers. I have tried you a second time about your {{job}} enquiry and missed you again — no problem, I know the days get busy.

To give you a proper figure I only need a few details: roughly how much of each item, what the access is like, and whether you have any drawings. A ten-minute call covers it.

Let me know a time that suits, or call me on {{phone}} whenever you are free. Before 8 am and after 4 pm are both fine.`,
    sms: `Estate Landscapers: Hi {{name}}, missed you again about your {{jobshort}} enquiry. What time suits for a 10 min call? {{me}}, {{phone}}.`,
  },
  call3: {
    subject: 'Still keen to help with your {{jobshort}} project',
    body: `Hi {{name}},

{{me}} from Estate Landscapers again. I have called three times now about your {{job}} enquiry and have not been able to reach you.

If the project is still going ahead, I would like to help. Reply with a time that suits, or call {{phone}}, and I will work around you.

If your plans have changed or you have gone with someone else, just let me know and I will close the enquiry so you do not hear from us again.`,
    sms: `Estate Landscapers: Hi {{name}}, third try about your {{jobshort}} enquiry. Still going ahead? Reply with a time or call {{phone}}. If not, just say so. {{me}}`,
  },
  call4: {
    subject: 'Last call — your {{jobshort}} enquiry',
    body: `Hi {{name}},

{{me}} from Estate Landscapers. This is my last attempt to reach you about your {{job}} enquiry — I do not want to keep chasing if the timing is not right.

If you would still like a price, call me on {{phone}} or reply to this message this week and I will pick it straight up.

Otherwise I will close the enquiry at the end of the week. You are welcome to come back to us any time and we will start from where we left off.`,
    sms: `Estate Landscapers: Hi {{name}}, last try about your {{jobshort}} enquiry. Still want a price? Call {{phone}} this week, or I will close it off. {{me}}`,
  },
  callback: {
    subject: 'Call back {{slot}} — Estate Landscapers',
    body: `Hi {{name}},

Thanks for picking up just now. As agreed, I will call you back {{slot}} to go through your {{job}} project.

The call takes about ten minutes. If you can have a rough idea of the areas and sizes involved, and any drawings you hold, I can give you a ballpark on the spot.

If that time stops suiting, reply here or call {{phone}} and we will move it.`,
    sms: `Estate Landscapers: Hi {{name}}, I will call you back {{slot}} about your {{jobshort}}. Need to move it? Call {{phone}}. {{me}}`,
  },
  // ---- Step 2: qualifying ------------------------------------------------------------
  qualified: {
    subject: 'Next steps for your {{jobshort}} project',
    body: `Hi {{name}},

Thanks for your time on the phone. It was good to go through your {{job}} project{{at_address}}.

Here is what happens from here:

1. You send us what you have: any drawings (architectural, hydraulic, landscape plan or DA consent) and a few photos of the front, the back and the side access.
2. We check the scope against those and confirm the ballpark we discussed.
3. We come out for a site visit — Fridays — to measure, check levels and look at access.
4. Your itemised quote follows within 48 hours of the visit, with three levels of finish to compare.

You can send the drawings and photos by replying to this message or to {{email}}. If there is nothing drawn up yet, the photos alone are enough to keep moving.

Any questions, call me on {{phone}}.`,
    sms: `Estate Landscapers: thanks for the chat {{name}}. Next step: email any drawings and photos of the front, back and side access to {{email}}. {{me}}`,
  },
  estimatedone: {
    subject: 'Your online estimate — Estate Landscapers',
    body: `Hi {{name}},

{{me}} from Estate Landscapers here. Thank you for completing the online estimate for your {{job}} project{{at_address}} — I have your answers in front of me.

Before we come out I would like a quick call to confirm two or three of them, mainly the sizes and the access, so the site visit and the quote are based on the right scope. It takes about five minutes.

When suits today or tomorrow? Reply with a time, or call me on {{phone}}.

Your code still works if you would like to change any answers: {{estlink}}`,
    sms: `Estate Landscapers: thanks for doing the online estimate {{name}}. Can I call to confirm a couple of answers? When suits? {{me}}, {{phone}}`,
  },
  docsasked: {
    subject: 'Drawings and photos for your {{jobshort}} project',
    body: `Hi {{name}},

{{me}} from Estate Landscapers. To take your {{job}} project{{at_address}} to the next step, I need the following from you:

• Drawings — whichever you have: architectural, hydraulic, a landscape plan, or the DA consent
• Photos — the front, the backyard, and the side access at its narrowest point
• Anything we should know about underground: pool, sewer or stormwater lines, irrigation

Send them by replying to this message or to {{email}}. Phone photos are fine, and if you have no drawings, the photos on their own are enough.

Once they are in, I will check the scope, confirm the ballpark and book a Friday site visit with you. If anything on the list is hard to find, call me on {{phone}} and we will work around it.`,
    sms: `Estate Landscapers: Hi {{name}}, please send your drawings (if any) and photos of the front, back and side access to {{email}}. {{me}}`,
  },
  disqualified: {
    subject: 'Your landscaping enquiry — Estate Landscapers',
    body: `Hi {{name}},

Thank you for going through your {{job}} project with us and for being upfront about where you have landed.

As discussed, I will close the enquiry on our side, so you will not get any more follow-ups from us.

If the scope, timing or budget changes down the track, call me on {{phone}} and we will pick it up from where we left off — everything you have told us stays on file.`,
    sms: `Estate Landscapers: thanks {{name}}. As discussed I have closed your enquiry. If plans change, call {{phone}} and we will pick it straight up. {{me}}`,
  },
  // ---- Step 3: documentation -------------------------------------------------------
  docsin: {
    subject: 'Got your drawings — booking the site visit',
    body: `Hi {{name}},

Thank you, I have received what you sent for the {{job}} project{{at_address}} and have been through it.

The next step is a site visit so we can measure up, check levels and falls, and look at the access for machinery and materials. We do visits on Fridays and they take about 30 to 45 minutes.

I have {{slot}} available — does that suit? If not, tell me which Friday and whether morning or afternoon is better, and I will fit around you.

After the visit your itemised quote follows within 48 hours.`,
    sms: `Estate Landscapers: drawings received, thanks {{name}}. Next is a site visit. Does {{slot}} suit? Reply or call {{phone}}. {{me}}`,
  },
  visitbooked: {
    subject: 'Site visit confirmed {{slot}}',
    body: `Hi {{name}},

Confirming your site visit {{slot}}{{at_address}}.

On the day we will:
• measure each area for the {{job}}
• check levels, falls and drainage
• look at access for machinery and deliveries
• photograph the site for the quote

It takes about 30 to 45 minutes. It helps if we can get to the whole area, including the side access, and if any pets are secured. If you have drawings we have not seen yet, please have them handy.

Your itemised quote follows within 48 hours of the visit. If you need to change the time, call me on {{phone}}.`,
    sms: `Estate Landscapers: Hi {{name}}, site visit confirmed {{slot}}. Please keep the side access clear. Changes: {{phone}}. {{me}}`,
  },
  visitdone: {
    subject: 'Thanks for having us out — your quote is next',
    body: `Hi {{name}},

Thank you for your time on site today. I have the measurements, levels and photos I need for the {{job}}.

Your quote will be with you within 48 hours. It is itemised element by element and shows three levels of finish, so you can see exactly what each option includes and add, remove or stage items to suit the budget.

If anything comes to mind in the meantime that we did not cover on site, reply here or call me on {{phone}} so I can include it.`,
    sms: `Estate Landscapers: thanks for today {{name}}. Your itemised quote, with three levels of finish, will be with you within 48 hours. Questions? {{phone}}. {{me}}`,
  },
  // ---- Step 4: quote ----------------------------------------------------------------
  quotesent: {
    subject: 'Your quote {{quote}} — Estate Landscapers',
    body: `Hi {{name}},

Your quote for the {{job}}{{at_address}} is ready:

{{quotelink}}

A few pointers for reading it:
• It shows three levels of finish — Basic, Standard and Premium — so you can compare what each includes.
• Every item is priced separately, so you can add, remove or stage parts of the work.
• When you are happy, you can accept and sign on the same page.

I will give you a call to check it came through and to walk you through anything that is unclear. If you would rather go through it sooner, I am on {{phone}}.`,
    sms: `Estate Landscapers: Hi {{name}}, your quote {{quote}} is ready: {{quotelink}} I will call to go through it. {{me}}`,
  },
  quotechase1: {
    subject: 'Your quote {{quote}} — any questions?',
    body: `Hi {{name}},

{{me}} from Estate Landscapers. I wanted to check you have had a chance to look through the quote for your {{job}}:

{{quotelink}}

If something is not quite right — an item you want changed, a different finish, or a figure you would like explained — tell me and I will revise it. Quotes usually go through one or two rounds before they are final, so changes are no trouble.

Happy to talk it through on {{phone}} whenever suits.`,
    sms: `Estate Landscapers: Hi {{name}}, any questions on quote {{quote}}? Happy to adjust it. {{quotelink}} {{me}}, {{phone}}`,
  },
  quotechase2: {
    subject: 'Your quote {{quote}} — how is it looking?',
    body: `Hi {{name}},

Following up on the quote for your {{job}}:

{{quotelink}}

I would like to know where you have landed, whichever way it is going. If the total is higher than you planned for, we can stage the work or change the finish to bring it in. If you are comparing quotes, I am glad to go through ours line by line so you can compare like for like.

Our schedule fills a few weeks ahead, so if you have a start date in mind it is worth locking in. Call me on {{phone}} or reply here.`,
    sms: `Estate Landscapers: Hi {{name}}, checking in on quote {{quote}}. If the price or scope needs work we can stage or adjust it. Call {{phone}}. {{me}}`,
  },
  quotefinal: {
    subject: 'Last check-in on your quote {{quote}}',
    body: `Hi {{name}},

This is my last check-in on the quote for your {{job}}:

{{quotelink}}

If you would like to go ahead, you can accept and sign on that page and I will get you into the schedule. If you need a change first, tell me what and I will revise it.

If it is not going ahead, that is completely fine — a short reply lets me close the file. I will switch the quote link off at the end of the week, and it can be reopened any time by calling {{phone}}.`,
    sms: `Estate Landscapers: Hi {{name}}, last check-in on quote {{quote}}. Going ahead, need a change, or not proceeding? A quick reply or call to {{phone}} helps. {{me}}`,
  },
  // ---- Step 5: outcome ---------------------------------------------------------------
  won: {
    subject: 'Thank you — next steps for your project',
    body: `Hi {{name}},

Thank you for going ahead with the {{job}}{{at_address}} — we appreciate the trust.

Here is what happens next:

1. You will receive a copy of the signed contract by email.
2. We confirm your material and finish selections with you.
3. We give you a start date and an outline of the program.
4. One point of contact through the job, with progress photos as we go.

I will be in touch shortly with the start date. In the meantime, call me on {{phone}} with any questions.`,
    sms: `Estate Landscapers: thank you {{name}}, great to have you on board. I will be in touch shortly with selections and a start date. {{me}}, {{phone}}.`,
  },
  lost: {
    subject: 'Thanks for the opportunity',
    body: `Hi {{name}},

Thank you for the opportunity to quote on your {{job}}, and for letting us know your decision.

I have closed the quote on our side. If anything changes, or you would like a second look later, call me on {{phone}} — your details and the site information stay on file, so we can pick it up quickly.

All the best with the project.`,
    sms: `Estate Landscapers: thanks for the opportunity {{name}}, and all the best with the project. If anything changes, call {{phone}}. {{me}}`,
  },
  closeout: {
    subject: 'Closing off your enquiry',
    body: `Hi {{name}},

I have not been able to reach you about your {{job}} enquiry, so I will close it off for now rather than keep following up.

Nothing is lost — your details stay on file. If the project comes back around, call me on {{phone}} or reply to this message and we will pick it straight up.

All the best.`,
    sms: `Estate Landscapers: Hi {{name}}, I have closed your {{jobshort}} enquiry for now. If it comes back around, call {{phone}} any time. {{me}}`,
  },
};
// Stage names used before the 5-phase board. A lead or a saved template still carrying one
// gets the message of the stage it became.
const OLD_KEYS = { noanswer: 'call1', details: 'qualified', follow1: 'docsasked', follow2: 'docsasked', propose: 'docsin',
  confirm: 'visitbooked', remind: 'visitbooked', aftervisit: 'visitdone', quotechase: 'quotechase1' };

function niceDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { return d; }
}

// Build the message for a lead at a given stage. A template edited in Settings wins.
// Returns the full message (email / WhatsApp), the short SMS version, and the sign-off
// WhatsApp adds. A stage with no message of its own no longer falls back to a generic
// "following up": it gets the message of the step it belongs to.
function buildMessage({ lead, stage, sender, date, time, quoteLink, quoteNumber, estLink }) {
  const key = DEFAULTS[stage] ? stage : (OLD_KEYS[stage] || 'call1');
  const custom = settingGet('lead_tpl_' + stage) || settingGet('lead_tpl_' + key);
  const base = DEFAULTS[key];
  let subject = base.subject, body = base.body, sms = base.sms;
  if (custom) {
    try { const c = JSON.parse(custom); subject = c.subject || subject; body = c.body || body; sms = c.sms || sms; } catch (e) {}
  }
  const d = niceDate(date);
  const slot = d ? `on ${d}${time ? ' at ' + time : ''}` : (time ? `at ${time}` : 'this Friday');
  const job = String(lead.job_type || '').trim() || 'landscaping';
  // Lower-case the first word so it reads mid-sentence ("your turf, pebbles… enquiry").
  const jobText = /\b[A-Z]{2,}\b/.test(job) ? job : job.toLowerCase();
  const addr = String(lead.address || '').trim();
  const me = String(sender || 'Smit').trim().split(/\s+/)[0];
  const vals = {
    name: (lead.name || 'there').trim().split(/\s+/)[0],
    job: jobText, jobshort: jobText.length > 28 ? 'landscaping' : jobText,
    suburb: lead.suburb || lead.address || '', address: addr, at_address: addr ? ` at ${addr}` : '',
    me, date: d, time: time || '', slot,
    email: settingGet('company_email') || 'info@estatelandscapers.com.au',
    phone: settingGet('company_phone') || '',
    quotelink: quoteLink || '', quote: quoteNumber || '',
    estlink: estLink || '', code: lead.est_code || '', ref: lead.enquiry_ref || '',
  };
  const fill = s => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] != null ? vals[k] : '');
  // A paragraph that only exists to carry a link we do not have (no estimator page set, no
  // quote yet) is left out rather than sent with a gap in it.
  const have = { estlink: !!vals.estlink, quotelink: !!vals.quotelink };
  const paras = String(body || '').split('\n\n').filter(p => !(/\{\{estlink\}\}/.test(p) && !have.estlink) && !(p.trim() === '{{quotelink}}' && !have.quotelink));
  const tidy = s => s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return { subject: fill(subject).replace(/\s{2,}/g, ' ').trim(), body: tidy(fill(paras.join('\n\n'))), sms: fill(sms).replace(/\s{2,}/g, ' ').replace(/ +([.,])/g, '$1').trim(),
    signoff: [me, 'Estate Landscapers', vals.phone].filter(Boolean).join('\n'), template: key };
}

// What must be known before a lead can sensibly move to the next phase.
// These WARN, they don't block — except Won, which is enforced in the route.
const GATES = {
  2: [{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Mobile number' }],
  3: [{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Mobile number' },
      { key: 'address', label: 'Site address' }, { key: 'job_type', label: 'What they want done' },
      { key: 'docs_received', label: 'Drawings received' }],
  4: [{ key: 'quote_id', label: 'A quote built for this lead' }],
};
function gapsFor(lead, phase) {
  return (GATES[phase] || []).filter(g => !String(lead[g.key] || '').trim()).map(g => g.label);
}
function stageById(id) { return STAGES.find(s => s.id === id) || STAGES[0]; }
const LEGACY = { noanswer: 'call1', details: 'qualified', follow1: 'docsasked', follow2: 'docsasked',
  propose: 'docsin', confirm: 'visitbooked', remind: 'visitbooked', aftervisit: 'visitdone',
  quotechase: 'quotechase1', 'quotefinal': 'quotefinal' };
function normalise(id) { return LEGACY[id] || id; }
function phaseOf(stageId) { return stageById(normalise(stageId)).phase || 1; }
// Next date, from the stage's own timing. Working days would be over-engineering here.
function nextDueFrom(stageId, base) {
  const s = stageById(normalise(stageId));
  if (s.nextIn == null) return null;
  const d = base ? new Date(base) : new Date();
  d.setDate(d.getDate() + s.nextIn);
  return d.toISOString().slice(0, 10);
}
// A lead's real step is whatever its evidence says, not whichever button happened to be
// pressed. Building a quote outside the tool used to leave a lead stuck on Step 1.
// Default stage to land on when a lead is pulled to a step it has no recorded position in.
const PHASE_DEFAULT = { 1: 'call1', 2: 'qualified', 3: 'docsin', 4: 'quotesent' };

// Keys that live in call_answers but are NOT evidence a discovery call happened.
// `_prefill` and `scope` are written when a lead is CREATED — by the website form and by
// the hipages/email ingest — to pre-populate the pre-call checklist. Counting them as call
// answers pushed brand-new enquiries straight to Step 2 before anyone had phoned.
const NON_ANSWER_KEYS = ['_prefill', 'scope', 'notes'];

// Where the EVIDENCE says a lead is, ignoring whatever stage was last clicked.
// Step 4 is deliberately excluded — it is granted only by a live quote, in derivedStage.
function evidencePhase(lead, docsIn) {
  const cur = normalise(lead.stage || '');
  let answers = 0;
  try {
    answers = Object.keys(JSON.parse(lead.call_answers || '{}') || {})
      .filter(k => !NON_ANSWER_KEYS.includes(k)).length;
  } catch (e) {}
  // Step 3: drawings in, or a site visit already booked or completed.
  if (docsIn || ['docsin', 'visitbooked', 'visitdone'].includes(cur)) return 3;
  // Step 2: the discovery call was actually run — either recorded in the tool, or the
  // owner moved the lead there by hand. Most calls are made from a mobile and leave no
  // answers behind, so the recorded stage has to count as evidence too.
  if (answers > 0 || ['qualified', 'docsasked'].includes(cur)) return 2;
  return 1;
}

function derivedStage(lead, quote, docsIn) {
  if (quote && quote.status === 'accepted') return 'won';
  if (lead.status === 'Lost') return lead.stage && ['lost','closeout','disqualified'].includes(lead.stage) ? lead.stage : 'lost';
  const cur = normalise(lead.stage || 'call1');
  if (quote) {
    // A LIVE quote exists. If the recorded stage is already inside Step 4, keep it — the
    // chase position (3 / 5 / 14 days) is real information and must not be reset.
    const inStep4 = ['quotesent','quotechase1','quotechase2','quotefinal'].includes(cur);
    return inStep4 ? cur : 'quotesent';
  }
  // No live quote — Step 4 is not available, even if the stage says otherwise. This is how
  // a lead whose quote was deleted falls back instead of sitting at a step it can't prove.
  const ph = evidencePhase(lead, docsIn);
  return phaseOf(cur) === ph ? cur : PHASE_DEFAULT[ph];
}
module.exports = { STAGES, PHASES, GATES, normalise, derivedStage, evidencePhase, DEFAULTS, buildMessage, niceDate, gapsFor, stageById, phaseOf, nextDueFrom };
