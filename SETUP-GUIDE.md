# Estate Landscapers Quote Tool — Setup Guide

Written for non-technical setup. Follow top to bottom. Total time ~45–60 minutes.
If you get stuck, any local IT person can finish this in under an hour using this same guide.

---

## What you're setting up
- The **app** runs on a small cloud host (Railway) so client links work 24/7 from anywhere.
- Client links look like **quotes.estatelandscapers.com.au/q/xxxx**.
- Emails (quote acceptances, signed contracts) send from **info@estatelandscapers.com.au** via **Zoho**.
- Your **Synology + OneDrive** are used for **backups only** (Part 6).

---

## Part 1 — Get the app onto GitHub (10 min)
GitHub stores the code so Railway can run it.

1. Go to https://github.com and sign up / log in.
2. Click the **+** (top right) → **New repository**.
3. Name it `estate-quote-tool`. Set it to **Private**. Click **Create repository**.
4. On the new repo page, click **uploading an existing file**.
5. Drag in **all the files from this app folder** (the whole contents of the zip). Click **Commit changes**.

## Part 2 — Run it on Railway (10 min)
1. Go to https://railway.app → **Login with GitHub**.
2. **New Project** → **Deploy from GitHub repo** → pick `estate-quote-tool`.
3. Railway starts building. Wait for it to finish (~2 min).
4. Click the service → **Settings** → **Networking** → **Generate Domain**. You'll get a URL like `estate-quote-tool-production.up.railway.app`. It works immediately.

## Part 3 — Add a persistent disk so data is never lost (3 min)
1. In your Railway service → **Variables** tab → add:
   - `DATA_DIR` = `/data`
2. Go to the service → **Settings** → **Volumes** (or **+ New** → **Volume**) → mount path `/data`.
   This is where the database lives so it survives restarts and redeploys.

## Part 4 — Turn on email (Zoho) (10 min)
You need a Zoho **App Password** (not your normal login password).

1. Log in at https://mail.zoho.com.
2. Go to **My Account** → **Security** → **App Passwords** (https://account.zoho.com/home#security/app-passwords).
3. Click **Generate New Password**. Name it "Quote Tool". Copy the password it shows (you won't see it again).
4. Back in Railway → **Variables** → add these three:
   - `SMTP_HOST` = `smtp.zoho.com`  (use `smtp.zoho.com.au` if your Zoho account is Australia-hosted — if email fails, try this)
   - `SMTP_USER` = `info@estatelandscapers.com.au`
   - `SMTP_PASS` = *(the app password you copied)*
5. Railway redeploys automatically. Email is now on.

## Part 5 — Your own web address (10 min)
So links read `quotes.estatelandscapers.com.au` instead of the Railway URL.

1. In Railway → service → **Settings** → **Networking** → **Custom Domain** → type `quotes.estatelandscapers.com.au` → it shows you a **CNAME target** (like `xxx.up.railway.app`).
2. Go to wherever **estatelandscapers.com.au** is managed (GoDaddy, Crazy Domains, etc.) → **DNS settings**.
3. Add a record: **Type** = CNAME, **Name/Host** = `quotes`, **Value/Target** = the target Railway gave you. Save.
4. Wait 10–30 min. Railway will show a green tick when it's live. HTTPS is automatic.

## Part 6 — Backups to Synology + OneDrive (15 min)
Keeps a nightly copy of your data on your NAS, mirrored to OneDrive. You never need this unless something goes wrong — but it means you're safe if it does.

**On the Synology (DSM):**
1. Open **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**.
2. Schedule: **Daily**, time e.g. **1:00am**.
3. Task settings → paste this script (replace `YOUR-RAILWAY-URL` with your app URL):
   ```
   /usr/bin/curl -s "https://YOUR-RAILWAY-URL/api/backup?key=CHANGE-ME" -o /volume1/EstateBackups/estate-$(date +\%Y\%m\%d).db
   ```
   *(Ask your installer to enable the backup endpoint, or use Railway's built-in volume backup instead — see note below.)*
4. **Cloud Sync** (install from Package Center if needed) → add **OneDrive** → sync the `/volume1/EstateBackups` folder to OneDrive. Done.

> **Simpler alternative:** Railway can back the volume up for you. In the volume settings, enable **Backups**. Then you only need the OneDrive copy occasionally. For most people this is enough and Part 6's script is optional.

---

## First-run checklist (do this once the app is live)
1. Open `https://quotes.estatelandscapers.com.au/admin`.
2. **Settings → Management PIN**: change it from the default **1234**.
3. **Settings → Company**: check ABN, licence, phone, email, association line.
4. **Settings → Package descriptions**: paste your Basic / Standard / Premium wording.
5. **Pricing Sheet**: confirm every rate. Edit anything that's changed.
6. **Surcharges**: confirm your access/slope rates.
7. Make a **test quote**, open its client link on your phone, and run through accept + sign to confirm the email arrives.

## Day-to-day
- **New quote:** Quotes → New quote → fill details → add deliverables → upload the site drawing → copy the link → send to client.
- **Client accepts & signs** on the link; you and they both get the signed PDF by email.
- **Need to change an issued quote?** Open it → **New revision**. The old link auto-marks superseded; only the newest link is live.

## If something breaks
- **Email not sending:** double-check the three SMTP variables; try `smtp.zoho.com.au`.
- **Link shows "not found":** you may be using an old revision's link — resend the latest.
- **App won't load:** Railway → Deployments → check the latest build log, or click **Redeploy**.
