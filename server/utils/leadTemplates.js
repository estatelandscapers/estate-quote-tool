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

// {{name}} {{job}} {{suburb}} {{me}} {{date}} {{time}} {{slot}} {{email}} {{phone}} {{quotelink}}
const DEFAULTS = {
  noanswer: {
    subject: 'Your {{job}} enquiry — Estate Landscapers',
    body: `Hi {{name}},

{{me}} from Estate Landscapers here.

I just tried calling about your {{job}} enquiry. When would be a good time for a quick chat?

Happy to organise a free site visit and get a quote sorted for you.`,
  },
  callback: {
    subject: 'Speak {{date}}',
    body: `Hi {{name}},

Thanks for taking my call just now. I'll give you a ring back {{slot}} to run through your {{job}} project.

If anything changes before then, just reply to this message.`,
  },
  details: {
    subject: 'Estate Landscapers — your {{job}} project',
    body: `Hi {{name}},

{{me}} from Estate Landscapers here. As discussed, we're keen to look at your {{job}} job.

To review your project, could you please send the following to {{email}} or straight back to this message:

• Hydraulic drawings and DA consent (whichever you have)
• Site photos — front, backyard and access
• A brief scope of works, plus anything we should know about such as underground services

If you can get those across tonight or tomorrow, I'll come back to you with a ballpark figure.

If the numbers make sense, we'll do a site visit {{slot}} and have a detailed quotation to you shortly after for your final review and sign-off.

Any questions in the meantime, just give me a call.`,
  },
  follow1: {
    subject: 'Following up — your {{job}} request',
    body: `Hi {{name}},

Just following up on your {{job}} enquiry — did you get a chance to look at what I sent through?

Happy to answer any questions, or we can lock in a time for me to come out and measure up.

{{me}}
{{phone}}`,
  },
  follow2: {
    subject: 'Still keen to help — {{job}}',
    body: `Hi {{name}},

Checking in one more time about your {{job}} project.

If you're still weighing it up, no problem at all — just let me know either way and I'll keep the file open or close it off.

{{me}}
{{phone}}`,
  },
  closeout: {
    subject: 'Closing off your enquiry',
    body: `Hi {{name}},

I haven't heard back, so I'll close your {{job}} enquiry off for now.

If it comes back around later in the year, just give me a call and we'll pick it straight up.

All the best,
{{me}}`,
  },
  propose: {
    subject: 'Site visit — {{job}}',
    body: `Hi {{name}},

I can come out and measure up for the {{job}}. I have {{slot}} free — does that suit?

If another time works better, let me know what you're free and I'll fit around it.

{{me}}`,
  },
  confirm: {
    subject: 'Confirmed — site visit {{date}}',
    body: `Hi {{name}},

Confirming I'll be out {{slot}} to measure up for the {{job}}.

It helps if I can get to the whole area on the day. If anything changes, just give me a call.

{{me}}
{{phone}}`,
  },
  remind: {
    subject: 'Tomorrow — site visit',
    body: `Hi {{name}},

Quick reminder I'm coming out {{slot}} for the {{job}} measure-up.

See you then,
{{me}}`,
  },
  aftervisit: {
    subject: 'Thanks for your time today',
    body: `Hi {{name}},

Thanks for your time today. I've got everything I need for the {{job}}.

I'll have the quote across to you shortly — it'll show a few options so you can compare.

{{me}}`,
  },
  quotesent: {
    subject: 'Your quote — Estate Landscapers',
    body: `Hi {{name}},

Your quote for the {{job}} is ready:

{{quotelink}}

It shows three levels of finish so you can compare. Tap through and let me know your thoughts.

{{me}}
{{phone}}`,
  },
  quotechase: {
    subject: 'Your quote — any questions?',
    body: `Hi {{name}},

Just checking you got the quote through alright:

{{quotelink}}

Happy to walk you through any of it, or adjust the scope if something isn't quite right.

{{me}}`,
  },
  quotefinal: {
    subject: 'Last check-in on your quote',
    body: `Hi {{name}},

Last check-in on the {{job}} quote.

If you'd like to go ahead, just tap Accept on the link and I'll get you into the schedule. If it's not proceeding, no problem — just let me know so I can close it off.

{{quotelink}}

{{me}}`,
  },
  won: {
    subject: "Great news — let's get started",
    body: `Hi {{name}},

Thanks for going ahead with the {{job}} — much appreciated.

I'll be in touch shortly with start dates and what happens next.

{{me}}`,
  },
  lost: {
    subject: 'Thanks for the opportunity',
    body: `Hi {{name}},

Thanks for the opportunity to quote on your {{job}}. Sorry we couldn't make it work this time.

If anything changes down the track, you know where to find us.

All the best,
{{me}}`,
  },
};

function niceDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { return d; }
}

// Build a message for a lead at a given stage. Any template edited in Settings wins.
function buildMessage({ lead, stage, sender, date, time, quoteLink }) {
  const custom = settingGet('lead_tpl_' + stage);
  const base = DEFAULTS[stage] || DEFAULTS.follow1;
  let subject = base.subject, body = base.body;
  if (custom) {
    try { const c = JSON.parse(custom); subject = c.subject || subject; body = c.body || body; } catch (e) {}
  }
  const d = niceDate(date);
  const slot = d ? `on ${d}${time ? ' at ' + time : ''}` : (time ? `at ${time}` : 'this week');
  const vals = {
    name: (lead.name || 'there').trim().split(/\s+/)[0],
    job: lead.job_type || 'landscaping',
    suburb: lead.suburb || lead.address || '',
    me: sender || 'Smit',
    date: d, time: time || '', slot,
    email: settingGet('company_email') || 'info@estatelandscapers.com.au',
    phone: settingGet('company_phone') || '',
    quotelink: quoteLink || '',
  };
  const fill = s => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] != null ? vals[k] : '');
  return { subject: fill(subject), body: fill(body).replace(/\n{3,}/g, '\n\n').trim() };
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

// Where the EVIDENCE says a lead is, ignoring whatever stage was last clicked.
// Step 4 is deliberately excluded — it is granted only by a live quote, in derivedStage.
function evidencePhase(lead, docsIn) {
  const cur = normalise(lead.stage || '');
  let answers = 0;
  try { answers = Object.keys(JSON.parse(lead.call_answers || '{}') || {}).length; } catch (e) {}
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
