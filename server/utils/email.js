// SMTP via nodemailer.
//   SMTP_HOST  smtp.zoho.com   (use smtp.zoho.com.au if your Zoho account is AU-hosted)
//   SMTP_USER  info@estatelandscapers.com.au   — must be a full mailbox, not an alias
//   SMTP_PASS  Zoho App Password
//   SMTP_PORT  optional. 465 = SSL, 587 = STARTTLS. If unset we try 465 then fall back to 587.
// Cloud hosts often drop outbound traffic on 465, which shows up as "Connection timeout".
// We therefore fail fast and automatically retry on the other port before giving up.
const nodemailer = require('nodemailer');

function configured() { return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }

function transport(port) {
  const secure = Number(port) === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.zoho.com',
    port: Number(port), secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // fail in seconds, not minutes, so signing never appears to hang
    connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 20000,
    tls: { rejectUnauthorized: false },
  });
}

// Ports to attempt, in order. An explicit SMTP_PORT is tried first, then the other one.
function portPlan() {
  const p = Number(process.env.SMTP_PORT);
  if (p === 465) return [465, 587];
  if (p === 587) return [587, 465];
  if (p) return [p];
  return [465, 587];
}

async function sendMail({ to, subject, html, attachments }) {
  if (!configured()) {
    console.log(`[email] SMTP not configured — skipped: ${subject} → ${to}`);
    return { skipped: true, reason: 'SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)' };
  }
  if (!to) return { skipped: true, reason: 'no recipient address' };
  const from = `"Estate Landscapers" <${process.env.SMTP_USER}>`;
  const errors = [];
  for (const port of portPlan()) {
    try {
      const info = await transport(port).sendMail({ from, to, subject, html, attachments });
      console.log(`[email] sent on port ${port} → ${to} (${subject})`);
      return { ok: true, port, messageId: info.messageId };
    } catch (e) {
      const msg = `port ${port}: ${e.message}`;
      errors.push(msg);
      console.error(`[email] ${msg}`);
    }
  }
  const err = new Error(errors.join(' | '));
  err.allPortsFailed = true;
  throw err;
}

// Connection-only check for the Settings "Send test email" button.
async function verifyConnection() {
  if (!configured()) return { ok: false, error: 'SMTP not configured — set SMTP_HOST, SMTP_USER and SMTP_PASS in Railway.' };
  const errors = [];
  for (const port of portPlan()) {
    try { await transport(port).verify(); return { ok: true, port }; }
    catch (e) { errors.push(`port ${port}: ${e.message}`); }
  }
  return { ok: false, error: errors.join(' | ') };
}
module.exports = { sendMail, configured, verifyConnection };
