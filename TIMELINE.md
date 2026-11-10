# Works timeline (v36)

Admin-only tab between Costing and Quotes. Mockup: https://claude.ai/artifact/L2LUDFL76hywWvAGLXFvpC

## Model
- `timeline_items` — a job (`parent_id` NULL) or a separate item under a job (variation,
  extra works). Jobs come from signed/PO quotes automatically (`source='tool'`,
  `quote_id`; a later accepted revision takes over the row) or are added by hand.
- `timeline_blocks` — one item × one month: `planned_pct` + `planned_lock`,
  `actual_pct` + `actual_lock`.
- Planned shares add up to 100. Typing a planned % locks it; months with an actual are
  spent; unlocked months with no actual share what is left (`rebalance()`), to one decimal.
- Done % = sum of actuals. Plan = done + planned months still to come (flagged ≠ 100).
- Revenue per month = value × (actual, else planned). Profit = revenue × margin.
- Value/margin of a tool job: `won_value` (PO/contract) or `quoted_sell`, margin from
  `quoted_sell/quoted_cost`, else the costing engine. Typing either overrides; clearing
  goes back. Hand-added jobs/items have no margin until typed — never guessed; profit
  excludes them and they are flagged.

## Month end
Past months (and the current month from its last two days) with blocks but no actual are
"pending": a card at the top of the tab (prefilled with the plan, Confirm per month locks
each actual), a count badge on the Timeline tab, and a push notification at 4 pm on the last
day of the month (`tl_eom_notified` setting, once per month). Deep link `/admin/?tab=timeline`.

## Costing
"Forecast cashflow" card (admin): next-12-month revenue and profit, busiest month, FY works
revenue against `fy_target`, signed-not-scheduled, pending months, and a 3-back/11-ahead strip.

## API (`/api/timeline`, admin)
`GET /` grid · `GET /cashflow` · `GET /pending-count` · `POST /jobs` · `POST /jobs/:id/items`
· `PUT /items/:id` · `DELETE /items/:id` (hand-added only; tool jobs archive) · `PUT /order`
· `PUT /items/:id/blocks/:month` {planned, plannedLock, actual, actualLock, remove}
· `POST /confirm` {month, entries:[{itemId, actual}]}
