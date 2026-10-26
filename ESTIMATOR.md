# Online estimator (v23)

The website's free estimate: the discovery call, done by the client on their phone, feeding the
same lead the rep would otherwise fill in by hand.

## What happens

1. **A lead arrives with an email** (website form, the estimate page's "Get your code" box,
   hipages, or typed in by hand) and is residential. The tool gives it a 4-digit code and sends
   the intro email: "here's how it works" with the seven steps, the code, a Start button and a
   link to the current sample quote. Commercial website enquiries get the old acknowledgement.
   A lead with no email shows "no code could be sent" on its card; add the email and tap Send.
2. **The client opens /estimate/**, enters the code and the email it went to, and answers the
   call script's questions in plain words, one per screen. Answers save as they go. "Not sure"
   is always allowed and goes on the "check on site" list.
3. **A review screen** shows every answer with Change buttons and a notes box.
4. **The ballpark** comes from `callScript.ballpark()`, the same function the rep uses, worded
   in the second person. The same words are emailed to the client and logged on the lead.
   Under-800 mm access gets the script's decline wording and the visit is still offered.
5. **One tap reaction** (works / higher / lower / cheaper / not sure / out of budget), optional.
6. **Friday booking**, AM or PM, a real `site_visits` row. Capacity per half day is in Settings.
   The client is told we have a high number of enquiries and will confirm the day before with
   an ETA. The rep gets a push notification.
7. **Photos and drawings**, optional, straight to the ENQ folder on OneDrive like the quote form.

## What the rep sees

* **Lead console → Online estimator panel**: the code and expiry, status, questions answered,
  the ballpark shown, their reaction, their notes, "changed since last time" when they came
  back and altered answers, every session (when, device, city, how long, how far they got),
  and a Send / Resend button.
* **What they told us** panel: the answers, exactly as a discovery call would have recorded
  them, because they are mirrored into `call_answers` when the client reaches the ballpark.
  The pre-call checklist and the quote comparison read them the same way.
* **Pipeline board**: an `estimate · hot/warm/cold` chip with the reason.
* **Lead stage**: a run that reaches the ballpark moves a step-1 lead to the new
  **Online estimate done** stage (phase 2) with next action "call to confirm, same day". A
  Friday booking moves it to **Site visit booked**. Leads already further along keep their place.

## Signal (Settings → Online estimator)

| Signal | Rule |
|---|---|
| hot | booked a Friday; or reached the ballpark and compared tiers `est_hot_toggles`+ times; or `est_hot_sessions`+ sessions inside `est_hot_window_h` |
| warm | reached the ballpark without booking; or answered `est_warm_answer_pct` % of the questions with `est_warm_active_sec`+ seconds in one session |
| cold | everything else; "out of budget" is always cold |

Hot fades to warm after `est_hot_fade_days` without a session, warm to cold after `est_warm_fade_days`.

## The switch

**Editor → Settings → Online estimator → Auto lead processing (ON/OFF).** Off means: no lead gets a
code automatically (website, hipages, typed-in), the website estimator shows "taking a short
break" with a link to the quote form, every public estimator call answers 503, and the Send code
button on lead cards is disabled. Website enquiries get the plain acknowledgement again. Nothing
is deleted: codes, answers and sessions are all there when it goes back on.

## Settings to check after deploy

* `est_url` — the estimator page, default `https://www.estatelandscapers.com.au/estimate/`
* `tool_url` — this tool's public address (e.g. `https://quotes.estatelandscapers.com.au`), used to
  build the sample-quote link in the emails. Blank = no sample link.
* A **sample quote** must exist (open a quote → Make sample copy) for the sample link to appear.
* `SITE_ORIGIN` in Railway must include `https://www.estatelandscapers.com.au` (it already does
  for the quote form; the estimator uses the same CORS list).

## Files

New: `server/utils/estimator.js` (engine), `server/routes/publicEstimate.js` (public API),
`server/utils/refs.js` (ENQ references, shared). Changed: `db.js` (columns + `estimate_events`),
`index.js` (mount), `routes/leads.js` (invite on manual create, `/:id/estimate`,
`/:id/estimate/invite`, board chip), `routes/publicEnquiry.js` (invite on residential),
`routes/settings.js` (keys; also adds the client-link `sig_*` keys, which could not be saved before),
`utils/leadTemplates.js` (stage), `utils/mailIngest.js` (invite), `public/admin/app.js`,
`styles.css`, `sw.js` (v23).

## Public API (no login; CORS = SITE_ORIGIN)

```
POST /api/public/estimate/start        {name,email,phone,suburb}      → lead + code emailed
POST /api/public/estimate/resend       {email}                        → always ok
POST /api/public/estimate/auth         {code,email,vk}                → {token, steps, sizes, answers,…}
POST /api/public/estimate/auth-resume  (X-Est-Token)                  → same, no code
POST /api/public/estimate/answers      {step, answers, unknown}
POST /api/public/estimate/event        {type: heartbeat|tier|screen, payload}
POST /api/public/estimate/complete     → ballpark; emails it once per version
POST /api/public/estimate/reaction     {v}
GET  /api/public/estimate/slots        → next 3 Fridays, am/pm availability
POST /api/public/estimate/book         {date, half}
POST /api/public/estimate/not-ready    {reason}
POST /api/public/estimate/files        {files:[{name,size}]}           → OneDrive upload URLs
POST /api/public/estimate/files/complete {uploaded:[names]}
```
5 wrong code attempts per IP = 15 minute lockout. Codes expire after `est_code_days` and stop
working once the lead is Won or Lost.
