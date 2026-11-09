# Marketing · Leads · Costing split — handover (v34 scaffold)

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

## Left to build (in order)

1. **Test Meta end to end** with Smit's real system-user token: `metaAccounts`, `pullMeta`
   (field names, `actions` types for his lead objective, `daily_budget` units — cents), the
   6 am scheduler. Add `GET /marketing/meta/campaign/:id` if the table needs a drill-down.
2. **Test the Google script** in his Google Ads account: `getStatsFor` date format, search
   impression share method name (`getSearchImpressionShare` exists on campaign stats in
   current AdsApp; guard it), MCC vs single account. Confirm `tool_url` setting is set so the
   script URL is right.
3. **Attribution** — `channelOf` is a first cut. Check it against the real `source` values in
   `sources.js` groups; capture `gclid`/`fbclid` and `utm_campaign` into `leads.click_id` /
   `leads.campaign_ref` at insert time in `publicEnquiry.js` and `publicEstimate.js`
   (currently only the UTM line in notes is parsed). Match `campaign_ref` to
   `ad_campaigns.campaign_id` (Google `{campaignid}` gives the id; Meta needs
   `utm_campaign={{campaign.id}}` in the ad URL — add to the guide).
4. **Figure lists** — `GET /marketing/figure/:key` for every tile (`spend`, `ads`, `leads`,
   `cpl`, `cpq`, `cpw`, `roas`, `slow`, `ch_meta`…) returning the same row shape
   `openFigure()` renders (lead rows with `leadId`, campaign rows). Replace the toast in
   `marketingTab`.
5. **Levers** — rules in `summary()`: CPL > 2× blended average; Meta frequency > 3.5; ad
   leads not contacted within 2 h (list them); best-CPL campaign pacing < 95% of budget;
   platform-reported vs tool lead gap > 20%; a campaign with spend and zero leads in 14 days.
   Each: `{ level: 'r'|'a'|'g', title, body, url, action }` with deep links to Meta Ads
   Manager / Google Ads campaign pages.
6. **Meta lead-form webhook** (if Smit runs lead ads): GET verify with `hub.challenge` and a
   `meta_verify_token` setting; POST `leadgen` → fetch the lead via Graph → create an enquiry
   with `channel='meta'`, `campaign_ref`, source 'Facebook'. Needs the app subscribed to the
   Page's `leadgen` field.
7. **Settings** — Editor card for `tool_url` check, `meta_verify_token`, optional monthly
   marketing budget.
8. **Drawer polish** — the call script's screens are tall; check them in the drawer on a
   phone. Consider "Open full page" in the drawer header. `closeLeadDrawer()` repaints the
   whole summary; a lighter refresh (hot + today + board) would feel quicker.
9. **Data noticed while testing** — some hipages-ingested leads have `address` and `suburb`
   swapped (e.g. Peter Tan: address "Hornsby", suburb "8 Emu Place…"). Worth a one-off fix in
   `mailIngest.js` parsing plus a migration.
10. Bump `public/admin/sw.js` VERSION on every deploy; update `HANDOVER`/`ESTIMATOR.md` cross-refs.

## Testing notes

Boot against a backup: `DATA_DIR=/path/with/estate.db PORT=4311 node server/index.js`,
login `admin`, then `/api/marketing/summary` and `/api/leads/hot`. Playwright is available in
the build container for screenshots (`/home/claude/d/shot3.js` pattern).
