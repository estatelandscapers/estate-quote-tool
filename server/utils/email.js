// Email sending.
//
// Railway blocks outbound SMTP (ports 465 and 587 both time out), so the tool sends over
// HTTPS via an email API instead. Pick ONE provider by setting its key in Railway:
//
//   ZeptoMail (Zoho's own — keeps your existing verified domain):
//     ZEPTOMAIL_TOKEN   the "Send Mail Token" from ZeptoMail
//   Resend:
//     RESEND_API_KEY
//   SendGrid:
//     SENDGRID_API_KEY
//
//   MAIL_FROM   optional, defaults to SMTP_USER or info@estatelandscapers.com.au
//
// If no API key is present it falls back to SMTP (which works on hosts that allow it).
const nodemailer = require('nodemailer');

const FROM_NAME = 'Estate Landscapers';
function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'info@estatelandscapers.com.au';
}
function provider() {
  if (process.env.ZEPTOMAIL_TOKEN) return 'zeptomail';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}
function configured() { return !!provider(); }

const b64 = c => Buffer.isBuffer(c) ? c.toString('base64') : Buffer.from(String(c)).toString('base64');

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// ZeptoMail needs two things people commonly get wrong:
//   1. the Authorization header must be "Zoho-enczapikey <token>", not the bare token
//   2. the endpoint is regional — AU-hosted Zoho accounts use api.zeptomail.com.au
// We normalise the token and try each region until one is accepted.
function zeptoAuth() {
  const raw = (process.env.ZEPTOMAIL_TOKEN || '').trim();
  return /^Zoho-enczapikey\s/i.test(raw) ? raw : `Zoho-enczapikey ${raw}`;
}
function zeptoEndpoints() {
  if (process.env.ZEPTOMAIL_URL) return [process.env.ZEPTOMAIL_URL];
  const r = (process.env.ZEPTOMAIL_REGION || '').toLowerCase();
  if (r === 'au') return ['https://api.zeptomail.com.au/v1.1/email'];
  if (r === 'eu') return ['https://api.zeptomail.eu/v1.1/email'];
  if (r === 'in') return ['https://api.zeptomail.in/v1.1/email'];
  // unknown: try AU first (this account is Australian), then global, then EU/IN
  return ['https://api.zeptomail.com.au/v1.1/email',
          'https://api.zeptomail.com/v1.1/email',
          'https://api.zeptomail.eu/v1.1/email',
          'https://api.zeptomail.in/v1.1/email'];
}
async function sendViaZepto({ to, subject, html, attachments }) {
  const body = {
    from: { address: fromAddress(), name: FROM_NAME },
    to: [{ email_address: { address: to } }],
    subject, htmlbody: html,
    attachments: (attachments || []).map(a => ({ name: a.filename, content: b64(a.content), mime_type: 'application/pdf' })),
  };
  const errors = [];
  for (const url of zeptoEndpoints()) {
    try {
      await postJson(url, { Authorization: zeptoAuth() }, body);
      console.log(`[email] zeptomail endpoint ${url} accepted`);
      return url;
    } catch (e) {
      errors.push(`${url.replace('https://api.', '').replace('/v1.1/email', '')}: ${e.message}`);
      // a 401 on one region usually means wrong region, so keep trying; other errors too
    }
  }
  throw new Error(errors.join(' | '));
}

async function sendViaResend({ to, subject, html, attachments }) {
  return postJson('https://api.resend.com/emails',
    { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    { from: `${FROM_NAME} <${fromAddress()}>`, to: [to], subject, html,
      attachments: (attachments || []).map(a => ({ filename: a.filename, content: b64(a.content) })) });
}
async function sendViaSendgrid({ to, subject, html, attachments }) {
  return postJson('https://api.sendgrid.com/v3/mail/send',
    { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
    { personalizations: [{ to: [{ email: to }] }],
      from: { email: fromAddress(), name: FROM_NAME },
      subject, content: [{ type: 'text/html', value: html }],
      attachments: (attachments || []).map(a => ({ filename: a.filename, content: b64(a.content), type: 'application/pdf' })) });
}

function smtpTransport(port) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(port), secure: Number(port) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 20000,
    tls: { rejectUnauthorized: false },
  });
}
function smtpPorts() {
  const p = Number(process.env.SMTP_PORT);
  return p === 465 ? [465, 587] : p === 587 ? [587, 465] : p ? [p] : [465, 587];
}
async function sendViaSmtp({ to, subject, html, attachments }) {
  const errors = [];
  for (const port of smtpPorts()) {
    try {
      await smtpTransport(port).sendMail({ from: `"${FROM_NAME}" <${fromAddress()}>`, to, subject, html, attachments });
      return `smtp:${port}`;
    } catch (e) { errors.push(`port ${port}: ${e.message}`); }
  }
  throw new Error(errors.join(' | '));
}

async function sendMail({ to, subject, html, attachments }) {
  const p = provider();
  if (!p) {
    console.log(`[email] no provider configured — skipped: ${subject} → ${to}`);
    return { skipped: true, reason: 'No email provider configured. Set ZEPTOMAIL_TOKEN, RESEND_API_KEY or SENDGRID_API_KEY in Railway.' };
  }
  if (!to) return { skipped: true, reason: 'no recipient address' };
  const payload = { to, subject, html, attachments };
  try {
    if (p === 'zeptomail') await sendViaZepto(payload);
    else if (p === 'resend') await sendViaResend(payload);
    else if (p === 'sendgrid') await sendViaSendgrid(payload);
    else await sendViaSmtp(payload);
    console.log(`[email] sent via ${p} → ${to} (${subject})`);
    return { ok: true, provider: p };
  } catch (e) {
    console.error(`[email] ${p} FAILED → ${to}: ${e.message}`);
    const err = new Error(`${p}: ${e.message}`);
    if (p === 'zeptomail' && /SERR_157|Invalid API Token|401/i.test(e.message)) {
      err.hint = 'ZeptoMail rejected the token on every region. Check you copied the Mail Agent\'s "Send Mail Token" (not an OAuth key), and that the Mail Agent is Active. If your Zoho account is Australian, set ZEPTOMAIL_REGION=au in Railway.';
    }
    throw err;
  }
}

// Used by the Settings "Send test email" button.
async function verifyConnection() {
  const p = provider();
  if (!p) return { ok: false, error: 'No email provider configured.',
    hint: 'Railway blocks SMTP, so set an email API key instead: ZEPTOMAIL_TOKEN (Zoho), RESEND_API_KEY or SENDGRID_API_KEY.' };
  if (p !== 'smtp') return { ok: true, provider: p };
  const errors = [];
  for (const port of smtpPorts()) {
    try { await smtpTransport(port).verify(); return { ok: true, provider: `smtp:${port}` }; }
    catch (e) { errors.push(`port ${port}: ${e.message}`); }
  }
  return { ok: false, provider: 'smtp', error: errors.join(' | '),
    hint: 'Both SMTP ports timed out — this host blocks outbound SMTP. Switch to an email API: set ZEPTOMAIL_TOKEN, RESEND_API_KEY or SENDGRID_API_KEY in Railway.' };
}
module.exports = { sendMail, configured, verifyConnection, provider, fromAddress };
