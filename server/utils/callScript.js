// The call script. This is data, not code — every question, option and threshold is
// here so it can be changed without touching the app.
const { db, settingGet } = require('../db');

// ---- thresholds (Editor settings, defaults here) ----------------------------
const T = () => ({
  minAccess: +(settingGet('access_min') || 800),          // below this we decline the job
  difficultTo: +(settingGet('access_difficult_to') || 1200), // 800–1200 = difficult access
  narrowTo: +(settingGet('access_narrow_to') || 1800),    // 1200–1800 = narrow side access
  stepRise: +(settingGet('step_rise_mm') || 170),
  steepFall: +(settingGet('slope_steep_mm') || 800),      // fall at/above this = steep slope
  maxWallHeight: +(settingGet('rw_max_height_mm') || 1200),
});

// ---- what a slider maps to in the price list ---------------------------------
// code: price item · unit label · slider max/step · plain-English hints
const SIZES = [
  { id: 'turf',    code: 'GT', label: 'Turf',                unit: 'm²', max: 400, step: 10, ask: 'How much lawn?' },
  { id: 'beds',    code: 'GM', label: 'Garden beds & mulch', unit: 'm²', max: 200, step: 5,  ask: 'How much garden bed?' },
  { id: 'wall',    code: 'RW', label: 'Retaining wall',      unit: 'm',  max: 50,  step: 1,  ask: 'How many metres of wall?' },
  { id: 'drive',   code: 'CP', label: 'Concrete / driveway', unit: 'm²', max: 200, step: 5,  ask: 'How big is the driveway?' },
  { id: 'rock',    code: 'PW', label: 'Decorative rock',     unit: 'm²', max: 150, step: 5,  ask: 'How much rock?' },
  { id: 'fence',   code: 'FC', label: 'Fencing',             unit: 'm',  max: 100, step: 1,  ask: 'How many metres of fence?' },
  { id: 'gates',   code: 'FG', label: 'Gates',               unit: '',   max: 6,   step: 1,  ask: 'How many gates?' },
  { id: 'steppers',code: 'PC', label: 'Stepping stones',     unit: '',   max: 40,  step: 1,  ask: 'How many stepping stones?' },
];

