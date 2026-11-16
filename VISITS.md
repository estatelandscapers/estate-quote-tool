# Site visits: preference only, time set the day before — v54

A site visit is booked for a **date**. Nobody is promised a time when it is booked.

- **At booking** (call script, calendar, online estimator): only the client's preference is recorded — morning, afternoon or none. No clash checks, because nothing is a fixed time.
- **Messages** to the client give the date and say the arrival window will come the afternoon before, once the route is planned.
- **The day before, from midday** (Thursday for the usual Friday visits): "Lock in the times" becomes the critical task. It is red at the top of Leads and on the welcome screen, with a phone notification at midday and again at 3 pm while any client is still waiting.
- **Lock in the times** (above the calendar): each visit shows its suburb and preference. Give each a start time; the client gets a 60-minute arrival window by email and text. That message is also the reminder — the old timed reminder is gone. A time that goes against a preference is flagged, not blocked.
- Changing a time after it was sent sends the new window. Moving a visit to another day clears its window.
- Visits booked with a clock time before v54 were converted: the time became the preference and is kept in the visit's note.

Code: `server/utils/visits.js`; routes `GET/POST /api/leads/visits/lockin`; message `visitwindow` in `server/utils/leadTemplates.js`; text type `visit` in `server/utils/sms.js`.

# Sign-offs
Every email and text ends with a sign-off chosen for that message, then name / Estate Landscapers / phone: **Kind regards** (most), **Many thanks** (asking for something, contract signed), **Best wishes** (closing an enquiry), **Talk soon** (before a booked call), **See you then** (arrival window). Set per template as `close`.
