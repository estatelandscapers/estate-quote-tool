// Branded HTML for the quote email. Same palette as the tool and the client link.
const { settingGet } = require('../db');
const BLUE = '#1E5BFF', INK = '#000000', LGREY = '#F5F5F5';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const para = t => esc(t).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;">${p.replace(/\n/g, '<br>')}</p>`).join('');

function signatureHtml() {
  const sig = settingGet('email_signature') || '';
  const lines = sig.split('\n').filter(Boolean).map(esc);
  const name = lines.shift() || '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-collapse:collapse;">
    <tr><td style="border-left:3px solid ${BLUE};padding-left:12px;font-size:13px;line-height:1.7;color:${INK};font-family:Montserrat,Arial,sans-serif;">
      <b>${name}</b><br>${lines.join('<br>')}
      <div style="color:#888;font-size:11.5px;margin-top:7px;">
        ${esc(settingGet('company_abn') || '')} &middot; ${esc(settingGet('company_lic') || '')}<br>
        ${esc(settingGet('association_line') || '')}
      </div>
    </td></tr></table>`;
}

// Shared shell so quote emails and contract emails look like the same company.
function shell(inner) {
  return `<div style="background:${LGREY};padding:24px 12px;font-family:Montserrat,Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
      <div style="background:${BLUE};padding:20px 24px;">
        <div style="color:#fff;font-size:17px;font-weight:800;letter-spacing:2px;">ESTATE LANDSCAPERS</div>
        <div style="color:#cfe0ff;font-size:9.5px;letter-spacing:2px;text-transform:uppercase;margin-top:3px;">Integrity. Precision. Value.</div>
      </div>
      <div style="padding:26px 24px;color:${INK};font-size:14px;line-height:1.65;">${inner}</div>
      <div style="background:${LGREY};padding:14px 24px;color:#888;font-size:11px;text-align:center;">
        ${esc(settingGet('company_name') || 'Estate Landscapers')} &middot; ${esc(settingGet('company_address') || '')}
      </div>
    </div></div>`;
}

function quoteEmailHtml({ message, link, quoteNumber, validUntil }) {
  return shell(`
    ${para(message)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto;"><tr><td style="border-radius:8px;background:${BLUE};">
      <a href="${esc(link)}" style="display:inline-block;padding:14px 30px;color:#fff;text-decoration:none;font-weight:800;font-size:13px;letter-spacing:.6px;text-transform:uppercase;font-family:Montserrat,Arial,sans-serif;">View your quote</a>
    </td></tr></table>
    <div style="text-align:center;color:#888;font-size:12px;margin-bottom:6px;">
      Quote ${esc(quoteNumber)}${validUntil ? ` &middot; valid until ${esc(validUntil)}` : ''}
    </div>
    <div style="text-align:center;color:#aaa;font-size:11px;word-break:break-all;">
      Or paste this into your browser:<br>${esc(link)}
    </div>
    ${signatureHtml()}`);
}
module.exports = { quoteEmailHtml, signatureHtml, shell, esc };