// ---- the questions -----------------------------------------------------------
const STEPS = [
  { id: 'open', section: 'Open', title: 'Reach the person',
    say: "Hi, is that {{first}}? It's {{me}} calling from Estate Landscapers — you put through an enquiry{{via}}. Is now an alright time for a quick chat?",
    type: 'outcome',
    options: [
      { v: 'talk',    label: 'Happy to talk' },
      { v: 'callback',label: 'Busy — call back', ends: true, stage: 'callback', wantsWhen: true },
      { v: 'noanswer',label: 'No answer',        ends: true, stage: 'noanswer' },
      { v: 'notint',  label: 'Not interested',   ends: true, stage: 'closeout' },
      { v: 'wrong',   label: 'Wrong number',     ends: true, stage: 'closeout', noMessage: true },
    ] },

  { id: 'property', section: 'Property', title: 'New build or existing',
    say: "Before we get into what you want done — is this a new build, or an existing property?",
    type: 'single', key: 'propertyType',
    options: [{ v: 'new', label: 'New build' }, { v: 'existing', label: 'Existing home' },
              { v: 'reno', label: 'Renovation in progress' }, { v: 'investment', label: 'Investment / rental' }] },

  { id: 'builder', section: 'Property', title: 'Builder', showIf: { propertyType: ['new'] },
    say: "Who's the builder?",
    type: 'single', key: 'builder', other: true,
    options: [{ v: 'Metricon' }, { v: 'Rawson' }, { v: 'Clarendon' }, { v: 'Masterton' }, { v: 'Owner-builder' }] },

  { id: 'handover', section: 'Property', title: 'Handover', showIf: { propertyType: ['new'] },
    say: "When's handover?",
    type: 'single', key: 'handover',
    options: [{ v: 'done', label: 'Already handed over' }, { v: '1m', label: 'Within a month' },
              { v: '1-3m', label: '1–3 months' }, { v: '3-6m', label: '3–6 months' },
              { v: '6m+', label: 'More than 6 months' }, { v: 'unknown', label: 'Not sure yet' }] },

  { id: 'start', section: 'Property', title: 'When on site', showIf: { propertyType: ['new'] },
    say: "And when would you want us on site?",
    type: 'single', key: 'startWhen', weeks: true, month: true,
    options: [{ v: 'after', label: 'Straight after handover' }, { v: 'month-after', label: 'Within a month of handover' },
              { v: 'flexible', label: 'Flexible' }] },

  { id: 'plans', section: 'Property', title: 'Drawings', showIf: { propertyType: ['new', 'reno'] },
    say: "Do you have the drawings from the builder — architectural, hydraulic, or the DA consent?",
    type: 'multi', key: 'plans',
    options: [{ v: 'architectural', label: 'Architectural drawings' }, { v: 'hydraulic', label: 'Hydraulic drawings' },
              { v: 'da', label: 'DA consent' }, { v: 'landscape', label: 'Landscape plan' },
              { v: 'none', label: 'None yet' }, { v: 'unknown', label: "Doesn't know" }] },

  { id: 'existing', section: 'Property', title: "What's there now", showIf: { propertyType: ['existing', 'reno', 'investment'] },
    say: "Is there anything in the area now that needs to come out — old paving, a shed, dead lawn, an existing retaining wall?",
    type: 'multi', key: 'toRemove',
    options: [{ v: 'nothing', label: 'Nothing — bare' }, { v: 'turf', label: 'Old lawn / turf' },
              { v: 'paving', label: 'Old paving or concrete' }, { v: 'fence', label: 'Old fence' },
              { v: 'shed', label: 'Shed or structure' }, { v: 'wall', label: 'Existing retaining wall' }] },

  { id: 'scope', section: 'Scope', title: 'What they want done',
    say: "So what are you looking to have done? Just talk me through it.",
    type: 'multi', key: 'scope',
    options: [{ v: 'turf', label: 'Turf' }, { v: 'beds', label: 'Garden beds & mulch' },
              { v: 'wall', label: 'Retaining wall' }, { v: 'drive', label: 'Concrete / driveway' },
              { v: 'rock', label: 'Decorative rock' }, { v: 'fence', label: 'Fencing' },
              { v: 'gates', label: 'Gates' }, { v: 'steppers', label: 'Stepping stones' },
              { v: 'planting', label: 'Planting' }, { v: 'drainage', label: 'Drainage' },
              { v: 'unsure', label: 'Not sure — wants advice' }] },

  { id: 'area', section: 'Scope', title: 'Which part of the block',
    say: "Is that the front, the back, or the whole block?",
    type: 'single', key: 'areaOfBlock',
    options: [{ v: 'front', label: 'Front only' }, { v: 'back', label: 'Back only' },
              { v: 'both', label: 'Both' }, { v: 'whole', label: 'Whole block' }, { v: 'side', label: 'Side only' }] },

  { id: 'sizes', section: 'Scope', title: 'Roughly how much',
    say: "Roughly how much of each — I'll give you a ballpark on the phone.",
    type: 'sizes' },

  { id: 'access', section: 'Site', title: 'Access width',
    say: "Walk down the side of the house for me — at the narrowest point, usually the gate, how wide is it? If you're not sure, is it wider or narrower than a wheelie bin?",
    type: 'slider', key: 'accessMm', min: 400, max: 3000, step: 50, def: 1200, unit: 'mm', unknown: true },

  { id: 'steps', section: 'Site', title: 'Steps in the access',
    say: "How many steps are there from the back door down to the lawn? And any steps along the side access?",
    type: 'slider', key: 'steps', min: 0, max: 20, step: 1, def: 0, unit: 'steps', unknown: true },

  { id: 'fall', section: 'Site', title: 'Fall across the yard',
    say: "Stand at the back door and look at the back fence — is the ground there level with you, or higher or lower? Roughly knee, waist, chest, or over your head?",
    type: 'slider', key: 'fallMm', min: 0, max: 2500, step: 100, def: 0, unit: 'mm', unknown: true, bodyScale: true },

  { id: 'vehicle', section: 'Site', title: 'Vehicle access',
    say: "Can a ute and trailer get to where the work is, or does everything come through the side?",
    type: 'single', key: 'vehicle',
    options: [{ v: 'drive', label: 'Drives right in' }, { v: 'side', label: 'Side access only' },
              { v: 'house', label: 'Through the house' }, { v: 'unknown', label: 'Not sure' }] },

  { id: 'services', section: 'Site', title: 'Services & obstacles',
    say: "Anything we should know about underground — pool, pipes, a sewer line, big trees?",
    type: 'multi', key: 'services',
    options: [{ v: 'none', label: 'Nothing known' }, { v: 'pool', label: 'Pool' },
              { v: 'sewer', label: 'Sewer / stormwater' }, { v: 'trees', label: 'Large trees' },
              { v: 'irrigation', label: 'Irrigation' }, { v: 'neighbour', label: 'Retaining to neighbour' },
              { v: 'unknown', label: "Doesn't know" }] },

  { id: 'timing', section: 'Timing', title: 'When', showIf: { propertyType: ['existing', 'reno', 'investment'] },
    say: "When are you hoping to get it under way?",
    type: 'single', key: 'timing',
    options: [{ v: 'asap', label: 'ASAP' }, { v: '2-4w', label: '2–4 weeks' }, { v: '1-3m', label: '1–3 months' },
              { v: '3m+', label: '3+ months' }, { v: 'pricing', label: 'Just pricing for now' }] },

  { id: 'driver', section: 'Timing', title: "What's driving the date",
    say: "Is there anything driving that — handover, an event, other trades finishing?",
    type: 'single', key: 'driver',
    options: [{ v: 'handover', label: 'Handover' }, { v: 'event', label: 'Event / party' },
              { v: 'trades', label: 'Other trades' }, { v: 'selling', label: 'Selling' },
              { v: 'none', label: 'Nothing specific' }] },

  { id: 'quotes', section: 'Decision', title: 'Other quotes',
    say: "Have you had other quotes so far?",
    type: 'single', key: 'otherQuotes',
    options: [{ v: 'first', label: "We're the first" }, { v: 'one', label: 'One other' },
              { v: 'two+', label: 'Two or more' }, { v: 'wontsay', label: "Won't say" }] },

  { id: 'decision', section: 'Decision', title: 'Who decides',
    say: "Is it just yourself deciding, or is there a partner involved as well?",
    type: 'single', key: 'decisionMaker',
    options: [{ v: 'them', label: 'Just them' }, { v: 'partner', label: 'Partner too' },
              { v: 'builder', label: 'Builder decides' }, { v: 'owner', label: 'Landlord / owner' }] },

  { id: 'ballpark', section: 'Close', title: 'Give the ballpark', type: 'ballpark' },

  { id: 'book', section: 'Close', title: 'Book the Friday', type: 'booking', key: 'visitOutcome',
    say: "Great — site visits are Fridays. I've got {{friday1}} or {{friday2}} free. Which suits?",
    options: [{ v: 'booked', label: 'Books a Friday' }, { v: 'nofri', label: "Fridays don't work" },
              { v: 'think', label: 'Wants to think about it' }, { v: 'notready', label: 'Not ready' }] },

  { id: 'source', section: 'Close', title: 'How they found us',
    say: "Last thing — how did you come across us?",
    type: 'single', key: 'source', other: true, referrerFor: ['Past client', 'Builder', 'Architect / designer', 'Friend or family', 'Another trade', 'Supplier / nursery', 'Real estate agent'],
    groups: [
      { g: 'Lead sites', o: ['hipages', 'ServiceSeeking', 'Airtasker', 'Bark', 'Houzz', 'Yellow Pages'] },
      { g: 'Online', o: ['Google search', 'Google Maps', 'Our website', 'Facebook', 'Instagram', 'TikTok', 'Local Facebook group'] },
      { g: 'Referral — who?', o: ['Past client', 'Builder', 'Architect / designer', 'Friend or family', 'Another trade', 'Supplier / nursery', 'Real estate agent'] },
      { g: 'Seen us', o: ['Vehicle signage', 'Site sign at a job', 'Working in the street', 'Letterbox flyer'] },
      { g: 'Other', o: ['Repeat client', 'Local paper', 'Home show / expo'] },
    ] },
];

