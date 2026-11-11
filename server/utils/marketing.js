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
  const KEYS = ['status', 'account_id', 'account_name', 'currency', 'secret', 'config', 'last_pull_at', 'last_error'];
  const row = { platform, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  KEYS.forEach(k => { row[k] = fields[k] !== undefined ? fields[k] : (cur[k] !== undefined ? cur[k] : null); });
  db.prepare(`INSERT INTO ad_connections (platform,status,account_id,account_name,currency,secret,config,last_pull_at,last_error,updated_at)
    VALUES (@platform,@status,@account_id,@account_name,@currency,@secret,@config,@last_pull_at,@last_error,@updated_at)
    ON CONFLICT(platform) DO UPDATE SET status=excluded.status, account_id=excluded.account_id, account_name=excluded.account_name, currency=excluded.currency,
      secret=excluded.secret, config=excluded.config, last_pull_at=excluded.last_pull_at, last_error=excluded.last_error, updated_at=excluded.updated_at`)
    .run({ ...row, status: row.status || 'disconnected' });
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
async function metaPost(path, token, params = {}) {
  const body = new URLSearchParams(); Object.entries({ ...params, access_token: token }).forEach(([k, v]) => body.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
  const r = await fetch(META_API + path, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || `Meta API ${r.status}`);
  return j;
}

// ---- Lead ads, set up from here ---------------------------------------------------------------
// Meta's app dashboard often has no Webhooks menu, and subscribing a Page to an app has no
// button anywhere. Both are plain Graph calls, so the tool makes them:
//   1. which app the system-user token belongs to            GET  /app
//   2. register this tool's callback for Page `leadgen`       POST /{app}/subscriptions   (app token = id|secret)
//   3. the Pages the system user manages, with Page tokens    GET  /me/accounts
//   4. subscribe each Page to the app for `leadgen`           POST /{page}/subscribed_apps (Page token)
// Each step reports in plain words, so a missing permission says which one.
async function setupLeadAds(callbackUrl, { appSecret } = {}) {
  const { settingSet } = require('../db');
  const steps = []; const add = (ok, title, detail) => { steps.push({ ok, title, detail: detail || '' }); return ok; };
  const c = connection('meta');
  if (!c.secret) { add(false, 'Meta is not connected', 'Connect Meta above first (system-user token).'); return { ok: false, steps }; }
  if (appSecret) settingSet('meta_app_secret', String(appSecret).trim());
  const secret = settingGet('meta_app_secret');
  if (!secret) { add(false, 'App secret needed', 'Paste the app secret (developers.facebook.com → your app → App settings → Basic → App secret → Show).'); return { ok: false, steps }; }
  let verify = settingGet('meta_verify_token');
  if (!verify) { verify = 'eq_' + crypto.randomBytes(9).toString('base64url'); settingSet('meta_verify_token', verify); }
  let app;
  try { app = await metaFetch('/app', c.secret, { fields: 'id,name' }); add(true, `App found: ${app.name}`, 'id ' + app.id); }
  catch (e) { add(false, 'Could not read the app behind the token', e.message); return { ok: false, steps }; }
  try {
    await metaPost(`/${app.id}/subscriptions`, `${app.id}|${secret}`, { object: 'page', callback_url: callbackUrl, fields: 'leadgen', verify_token: verify, include_values: 'true' });
    add(true, 'Webhook registered with Meta', callbackUrl);
  } catch (e) {
    add(false, 'Meta would not register the webhook', /secret|validat|access token/i.test(e.message) ? e.message + ' — check the app secret is this app\'s.' : e.message);
    return { ok: false, steps, app };
  }
  let pages = [];
  try { const r = await metaFetch('/me/accounts', c.secret, { fields: 'id,name,access_token', limit: 100 }); pages = r.data || []; }
  catch (e) { add(false, 'Could not list your Pages', e.message + ' — the token needs pages_show_list.'); return { ok: false, steps, app }; }
  if (!pages.length) { add(false, 'The system user has no Page', 'Business settings → System users → quote-tool → Assign assets → Pages → your Page (full control), then generate a new token with pages_show_list, pages_manage_metadata, pages_read_engagement, leads_retrieval and reconnect.'); return { ok: false, steps, app }; }
  let any = false;
  for (const pg of pages) {
    try { await metaPost(`/${pg.id}/subscribed_apps`, pg.access_token, { subscribed_fields: 'leadgen' }); any = true; add(true, `Page subscribed: ${pg.name}`, 'lead-form submissions on this Page now come here'); }
    catch (e) { add(false, `Could not subscribe Page: ${pg.name}`, e.message + (/permission|pages_manage_metadata/i.test(e.message) ? ' — the token needs pages_manage_metadata and the system user needs full control of the Page.' : '')); }
  }
  setConnection('meta', { config: JSON.stringify({ ...(JSON.parse(c.config || '{}')), leadAds: { app: { id: app.id, name: app.name }, pages: pages.map(p => ({ id: p.id, name: p.name })), at: new Date().toISOString(), ok: any } }) });
  if (any) add(true, 'Two things only you can do in Meta', '1) App mode must be LIVE (top of the app dashboard) — in Development mode real leads are not delivered. 2) Business settings → Integrations → Leads access → your Page → CRMs → assign this app.');
  return { ok: any, steps, app };
}
function leadAdsStatus() {
  let cfg = {}; try { cfg = JSON.parse(connection('meta').config || '{}'); } catch (e) {}
  const last = db.prepare("SELECT created_at FROM leads WHERE click_id LIKE 'fbl:%' ORDER BY created_at DESC LIMIT 1").get();
  return { setUp: !!(cfg.leadAds && cfg.leadAds.ok), app: cfg.leadAds ? cfg.leadAds.app : null, pages: cfg.leadAds ? cfg.leadAds.pages : [], at: cfg.leadAds ? cfg.leadAds.at : null,
    hasSecret: !!settingGet('meta_app_secret'), lastLeadAt: last ? last.created_at : null };
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
  const src = String(l.source || '').toLowerCase().trim();
  const notes = String(l.notes || '');
  const utm = (notes.match(/Campaign:\s*([^\n]+)/) || [])[1] || '';
  const ck = String(l.click_id || '');
  // Paid signals first: a click id or a paid UTM beats whatever source was typed.
  if (/^fbl?:/.test(ck) || /source=(facebook|instagram|meta|fb|ig)\b/i.test(utm)) return 'meta';
  if (/^gl?:/.test(ck) || /medium=(cpc|ppc|paid)/i.test(utm)) return 'google';
  if (/hipages/.test(src)) return 'hipages';
  if (/local facebook group/.test(src)) return 'referral';            // a community post, not an ad
  if (/^(facebook|instagram)$|meta|facebook ad|instagram ad/.test(src)) return 'meta';
  if (/google ads|adwords|search ad|google \(paid\)|google ppc/.test(src)) return 'google';
  if (/serviceseeking|airtasker|bark|houzz|yellow pages|oneflare/.test(src)) return 'leadsite';
  if (/referr|past client|builder|architect|designer|friend|family|trade|supplier|nursery|real estate|repeat/.test(src)) return 'referral';
  if (/google search|google maps|website|organic|phone|walk-in|signage|site sign|street|flyer|letterbox|paper|expo|home show|tiktok/.test(src)) return 'direct';
  return src ? 'other' : 'direct';
}
// Called right after a website / estimator enquiry is inserted, with whatever the page
// passed: { utm: {utm_source,…} | JSON string, gclid, fbclid }. Stores the click id and
// campaign, and sets the channel straight away so the lead counts from minute one.
function captureAttribution(leadId, b = {}) {
  let utm = {};
  try { utm = typeof b.utm === 'string' ? JSON.parse(b.utm || '{}') : (b.utm || {}); } catch (e) {}
  const clip = (x, n) => x == null ? null : String(x).trim().slice(0, n) || null;
  const gclid = clip(b.gclid || utm.gclid || utm.gbraid || utm.wbraid, 200);
  const fbclid = clip(b.fbclid || utm.fbclid, 200);
  const clickId = fbclid ? 'fb:' + fbclid : gclid ? 'g:' + gclid : null;
  const campaign = clip(utm.utm_campaign || utm.campaign || b.utm_campaign, 120);
  const src = String(utm.utm_source || '').toLowerCase(), med = String(utm.utm_medium || '').toLowerCase();
  let channel = null;
  if (fbclid || /facebook|instagram|meta|^fb$|^ig$/.test(src)) channel = 'meta';
  else if (gclid || (/google/.test(src) && /cpc|ppc|paid|ads/.test(med))) channel = 'google';
  if (!clickId && !campaign && !channel) return null;
  db.prepare('UPDATE leads SET click_id=COALESCE(click_id, ?), campaign_ref=COALESCE(campaign_ref, ?), channel=COALESCE(?, channel) WHERE id=?')
    .run(clickId, campaign, channel, leadId);
  // Make it visible on the lead itself: an enquiry that arrived through the website from
  // an ad reads "Google Ads" / "Facebook Ads", not "Our website", with the campaign in
  // the first line of the notes.
  if (channel) {
    const l = db.prepare('SELECT source, notes FROM leads WHERE id=?').get(leadId);
    const label = channel === 'google' ? 'Google Ads' : (/instagram|^ig$/.test(src) ? 'Instagram Ads' : 'Facebook Ads');
    const camp = campaign ? (db.prepare('SELECT name FROM ad_campaigns WHERE platform=? AND campaign_id=?').get(channel, campaign) || {}).name || campaign : null;
    const line = `Came from: ${label}${camp ? ' · ' + camp : ''}${utm.utm_term ? ' · searched "' + clip(utm.utm_term, 80) + '"' : ''} (via the website)`;
    if (l && /^(our website|website)?$/i.test(l.source || '')) db.prepare('UPDATE leads SET source=?, notes=? WHERE id=?').run(label, line + '\n' + (l.notes || ''), leadId);
  }
  return { channel, campaign, clickId };
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

// Ad leads (Meta/Google) older than 2 h whose first human contact took longer than 2 h, or
// never happened. The cheapest lever there is: a lead called inside 2 h quotes far more often.
function slowLeads(since) {
  return db.prepare(`SELECT l.* FROM leads l WHERE l.channel IN ('meta','google') AND l.created_at>=?
      AND (julianday('now')-julianday(l.created_at))*24 > 2 AND NOT EXISTS (
      SELECT 1 FROM lead_messages m WHERE m.lead_id=l.id AND m.channel IN ('call','whatsapp','sms','email')
        AND COALESCE(m.sent_by,'') NOT IN ('client','','auto') AND (julianday(m.created_at)-julianday(l.created_at))*24 <= 2)
    ORDER BY l.created_at DESC`).all(since);
}
// Quote-to-lead rate for ad leads called inside 2 h vs later — the number the "speed" lever quotes.
function speedSplit(since) {
  const ads = db.prepare("SELECT * FROM leads WHERE channel IN ('meta','google') AND created_at>=? AND (julianday('now')-julianday(created_at))*24 > 2").all(since);
  const slowIds = new Set(slowLeads(since).map(l => l.id));
  const fast = ads.filter(l => !slowIds.has(l.id)), slow = ads.filter(l => slowIds.has(l.id));
  const rate = l => l.length ? Math.round(l.filter(x => x.quote_id).length / l.length * 100) : null;
  return { fast: rate(fast), fastN: fast.length, slow: rate(slow), slowN: slow.length };
}

// ---- levers: what to change, worked out from the numbers ------------------------------------
const ADS_URL = {
  meta: (acct, cid) => `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${String(acct || '').replace(/^act_/, '')}${cid ? '&selected_campaign_ids=' + cid : ''}`,
  google: (acct, cid) => `https://ads.google.com/aw/campaigns${cid ? '?campaignId=' + cid : ''}`,
};
function levers(S) {
  const out = [];
  const conn = { meta: connection('meta'), google: connection('google') };
  const url = (p, cid) => ADS_URL[p] ? ADS_URL[p](conn[p].account_id, cid) : null;
  const money = n => '$' + Math.round(n || 0).toLocaleString('en-AU');
  const withLeads = S.campaigns.filter(c => c.spend > 0);
  const totalSpend = withLeads.reduce((a, c) => a + c.spend, 0);
  const totalLeads = withLeads.reduce((a, c) => a + Math.max(c.toolLeads || 0, c.platformLeads || 0), 0);
  const avgCpl = totalLeads ? totalSpend / totalLeads : null;
  // 1. A campaign buying clicks, not leads
  withLeads.forEach(c => {
    const leads = Math.max(c.toolLeads || 0, c.platformLeads || 0);
    if (avgCpl && leads > 0 && c.spend / leads > 2 * avgCpl && c.spend >= 200)
      out.push({ level: 'r', title: `"${c.name}" costs ${Math.round(c.spend / leads / avgCpl * 10) / 10}× the average per lead`, body: `${money(c.spend)} for ${leads} lead${leads === 1 ? '' : 's'} (${money(c.spend / leads)} each, average ${money(avgCpl)}). Pause it or move its budget to a cheaper campaign.`, url: url(c.platform, c.campaignId), action: 'Open in ' + (c.platform === 'meta' ? 'Meta' : 'Google'), key: 'camp:' + c.id });
    else if (leads === 0 && c.spend >= 250 && c.status === 'ACTIVE')
      out.push({ level: 'r', title: `"${c.name}" has spent ${money(c.spend)} with no leads`, body: `Nothing has come through from it in ${S.days} days. Check the landing page and targeting, or pause it.`, url: url(c.platform, c.campaignId), action: 'Open in ' + (c.platform === 'meta' ? 'Meta' : 'Google'), key: 'camp:' + c.id });
  });
  // 2. Ad fatigue
  S.campaigns.filter(c => c.platform === 'meta' && c.frequency && c.frequency > 3.5 && c.status === 'ACTIVE').forEach(c =>
    out.push({ level: 'a', title: `"${c.name}" frequency is ${Math.round(c.frequency * 10) / 10}`, body: 'The same people are seeing this ad over and over. Refresh the creative or cap frequency around 2.5.', url: url('meta', c.campaignId), action: 'Open in Meta', key: 'freq:' + c.id }));
  // 3. Speed to lead
  if (S.leads.slow > 0) {
    const sp = S.speed || {};
    out.push({ level: 'a', title: `${S.leads.slow} ad lead${S.leads.slow === 1 ? '' : 's'} waited more than 2 hours`, body: (sp.fast != null && sp.slow != null ? `Ad leads called inside 2 h quoted at ${sp.fast}%; after 2 h, ${sp.slow}%. ` : '') + 'Every one of these was paid for. Check who is on the phone when the ads run.', fig: 'slow', action: 'See them', key: 'slow' });
  }
  // 4. Best campaign with room to grow
  const best = withLeads.filter(c => c.status === 'ACTIVE' && (c.toolLeads || 0) >= 2).sort((a, b) => a.spend / a.toolLeads - b.spend / b.toolLeads)[0];
  if (best && best.dailyBudget) {
    const perDay = best.spend / S.days, pace = perDay / best.dailyBudget;
    if (pace >= 0.9) out.push({ level: 'g', title: `"${best.name}" is your cheapest leads — and it is using its whole budget`, body: `${money(best.spend / best.toolLeads)} per lead, ${best.toolQuoted} of ${best.toolLeads} quoted. It is spending ${Math.round(pace * 100)}% of its ${money(best.dailyBudget)}/day; it can likely take more.`, url: url(best.platform, best.campaignId), action: 'Open in ' + (best.platform === 'meta' ? 'Meta' : 'Google'), key: 'best' });
  }
  // 5. Platform says more leads than reached the tool
  if (S.leads.platformReported >= 4 && S.leads.platformReported > S.leads.tool * 1.2)
    out.push({ level: 'a', title: `${S.leads.platformReported - S.leads.tool} leads the platforms count never reached the tool`, body: `Platforms report ${S.leads.platformReported}, the tool logged ${S.leads.tool} from ads. Either the lead form is not connected, enquiries came by phone, or ad URLs are missing their UTM tags.`, action: 'Check', fig: 'leads', key: 'gap' });
  // 6. Monthly budget
  if (S.budget && S.budget.month > 0 && S.budget.pct > S.budget.monthPct + 15)
    out.push({ level: 'a', title: `${S.budget.pct}% of this month's marketing budget spent, ${S.budget.monthPct}% of the month gone`, body: `${money(S.budget.spent)} of ${money(S.budget.month)}. At this pace the month ends near ${money(S.budget.projected)}.`, key: 'budget' });
  // 7. Untagged traffic
  const webNoUtm = db.prepare("SELECT COUNT(*) n FROM leads WHERE source='Our website' AND created_at>=? AND COALESCE(campaign_ref,'')='' AND COALESCE(click_id,'')=''").get(S.since).n;
  if (S.spend.total > 0 && webNoUtm >= 5)
    out.push({ level: 'a', title: `${webNoUtm} website enquiries arrived with no campaign tag`, body: 'If any came from ads, they are being counted as direct. Add utm_source / utm_campaign to every ad URL (see the guide below).', key: 'utm' });
  const order = { r: 0, a: 1, g: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---- summary for the tab -------------------------------------------------------------------
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
      spend: Math.round(d.s), platformLeads: Math.round(d.l || 0), clicks: d.k, impressions: d.i, frequency: d.f, impressionShare: d.sh, toolLeads: toolLeads.n, toolQuoted: toolLeads.q || 0,
      cpl: Math.max(toolLeads.n || 0, Math.round(d.l || 0)) ? Math.round(d.s / Math.max(toolLeads.n || 0, Math.round(d.l || 0))) : null };
  });
  const leadsBy = ch => db.prepare("SELECT COUNT(*) n, SUM(quote_id IS NOT NULL) q, SUM(status='Won') w FROM leads WHERE channel=? AND created_at>=?").get(ch, since);
  const channels = {}; ['meta', 'google', 'hipages', 'leadsite', 'direct', 'referral', 'other'].forEach(ch => channels[ch] = leadsBy(ch));
  const adLeads = (channels.meta.n || 0) + (channels.google.n || 0);
  const adQuoted = (channels.meta.q || 0) + (channels.google.q || 0);
  const adWon = (channels.meta.w || 0) + (channels.google.w || 0);
  const spend = meta.s + google.s;
  // Won value from ad-channel leads (quotes accepted, linked by lead_id)
  const wonValue = db.prepare("SELECT COALESCE(SUM(COALESCE(q.quoted_sell, q.cached_value_ex, 0)),0) v FROM quotes q JOIN leads l ON l.id=q.lead_id WHERE q.status='accepted' AND l.channel IN ('meta','google') AND l.created_at>=?").get(since).v;
  const budgetDaily = db.prepare("SELECT COALESCE(SUM(daily_budget),0) b FROM ad_campaigns WHERE status='ACTIVE'").get().b;
  // Speed to lead: ad leads first contacted within 2 h (first call/message after creation)
  const slowRows = slowLeads(since);
  const slow = slowRows.length;
  const out = {
    days, since, connections: connections(),
    spend: { total: Math.round(spend), meta: Math.round(meta.s), google: Math.round(google.s), perDay: Math.round(spend / days), budgetPerDay: Math.round(budgetDaily), prev: Math.round(prevSpend) },
    ads: { live: campaigns.filter(c => c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), paused: campaigns.reduce((a, c) => a + (c.adsPaused || 0), 0), inReview: campaigns.reduce((a, c) => a + (c.adsInReview || 0), 0),
      campaigns: campaigns.filter(c => c.status === 'ACTIVE').length, byPlatform: { meta: { ads: campaigns.filter(c => c.platform === 'meta' && c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), campaigns: campaigns.filter(c => c.platform === 'meta' && c.status === 'ACTIVE').length },
        google: { ads: campaigns.filter(c => c.platform === 'google' && c.status === 'ACTIVE').reduce((a, c) => a + (c.adsLive || 0), 0), campaigns: campaigns.filter(c => c.platform === 'google' && c.status === 'ACTIVE').length } } },
    leads: { tool: adLeads, meta: channels.meta.n || 0, google: channels.google.n || 0, platformReported: Math.round((meta.l || 0) + (google.l || 0)), quoted: adQuoted, won: adWon, wonValue: Math.round(wonValue), slow },
    // Cost per lead divides by the larger of the two counts: early on, untagged ad leads are
    // missing from the tool's count and dividing by it alone overstates the cost badly.
    cost: { perLead: Math.max(adLeads, Math.round(meta.l + google.l)) ? Math.round(spend / Math.max(adLeads, Math.round(meta.l + google.l))) : null,
      perLeadBasis: adLeads >= Math.round(meta.l + google.l) ? 'tool' : 'platform',
      perLeadMeta: Math.max(channels.meta.n || 0, Math.round(meta.l)) ? Math.round(meta.s / Math.max(channels.meta.n || 0, Math.round(meta.l))) : null,
      perLeadGoogle: Math.max(channels.google.n || 0, Math.round(google.l)) ? Math.round(google.s / Math.max(channels.google.n || 0, Math.round(google.l))) : null,
      perQuote: adQuoted ? Math.round(spend / adQuoted) : null, perWon: adWon ? Math.round(spend / adWon) : null, roas: spend > 0 ? Math.round(wonValue / spend * 10) / 10 : null },
    channels, campaigns: campaigns.sort((a, b) => b.spend - a.spend),
  };
  // Monthly budget (optional, Editor → Marketing): spent this calendar month vs the budget.
  const month = parseFloat(settingGet('mkt_budget_month') || '0') || 0;
  if (month > 0) {
    const { year, month: mm, day } = require('./refs').sydneyParts();
    const first = `${year}-${mm}-01`;
    const spent = db.prepare('SELECT COALESCE(SUM(spend),0) s FROM ad_daily WHERE day>=?').get(first).s;
    const dim = new Date(Number(year), Number(mm), 0).getDate();
    out.budget = { month, spent: Math.round(spent), pct: Math.round(spent / month * 100), monthPct: Math.round(Number(day) / dim * 100), projected: Math.round(spent / Number(day) * dim) };
  }
  out.speed = speedSplit(since);
  out.levers = levers(out);
  return out;
}

// ---- figure lists: what is behind each tile ---------------------------------------------------
// Same row shape as the Costing figures (openFigure renders both): { quoteId, leadId,
// quoteNumber, client, package, note, value }.
function figure(key, days = 30) {
  attributeLeads();
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const money = n => '$' + Math.round(n || 0).toLocaleString('en-AU');
  const leadRow = (l, note) => {
    const q = l.quote_id ? db.prepare('SELECT id, quote_number, cached_value_ex, quoted_sell FROM quotes WHERE id=?').get(l.quote_id) : null;
    return { leadId: l.id, quoteId: q ? q.id : null, quoteNumber: q ? q.quote_number : '—', client: l.name, package: [l.suburb, l.source].filter(Boolean).join(' · '), note, value: q ? Math.round(q.quoted_sell || q.cached_value_ex || 0) : null };
  };
  const campRows = (filter) => {
    const S = summary(days);
    return S.campaigns.filter(filter || (() => true)).map(c => ({ quoteNumber: c.platform === 'meta' ? 'Meta' : 'Google', client: c.name,
      package: `${c.status || ''} · ${c.adsLive != null ? c.adsLive + ' live ads' : ''}`, note: `${c.clicks} clicks · ${c.toolLeads} leads here / ${c.platformLeads} platform${c.cpl ? ' · CPL ' + money(c.cpl) : ''}`, value: c.spend }));
  };
  const adLeads = () => db.prepare("SELECT * FROM leads WHERE channel IN ('meta','google') AND created_at>=? ORDER BY created_at DESC").all(since);
  const status = l => l.status === 'Won' ? 'won' : l.quote_id ? 'quoted' : l.status === 'Lost' ? 'lost' : 'open';
  const M = {
    spend: () => ({ title: `Spend, ${days} days`, rows: campRows(c => c.spend > 0), note: 'Spend by campaign, as the platforms report it (ex GST).' }),
    ads: () => ({ title: 'Live ads', rows: campRows(c => c.status === 'ACTIVE'), note: 'Active campaigns and how many ads each is running.' }),
    leads: () => ({ title: `Leads from ads, ${days} days`, rows: adLeads().map(l => leadRow(l, `${l.channel} · ${String(l.created_at).slice(0, 10)} · ${status(l)}${l.campaign_ref ? ' · ' + l.campaign_ref : ''}`)), note: 'Enquiries in this tool attributed to Meta or Google. The platforms\' own count is on the tile.' }),
    cpl: () => ({ title: 'Cost per lead, by campaign', rows: campRows(c => c.spend > 0), note: 'Campaign spend ÷ leads.' }),
    cpq: () => ({ title: 'Ad leads that were quoted', rows: adLeads().filter(l => l.quote_id).map(l => leadRow(l, l.channel)), note: 'Spend ÷ these = cost per quote.' }),
    cpw: () => ({ title: 'Won jobs from ad leads', rows: adLeads().filter(l => db.prepare("SELECT 1 FROM quotes WHERE lead_id=? AND status='accepted'").get(l.id)).map(l => leadRow(l, l.channel + ' · won')), note: 'Spend ÷ these = cost per won job.' }),
    roas: () => ({ title: 'Return on ad spend', rows: adLeads().filter(l => db.prepare("SELECT 1 FROM quotes WHERE lead_id=? AND status='accepted'").get(l.id)).map(l => leadRow(l, l.channel + ' · won')), note: 'Won value from ad leads ÷ ad spend.' }),
    slow: () => ({ title: 'Ad leads not contacted within 2 hours', rows: slowLeads(since).map(l => { const m = db.prepare("SELECT created_at FROM lead_messages WHERE lead_id=? AND channel IN ('call','whatsapp','sms','email') AND COALESCE(sent_by,'') NOT IN ('client','','auto') ORDER BY created_at LIMIT 1").get(l.id);
      const h = m ? Math.round((new Date(m.created_at.replace(' ', 'T') + 'Z') - new Date(l.created_at.replace(' ', 'T') + 'Z')) / 36e5 * 10) / 10 : null;
      return leadRow(l, m ? `first contact after ${h} h` : 'never contacted'); }), note: 'Paid-for enquiries that waited. Open one to call.' }),
  };
  if (key.startsWith('ch_')) {
    const ch = key.slice(3);
    const rows = db.prepare('SELECT * FROM leads WHERE channel=? AND created_at>=? ORDER BY created_at DESC').all(ch, since);
    return { title: `${ch[0].toUpperCase() + ch.slice(1)} enquiries, ${days} days`, rows: rows.map(l => leadRow(l, `${String(l.created_at).slice(0, 10)} · ${status(l)}`)), note: 'Every enquiry attributed to this channel.' };
  }
  return M[key] ? M[key]() : null;
}

// ---- Meta lead ads: each form submission becomes an enquiry -----------------------------------
// The app must be subscribed to the Page's `leadgen` field with this callback URL and the
// verify token from Editor → Marketing. Signature (X-Hub-Signature-256) is checked when an
// app secret is set.
function verifyMetaSignature(raw, header) {
  const secret = settingGet('meta_app_secret');
  if (!secret) return true;
  if (!raw || !header) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(header))); } catch (e) { return false; }
}
async function handleMetaLead(leadgenId, pageId) {
  const c = connection('meta');
  if (!c.secret) throw new Error('Meta not connected');
  if (db.prepare('SELECT id FROM leads WHERE click_id=?').get('fbl:' + leadgenId)) return { duplicate: true };
  const L = await metaFetch('/' + leadgenId, c.secret, { fields: 'created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,platform' });
  const f = {}; (L.field_data || []).forEach(x => { f[String(x.name).toLowerCase()] = (x.values || [])[0] || ''; });
  const pick = (...keys) => { for (const k of keys) { const hit = Object.keys(f).find(n => n === k || n.includes(k)); if (hit && f[hit]) return String(f[hit]).trim(); } return ''; };
  const name = pick('full_name', 'name') || [pick('first_name'), pick('last_name')].filter(Boolean).join(' ') || '(Meta lead)';
  const phone = pick('phone_number', 'phone', 'mobile'), email = pick('email').toLowerCase();
  const suburb = pick('city', 'suburb', 'post_code', 'postcode', 'zip'), address = pick('street_address', 'address');
  const other = Object.entries(f).filter(([k]) => !/full_name|first_name|last_name|phone|email|city|suburb|post|zip|street|address/.test(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  const { newId } = require('./ids'); const { nextRef, sydneyParts } = require('./refs');
  const id = newId(), ref = nextRef();
  const notes = [`${ref} · Meta lead ad${L.campaign_name ? ' · ' + L.campaign_name : ''}${L.ad_name ? ' · ad "' + L.ad_name + '"' : ''}`, ...other].join('\n');
  db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb,call_answers,enquiry_ref,channel,campaign_ref,click_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, phone, email, address, L.platform === 'ig' ? 'Instagram' : 'Facebook', notes, 'New', 'call1', sydneyParts().ymd, '', suburb,
    JSON.stringify({ _prefill: { source: 'Facebook', name, phone, email, suburb, address, enquiry_ref: ref, confirmed: {} } }), ref, 'meta', L.campaign_id || null, 'fbl:' + leadgenId);
  try { require('./push').notify({ title: `New Meta lead: ${name}`, body: [suburb, phone].filter(Boolean).join(' · ') + ` · ${ref}`, url: '/admin/?lead=' + id, tag: 'lead-' + id }).catch(() => {}); } catch (e) {}
  if (email) { try { require('./estimator').autoInvite(id, { reason: 'new', by: 'meta' }).catch(() => {}); } catch (e) {} }
  return { id, ref };
}

// ---- Google lead form assets: each submission becomes an enquiry ------------------------------
// In Google Ads the lead form's "Lead delivery" is set to Webhook with this tool's URL and
// key. Google POSTs { lead_id, form_id, campaign_id, gcl_id, is_test, google_key,
// user_column_data: [{ column_id, column_name, string_value }] }.
function handleGoogleLead(b = {}) {
  const leadId = String(b.lead_id || '').trim();
  if (!leadId) return { error: 'no lead_id' };
  if (db.prepare('SELECT id FROM leads WHERE click_id=?').get('gl:' + leadId)) return { duplicate: true };
  const f = {}, extra = [];
  (b.user_column_data || []).forEach(c => { const k = String(c.column_id || c.column_name || '').toUpperCase(); if (k) f[k] = String(c.string_value || '').trim(); });
  const KNOWN = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'WORK_EMAIL', 'PHONE_NUMBER', 'WORK_PHONE', 'CITY', 'POSTAL_CODE', 'STREET_ADDRESS', 'REGION', 'COUNTRY'];
  (b.user_column_data || []).forEach(c => { const k = String(c.column_id || '').toUpperCase(); if (!KNOWN.includes(k) && c.string_value) extra.push(`${c.column_name || c.column_id}: ${c.string_value}`); });
  const name = (f.FULL_NAME || [f.FIRST_NAME, f.LAST_NAME].filter(Boolean).join(' ') || '(Google lead)') + (b.is_test ? ' (test)' : '');
  const phone = f.PHONE_NUMBER || f.WORK_PHONE || '', email = (f.EMAIL || f.WORK_EMAIL || '').toLowerCase();
  const suburb = [f.CITY, f.POSTAL_CODE].filter(Boolean).join(', '), address = f.STREET_ADDRESS || '';
  const { newId } = require('./ids'); const { nextRef, sydneyParts } = require('./refs');
  const id = newId(), ref = nextRef();
  const camp = b.campaign_id != null ? String(b.campaign_id) : null;
  const campName = camp ? (db.prepare("SELECT name FROM ad_campaigns WHERE platform='google' AND campaign_id=?").get(camp) || {}).name : null;
  const notes = [`${ref} · Google lead form${campName ? ' · ' + campName : camp ? ' · campaign ' + camp : ''}${b.is_test ? ' · TEST' : ''}`, ...extra].join('\n');
  db.prepare(`INSERT INTO leads (id,name,phone,email,address,source,notes,status,stage,next_followup,job_type,suburb,call_answers,enquiry_ref,channel,campaign_ref,click_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, phone, email, address, 'Google Ads', notes, 'New', 'call1', sydneyParts().ymd, '', suburb,
    JSON.stringify({ _prefill: { source: 'Google Ads', name, phone, email, suburb, address, enquiry_ref: ref, confirmed: {} } }), ref, 'google', camp, 'gl:' + leadId);
  try { require('./push').notify({ title: `New Google lead: ${name}`, body: [suburb, phone].filter(Boolean).join(' · ') + ` · ${ref}`, url: '/admin/?lead=' + id, tag: 'lead-' + id }).catch(() => {}); } catch (e) {}
  if (email && !b.is_test) { try { require('./estimator').autoInvite(id, { reason: 'new', by: 'google' }).catch(() => {}); } catch (e) {} }
  return { id, ref };
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

module.exports = { handleGoogleLead, setupLeadAds, leadAdsStatus, captureAttribution, figure, slowLeads, verifyMetaSignature, handleMetaLead, PLATFORMS, connection, connections, setConnection, googleKey, checkGoogleKey, ingestGoogle, googleScript, metaAccounts, pullMeta, channelOf, attributeLeads, summary, start };
