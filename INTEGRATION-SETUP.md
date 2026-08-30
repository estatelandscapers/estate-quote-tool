# Estate Landscapers — Backend Integration Guide

Every connection between the website, the quote tool, and the outside services — in the
order to do them. Tick top to bottom; each step says how to prove it worked before moving
on. Nothing here requires touching code.

---

## 0. The map — what talks to what

```
Visitor → WEBSITE (Cloudflare) → forms POST → QUOTE TOOL (Railway)
                                                ├─ lead in your Leads tab (due today)
                                                ├─ acknowledgement email via ZEPTOMAIL
                                                └─ upload URLs from MICROSOFT GRAPH
Visitor's browser → files PUT direct → ONEDRIVE (Estate Enquiries/<year>/ENQ-…)
Website → GA4 (G-NWQPY0NXEF, live domain only)
Quote tool → Google PLACES (daily rating cache — tool-side feature, see §7)
```

---

## 1. GitHub → Cloudflare (the website itself)

1. Extract the latest `estate-website-repo.zip` into your `estate-website` repo folder —
   **delete the old `public/` and `src/` folders first**, then extract, so no stale file
   survives. Commit and push.
2. Cloudflare → your `estate-website` project → **Settings → Build → Deploy command**:
   set it to `node build.js && npx wrangler deploy` (rebuilds from src on every push).
3. **Prove it:** open your `*.workers.dev` URL, view page source (long-press → view
   source on mobile, Ctrl+U on desktop), and check the last line: a comment like
   `<!-- estate build 2026-08-28T… · / -->`. The path after the `·` tells you which page
   you're really looking at, and the timestamp tells you it's the fresh build. If the
   stamp is missing or old: hard-refresh (Ctrl+Shift+R), then check the file on GitHub
   itself (repo → public/index.html → it should contain `fd-open`).

## 2. Railway — connect the website to the tool

Railway → your quote-tool service → **Variables**, add:

| Variable | Value |
|---|---|
| `SITE_ORIGIN` | your staging origin, e.g. `https://estate-website.xxx.workers.dev` — no trailing slash. At cutover change to `https://www.estatelandscapers.com.au,https://estatelandscapers.com.au` |

Railway redeploys automatically when variables change.

**Prove it:** open `https://quotes.estatelandscapers.com.au/api/public/enquiry/health` —
`corsOrigins` should be `1` (or `2` after cutover). If it's `0`, the variable name or
value is wrong.

## 3. Azure — the OneDrive connection (six minutes)

1. **portal.azure.com** → sign in as the Microsoft account that owns the tenant
   (`info@estatelandscapers.onmicrosoft.com` or your admin account).
2. **Microsoft Entra ID → App registrations → New registration.** Name:
   `Estate Enquiry Push`. Supported account types: *Accounts in this organizational
   directory only*. Redirect URI: leave empty. → **Register**.
3. On the app's **Overview** page, copy two values into Railway:
   - `GRAPH_TENANT_ID` = Directory (tenant) ID
   - `GRAPH_CLIENT_ID` = Application (client) ID
4. **API permissions → Add a permission → Microsoft Graph → Application permissions**
   → tick `Files.ReadWrite.All` → **Add permissions** → then press
   **Grant admin consent for <tenant>** (the button above the table) → confirm.
   The Status column must show a green tick.
5. **Certificates & secrets → New client secret** → description `railway`, expiry
   24 months → **Add** → copy the **Value** column immediately (shown once, ever).
   - Into Railway as `GRAPH_CLIENT_SECRET`. **Never paste it into a chat.**
   - Diary note: it expires in 24 months — August 2028 — and uploads stop when it does.
6. Add the last variable: `ONEDRIVE_USER` = `info@estatelandscapers.onmicrosoft.com`.

**Prove it:** the health URL again — the `onedrive` block should show
`ok: true`, the drive owner, and your quota (you saw 350 GB / 1 TB). If it shows a
consent error, step 4's green tick is missing.

## 4. ZeptoMail — acknowledgement emails

Already wired (the tool sends quote emails through it today). Two checks only:

