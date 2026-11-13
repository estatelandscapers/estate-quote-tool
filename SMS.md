# Text messages (SMS)

Sent through Mobile Message (mobilemessage.com.au). Code: `server/utils/sms.js`,
`server/routes/sms.js`, `public/admin/sms.js`. Settings card: Setup → Editor → Settings.

## Railway variables
- `MOBILEMESSAGE_USERNAME`, `MOBILEMESSAGE_PASSWORD` — the API login from the Mobile Message dashboard
- `SMS_SENDER` — the registered sender name (max 11 characters, no spaces), e.g. `EstateLands`

## Mode
- **Off**: nothing is sent.
- **Trial**: only the mobiles listed under Trial numbers receive texts. Everything else is
  recorded as "held" in the list at the bottom of the card, with the exact wording, and is not sent.
- **Live**: every switched-on message goes to every client with an Australian mobile.

"Send test text" works in any mode.

## Messages (each has its own switch and wording; all start off)
| Message | Sent |
|---|---|
| Enquiry received | with the website enquiry acknowledgement |
| Estimator invite | with the code email (and when the code is resent) |
| Estimate reminder | N days after the invite if the estimate is not finished (default 2) |
| Site visit reminder | from 3 pm the day before a booked visit |
| Quote sent | when Send to client is pressed (needs the quote linked to a lead with a mobile) |
| Quote follow-up | N days after sending if not accepted (default 3) |
| Contract signed | when the client signs |

Rules: each automatic message goes once (`sms_log.ref`); reminders only go 9 am–6 pm Sydney
and only for invites, quotes and visits created after the switch was turned on; only
Australian mobiles are texted. Every text is written to the lead's history. The SMS button
on a lead sends from the tool when the mode is Trial or Live, and opens the phone's Messages
app when it is Off.
