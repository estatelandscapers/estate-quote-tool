// Zoho Mail SMTP via nodemailer. Credentials come from environment variables
// (set in Railway → Variables; see SETUP-GUIDE.md):
//   SMTP_HOST  smtp.zoho.com   (use smtp.zoho.com.au if your Zoho account is AU-hosted)
//   SMTP_USER  info@estatelandscapers.com.au
//   SMTP_PASS  <Zoho App Password — NOT your normal password>
const nodemailer = require('nodemailer');

function configured() { return !!(process.env.SMTP_USER && process.env.SMTP_PASS); }

function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.zoho.com',
    port: 465, secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail({ to, subject, html, attachments }) {
  if (!configured()) { console.log('[email] SMTP not configured — skipped:', subject, '→', to); return { skipped: true }; }
  return transport().sendMail({ from: `"Estate Landscapers" <${process.env.SMTP_USER}>`, to, subject, html, attachments });
}

module.exports = { sendMail, configured };
