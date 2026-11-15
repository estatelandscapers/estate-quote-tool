# On hold (Future projects) and the forecast — v51

## On hold
A job the client wants later (house still being built, say) goes **on hold until a date**. A date is required; without one the job cannot be put on hold.

- **Where:** the sixth board column "Future projects" (drag a card in), the lead screen, the quote page, each row on Quotes, and the "On hold" tab on Quotes. Admins and estimators can use it.
- **While held:** off the board steps, follow-ups, open quotes, stale list, expected-to-land and win rate. The client's quote link stays open. Nothing is marked lost.
- **Coming back:** on the date it returns to the step it was at with a follow-up due that day, and a notification is sent. Drag it out of the column, or use "Take off hold", to bring it back early.
- **Early warning:** 14 days before (optional, on by default) — a note on the lead, a notification, a card on the welcome screen.
- **Check-in message:** optional, off by default. Email and text to the client every 3 months and at the halfway point (never within 3 weeks of the start or end). An 8-month hold sends at month 3 and month 6. Wording: `holdcheckin` in `server/utils/leadTemplates.js`.
- Leads parked before v51 show in the column as "no date — set one".

Code: `server/utils/holds.js` (table `holds`, 10-minute timer), `server/routes/holds.js`.

## Forecast (Costing tab)
- Win rate counts decided jobs only (won ÷ won + lost), one count per job, not per revision.
- Expected to land: each open quote × its own chance, from job size and days waited.
- FY outlook: secured + open quotes + enquiries in hand + leads still to come, at each lead source's own conversion, with a likely range.
- Lead conversion is measured on leads 45+ days old.
- Profit is shown after the year's overheads; margins outside 5–60% are flagged, not hidden.
- Target tile shows pace (where an even year would be today).
- On-hold jobs are shown in their own tile and left out of everything else.
