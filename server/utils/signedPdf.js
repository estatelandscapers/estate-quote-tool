// Signed contract PDF via pdfkit (pure JS). Contains quote summary, standard
// conditions, special clauses, warranty, and the signature record.
const PDFDocument = require('pdfkit');

function buildSignedPdf({ quote, totals, settings }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const H = (t) => doc.moveDown(0.8).fontSize(13).fillColor('#1E5BFF').text(t.toUpperCase()).moveDown(0.3).fontSize(9.5).fillColor('#000');

    doc.fontSize(20).fillColor('#1E5BFF').text('ESTATE LANDSCAPERS');
    doc.fontSize(9).fillColor('#555').text(`${settings.company_abn}  ·  ${settings.company_lic}  ·  ${settings.company_address}`);
    doc.moveDown(1);
    doc.fontSize(15).fillColor('#000').text('SIGNED CONTRACT & ACCEPTANCE RECORD');
    doc.moveDown(0.5).fontSize(10);
    doc.text(`Quote: ${quote.quote_number}    Date: ${quote.quote_date}`);
    doc.text(`Client: ${quote.client_name}    Site: ${quote.address}`);
    doc.text(`Package accepted: ${quote.accepted_package}`);
    doc.text(`Contract Price: $${totals.grandExGst.toLocaleString()} + GST  ($${totals.grandIncGst.toLocaleString()} inc. GST)`);

    H('Signature record');
    doc.text(`Signed by: ${quote.signed_name}`);
    doc.text(`Signed at: ${quote.accepted_at} (server time, UTC)`);
    doc.text(`IP address: ${quote.signed_ip || 'n/a'}`);
    doc.text(`Signature (as entered): ${quote.signed_sig || quote.signed_name}`);

    H('Special clauses (as signed)');
    doc.text(quote.special_clauses || settings.default_special_clauses || 'None for this quote.');

    H('Warranty');
    doc.text(settings.warranty_text || '');

    H('Standard contract terms & conditions');
    doc.text(settings.standard_conditions || '');

    doc.moveDown(1).fontSize(8.5).fillColor('#888').text(settings.tagline || 'Integrity. Precision. Value.', { align: 'center' });
    doc.end();
  });
}
module.exports = { buildSignedPdf };
