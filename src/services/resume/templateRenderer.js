const PDFDocument = require('pdfkit');

// ── Style definitions (9 total) ───────────────────────────────────
const STYLE_DEFS = {
  classic:   { headerBg: '#1a1a2e', headerFg: '#ffffff', accent: '#1a1a2e', muted: '#555555', sectionOrder: ['summary','experience','education','skills','projects'] },
  modern:    { headerBg: '#4f46e5', headerFg: '#ffffff', accent: '#4f46e5', muted: '#6b7280', sectionOrder: ['summary','experience','skills','projects','education'] },
  minimal:   { headerBg: '#ffffff', headerFg: '#000000', accent: '#111111', muted: '#888888', sectionOrder: ['summary','experience','skills','education','projects'] },
  tech:      { headerBg: '#0f172a', headerFg: '#e2e8f0', accent: '#0ea5e9', muted: '#64748b', sectionOrder: ['skills','experience','projects','education'] },
  executive: { headerBg: '#1e3a5f', headerFg: '#ffffff', accent: '#1e3a5f', muted: '#4a4a4a', sectionOrder: ['summary','experience','education','skills','projects'] },
  // ── 4 new styles ───────────────────────────────────────────────
  clean:     { headerBg: '#f9fafb', headerFg: '#111827', accent: '#374151', muted: '#9ca3af', sectionOrder: ['summary','experience','skills','education','projects'] },
  bold:      { headerBg: '#111111', headerFg: '#ffffff', accent: '#111111', muted: '#6b7280', sectionOrder: ['experience','skills','summary','projects','education'] },
  sidebar:   { headerBg: '#6366f1', headerFg: '#ffffff', accent: '#6366f1', muted: '#64748b', sectionOrder: ['summary','skills','experience','projects','education'] },
  compact:   { headerBg: '#1f2937', headerFg: '#f9fafb', accent: '#374151', muted: '#6b7280', sectionOrder: ['experience','skills','projects','summary','education'] },
};

// ── Layout constants ──────────────────────────────────────────────
const ML = 42;  // left margin
const MR = 42;  // right margin
const getW = (doc) => doc.page.width - ML - MR;

// ── Shared helpers ────────────────────────────────────────────────
function makeDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  return { doc, chunks };
}

function contactLine(doc, s, fg, y) {
  const bits = [s.phone, s.email, s.city, s.linkedin, s.portfolio].filter(Boolean);
  if (!bits.length) return;
  doc.font('Helvetica').fontSize(8).fillColor(fg).opacity(0.85)
     .text(bits.join('  ·  '), ML, y || doc.y, { width: getW(doc), align: 'center' });
  doc.opacity(1);
}

function sectionBlock(doc, title, accent, muted, renderContent) {
  const w = getW(doc);
  if (doc.y > doc.page.height - 100) doc.addPage();
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(accent)
     .text(title.toUpperCase(), ML, doc.y, { width: w });
  doc.moveTo(ML, doc.y + 1).lineTo(ML + w, doc.y + 1).lineWidth(0.5).strokeColor(accent).stroke();
  doc.moveDown(0.2);
  renderContent(doc, w, muted);
}

function bullets(doc, list, w, muted, indent = 8) {
  for (const b of (list || []).slice(0, 5)) {
    if (!b?.trim()) continue;
    const y = doc.y;
    doc.circle(ML + indent + 3, y + 3.8, 1.3).fill(muted);
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
       .text(b.trim(), ML + indent + 9, y, { width: w - indent - 10, lineGap: 1 });
  }
}

function experience(doc, items, w, accent, muted) {
  for (const x of (items || [])) {
    if (doc.y > doc.page.height - 80) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111')
       .text([x.title, x.company].filter(Boolean).join('  ·  '), ML, doc.y, { width: w });
    const meta = [x.dates, x.location].filter(Boolean).join('  |  ');
    if (meta) doc.font('Helvetica').fontSize(8).fillColor(muted).text(meta, ML, doc.y, { width: w });
    doc.moveDown(0.1);
    bullets(doc, x.bullets, w, muted);
    doc.moveDown(0.3);
  }
}

function education(doc, items, w, muted) {
  for (const e of (items || [])) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(e.school || '', ML, doc.y, { width: w });
    const sub = [e.degree, e.dates, e.location].filter(Boolean).join('  ·  ');
    if (sub) doc.font('Helvetica').fontSize(8).fillColor(muted).text(sub, ML, doc.y, { width: w });
    doc.moveDown(0.25);
  }
}

function skills(doc, sk, w, accent, muted) {
  const all = [...(sk?.primary || []), ...(sk?.secondary || [])];
  if (!all.length) return;
  for (let i = 0; i < all.length; i += 7) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
       .text(all.slice(i, i + 7).join('  •  '), ML, doc.y, { width: w });
    doc.moveDown(0.18);
  }
}

function projects(doc, items, w, accent, muted) {
  for (const pr of (items || []).slice(0, 4)) {
    const h = pr.tech ? `${pr.name}  |  ${pr.tech}` : pr.name;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(h, ML, doc.y, { width: w });
    doc.moveDown(0.08);
    bullets(doc, pr.bullets, w, muted);
    doc.moveDown(0.25);
  }
}

