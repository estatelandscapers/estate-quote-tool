# Revisions of a won job (v57)

A job is one quote family: 1438, 1438.1, 1438.2 share the parent number 1438.
The rules live in `server/utils/revisions.js`.

1. **Only a signed revision is a won job.** E-signed, or marked won from a PO / returned
   contract. A newer revision that is with the client but not signed is still a quote: its
   lead card sits in **4 · Quote** (chip "revision of won 1438 · not signed") and it counts
   for nothing. The signed revision stays in Won, Projects, Selections and revenue.
2. **When the newer revision is signed, the older one stops counting at once** — the job
   is never in the figures twice. The older one is held **"superseded · to close"**:
   greyed in Won at $0, with a prompt at the top of the lead board, on both quote pages
   and in the office copy of the signed email.
3. **An admin closes it.** Closing files the old revision as the **predecessor**: who
   closed it and when are recorded (quote page + audit log), and its signature, signed PDF
   and terms snapshot are never touched. On closing, these move to the new revision:
   - the purchase order with all its PO revisions (unless the new revision already has its
     own PO — then nothing is moved over it), and the selections lock with it;
   - selections (method, vendor, sub days) for matching lines the new revision has not
     set itself.
   Photos and files belong to the enquiry, so they already follow the job and keep the
   revision they were added under.
4. **After the move the PO still lists the old scope.** The new revision's page says so
   until a new PO revision is raised (PO → "Job changed — new PO revision"; ordered and
   delivered lines carry forward).
5. **A dropped revision loses nothing.** Marking the unsigned revision lost (quote page, or
   dragging its card to Lost) returns the enquiry to Won on the signed revision.

Columns: `quotes.supersede_pending`, `superseded_closed_at`, `superseded_closed_by`,
`superseded_carried` (JSON of what moved). Routes: `GET /api/quotes/to-close`,
`POST /api/quotes/:id/supersede` (admin).
