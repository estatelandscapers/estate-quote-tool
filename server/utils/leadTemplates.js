// Follow-up message templates, ported from Smit's standalone console so the wording
// is the wording that already works. Every template is editable in Editor → Settings;
// these are only the defaults used until one is edited.
const { settingGet } = require('../db');

const STAGES = [
  { id: 'noanswer',   group: 'Enquiry',    label: 'Called — no answer',      when: 'Day 0',       date: false },
  { id: 'callback',   group: 'Enquiry',    label: 'Call-back arranged',      when: 'Booked',      date: true },
  { id: 'details',    group: 'Enquiry',    label: 'Spoke — ask for details', when: 'Same day',    date: true },
  { id: 'follow1',    group: 'Enquiry',    label: 'Follow-up 1',             when: '+24 hrs',     date: false },
  { id: 'follow2',    group: 'Enquiry',    label: 'Follow-up 2',             when: '+3–4 days',   date: false },
  { id: 'closeout',   group: 'Enquiry',    label: 'Close the enquiry out',   when: '+5–7 days',   date: false },
  { id: 'propose',    group: 'Site visit', label: 'Offer a visit time',      when: 'Booking',     date: true },
  { id: 'confirm',    group: 'Site visit', label: 'Confirm the booking',     when: 'Booked',      date: true },
  { id: 'remind',     group: 'Site visit', label: 'Reminder',                when: 'Day before',  date: true },
  { id: 'aftervisit', group: 'Site visit', label: 'Thanks — quote coming',   when: 'After visit', date: true },
  { id: 'quotesent',  group: 'Quote',      label: 'Quote sent',              when: 'Quote out',   date: false },
  { id: 'quotechase', group: 'Quote',      label: 'Chase the quote',         when: '+3–5 days',   date: false },
  { id: 'quotefinal', group: 'Quote',      label: 'Last check-in',           when: '+7–10 days',  date: false },
  { id: 'won',        group: 'Outcome',    label: 'They said yes',           when: 'Won',         date: false },
  { id: 'lost',       group: 'Outcome',    label: 'Not proceeding',          when: 'Closed',      date: false },
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

module.exports = { STAGES, DEFAULTS, buildMessage, niceDate };
