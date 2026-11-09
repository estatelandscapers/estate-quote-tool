// ---------------------------------------------------------------------------
// Marketing — Meta and Google Ads performance tied back to the enquiries, quotes
// and wins in this tool.
//
// STRUCTURE ONLY (v34 scaffold). The shapes, tables, routes and the two connection
// routes are in place; the Meta pull and the attribution sweep are written but
// untested against a live account. See MARKETING.md for what is done and what is left.
//
// Two connections, both read-only, both chosen to need no platform approval:
//   Meta    — Marketing API with a Business Manager SYSTEM USER token (never expires).
//             The tool pulls campaign + daily insights for the ad account each morning.
//   Google  — a Google Ads SCRIPT that runs inside the customer's own Google Ads account
//             and POSTs yesterday's campaign stats to /api/public/marketing/google with a
//             per-tool key. No developer token, no API application.
//
// Attribution: every lead gets a channel (meta | google | hipages | direct | referral |
// other) from its source, its UTM tags and any click id the website form passed. Cost per
// lead / quote / won job divide platform spend by THOSE leads — the figures the platforms
// show are kept separately as "platform-reported".
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { db, settingGet } = require('../db');

const PLATFORMS = ['meta', 'google'];
const META_API = 'https://graph.facebook.com/v21.0';

// ---- connections --------------------------------------------------------------------------

