# Photos and files on a lead — v52

Every lead has a **Photos & files** section on the lead screen, and a paperclip count on its board card. Photos, PDFs and video open inside the tool; nothing needs hipages or OneDrive open.

## Where files come from
- **Website enquiry uploads** — already went to the lead's OneDrive folder; now shown here.
- **hipages photos** — the hipages bot sends them when it accepts a job (see below).
- **Added in the tool** — "Add photos or files", or drop them on the box. Works from the phone camera roll. Admins and estimators can add; only an admin can delete (deleted files go to the OneDrive recycle bin).

## Where files live
In OneDrive, under `Estate Enquiries/<year>/`, one folder per lead. Nothing is stored on the tool's own server. Uploads go from the browser straight to OneDrive in 5 MB pieces; viewing is streamed through the tool's login. Only photos, PDFs and video open in the page — anything else downloads.

## hipages photos
hipages emails do not contain the customer's photos; only the portal's lead list does. The bot remembers the photo addresses while a lead is listed and, once it has accepted the job, pushes each photo to `PUT /api/public/hipages/photo` (header `X-Hipages-Key`). The tool files them under `HIP-<job number>` and ties them to the lead by postcode + the customer's description, as soon as the "Job Details" email creates the lead.

Variables: tool `HIPAGES_FILES_KEY`; bot `QUOTE_TOOL_URL` and `QUOTE_TOOL_KEY` (same value as the tool's key).

Limits: only jobs accepted after this went live; a job accepted purely by the overnight email path, never seen in the portal list, has no photos to send — add those by hand.

Code: `server/utils/leadFiles.js`, `server/routes/publicHipages.js`, routes under `/api/leads/:id/files`.

## Email leads from Zoho (v53)
The tool also watches one folder of the Zoho mailbox (default `Leads`). Any email moved into that folder becomes a lead: the sender is the client, the message is the notes, a mobile in the message is picked up, and attachments go into Photos & files. Nothing else in the mailbox is read and nothing is marked or moved.

Variables: `ZOHO_IMAP_USER`, `ZOHO_IMAP_PASS` (a Zoho app-specific password); optional `ZOHO_IMAP_FOLDER` (default `Leads`), `ZOHO_IMAP_HOST` (default `imappro.zoho.com.au`), `ZOHO_POLL_MINUTES` (default 2).
