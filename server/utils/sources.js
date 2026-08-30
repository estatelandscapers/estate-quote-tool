// Where enquiries come from. The list learns: anything typed into "Other" is remembered
// and appears as a button next time, so it never goes stale.
const { db } = require('../db');

const BUILTIN = [
  { g: 'Lead sites', o: ['hipages', 'ServiceSeeking', 'Airtasker', 'Bark', 'Houzz', 'Yellow Pages'] },
  { g: 'Online', o: ['Google search', 'Google Maps', 'Our website', 'Facebook', 'Instagram', 'TikTok', 'Local Facebook group'] },
  { g: 'Referral', o: ['Past client', 'Builder', 'Architect / designer', 'Friend or family', 'Another trade', 'Supplier / nursery', 'Real estate agent'] },
  { g: 'Seen us', o: ['Vehicle signage', 'Site sign at a job', 'Working in the street', 'Letterbox flyer'] },
  { g: 'Other', o: ['Repeat client', 'Walk-in', 'Local paper', 'Home show / expo'] },
];
const REFERRAL = BUILTIN.find(g => g.g === 'Referral').o;

function learned() {
  const known = new Set(BUILTIN.flatMap(g => g.o));
  return db.prepare("SELECT DISTINCT source s FROM leads WHERE source IS NOT NULL AND source<>''").all()
    .map(r => r.s).filter(s => s && !known.has(s));
}
function groups() {
  const extra = learned();
  const out = BUILTIN.map(g => ({ ...g }));
  if (extra.length) out.push({ g: 'Yours', o: extra });
  return out;
}
module.exports = { groups, REFERRAL, BUILTIN };