1. ZeptoMail dashboard → **Domains** → estatelandscapers.com.au → every indicator green
   (SPF via the bounce domain, DKIM `23172954._domainkey`).
2. After the end-to-end test in §5, confirm the acknowledgement email arrived and landed
   in the **inbox**, not spam. If spam: tell me — we adjust before launch, not after.

## 5. The end-to-end test — the one that matters

From your **phone** (then repeat on a laptop):

1. Open the staging site → Residential → **Get a quote**.
2. Fill it in as a fake client — pick "New build", budget $50k–$100k — and attach one
   real photo from your camera roll and one PDF.
3. Submit. Expect: progress bar → success panel with a reference like `ENQ-2026-0001`.
4. Verify all four systems fired:
   - **Tool:** the lead is in your Leads tab, due today, source "Our website", notes
     showing job type, budget, landing page and file names.
   - **OneDrive:** `Estate Enquiries/2026/ENQ-2026-0001 — <name> — <suburb>/` contains
     both files. (Allow a minute.)
   - **Email:** the acknowledgement arrived at the address you entered.
   - **Health URL:** no errors.
5. Repeat once on the **commercial tender form** with a bigger PDF.

**If files fail but the enquiry succeeds:** that's the designed degradation — but on a
first test it most likely means the browser was blocked PUTting directly to Microsoft.
Open the browser console (or tell me the error banner text) and report back; the enquiry
itself is never lost either way.

**Also test the spam path once:** submit 6 enquiries quickly — the 6th must be politely
refused (rate limit working).

## 6. Google Analytics — make enquiries count as conversions

GA4 only fires on the live domain, so this activates fully at cutover — set it up now:

1. **analytics.google.com → Admin → Data display → Events.** After the first live
   submissions, these events appear: `quote_started`, `quote_submitted`,
   `tender_started`, `tender_submitted`, `quote_referred_out`.
2. **Admin → Key events** (Google's name for conversions): mark `quote_submitted` and
   `tender_submitted` as key events.
3. That's it. From then on, reports and any future Google Ads optimise toward
   *enquiries*, not clicks.

## 7. Google Places — the live rating (tool-side, pending)

You've done the hard parts: Place ID `ChIJW7IBymuYUwkR_RBdJtgxXP0` and the restricted
API key in Railway as `GOOGLE_PLACES_API_KEY`. The daily fetcher that reads the rating
into the tool's settings cache is a **tool-side feature that may not exist yet** in the
other chat's version — ask that chat (or me, with the current tool zip) to add: a daily
job calling Places for rating + review count, cached in settings, exposed on the public
read API. Until then the site simply doesn't show a star rating — nothing is broken.
Add `GOOGLE_PLACE_ID` = the ChIJ value to Railway so it's there when the feature lands.

## 8. Search Console — at cutover, not before

The staging site is deliberately invisible (`public/_headers` noindex). At go-live:

1. Delete the noindex block from `public/_headers`, push.
2. **search.google.com/search-console** → your property → Sitemaps → submit
   `https://www.estatelandscapers.com.au/sitemap.xml` (43 URLs, generated on every build).
3. Indexing → Pages a week later: watch the count climb from 1.

## 9. DNS cutover — the final link

Follow `estate-dns-zone-reference.md` in the repo, in its order: recreate the zone at
the new DNS host → drop TTLs → switch nameservers → verify email, quotes subdomain and
website → wait 72 hours → cancel Wix. Then update `SITE_ORIGIN` (§2) to the real domain
and re-run the §5 test once from the live site.

---

## Quick status board

| Connection | State | Blocked on |
|---|---|---|
| Website → Cloudflare deploy | live (verify stamp) | — |
| Forms → tool (CORS) | ready | §2 variable |
| Tool → OneDrive | code ready | §3 Azure registration |
| Ack emails → ZeptoMail | live | §4 green check |
| GA4 events | wired, dormant until live domain | cutover |
| Key events marked | — | §6, two clicks |
| Places rating | site ready, tool feature pending | §7 |
| Sitemap → Search Console | generated | cutover |
| DMARC | live at p=none | tighten post-cutover |