function summary(doc, text, w) {
  if (!text?.trim()) return;
  doc.font('Helvetica').fontSize(8.5).fillColor('#222')
     .text(text.trim(), ML, doc.y, { width: w, align: 'justify', lineGap: 1 });
  doc.moveDown(0.25);
}

function renderSection(key, doc, s, w, accent, muted) {
  switch (key) {
    case 'summary':    if (s.summary?.trim())               sectionBlock(doc, 'Professional Summary', accent, muted, (d,w) => summary(d, s.summary, w));     break;
    case 'experience': if (s.experience?.length)            sectionBlock(doc, 'Experience',           accent, muted, (d,w) => experience(d, s.experience, w, accent, muted)); break;
    case 'education':  if (s.education?.length)             sectionBlock(doc, 'Education',            accent, muted, (d,w) => education(d, s.education, w, muted)); break;
    case 'skills':     if (s.skills?.primary?.length)       sectionBlock(doc, 'Skills',               accent, muted, (d,w) => skills(d, s.skills, w, accent, muted)); break;
    case 'projects':   if (s.projects?.length)              sectionBlock(doc, 'Projects',             accent, muted, (d,w) => projects(d, s.projects, w, accent, muted)); break;
  }
}

// ── Header styles ─────────────────────────────────────────────────
function hClassic(doc, s, st) {
  const w = getW(doc), bgH = 66;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 14, { width: w, align: 'center' });
  doc.moveDown(0.12); contactLine(doc, s, st.headerFg);
  doc.y = bgH + 6;
}

function hModern(doc, s, st) {
  const w = getW(doc), bgH = 62;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.rect(0, bgH, doc.page.width, 3).fill(st.accent);
  doc.font('Helvetica-Bold').fontSize(19).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 13, { width: w, align: 'center' });
  doc.moveDown(0.1); contactLine(doc, s, st.headerFg);
  doc.y = bgH + 10;
}

function hMinimal(doc, s, st) {
  const w = getW(doc);
  doc.y = 32;
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#000').text(s.name || 'Your Name', ML, doc.y, { width: w });
  doc.moveDown(0.15); contactLine(doc, s, '#555');
  doc.moveDown(0.25);
  doc.moveTo(ML, doc.y).lineTo(ML + w, doc.y).lineWidth(1.5).strokeColor('#000').stroke();
  doc.moveDown(0.4);
}

function hTech(doc, s, st) {
  const w = getW(doc), bgH = 58;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.rect(0, 0, 5, bgH).fill(st.accent);
  doc.font('Helvetica-Bold').fontSize(19).fillColor(st.headerFg).text(s.name || 'Your Name', ML + 5, 11, { width: w - 5 });
  doc.moveDown(0.12); contactLine(doc, s, st.headerFg);
  doc.y = bgH + 6;
}

function hExecutive(doc, s, st) {
  const w = getW(doc), bgH = 74;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 16, { width: w, align: 'center' });
  doc.moveDown(0.15); contactLine(doc, s, st.headerFg);
  doc.y = bgH + 8;
}

function hClean(doc, s, st) {
  const w = getW(doc);
  doc.rect(0, 0, doc.page.width, 56).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 12, { width: w, align: 'center' });
  doc.moveDown(0.12); contactLine(doc, s, '#555');
  doc.moveDown(0.2);
  doc.moveTo(ML, doc.y).lineTo(ML + w, doc.y).lineWidth(0.5).strokeColor('#d1d5db').stroke();
  doc.y = 64;
}

function hBold(doc, s, st) {
  const w = getW(doc), bgH = 60;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(21).fillColor(st.headerFg).text((s.name || 'Your Name').toUpperCase(), ML, 12, { width: w, align: 'center' });
  doc.moveDown(0.1); contactLine(doc, s, '#cccccc');
  doc.y = bgH + 6;
}

function hSidebar(doc, s, st) {
  const w = getW(doc), bgH = 64;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 14, { width: w, align: 'center' });
  doc.moveDown(0.1); contactLine(doc, s, '#e0e7ff');
  doc.y = bgH + 6;
}

function hCompact(doc, s, st) {
  const w = getW(doc), bgH = 52;
  doc.rect(0, 0, doc.page.width, bgH).fill(st.headerBg);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(st.headerFg).text(s.name || 'Your Name', ML, 10, { width: w, align: 'center' });
  doc.moveDown(0.1); contactLine(doc, s, '#d1d5db');
  doc.y = bgH + 5;
}

const HEADERS = { classic: hClassic, modern: hModern, minimal: hMinimal, tech: hTech, executive: hExecutive, clean: hClean, bold: hBold, sidebar: hSidebar, compact: hCompact };

// ── Main export ───────────────────────────────────────────────────
const renderResumeWithTemplate = (sections, template) => {
  return new Promise((resolve, reject) => {
    try {
      const styleName = template?.style || 'classic';
      const def = { ...STYLE_DEFS[styleName] || STYLE_DEFS.classic };
      if (template?.accentColor?.trim()) def.accent = template.accentColor.trim();

      const { doc, chunks } = makeDoc();
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const renderHeader = HEADERS[styleName] || hClassic;
      renderHeader(doc, sections, def);

      const w = getW(doc);
      for (const key of def.sectionOrder) renderSection(key, doc, sections, w, def.accent, def.muted);

      doc.end();
    } catch (err) { reject(err); }
  });
};

module.exports = { renderResumeWithTemplate, STYLE_DEFS };
