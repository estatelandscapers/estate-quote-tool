// Enquiry reference numbers: ENQ-YYYY-MMNN (NN resets monthly, grows past 99).
//
// Lived inside the website enquiry route until the online estimator needed to give a
// reference to leads that arrive by other doors (hipages, a lead typed in by hand). One
// counter, one format, wherever the lead came from.
//
// Sydney time, not server time: Railway runs UTC, so without this the month would roll
// over at 10 or 11 am on the 1st and the first morning's enquiries would be numbered into
// the previous month.
const { settingGet, settingSet } = require('../db');

function sydneyParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { year: p.year, month: p.month, day: p.day, ymd: `${p.year}-${p.month}-${p.day}` };
}

function nextRef() {
  const { year, month } = sydneyParts();
  const key = `enquiry_seq_${year}${month}`;
  const n = (parseInt(settingGet(key) || '0', 10) || 0) + 1;
  settingSet(key, String(n));
  return `ENQ-${year}-${month}${String(n).padStart(2, '0')}`;
}

module.exports = { sydneyParts, nextRef };