// ---- ballpark ---------------------------------------------------------------
function rate(code) {
  const p = db.prepare('SELECT basic_sell, standard_sell, premium_sell FROM price_items WHERE code=?').get(code);
  if (!p) return null;
  return { lo: p.basic_sell || 0, hi: p.premium_sell || p.standard_sell || 0 };
}

// Everything the client couldn't answer is EXCLUDED, never guessed.
function ballpark(a) {
  const t = T();
  const inc = [], exc = [], sur = [];
  let lo = 0, hi = 0;

  if ((a.accessMm != null) && a.accessMm < t.minAccess) {
    return { decline: true, reason: `Access ${a.accessMm}mm is below our ${t.minAccess}mm minimum — no machine fits.` };
  }

  const est = rate('PL');
  if (est) { lo += est.lo; hi += est.lo; inc.push({ name: 'Establishment, supervision & insurances', qty: '1', lo: est.lo, hi: est.lo }); }

  (a.scope || []).forEach(s => {
    const size = SIZES.find(x => x.id === s);
    if (!size) {
      if (s === 'planting') exc.push('Planting — priced from the plan');
      if (s === 'drainage') exc.push('Drainage — needs levels from site');
      if (s === 'unsure') exc.push('Scope not settled — wants advice');
      return;
    }
    const q = (a.sizes || {})[s];
    if (q == null || q === 'unknown') { exc.push(`${size.label} — size not known`); return; }
    if (!q) return;
    const r = rate(size.code);
    if (!r) { exc.push(`${size.label} — no rate on file`); return; }
    lo += q * r.lo; hi += q * r.hi;
    inc.push({ name: size.label, qty: `${q} ${size.unit}`.trim(), lo: q * r.lo, hi: q * r.hi });
  });

  // A wall taller than the standard rate covers needs engineering — exclude it.
  if (a.fallMm != null && a.fallMm !== 'unknown' && a.fallMm > t.maxWallHeight && (a.scope || []).includes('wall')) {
    exc.push(`Retaining over ${t.maxWallHeight}mm — needs engineering, outside the standard rate`);
  }

  // site condition surcharges
  const add = (name, amount, why, pct) => { sur.push({ name, amount, why, pct }); };
  if (a.accessMm == null || a.accessMm === 'unknown') exc.push('Access width not measured');
  else if (a.accessMm < t.difficultTo) add('Difficult access', null, `${a.accessMm}mm — excavator only`, 10);
  else if (a.accessMm < t.narrowTo) add('Narrow side access', 750, `${a.accessMm}mm — constrained handling`);

  if (a.steps === 'unknown' || a.steps == null) exc.push('Steps not counted');
  else if (a.steps >= 5 && !sur.find(s => s.name === 'Difficult access')) add('Difficult access', null, `${a.steps} steps — significant hand-carting`, 10);

  if (a.fallMm === 'unknown' || a.fallMm == null) exc.push('Fall across the yard not assessed');
  else if (a.fallMm >= t.steepFall) add('Steep slope', null, `${(a.fallMm / 1000).toFixed(1)}m fall`, 15);

  if (a.vehicle === 'side' || a.vehicle === 'house') add('Rear yard — no vehicle access', 1200, a.vehicle === 'house' ? 'through the house only' : 'everything through the side');
  if (a.vehicle === 'unknown') exc.push('Vehicle access unknown');
  if ((a.services || []).includes('unknown')) exc.push('Underground services unknown');
  if ((a.services || []).includes('sewer')) exc.push('Sewer / stormwater — needs locating before pricing');

  const pct = sur.filter(s => s.pct).reduce((n, s) => n + s.pct, 0);
  const fixed = sur.filter(s => s.amount).reduce((n, s) => n + s.amount, 0);
  lo = lo * (1 + pct / 100) + fixed;
  hi = hi * (1 + pct / 100) + fixed;

  const gst = 1.1;
  const round = n => Math.round(n / 1000) * 1000;
  return {
    decline: false, priced: inc.length > 1 || (inc.length === 1 && (a.scope || []).length === 0),
    inc, exc, sur,
    exLo: Math.round(lo), exHi: Math.round(hi),
    incLo: round(lo * gst), incHi: round(hi * gst),
    tooUnknown: inc.length <= 1,
  };
}