function connection(platform) {
  return db.prepare('SELECT * FROM ad_connections WHERE platform=?').get(platform) || { platform, status: 'disconnected' };
}
function connections() {
  return PLATFORMS.map(p => { const c = connection(p); return { platform: p, status: c.status || 'disconnected', accountId: c.account_id || null, accountName: c.account_name || null,
    currency: c.currency || null, lastPullAt: c.last_pull_at || null, lastError: c.last_error || null, hasSecret: !!c.secret }; });
}
function setConnection(platform, fields) {
  const cur = connection(platform);
  const row = { ...cur, ...fields, platform, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  db.prepare(`INSERT INTO ad_connections (platform,status,account_id,account_name,currency,secret,config,last_pull_at,last_error,updated_at)
    VALUES (@platform,@status,@account_id,@account_name,@currency,@secret,@config,@last_pull_at,@last_error,@updated_at)
    ON CONFLICT(platform) DO UPDATE SET status=excluded.status, account_id=excluded.account_id, account_name=excluded.account_name, currency=excluded.currency,
      secret=excluded.secret, config=excluded.config, last_pull_at=excluded.last_pull_at, last_error=excluded.last_error, updated_at=excluded.updated_at`)
    .run({ status: 'disconnected', account_id: null, account_name: null, currency: null, secret: null, config: null, last_pull_at: null, last_error: null, ...row });
  return connection(platform);
}
// The key the Google Ads script presents. Created on first request, shown on the tab.
function googleKey() {
  const c = connection('google');
  if (c.secret) return c.secret;
  const key = 'eq_g_' + crypto.randomBytes(18).toString('base64url');
  setConnection('google', { secret: key, status: c.status || 'disconnected' });
  return key;
}
function checkGoogleKey(given) {
  const want = connection('google').secret || '';
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest(), b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- Google: what the script sends ----------------------------------------------------------
// Body: { account: { id, name, currency }, days: [ { day: 'YYYY-MM-DD', campaigns: [ { id, name, status, budget, spend, impressions, clicks, conversions, impressionShare, adsLive, adsPaused } ] } ] }
function ingestGoogle(body) {
  const acct = body.account || {};
  let rows = 0;
  const upC = db.prepare(`INSERT INTO ad_campaigns (id,platform,campaign_id,name,status,daily_budget,ads_live,ads_paused,ads_in_review,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, daily_budget=excluded.daily_budget, ads_live=excluded.ads_live, ads_paused=excluded.ads_paused, ads_in_review=excluded.ads_in_review, updated_at=datetime('now')`);
  const upD = db.prepare(`INSERT INTO ad_daily (platform,day,campaign_id,spend,impressions,clicks,leads,impression_share,updated_at) VALUES ('google',?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(platform,day,campaign_id) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, leads=excluded.leads, impression_share=excluded.impression_share, updated_at=datetime('now')`);
  (body.days || []).forEach(d => (d.campaigns || []).forEach(c => {
    upC.run('google:' + c.id, 'google', String(c.id), c.name || '', c.status || null, c.budget != null ? Number(c.budget) : null, c.adsLive ?? null, c.adsPaused ?? null, null);
    upD.run(d.day, String(c.id), Number(c.spend || 0), Number(c.impressions || 0), Number(c.clicks || 0), Number(c.conversions || 0), c.impressionShare != null ? Number(c.impressionShare) : null);
    rows++;
  }));
  setConnection('google', { status: 'connected', account_id: acct.id || connection('google').account_id, account_name: acct.name || connection('google').account_name,
    currency: acct.currency || 'AUD', last_pull_at: new Date().toISOString().slice(0, 19).replace('T', ' '), last_error: null });
  return { rows };
}

// The script itself, served to the Marketing tab with the key filled in. Runs daily inside
// the customer's Google Ads account; pulls yesterday and the day before (late conversions).
function googleScript(baseUrl) {
  return `// Estate quote tool — Google Ads sync. Runs daily; sends campaign stats to the tool. Read-only.
var KEY = "${googleKey()}";
var URL = "${baseUrl.replace(/\/$/, '')}/api/public/marketing/google";
function main() {
  var acct = AdsApp.currentAccount();
  var out = { account: { id: acct.getCustomerId(), name: acct.getName(), currency: acct.getCurrencyCode() }, days: [] };
  var days = ['YESTERDAY'];
  var d2 = new Date(); d2.setDate(d2.getDate() - 2);
  var ymd = function (d) { return Utilities.formatDate(d, acct.getTimeZone(), 'yyyy-MM-dd'); };
  var y1 = new Date(); y1.setDate(y1.getDate() - 1);
  [[ymd(d2), ymd(d2)], [ymd(y1), ymd(y1)]].forEach(function (range) {
    var day = { day: range[0], campaigns: [] };
    var it = AdsApp.campaigns().withCondition("Status IN [ENABLED, PAUSED]").get();
    while (it.hasNext()) {
      var c = it.next(); var st = c.getStatsFor(range[0].replace(/-/g, ''), range[1].replace(/-/g, ''));
      var ads = c.ads(); var live = ads.withCondition("Status = ENABLED").get().totalNumEntities(); var paused = ads.withCondition("Status = PAUSED").get().totalNumEntities();
      day.campaigns.push({ id: c.getId(), name: c.getName(), status: c.isEnabled() ? 'ACTIVE' : 'PAUSED', budget: c.getBudget().getAmount(),
        spend: st.getCost(), impressions: st.getImpressions(), clicks: st.getClicks(), conversions: st.getConversions(),
        impressionShare: st.getSearchImpressionShare ? st.getSearchImpressionShare() : null, adsLive: live, adsPaused: paused });
    }
    out.days.push(day);
  });
  var res = UrlFetchApp.fetch(URL, { method: 'post', contentType: 'application/json', headers: { 'X-Marketing-Key': KEY }, payload: JSON.stringify(out), muteHttpExceptions: true });
  Logger.log('Estate quote tool: ' + res.getResponseCode() + ' ' + res.getContentText());
}
`;
}

// ---- Meta: pull with a system-user token -----------------------------------------------------
async function metaFetch(path, token, params = {}) {
  const u = new URL(META_API + path);
  Object.entries({ ...params, access_token: token }).forEach(([k, v]) => u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `Meta API ${r.status}`);
  return j;
}
// Step 1 of connecting: list the ad accounts the token can see, so the user picks one.
async function metaAccounts(token) {
  const j = await metaFetch('/me/adaccounts', token, { fields: 'id,name,account_id,currency,account_status' });
  return (j.data || []).map(a => ({ id: a.id, accountId: a.account_id, name: a.name, currency: a.currency, status: a.account_status }));
}
// Daily pull: campaigns (status, budget, ad counts) + per-day insights for the window.
async function pullMeta(days = 3) {
  const c = connection('meta');
  if (!c.secret || !c.account_id) return { ok: false, error: 'Meta not connected' };
  const acct = c.account_id.startsWith('act_') ? c.account_id : 'act_' + c.account_id;
  try {
    const camps = await metaFetch(`/${acct}/campaigns`, c.secret, { fields: 'id,name,status,effective_status,daily_budget,objective', limit: 200 });
    const upC = db.prepare(`INSERT INTO ad_campaigns (id,platform,campaign_id,name,status,daily_budget,objective,ads_live,ads_paused,ads_in_review,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, daily_budget=excluded.daily_budget, objective=excluded.objective, ads_live=excluded.ads_live, ads_paused=excluded.ads_paused, ads_in_review=excluded.ads_in_review, updated_at=datetime('now')`);
    for (const k of camps.data || []) {
      let live = null, paused = null, review = null;
      try { const ads = await metaFetch(`/${k.id}/ads`, c.secret, { fields: 'effective_status', limit: 200 });
        live = (ads.data || []).filter(a => a.effective_status === 'ACTIVE').length; paused = (ads.data || []).filter(a => a.effective_status === 'PAUSED').length; review = (ads.data || []).filter(a => /REVIEW|PENDING/.test(a.effective_status)).length; } catch (e) {}
      upC.run('meta:' + k.id, 'meta', k.id, k.name, k.effective_status || k.status, k.daily_budget != null ? Number(k.daily_budget) / 100 : null, k.objective || null, live, paused, review);
    }
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), until = new Date().toISOString().slice(0, 10);
    const ins = await metaFetch(`/${acct}/insights`, c.secret, { level: 'campaign', time_increment: 1, time_range: { since, until },
      fields: 'campaign_id,spend,impressions,clicks,reach,frequency,actions', limit: 500 });
    const upD = db.prepare(`INSERT INTO ad_daily (platform,day,campaign_id,spend,impressions,clicks,leads,reach,frequency,updated_at) VALUES ('meta',?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(platform,day,campaign_id) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, leads=excluded.leads, reach=excluded.reach, frequency=excluded.frequency, updated_at=datetime('now')`);
    (ins.data || []).forEach(r => {
      const leads = (r.actions || []).filter(a => /^lead$|onsite_conversion\.lead_grouped|offsite_conversion\.fb_pixel_lead/.test(a.action_type)).reduce((a, x) => a + Number(x.value || 0), 0);
      upD.run(r.date_start, r.campaign_id, Number(r.spend || 0), Number(r.impressions || 0), Number(r.clicks || 0), leads, r.reach != null ? Number(r.reach) : null, r.frequency != null ? Number(r.frequency) : null);
    });
    setConnection('meta', { status: 'connected', last_pull_at: new Date().toISOString().slice(0, 19).replace('T', ' '), last_error: null });
    return { ok: true, campaigns: (camps.data || []).length, rows: (ins.data || []).length };
  } catch (e) {
    setConnection('meta', { status: 'error', last_error: e.message });
    return { ok: false, error: e.message };
  }
}

// ---- attribution ---------------------------------------------------------------------------
// Which channel an enquiry came from. Source wins; UTM / click ids on a website enquiry
// refine it; anything else is direct. Stored on the lead so the figures are stable.
function channelOf(l) {
  const src = String(l.source || '').toLowerCase();
  const notes = String(l.notes || '');
  const utm = (notes.match(/Campaign:\s*([^\n]+)/) || [])[1] || '';
  if (/hipages/.test(src)) return 'hipages';
  if (/facebook|instagram|meta/.test(src) || /source=(facebook|instagram|meta|fb|ig)\b/i.test(utm) || l.click_id && /^fb/.test(l.click_id)) return 'meta';
  if (/google|adwords|search ad/.test(src) || /source=google\b.*medium=(cpc|ppc|paid)/i.test(utm) || /medium=cpc/i.test(utm) || l.click_id && !/^fb/.test(l.click_id)) return 'google';
  if (/referr|word of mouth|friend|repeat|existing/.test(src)) return 'referral';
  if (/website|our website|google search|organic|direct/.test(src)) return 'direct';
  return src ? 'other' : 'direct';
}
function campaignRefOf(l) {
  const m = String(l.notes || '').match(/Campaign:\s*([^\n]+)/);
  if (!m) return null;
  const c = (m[1].match(/campaign=([^\s]+)/) || [])[1];
  return c || null;
}
// Fill channel/campaign_ref on leads that have none yet (new ones get it on insert via sweep).
function attributeLeads() {
  const rows = db.prepare("SELECT * FROM leads WHERE channel IS NULL OR channel=''").all();
  const up = db.prepare('UPDATE leads SET channel=?, campaign_ref=COALESCE(campaign_ref, ?) WHERE id=?');
  rows.forEach(l => up.run(channelOf(l), campaignRefOf(l), l.id));
  return rows.length;
}

// ---- summary for the tab -------------------------------------------------------------------
// TODO (Opus): finish — this returns the shape the tab needs; several figures are stubs.
function summary(days = 30) {
  attributeLeads();
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const prevSince = new Date(Date.now() - 2 * days * 864e5).toISOString().slice(0, 10);
  const spendBy = p => db.prepare('SELECT COALESCE(SUM(spend),0) s, COALESCE(SUM(leads),0) l, COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i FROM ad_daily WHERE platform=? AND day>=?').get(p, since);
  const prevSpend = db.prepare('SELECT COALESCE(SUM(spend),0) s FROM ad_daily WHERE day>=? AND day<?').get(prevSince, since).s;
  const meta = spendBy('meta'), google = spendBy('google');
  const campaigns = db.prepare('SELECT * FROM ad_campaigns').all().map(c => {
    const d = db.prepare('SELECT COALESCE(SUM(spend),0) s, COALESCE(SUM(leads),0) l, COALESCE(SUM(clicks),0) k, COALESCE(SUM(impressions),0) i, AVG(frequency) f, AVG(impression_share) sh FROM ad_daily WHERE platform=? AND campaign_id=? AND day>=?').get(c.platform, c.campaign_id, since);
    const toolLeads = db.prepare('SELECT COUNT(*) n, SUM(quote_id IS NOT NULL) q FROM leads WHERE channel=? AND campaign_ref=? AND created_at>=?').get(c.platform, c.campaign_id, since);
    return { id: c.id, platform: c.platform, campaignId: c.campaign_id, name: c.name, status: c.status, dailyBudget: c.daily_budget, adsLive: c.ads_live, adsPaused: c.ads_paused, adsInReview: c.ads_in_review,
      spend: Math.round(d.s), platformLeads: d.l, clicks: d.k, impressions: d.i, frequency: d.f, impressionShare: d.sh, toolLeads: toolLeads.n, toolQuoted: toolLeads.q || 0,
      cpl: d.l ? Math.round(d.s / d.l) : null };
  });
  const leadsBy = ch => db.prepare("SELECT COUNT(*) n, SUM(quote_id IS NOT NULL) q, SUM(status='Won') w FROM leads WHERE channel=? AND created_at>=?").get(ch, since);
  const channels = {}; ['meta', 'google', 'hipages', 'direct', 'referral', 'other'].forEach(ch => channels[ch] = leadsBy(ch));
  const adLeads = (channels.meta.n || 0) + (channels.google.n || 0);
  const adQuoted = (channels.meta.q || 0) + (channels.google.q || 0);
  const adWon = (channels.meta.w || 0) + (channels.google.w || 0);
  const spend = meta.s + google.s;
  // Won value from ad-channel leads (quotes accepted, linked by lead_id)
  const wonValue = db.prepare("SELECT COALESCE(SUM(COALESCE(q.quoted_sell, q.cached_value_ex, 0)),0) v FROM quotes q JOIN leads l ON l.id=q.lead_id WHERE q.status='accepted' AND l.channel IN ('meta','google') AND l.created_at>=?").get(since).v;
  const budgetDaily = db.prepare("SELECT COALESCE(SUM(daily_budget),0) b FROM ad_campaigns WHERE status='ACTIVE'").get().b;
  // Speed to lead: ad leads first contacted within 2 h (first call/message after creation)
  const slow = db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.channel IN ('meta','google') AND l.created_at>=? AND NOT EXISTS (
      SELECT 1 FROM lead_messages m WHERE m.lead_id=l.id AND m.channel IN ('call','whatsapp','sms','email') AND m.sent_by<>'client' AND m.sent_by<>'' AND (julianday(m.created_at)-julianday(l.created_at))*24 <= 2)`).get(since).n;
  return {
    days, since, connections: connections(),
    spend: { total: Math.round(spend), meta: Math.round(meta.s), google: Math.round(google.s), perDay: Math.round(spend / days), budgetPerDay: Math.round(budgetDaily), prev: Math.round(prevSpend) },
    ads: { live: campaigns.filter(c => c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), paused: campaigns.reduce((a, c) => a + (c.adsPaused || 0), 0), inReview: campaigns.reduce((a, c) => a + (c.adsInReview || 0), 0),
      campaigns: campaigns.filter(c => c.status === 'ACTIVE').length, byPlatform: { meta: { ads: campaigns.filter(c => c.platform === 'meta' && c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), campaigns: campaigns.filter(c => c.platform === 'meta' && c.status === 'ACTIVE').length },
        google: { ads: campaigns.filter(c => c.platform === 'google' && c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), campaigns: campaigns.filter(c => c.platform === 'google' && c.status === 'ACTIVE').length } } },
    leads: { tool: adLeads, meta: channels.meta.n || 0, google: channels.google.n || 0, platformReported: (meta.l || 0) + (google.l || 0), quoted: adQuoted, won: adWon, wonValue: Math.round(wonValue), slow },
    cost: { perLead: adLeads ? Math.round(spend / adLeads) : null, perLeadMeta: channels.meta.n ? Math.round(meta.s / channels.meta.n) : null, perLeadGoogle: channels.google.n ? Math.round(google.s / channels.google.n) : null,
      perQuote: adQuoted ? Math.round(spend / adQuoted) : null, perWon: adWon ? Math.round(spend / adWon) : null, roas: spend > 0 ? Math.round(wonValue / spend * 10) / 10 : null },
    channels, campaigns: campaigns.sort((a, b) => b.spend - a.spend),
    levers: [],   // TODO (Opus): rules — CPL > 2× average; frequency > 3.5; slow leads; best campaign pacing < 95%; platform vs tool lead gap
  };
}

// ---- scheduler: Meta pull at 6 am Sydney, attribution sweep hourly --------------------------
function start() {
  attributeLeads();
  setInterval(() => { try { attributeLeads(); } catch (e) {} }, 3600e3).unref();
  // Daily Meta pull. Google pushes itself from the Ads script.
  const tick = async () => {
    try {
      const h = parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(new Date()), 10);
      const c = connection('meta');
      if (h === 6 && c.status !== 'disconnected' && c.secret && String(c.last_pull_at || '').slice(0, 10) !== new Date().toISOString().slice(0, 10)) await pullMeta(3);
    } catch (e) { console.error('[marketing] pull', e.message); }
  };
  setInterval(tick, 15 * 60e3).unref();
}

module.exports = { PLATFORMS, connection, connections, setConnection, googleKey, checkGoogleKey, ingestGoogle, googleScript, metaAccounts, pullMeta, channelOf, attributeLeads, summary, start };
