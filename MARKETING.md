# Marketing · Leads · Costing split — handover (v34 scaffold, v35 finished)

Built on commit `2d943ae` (v33). Mockup approved by Smit on 9 Nov 2026:
https://claude.ai/artifact/MQQsg4y5SkFW53LRkpJwPb

This commit lays down the **structure**. It boots, the tabs render, the Leads changes work;
the Marketing tab shows its layout with empty figures until an account is connected.
Finish the items under *Left to build* in order.

## Decisions taken from the mockup (confirm with Smit if in doubt)

| Question | Taken as |
|---|---|
| Meta connection | System-user token (Business Manager), read-only, never expires. Pasted on the tab; the tool lists ad accounts, user picks one. |
| Meta lead-form ads | **Unknown** — webhook endpoints stubbed (`/api/public/marketing/meta/webhook` returns 501). Ask before building. |
| Google connection | Google Ads **script** inside the customer's account, pushing daily to `/api/public/marketing/google` with a per-tool key. No API/developer token. |
| Attribution | `leads.channel` = meta / google / hipages / direct / referral / other from `source`, the `Campaign: …` UTM line in notes, and `click_id`. Hipages is its own channel. |
| Monthly marketing budget | Not built. Daily budgets come from the platforms (`ad_campaigns.daily_budget`). Ask whether an Editor setting is wanted. |
| Drawer | Lead opens in a right-hand drawer, `min(100%, max(50vw, 620px))`. Call script opens **inside** the drawer (full-page fallback not built). |
| Costing tab access | Same as Leads was: everyone sees Current, margin/profit halves admin-only. **Marketing tab is admin-only.** |

## What is in this commit

**Tabs** — `shell()` nav order: Marketing · Leads · Costing · Quotes · … `route()` dispatches
`marketingTab(v)` and `costingTab(v)`. Top-bar *Leads* always resets to the Summary
(`state.leadsSub='summary'`, `leadId=null`, drawer closed).

**Costing tab** — `costingTab(v)` in `public/admin/app.js`: the Current + Forecast cards lifted
verbatim out of `leadsSummary()` (which now fetches only board / stages / link-activity / hot).
Figure drawers and the FY-target input work as before. The Open-enquiries tile still calls
`/leads/board` for its phase counts.

