const PDFDocument = require('pdfkit');
const { mapUserToResumeSections } = require('./resumeContent.mapper');

/**
 * Compact one-page PDF from profile-derived sections.
 */
function renderProfileResumePdf(user) {
  const sections = mapUserToResumeSections(user);
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 40, bottom: 40, left: 50, right: 50 } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const L = 50;
    const W = doc.page.width - 100;
    const DARK = '#111';
    const MID = '#555';

    const rule = () => {
      doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor('#888').lineWidth(0.55).stroke();
      doc.moveDown(0.2);
    };

    const section = (title) => {
      doc.moveDown(0.35);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(title.toUpperCase(), L, doc.y, { width: W });
      rule();
      doc.moveDown(0.06);
    };

    const bullet = (text) => {
      const y = doc.y;
      doc.circle(L + 4, y + 4.5, 1.3).fill(DARK);
      doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(text, L + 12, y, { width: W - 14, lineGap: 0.5 });
    };

    doc.y = 40;
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#000').text(sections.name, L, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(MID).text(sections.headerLine || sections.email || ' ', L, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.35);
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor('#000').lineWidth(0.8).stroke();
    doc.moveDown(0.25);

    if (sections.education?.length) {
      section('Education');
      for (const e of sections.education) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(`${e.school} — ${e.location}`, L, doc.y, { width: W });
        doc.moveDown(0.06);
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MID).text(`${e.degree}  ·  ${e.dates}`, L, doc.y, { width: W });
        doc.moveDown(0.22);
      }
    }

    if (sections.experience?.length) {
      section('Experience');
      for (const x of sections.experience) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(`${x.title}  ·  ${x.dates}`, L, doc.y, { width: W });
        doc.moveDown(0.06);
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MID).text(`${x.company} — ${x.location}`, L, doc.y, { width: W });
        doc.moveDown(0.1);
        for (const b of (x.bullets || []).slice(0, 3)) {
          bullet(b);
          doc.moveDown(0.06);
        }
        doc.moveDown(0.12);
      }
    }

    if (sections.projects?.length) {
      section('Projects');
      for (const pr of sections.projects.slice(0, 2)) {
        doc.font('Helvetica-Bold').fontSize(9).text(`${pr.name}${pr.tech ? `  |  ${pr.tech}` : ''}`, L, doc.y, { width: W });
        doc.moveDown(0.08);
        for (const b of (pr.bullets || []).slice(0, 2)) {
          bullet(b);
          doc.moveDown(0.06);
        }
        doc.moveDown(0.1);
      }
    }

    section('Technical Skills');
    for (const g of sections.skillGroups.slice(0, 4)) {
      doc.font('Helvetica-Bold').fontSize(8.5).text(`${g.label}: `, L, doc.y, { continued: true })
        .font('Helvetica').fillColor(MID).text(g.value, { width: W });
      doc.moveDown(0.14);
    }

    doc.end();
  });
}

module.exports = { renderProfileResumePdf };