const words = n => {
  const k = Math.round(n / 1000);
  const w = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve',
    'thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const t = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  if (k < 20) return w[k] || String(k);
  if (k < 100) { const a = Math.floor(k / 10), b = k % 10; return t[a] + (b ? '-' + w[b] : ''); }
  return String(k);
};

// The exact words the rep reads out.
function ballparkScript(bp, a) {
  if (bp.decline) {
    return `I'll be upfront with you — with access under 800mm we can't get any machinery down the side at all, so everything would be hand-carried. That pushes the cost up to a point where it stops being fair value for you, so it's not one we'd take on.

I'd rather tell you now than have you waiting on a quote. If the access can be opened up at all — a fence panel out, or through the neighbour for a day — give me a call back and we'll take another look.`;
  }
  if (bp.tooUnknown) {
    return `There's a bit I'd need to see before I could put a number on it — I'd rather look at it properly than give you a figure that turns out to be wrong.

Site visits are Fridays. Can I come out and take a look?`;
  }
  const names = bp.inc.filter(i => !/Establishment/.test(i.name)).map(i => i.label || i.name.toLowerCase());
  const scope = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : (names[0] || 'the works');
  const exclLine = bp.exc.length
    ? `\n\nThat doesn't include the ${bp.exc.map(e => e.split(' — ')[0].toLowerCase()).join(' or the ')} — I'll need to see ${bp.exc.length > 1 ? 'those' : 'that'} on site before I can put a number on ${bp.exc.length > 1 ? 'them' : 'it'}.`
    : '';
  return `Based on what you've told me — the ${scope} — something like this usually lands somewhere between ${words(bp.incLo)} and ${words(bp.incHi)} thousand.${exclLine}

That's a ballpark off the phone, subject to the site visit, final measurements and which finishes you choose. Does that sound about right for you?`;
}

// Next two Fridays
function nextFridays(n = 2) {
  const out = []; const d = new Date();
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 5) out.push(new Date(d));
  }
  return out.map(x => ({ iso: x.toISOString().slice(0, 10),
    label: x.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) }));
}

module.exports = { STEPS, SIZES, T, ballpark, ballparkScript, nextFridays, words };