**Lead drawer** — `ensureLeadDrawer / openLeadDrawer(id) / closeLeadDrawer()` next to
`ensureDrawer`. `leadConsole(body)` renders into `#leadDrawerBody` unchanged. Hooks at the top
of `leadsTab(v)` and `leadsSummary(v)`: when called with the drawer body (every "back to
leads" path inside the console), they close the drawer and repaint `#view`. Every open-a-lead
call site (hot strip, Today strip, board card, enquiries list, calendar visit dialog, figure
rows) now calls `openLeadDrawer`. `route()` with `state.leadId` set paints the summary and
then opens the drawer (deep links from Behaviour record etc. still work).

**Hot strip** (`GET /leads/hot`, `paintHot`) — `latestRevision(quote)`: value and number from
the newest revision of the lead's quote (`revisionOf` carried for the "rev of 1439" line);
link signal from the latest *sent* revision. `nextVisit(leadId)`: next booked `site_visits`
row with countdown text ("Site visit Tue 11 Nov 9:00 am · in 2 days · rescheduled"); replaces
the estimator's "booked a Friday site visit". Row layout: six fixed columns, address under the
name, source under the stage pill, reason wraps to two lines. The board's `decorate()` uses
`latestRevision` too.

**Marketing — server**
- `server/db.js`: `ad_connections`, `ad_campaigns`, `ad_daily`; `leads.channel`,
  `leads.campaign_ref`, `leads.click_id`.
- `server/utils/marketing.js`: connections store, `googleKey()` (created on first use),
  `googleScript(baseUrl)` (the script text, ~40 lines, served with the key filled in),
  `ingestGoogle(body)`, `metaAccounts(token)`, `pullMeta(days)` (campaigns + ads status
  counts + daily insights; lead actions summed from `lead` / `onsite_conversion.lead_grouped`
  / `offsite_conversion.fb_pixel_lead`), `channelOf(lead)`, `attributeLeads()`,
  `summary(days)`, `start()` (hourly attribution sweep; Meta pull at 6 am Sydney, once a day).
- `server/routes/marketing.js` (admin): `GET /summary?days`, `GET /connections`,
  `GET /google/script`, `POST /google/reset-key`, `POST /meta/accounts`, `POST /meta/connect`,
  `POST /meta/pull`, `POST /:platform/disconnect`, `POST /attribute`.
- `server/routes/publicMarketing.js` (key-guarded, exempt from login in `utils/auth.js`):
  `POST /google` (header `X-Marketing-Key`), `GET /google/ping`, Meta webhook stubs.

**Marketing — UI** — `marketingTab(v)`: 7/30/90-day switch, eight tiles, channel row,
campaigns table, levers card (empty), connections (Meta token → account picker → connect;
Google key copy + "Show script"), the step-by-step guide. Styles `.plat .conn .steps .step
.lever` appended to `styles.css`.

## v35 — finished on top of the scaffold

- **Attribution at insert**: `captureAttribution(leadId, {utm, gclid, fbclid})` runs after
  every website enquiry and estimator lead; stores `click_id` (`g:…`, `fb:…`, `fbl:…` for lead
  ads), `campaign_ref` (utm_campaign — use the campaign **id**), and the channel. `channelOf`
  tuned to the real source list: paid signals first; "Local Facebook group" = referral;
  ServiceSeeking / Airtasker / Bark / Houzz = `leadsite`; Google search / Maps / phone /
  signage = direct.
- **Figure lists**: `GET /marketing/figure/:key?days` for spend, ads, leads, cpl, cpq, cpw,
  roas, slow, `ch_<channel>`; every tile opens its list in the same drawer as Costing.
- **Levers**: campaign CPL > 2× average (≥ $200 spent); campaign with ≥ $250 and no leads;
  Meta frequency > 3.5; ad leads not contacted within 2 h (with the fast-vs-slow quote rate);
  cheapest campaign spending ≥ 90 % of budget; platform-vs-tool lead gap > 20 %; monthly
  budget running ahead of the month; ≥ 5 untagged website enquiries while ads run. Each links
  to Ads Manager / Google Ads or opens its figure list.
- **Cost per lead** divides by the larger of the tool's and the platforms' lead counts (labelled).
- **Monthly budget** (Editor → Settings → Marketing, `mkt_budget_month`): progress line on the
  tab and a lever when spend runs > 15 points ahead of the month.
- **Meta lead ads**: `GET/POST /api/public/marketing/meta/webhook` — handshake with
  `meta_verify_token`, `X-Hub-Signature-256` checked against `meta_app_secret` (raw body kept
  by the `express.json` verify hook), each `leadgen` fetched from Graph and created as an
  enquiry (source Facebook/Instagram, channel meta, campaign id, push notification, estimator
  invite if there is an email; duplicates ignored).
- **Script / webhook URLs** built from the origin of `tool_url` only.
- **Lead drawer**: "⤢ Full page" button (for the call script on a phone); Back returns to Summary.
- **Data fix**: one-time migration moves street addresses typed into Suburb over to Address
  (2 leads on the 31 Oct backup); lead saves normalise the same way.

Tested on the 31 Oct backup with a mocked Graph API (accounts, campaign + ads + insights pull,
lead-ad intake, duplicate), a simulated Google script push (56 day-rows), a tagged website
enquiry (attributed to Google campaign 222), webhook handshake and signature, every figure
list, and a Playwright pass over Marketing, Leads (drawer + full page) and Editor.

## Still needs the real accounts

1. Connect Meta with the real system-user token; check `actions` types match the lead
   objective actually used (the code sums `lead`, `onsite_conversion.lead_grouped`,
   `offsite_conversion.fb_pixel_lead`).
2. Install the Google script; confirm the Preview run turns the row green. If the account is
   under a manager (MCC) account, run the script in the client account, not the MCC.
3. Add UTM parameters to every ad URL (guide on the tab) so website leads match campaigns.
4. Lead ads only: subscribe the app to the Page's `leadgen` field.

## Testing notes

Boot against a backup: `DATA_DIR=/path/with/estate.db PORT=4311 node server/index.js`,
login `admin`, then `/api/marketing/summary` and `/api/leads/hot`. Playwright is available in
the build container for screenshots (`/home/claude/d/shot3.js` pattern).
