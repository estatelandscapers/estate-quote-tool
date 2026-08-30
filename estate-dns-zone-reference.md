# estatelandscapers.com.au — DNS Zone Reference

**Captured 27 Aug 2026** from live DNS (authoritative server ns10.wixdns.net) and the Wix
DNS panel.

**Current DNS host:** Wixpress Ltd
**Nameservers:** `ns10.wixdns.net` · `ns11.wixdns.net`

> **Why this document exists.** The zone lives inside the Wix account. Cancelling Wix
> destroys it — and with it, email. Every record below must exist at the new DNS host and
> be verified working *before* Wix is cancelled. This file is the checklist.

---

## A (Host)

| Host | Value | TTL | Notes |
|---|---|---|---|
| `estatelandscapers.com.au` | `216.198.79.1` | 1 hr | Vercel apex IP. **Replaced at cutover** — points to the new host. |

## CNAME (Aliases)

| Host | Value | TTL | Notes |
|---|---|---|---|
| `bounce-zem` | `cluster89.zeptomail.com.au` | 1 hr | **Critical.** ZeptoMail bounce domain — carries SPF alignment for all quote emails. Must migrate. |
| `quotes` | `om1abbai.up.railway.app` | 1 hr | **Critical.** The quote tool. If this breaks, quoting stops. Must migrate. |
| `www` | `fb35bddd20ecb4e1.vercel-…` *(value truncated in source — recapture if needed)* | 1 hr | Current website. **Replaced at cutover.** |

## TXT

| Host | Value | Notes |
|---|---|---|
| `estatelandscapers.com.au` | `MS=ms78846552` | Microsoft 365 domain verification. Keep — the tenant hosts OneDrive. |
| `estatelandscapers.com.au` | `google-site-verification=T1F0c4iC2F13jWXzHWx37O_pTsUY9gUHbgA6aFcwbvk` | Search Console ownership. Keep. |
| `estatelandscapers.com.au` | `v=spf1 include:zoho.com.au ~all` | **Critical.** Authorises Zoho to send as your domain. |
| `estatelandscapers.com.au` | `zoho-verification=zb98215802.zmverify.zoho.com.au` | Zoho domain ownership. Keep. |
| `_railway-verify.quotes` | `railway-verify=8529a90c3fd295b4a470f2a8e4e5d04b0faea1b90c2c669b68571efc236ffd45` | Railway custom-domain proof for the quotes subdomain. |
| `_dmarc` | *(not yet checked — run a TXT lookup)* | If absent, add one. See below. |

### DKIM — `zmail._domainkey` (Zoho)

**Critical. One wrong character and outbound mail fails authentication.**

```
v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCxxH9ZiNJHB/B9MRRfh5qs1aYF5MrYoKYqYyfOoJV7Ng6CDMYsRwdeZSgUaZDT6YODEIixF3OW1cWPt2t488YjCCaQO7ko5fetnLI/JQot8bb0qE59ML1zuxUH8D+JRwev9yEcGC6jpPx31yOUug8g/3NpldrnFcoqSfDRHXNx/QIDAQAB
```

### DKIM — `23172954._domainkey` (ZeptoMail)

**Critical. Signs every quote and contract email the tool sends.**

```
k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCCe8+gQroeZQFzrDUeidu5feO5n5+6baLEDmrTu7fwiuKX6HbdaXSdY1VBJDgyAi1YSU6t/YJioVTBheUVsRpIZfItRNYM4eS7R9Fb8wrz1r7k/iF0/7BRTPN/n1DqnJzYxYyfzR8Op/QDCVz8WusRvl1dxXVWRnI2XXiUxPvfIwIDAQAB
```

> Transcribed from an MXToolbox screenshot. Before cutover, re-copy both from source
> (Zoho Mail Admin → Domains → DKIM, and ZeptoMail → Domains → DKIM) and paste directly.
> Do not retype these by hand.

## MX (Mail Exchange)

| Host | Points to | Priority | Notes |
|---|---|---|---|
| `estatelandscapers.com.au` | `mx.zoho.com.au` | 10 | **Critical** — all email. |
| `estatelandscapers.com.au` | `mx2.zoho.com.au` | 20 | **Critical** |
| `estatelandscapers.com.au` | `mx3.zoho.com.au` | 50 | **Critical** |

## SRV

None configured.

---

## Migration procedure

1. **Recreate everything above at the new DNS host** while Wix is still authoritative.
   Nothing is live yet — the new zone sits idle until nameservers change.
2. **Drop TTLs to 5 minutes** in the Wix panel 24 hours before the switch. Current TTLs
   are 1 hour, which means an hour of inconsistency if something needs rolling back.
3. **Switch nameservers at the registrar** (GoDaddy holds the registration).
4. **Verify, in this order:**
   - Send an email in and out of `info@estatelandscapers.com.au`
   - Load `quotes.estatelandscapers.com.au` and log in
   - Send a test quote from the tool and confirm it arrives, not in spam
   - Run an MXToolbox lookup on the domain and confirm every record matches this file
5. **Wait 72 hours.** Only then cancel Wix.

## Add at cutover

**DMARC** — if `_dmarc` is empty, add:

```
Host:  _dmarc
Value: v=DMARC1; p=none; rua=mailto:info@estatelandscapers.com.au; fo=1
```

`p=none` monitors without rejecting anything, so it cannot break mail. After a few weeks
of reports confirming Zoho and ZeptoMail are the only senders, tighten to
`p=quarantine`, then `p=reject`. This is what stops other people sending invoices that
appear to come from your domain.

## Risk notes

- **Three records are load-bearing beyond the website:** the two DKIM keys and the
  `quotes` CNAME. Email deliverability and the quoting tool depend on them. The website
  records (`A`, `www`) are the only ones actually changing at cutover.
- Email is Zoho, not Wix — so cancelling Wix cannot delete mailboxes. It *can* delete
  the DNS that routes mail to them. That distinction is the whole reason for step 5.
- Both DKIM values were read from screenshots. Treat them as a recovery backup, not as
  the paste source.
