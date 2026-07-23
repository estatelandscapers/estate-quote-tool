// Signed contract PDF via pdfkit. Contains the full quote schedule (deliverables at the
// accepted spec + prices), site plan, payment schedule, signature IMAGE, special clauses,
// warranty and standard conditions.
const PDFDocument = require('pdfkit');

function money(n) { return '$' + Math.round(n || 0).toLocaleString('en-AU'); }

function buildSignedPdf({ quote, totals, settings, deliverables = [], payment = null, sitePlan = null, preview = false }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = doc.page.width - 100;
    const H = (t) => doc.moveDown(0.7).fontSize(12).fillColor('#1E5BFF').text(String(t).toUpperCase()).moveDown(0.25).fontSize(9.5).fillColor('#000');

    // ---- header ----
    doc.fontSize(20).fillColor('#1E5BFF').text('ESTATE LANDSCAPERS');
    doc.fontSize(8.5).fillColor('#555').text(`${settings.company_abn || ''}  ·  ${settings.company_lic || ''}  ·  ${settings.company_address || ''}`);
    doc.moveTo(50, doc.y + 4).lineTo(doc.page.width - 50, doc.y + 4).lineWidth(2).strokeColor('#1E5BFF').stroke();
    doc.moveDown(0.9);
    if (preview) doc.fontSize(9).fillColor('#B08D3E').text('PREVIEW — not a signed document', { align: 'right' }).fillColor('#000');
    doc.fontSize(14).fillColor('#000').text('SIGNED CONTRACT & ACCEPTANCE RECORD');
    doc.moveDown(0.4).fontSize(9.5);
    doc.text(`Quote: ${quote.quote_number}          Date: ${quote.quote_date || ''}`);
    doc.text(`Client: ${quote.client_name || ''}`);
    doc.text(`Site: ${quote.address || ''}`);
    doc.text(`Package accepted: ${quote.accepted_package || ''}`);
    doc.fontSize(11).fillColor('#1E5BFF')
      .text(`Contract Price: ${money(totals.grandExGst)} + GST  =  ${money(totals.grandIncGst)} inc. GST`).fillColor('#000');

    // ---- deliverables schedule ----
    if (deliverables.length) {
      H('Schedule of works — as accepted');
      const x0 = 50, cCode = 50, cName = 85, cQty = 355, cPrice = 445;
      doc.fontSize(8).fillColor('#777');
      doc.text('CODE', cCode, doc.y, { width: 32, continued: false });
      const hy = doc.y - 10;
      doc.text('DELIVERABLE / SPECIFICATION', cName, hy);
      doc.text('QTY', cQty, hy);
      doc.text('PRICE', cPrice, hy, { width: 95, align: 'right' });
      doc.moveTo(x0, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2).lineWidth(0.7).strokeColor('#CCC').stroke();
      doc.moveDown(0.4).fillColor('#000');
      deliverables.forEach(d => {
        if (doc.y > doc.page.height - 110) { doc.addPage(); doc.moveDown(0.5); }
        const y = doc.y;
        doc.fontSize(9).fillColor('#000').font('Helvetica-Bold').text(d.code || '', cCode, y, { width: 32 });
        doc.font('Helvetica').text(d.name || '', cName, y, { width: 262 });
        const afterName = doc.y;
        if (d.spec) doc.fontSize(8).fillColor('#666').text(d.spec, cName, doc.y, { width: 262 });
        doc.fontSize(9).fillColor('#000');
        doc.text(d.showQty ? `${d.qty} ${d.unit || ''}` : '', cQty, y, { width: 80 });
        doc.text(money(d.price), cPrice, y, { width: 95, align: 'right' });
        doc.y = Math.max(doc.y, afterName) + 3;
        doc.moveTo(x0, doc.y).lineTo(doc.page.width - 50, doc.y).lineWidth(0.4).strokeColor('#EEE').stroke();
        doc.moveDown(0.25);
      });
      doc.moveDown(0.3).fontSize(9.5);
      const tRow = (label, val, bold) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, cName, y, { width: 300 });
        doc.text(val, cPrice, y, { width: 95, align: 'right' }).font('Helvetica');
        doc.moveDown(0.15);
      };
      tRow('Subtotal (ex GST)', money(totals.grandExGst));
      tRow('GST (10%)', money(totals.grandIncGst - totals.grandExGst));
      tRow('TOTAL INC. GST', money(totals.grandIncGst), true);
      doc.x = 50;
    }

    // ---- payment schedule ----
    if (payment) {
      H('Agreed payment schedule');
      doc.fontSize(9.5).text(payment);
    }

    // ---- site plan ----
    if (sitePlan && sitePlan.data) {
      if (doc.y > doc.page.height - 260) doc.addPage();
      H('Approved site plan');
      try {
        doc.image(Buffer.from(sitePlan.data, 'base64'), { fit: [W, 300], align: 'center' });
        doc.moveDown(0.5);
      } catch (e) { doc.fontSize(9).fillColor('#888').text('(site plan image could not be embedded)').fillColor('#000'); }
    }

    // ---- signature ----
    if (doc.y > doc.page.height - 200) doc.addPage();
    H('Signature record');
    doc.fontSize(9.5);
    doc.text(`Signed by: ${quote.signed_name || ''}`);
    doc.text(`Signed at: ${quote.accepted_at || ''} (server time, UTC)`);
    doc.text(`IP address: ${quote.signed_ip || 'n/a'}`);
    doc.moveDown(0.4);
    const sig = quote.signed_sig || '';
    doc.fontSize(8).fillColor('#777').text('Signature:').fillColor('#000');
    const boxY = doc.y + 2;
    if (sig.startsWith('data:image')) {
      // drawn signature — embed the actual image, never the data URL text
      try {
        const b64 = sig.split(',')[1];
        doc.image(Buffer.from(b64, 'base64'), 52, boxY + 4, { fit: [220, 60] });
        doc.y = boxY + 70;
      } catch (e) { doc.fontSize(11).text(quote.signed_name || '', 52, boxY + 18); doc.y = boxY + 70; }
    } else {
      // typed signature — render in a script-like italic face
      doc.font('Helvetica-Oblique').fontSize(20).text(sig || quote.signed_name || '', 52, boxY + 14);
      doc.font('Helvetica'); doc.y = boxY + 60;
    }
    doc.moveTo(52, doc.y).lineTo(280, doc.y).lineWidth(0.8).strokeColor('#666').stroke();
    doc.moveDown(0.3).fontSize(8).fillColor('#666').text(`${quote.signed_name || ''} — Client`, 52).fillColor('#000');

    // ---- terms ----
    doc.addPage();
    H('Special clauses (as signed)');
    doc.fontSize(9).text(quote.special_clauses || settings.default_special_clauses || 'None for this quote.');
    H('Warranty');
    doc.fontSize(9).text(settings.warranty_text || '');
    H('Standard contract terms & conditions');
    doc.fontSize(8.5).text(settings.standard_conditions || '');

    doc.moveDown(1).fontSize(8.5).fillColor('#888').text(settings.tagline || 'Integrity. Precision. Value.', { align: 'center' });
    doc.end();
  });
}
module.exports = { buildSignedPdf };
