// Signed contract PDF via pdfkit. Contains the full quote schedule (deliverables at the
// accepted spec + prices), site plan, payment schedule, signature IMAGE, special clauses,
// warranty and standard conditions.
const PDFDocument = require('pdfkit');

function money(n) { return '$' + Math.round(n || 0).toLocaleString('en-AU'); }

function buildSignedPdf({ quote, totals, settings, deliverables = [], payment = null, sitePlan = null, preview = false }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true });
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
      const cCode = 52, cName = 88, cQty = 372, cPrice = 452, wName = 275;
      const headRow = () => {
        doc.fontSize(7.5).fillColor('#777').font('Helvetica-Bold');
        const y = doc.y;
        doc.text('CODE', cCode, y); doc.text('DELIVERABLE / SPECIFICATION', cName, y);
        doc.text('QTY', cQty, y); doc.text('PRICE', cPrice, y, { width: 92, align: 'right' });
        doc.font('Helvetica').fillColor('#000');
        doc.y = y + 12;
        doc.moveTo(cCode, doc.y).lineTo(doc.page.width - 50, doc.y).lineWidth(0.8).strokeColor('#BBB').stroke();
        doc.y += 5;
      };
      headRow();
      deliverables.forEach(d => {
        // measure the row first so nothing can overlap
        doc.fontSize(9);
        const nameH = doc.heightOfString(d.name || '', { width: wName });
        const specH = d.spec ? doc.fontSize(7.8).heightOfString(d.spec, { width: wName }) : 0;
        const rowH = nameH + (specH ? specH + 2 : 0) + 8;
        if (doc.y + rowH > doc.page.height - 70) { doc.addPage(); headRow(); }
        const y = doc.y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(d.code || '', cCode, y, { width: 32, lineBreak: false });
        doc.font('Helvetica').text(d.name || '', cName, y, { width: wName });
        if (d.spec) doc.fontSize(7.8).fillColor('#666').text(d.spec, cName, y + nameH + 1, { width: wName });
        doc.fontSize(9).fillColor('#000');
        doc.text(d.showQty ? `${d.qty} ${d.unit || ''}` : '', cQty, y, { width: 74, lineBreak: false });
        doc.text(d.price ? money(d.price) : '—', cPrice, y, { width: 92, align: 'right', lineBreak: false });
        doc.y = y + rowH - 4;
        doc.moveTo(cCode, doc.y).lineTo(doc.page.width - 50, doc.y).lineWidth(0.4).strokeColor('#E8E8E8').stroke();
        doc.y += 4;
      });
      doc.y += 4;
      const tRow = (label, val, bold) => {
        const y = doc.y;
        doc.fontSize(bold ? 10.5 : 9.5).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(label, cName, y, { width: 280, lineBreak: false });
        doc.text(val, cPrice, y, { width: 92, align: 'right', lineBreak: false });
        doc.font('Helvetica').fontSize(9.5);
        doc.y = y + (bold ? 16 : 13);
      };
      doc.moveTo(cName, doc.y).lineTo(doc.page.width - 50, doc.y).lineWidth(0.8).strokeColor('#BBB').stroke();
      doc.y += 5;
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

    // Signature strip on the footer of EVERY page, plus page numbers.
    const range = doc.bufferedPageRange();
    const sigRaw = quote.signed_sig || '';
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const fy = doc.page.height - 44;
      doc.moveTo(50, fy - 8).lineTo(doc.page.width - 50, fy - 8).lineWidth(0.5).strokeColor('#DDD').stroke();
      doc.fontSize(7).fillColor('#999')
        .text(`${settings.tagline || 'Integrity. Precision. Value.'}   ·   Quote ${quote.quote_number}   ·   Page ${i - range.start + 1} of ${range.count}`,
          50, fy + 12, { width: 300, lineBreak: false });
      doc.fontSize(7).fillColor('#999').text('Signed:', doc.page.width - 190, fy - 2, { lineBreak: false });
      if (sigRaw.startsWith('data:image')) {
        try { doc.image(Buffer.from(sigRaw.split(',')[1], 'base64'), doc.page.width - 155, fy - 8, { fit: [95, 26] }); } catch (e) {}
      } else {
        doc.font('Helvetica-Oblique').fontSize(11).fillColor('#333')
          .text(sigRaw || quote.signed_name || '', doc.page.width - 155, fy - 2, { width: 105, lineBreak: false }).font('Helvetica');
      }
      doc.fontSize(6.5).fillColor('#AAA').text(quote.signed_name || '', doc.page.width - 155, fy + 14, { width: 105, lineBreak: false });
    }
    doc.end();
  });
}
module.exports = { buildSignedPdf };
