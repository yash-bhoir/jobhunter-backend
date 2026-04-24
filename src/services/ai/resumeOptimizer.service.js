const OpenAI  = require('openai');
const axios   = require('axios');
const zlib    = require('zlib');
const crypto  = require('crypto');
// pdf-parse required lazily (browser globals crash on import)

const getClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── ATS-Safe Text Normalization (career-ops inspired) ─────────────
// Strips Unicode characters that cause mojibake / ATS parsing errors.
// Runs on HTML before PDF generation so the output is ATS-clean.
const normalizeTextForATS = (html) => {
  // Mask <style> and <script> blocks so we don't corrupt CSS/JS
  const masked  = [];
  let safeHtml  = html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    masked.push(match);
    return `__MASKED_${masked.length - 1}__`;
  });

  // Normalize body text — these trip up ATS parsers
  safeHtml = safeHtml
    .replace(/\u2014/g, '-')           // em-dash → hyphen
    .replace(/\u2013/g, '-')           // en-dash → hyphen
    .replace(/[\u201C\u201D]/g, '"')   // smart double quotes → straight
    .replace(/[\u2018\u2019]/g, "'")   // smart single quotes → straight
    .replace(/\u2026/g, '...')         // ellipsis → three dots
    .replace(/\u200B/g, '')            // zero-width space → removed
    .replace(/\u00A0/g, ' ')           // non-breaking space → regular
    .replace(/\uFEFF/g, '')            // BOM → removed
    .replace(/\u2022/g, '-')           // bullet • → hyphen (some ATS hate bullets)
    .replace(/\u2019/g, "'");          // right single quote → apostrophe

  // Restore masked blocks
  safeHtml = safeHtml.replace(/__MASKED_(\d+)__/g, (_, i) => masked[parseInt(i)]);
  return safeHtml;
};

// ── Cache helpers (Redis, graceful no-op when unavailable) ─────────
let _cache = null;
const getCache = () => {
  if (!_cache) {
    try { _cache = require('../../config/redis').cache; } catch { _cache = null; }
  }
  return _cache;
};

const cacheGet = async (key) => { try { return await getCache()?.get(key); } catch { return null; } };
const cacheSet = async (key, val, ttl) => { try { await getCache()?.set(key, val, ttl); } catch {} };

// ── Download PDF from Cloudinary ─────────────────────────────────
const downloadPdfBuffer = async (url, publicId) => {
  const logger = require('../../config/logger');
  logger.info(`[Resume] Attempting download from: ${url}`);

  // First try: direct public URL
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    logger.info(`[Resume] Download success (${res.data.byteLength} bytes)`);
    return Buffer.from(res.data);
  } catch (firstErr) {
    const status = firstErr.response?.status;
    logger.warn(`[Resume] Direct URL failed — HTTP ${status || 'no-response'}: ${url}`);

    // For auth errors or 404, try multiple fallback strategies
    if (status === 404 || status === 401 || status === 403) {
      if (!publicId) return null;

      const { cloudinary } = require('../../config/cloudinary');

      // Strategy 1: signed CDN URL (extract real version from stored URL)
      const versionMatch = url.match(/\/v(\d+)\//);
      const version = versionMatch ? parseInt(versionMatch[1]) : undefined;

      for (const type of ['upload', 'authenticated']) {
        try {
          const signedUrl = cloudinary.url(publicId, {
            resource_type: 'raw',
            type,
            sign_url: true,
            secure:   true,
            ...(version && { version }),
          });
          logger.info(`[Resume] Signed CDN URL (type=${type}): ${signedUrl}`);
          const r = await axios.get(signedUrl, { responseType: 'arraybuffer', timeout: 15000 });
          logger.info(`[Resume] Signed CDN success (${r.data.byteLength} bytes)`);
          return Buffer.from(r.data);
        } catch (e) {
          logger.warn(`[Resume] Signed CDN failed (type=${type}): HTTP ${e.response?.status || 'err'}`);
        }
      }

      // Strategy 2: private_download_url — goes through API endpoint, bypasses CDN restrictions
      // NOTE: do NOT pass format for raw resources — public_id already contains the extension,
      // passing 'pdf' would cause Cloudinary to look for file.pdf.pdf (404)
      try {
        const privateUrl = cloudinary.utils.private_download_url(publicId, null, {
          resource_type: 'raw',
          expires_at:    Math.floor(Date.now() / 1000) + 300,
        });
        logger.info(`[Resume] Private download URL: ${privateUrl}`);
        const r = await axios.get(privateUrl, { responseType: 'arraybuffer', timeout: 15000 });
        logger.info(`[Resume] Private download success (${r.data.byteLength} bytes)`);
        return Buffer.from(r.data);
      } catch (e) {
        logger.warn(`[Resume] Private download failed: HTTP ${e.response?.status || 'err'} — ${e.message}`);
      }

      // Strategy 3: fetch via Cloudinary Admin API (uses HTTP Basic Auth with api_key:api_secret)
      try {
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        // Build signed download URL manually
        const timestamp = Math.floor(Date.now() / 1000);
        const crypto    = require('crypto');
        const toSign    = `expires_at=${timestamp + 300}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature = crypto.createHash('sha1').update(toSign).digest('hex');
        const adminUrl  = `https://api.cloudinary.com/v1_1/${cloudName}/raw/download`
          + `?public_id=${encodeURIComponent(publicId)}`
          + `&api_key=${apiKey}&timestamp=${timestamp}&expires_at=${timestamp + 300}&signature=${signature}`;
        logger.info(`[Resume] Admin download URL: ${adminUrl}`);
        const r = await axios.get(adminUrl, { responseType: 'arraybuffer', timeout: 15000 });
        logger.info(`[Resume] Admin download success (${r.data.byteLength} bytes)`);
        return Buffer.from(r.data);
      } catch (e) {
        logger.warn(`[Resume] Admin download failed: HTTP ${e.response?.status || 'err'} — ${e.message}`);
      }

      return null;
    }

    throw firstErr;
  }
};

// ── Extract text from PDF binary (handles compressed + uncompressed streams) ──
const extractTextFromPdfBinary = (buffer) => {
  try {
    const zlib    = require('zlib');
    const raw     = buffer.toString('binary'); // binary = latin1 preserves all bytes
    const texts   = [];

    const extractFromContentStream = (str) => {
      const btBlocks = str.match(/BT[\s\S]*?ET/g) || [];
      for (const block of btBlocks) {
        // (text) Tj
        const tjMatches = block.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g) || [];
        for (const m of tjMatches) {
          const t = m.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/);
          if (t) texts.push(
            t[1].replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\\(/g, '(').replace(/\\\)/g, ')')
          );
        }
        // [(text) 0 (text)] TJ
        const TJMatches = block.match(/\[([^\]]*)\]\s*TJ/g) || [];
        for (const m of TJMatches) {
          const inner = m.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) || [];
          for (const s of inner) {
            const t = s.slice(1, -1).replace(/\\\(/g, '(').replace(/\\\)/g, ')');
            if (t.trim()) texts.push(t);
          }
        }
      }
    };

    // Step 1: uncompressed BT..ET blocks
    extractFromContentStream(raw);

    // Step 2: decompress FlateDecode streams and extract text from each
    // Streams are delimited by "stream\r\n" or "stream\n" and "\nendstream"
    let pos = 0;
    while (pos < raw.length) {
      const streamStart = raw.indexOf('stream', pos);
      if (streamStart === -1) break;

      const nl = raw.indexOf('\n', streamStart);
      if (nl === -1) break;

      const endStream = raw.indexOf('endstream', nl);
      if (endStream === -1) break;

      const streamBytes = Buffer.from(raw.slice(nl + 1, endStream), 'binary');

      try {
        const decompressed = zlib.inflateSync(streamBytes);
        extractFromContentStream(decompressed.toString('latin1'));
      } catch { /* not a FlateDecode stream, skip */ }

      pos = endStream + 9;
    }

    return texts.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
};

// ── Extract text from PDF buffer ──────────────────────────────────
// Cache result by MD5 of buffer — saves re-parsing same PDF on every call.
// TTL: 30 days (same as search cache). Key: resume:text:{md5}
const extractResumeText = async (buffer) => {
  const bufHash = crypto.createHash('md5').update(buffer).digest('hex');
  const ck      = `resume:text:${bufHash}`;
  const cached  = await cacheGet(ck);
  if (cached && cached.length > 50) {
    const logger = require('../../config/logger');
    logger.info(`[Resume] Text cache hit (${cached.length} chars)`);
    return cached;
  }

  const text = await _extractResumeText(buffer);
  if (text.length > 50) await cacheSet(ck, text, 30 * 24 * 3600); // 30 days
  return text;
};

const _extractResumeText = async (buffer) => {
  // Polyfill process.getBuiltinModule (pdfjs-dist uses it to detect canvas)
  if (typeof process.getBuiltinModule !== 'function') {
    process.getBuiltinModule = (name) => { try { return require(name); } catch { return null; } };
  }
  // Polyfill browser globals required by pdfjs-dist
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
      constructor() { this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; }
      static fromMatrix() { return new DOMMatrix(); }
    };
  }
  if (typeof global.ImageData === 'undefined') {
    global.ImageData = class ImageData {
      constructor(w, h) { this.width=w||1; this.height=h||1; this.data=new Uint8ClampedArray((w||1)*(h||1)*4); }
    };
  }
  if (typeof global.Path2D === 'undefined') {
    global.Path2D = class Path2D {};
  }

  const logger = require('../../config/logger');

  // Strategy 1: pdf-parse 1.x (function API)
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const text = (data.text || '').trim();
    logger.info(`[Resume] pdf-parse extracted ${text.length} chars`);
    if (text.length > 50) return text;
  } catch (e) {
    logger.warn(`[Resume] pdf-parse failed: ${e.message}`);
  }

  // Strategy 2: binary extraction with zlib decompression
  logger.info('[Resume] Falling back to binary PDF text extraction');
  const binaryText = extractTextFromPdfBinary(buffer);
  logger.info(`[Resume] Binary extraction got ${binaryText.length} chars`);
  if (binaryText.length > 50) return binaryText;

  return '';
};

// ── Generate a formatted resume PDF from updated text ────────────
// Parses the AI-updated resume text into sections and produces a clean,
// professional PDF with all keyword changes applied.
const generateResumePdf = (resumeText, userName) => {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const M   = 40;   // margin
      const doc = new PDFDocument({ margin: M, size: 'A4', autoFirstPage: true });
      const chunks = [];

      doc.on('data',  c => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const lines      = resumeText.split('\n');
      const PAGE_W     = doc.page.width - M * 2;
      const SECTION_RE = /^(SUMMARY|OBJECTIVE|EXPERIENCE|WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|EDUCATION|SKILLS|TECHNICAL SKILLS|KEY SKILLS|CERTIFICATIONS|PROJECTS|ACHIEVEMENTS|AWARDS|LANGUAGES|INTERESTS|VOLUNTEER|PUBLICATIONS|REFERENCES|PROFILE|CAREER OBJECTIVE|EMPLOYMENT)/i;
      const CONTACT_RE = /(@|linkedin\.com|github\.com|\+\d|\d{10}|http)/i;

      let lineIdx = 0;

      // ── Name (first non-empty line) ──────────────────────────────
      while (lineIdx < lines.length && !lines[lineIdx].trim()) lineIdx++;
      if (lineIdx < lines.length) {
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1a2e')
           .text(lines[lineIdx].trim(), M, 36, { width: PAGE_W, align: 'center' });
        lineIdx++;
      }

      // ── Contact line(s) ──────────────────────────────────────────
      const contactLines = [];
      while (lineIdx < lines.length) {
        const t = lines[lineIdx].trim();
        if (!t) { lineIdx++; continue; }
        if (CONTACT_RE.test(t) || (contactLines.length === 0 && !SECTION_RE.test(t) && t.length < 120)) {
          contactLines.push(t); lineIdx++;
          if (contactLines.length >= 3) break;
        } else { break; }
      }
      if (contactLines.length) {
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(8.5).fillColor('#555555')
           .text(contactLines.join('  |  '), M, doc.y, { width: PAGE_W, align: 'center' });
      }

      // ── Divider ──────────────────────────────────────────────────
      doc.moveDown(0.35);
      doc.moveTo(M, doc.y).lineTo(M + PAGE_W, doc.y).lineWidth(1.2).strokeColor('#1a1a2e').stroke();
      doc.moveDown(0.25);

      // ── Body lines ───────────────────────────────────────────────
      for (; lineIdx < lines.length; lineIdx++) {
        const trimmed = lines[lineIdx].trim();

        if (!trimmed) { doc.moveDown(0.1); continue; }

        if (SECTION_RE.test(trimmed) && trimmed.length < 60) {
          if (doc.y > doc.page.height - 100) doc.addPage();
          doc.moveDown(0.25);
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#1a1a2e')
             .text(trimmed.toUpperCase(), M, doc.y, { width: PAGE_W });
          doc.moveTo(M, doc.y + 1).lineTo(M + PAGE_W, doc.y + 1)
             .lineWidth(0.4).strokeColor('#aaaaaa').stroke();
          doc.moveDown(0.18);
          continue;
        }

        if (/^[•\-\*▪]/.test(trimmed)) {
          const bulletText = trimmed.replace(/^[•\-\*▪]\s*/, '');
          doc.font('Helvetica').fontSize(9).fillColor('#222222')
             .text(`• ${bulletText}`, M + 10, doc.y, { width: PAGE_W - 12, lineGap: 1 });
          continue;
        }

        const isBoldLine = trimmed.length < 80 && !/[.?!]$/.test(trimmed)
          && /[A-Z]/.test(trimmed[0])
          && (lineIdx + 1 < lines.length ? !SECTION_RE.test(lines[lineIdx + 1].trim()) : true);

        if (isBoldLine && /[A-Z]{2,}/.test(trimmed.slice(0, 40))) {
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#333333')
             .text(trimmed, M, doc.y, { width: PAGE_W, lineGap: 1 });
        } else {
          doc.font('Helvetica').fontSize(9).fillColor('#333333')
             .text(trimmed, M, doc.y, { width: PAGE_W, lineGap: 1 });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

// ── Derive experience level from profile years ────────────────────
const deriveExperienceLevel = (years) => {
  const y = parseInt(years) || 0;
  if (y < 2)  return 'entry';
  if (y < 6)  return 'mid';
  return 'expert';
};

// ── CALL 1: JD Decoder ────────────────────────────────────────────
// Extracts structured brief from the job description: keywords, hard requirements,
// red flags, seniority signal, and section priority.
// Cache key: MD5(jobTitle + jd[:500]) — same JD always yields same brief.
// TTL: 30 days — JDs don't change. One cache hit saves ~400 tokens on every re-run.
const decodeJobDescription = async ({ jobTitle, jobDescription }) => {
  const logger = require('../../config/logger');
  const cacheInput = `jd:${jobTitle}||${(jobDescription || '').slice(0, 500)}`;
  const ck         = `ai:jd:${crypto.createHash('md5').update(cacheInput).digest('hex')}`;

  const cached = await cacheGet(ck);
  if (cached) {
    logger.info('[Resume] JD decode cache hit');
    return { ...cached, fromCache: true };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      seniority:        'mid',
      hard_requirements: [],
      nice_to_haves:    [],
      top_keywords:     [jobTitle],
      red_flags:        [],
      core_pain_point:  '',
      section_priority: ['experience', 'skills'],
      culture_signals:  [],
    };
  }

  const client = getClient();

  const systemPrompt = `You are an expert recruiter with 15 years of experience. Analyze the job description and return ONLY valid JSON — no markdown, no explanation — matching this exact schema:
{
  "seniority": "entry|mid|senior|lead|executive",
  "hard_requirements": ["must-have skill or qualification"],
  "nice_to_haves": ["preferred but not required"],
  "top_keywords": ["up to 12 ATS keywords from the JD"],
  "red_flags": ["things a resume should NOT mention for this role"],
  "core_pain_point": "one sentence: what problem this hire is solving",
  "section_priority": ["experience|skills|projects|education — most important first"],
  "culture_signals": ["startup|enterprise|research|agency|product"]
}`;

  const userPrompt = `Analyze this job description for the role: ${jobTitle}

${(jobDescription || '').slice(0, 3000)}`;

  const response = await client.chat.completions.create({
    model:           'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    max_tokens:      800,
    temperature:     0.1,
    response_format: { type: 'json_object' },
  });

  let brief;
  try {
    brief = JSON.parse(response.choices[0].message.content.trim());
  } catch {
    brief = {
      seniority: 'mid', hard_requirements: [], nice_to_haves: [],
      top_keywords: [jobTitle], red_flags: [], core_pain_point: '',
      section_priority: ['experience', 'skills'], culture_signals: [],
    };
  }

  await cacheSet(ck, brief, 30 * 24 * 3600);
  logger.info(`[Resume] JD decoded — ${brief.top_keywords?.length || 0} keywords, seniority=${brief.seniority}`);
  return brief;
};

// ── Level-specific writing instructions for Call 2 ────────────────
const LEVEL_INSTRUCTIONS = {
  entry: `EXPERIENCE LEVEL: Entry (0–2 years)
- Lead with Skills and Education — these are the strongest cards at this level
- Highlight projects, internships, and academic achievements prominently
- Bullet style: [Action verb] + [what you built/learned] + [technology or outcome]
- Summary: skills-forward and eager — "Recent graduate with strong X expertise, seeking to..."
- Keep Skills section prominent and detailed`,

  mid: `EXPERIENCE LEVEL: Mid (2–6 years)
- Lead with impact — metrics and outcomes over raw responsibilities
- Show a clear track record of delivery and increasing ownership
- Bullet style: [Strong verb] + [what you owned or delivered] + [measurable metric or outcome]
- Summary: confident and delivery-focused — "X years building/leading Y, consistently delivering Z"
- Balance Skills and Experience sections equally`,

  expert: `EXPERIENCE LEVEL: Expert (6+ years)
- Lead with Summary — your profile and reputation come first
- Emphasize leadership, scale, cross-team impact, and technical vision
- Bullet style: [Scope or org context] + [what you led or architected] + [scale, team size, or business result]
- Summary: vision and scale-focused — "Senior X with Y years leading Z at scale"
- Skills section should be brief — expertise is implied by the experience
- Education at the bottom, minimal detail`,
};

// ── CALL 2: Content Optimizer ─────────────────────────────────────
// Takes the JD brief from Call 1 + resume text + experience level.
// Rewrites the resume with level-aware tone, bullet structure, and JD keyword alignment.
// Cache key: MD5(resumeText + jdBrief + level) — 7 days.
const optimizeResumeContent = async ({ resumeText, jdBrief, level, jobTitle, company, userSkills }) => {
  const logger = require('../../config/logger');
  const cacheInput = `opt:${resumeText}||${JSON.stringify(jdBrief)}||${level}`;
  const ck         = `ai:opt:${crypto.createHash('md5').update(cacheInput).digest('hex')}`;

  const cached = await cacheGet(ck);
  if (cached) {
    logger.info('[Resume] Optimize cache hit — 0 tokens used');
    return { ...cached, tokensUsed: 0, fromCache: true };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      updatedResumeText: resumeText,
      keywordsAdded:     jdBrief.top_keywords || [],
      textReplacements:  [],
      atsScoreBefore:    45,
      atsScoreAfter:     65,
      fitScore:          60,
      gapAnalysis:       [],
      changesMade:       [],
      tokensUsed:        0,
    };
  }

  const client = getClient();

  const systemPrompt = `You are an elite resume writer and ATS optimization expert.

${LEVEL_INSTRUCTIONS[level] || LEVEL_INSTRUCTIONS.mid}

RULES:
1. NEVER invent facts, metrics, companies, job titles, or degrees
2. DO reframe existing experience with stronger verbs and clearer outcomes
3. DO reorder bullets within each role so the most JD-relevant ones appear first
4. Add missing JD keywords naturally — never keyword-stuff
5. Expand abbreviated tech names (e.g. "JS" → "JavaScript", "Node" → "Node.js")
6. Return ONLY valid JSON — no markdown, no explanation

OUTPUT SCHEMA:
{
  "text_replacements": [
    { "find": "exact substring from original resume", "replace": "improved version with JD keywords" }
  ],
  "updated_resume_text": "COMPLETE resume text with ALL replacements applied — every section, every line",
  "sections": {
    "name": "candidate full name",
    "phone": "phone number",
    "email": "email address",
    "city": "city, state/country",
    "linkedin": "linkedin URL if present",
    "portfolio": "portfolio/github URL if present",
    "summary": "2-3 sentence professional summary (optimized)",
    "experience": [
      { "company": "", "title": "", "dates": "", "location": "", "bullets": ["rewritten bullet 1"] }
    ],
    "education": [
      { "school": "", "degree": "", "dates": "", "location": "" }
    ],
    "projects": [
      { "name": "", "tech": "", "bullets": ["bullet 1"] }
    ],
    "skills": {
      "primary": ["most relevant skills first"],
      "secondary": ["other skills"]
    }
  },
  "keywords_added": ["keyword1", "keyword2"],
  "ats_score_before": "XX%",
  "ats_score_after": "XX%",
  "fit_score": 0-100,
  "gap_analysis": ["missing skill or experience 1", "missing skill or experience 2"],
  "changes_made": ["summary of key change 1", "key change 2"],
  "optimization_notes": "brief overall explanation of what changed and why"
}

IMPORTANT: updated_resume_text must be the COMPLETE resume — do not truncate or summarize it.
IMPORTANT: text_replacements "find" must be an EXACT copy-paste substring from the resume (character-for-character).
IMPORTANT: sections must be populated even if some fields are empty strings — never omit the sections object.`;

  const userPrompt = `TARGET ROLE: ${jobTitle}${company ? ` at ${company}` : ''}

JD ANALYSIS (from Call 1 decoder):
- Hard requirements: ${(jdBrief.hard_requirements || []).join(', ') || 'Not specified'}
- Top ATS keywords:  ${(jdBrief.top_keywords     || []).join(', ') || 'Not specified'}
- Nice-to-haves:     ${(jdBrief.nice_to_haves    || []).join(', ') || 'Not specified'}
- Avoid mentioning:  ${(jdBrief.red_flags        || []).join(', ') || 'None'}
- Core pain point:   ${jdBrief.core_pain_point   || 'Not specified'}
- Section priority:  ${(jdBrief.section_priority || []).join(' > ')}

CANDIDATE RESUME:
${resumeText}

CANDIDATE'S CURRENT SKILLS: ${(userSkills || []).join(', ') || 'Not listed'}

Optimize the resume for this specific role and experience level. Return the JSON.`;

  const response = await client.chat.completions.create({
    model:           'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    max_tokens:      4000,
    temperature:     0.15,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content.trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      updatedResumeText: resumeText,
      keywordsAdded:     [],
      textReplacements:  [],
      atsScoreBefore:    0,
      atsScoreAfter:     0,
      fitScore:          0,
      gapAnalysis:       [],
      changesMade:       [],
      tokensUsed:        response.usage?.total_tokens || 0,
    };
  }

  const before = parseInt(String(parsed.ats_score_before || '0').replace('%', '')) || 0;
  const after  = parseInt(String(parsed.ats_score_after  || '0').replace('%', '')) || 0;

  const result = {
    updatedResumeText: parsed.updated_resume_text || resumeText,
    sections:          parsed.sections            || null,
    keywordsAdded:     parsed.keywords_added      || [],
    textReplacements:  parsed.text_replacements   || [],
    atsScoreBefore:    before,
    atsScoreAfter:     after,
    fitScore:          typeof parsed.fit_score === 'number' ? parsed.fit_score : 0,
    gapAnalysis:       parsed.gap_analysis        || [],
    changesMade:       parsed.changes_made        || [],
    optimizationNotes: parsed.optimization_notes  || '',
    tokensUsed:        response.usage?.total_tokens || 0,
  };

  await cacheSet(ck, result, 7 * 24 * 3600);
  return result;
};

// ── Patch DOCX with keyword replacements ──────────────────────────
// DOCX files are ZIP archives containing word/document.xml (plain XML text).
// Simple string replacement works reliably for keyword-level changes.
// Returns patched DOCX buffer, or original if anything fails.
const patchDocxWithReplacements = async (docxBuffer, replacements) => {
  const logger = require('../../config/logger');
  if (!replacements?.length) return docxBuffer;

  try {
    const PizZip = require('pizzip');
    const zip    = new PizZip(docxBuffer);

    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) {
      logger.warn('[Resume] DOCX missing word/document.xml — returning original');
      return docxBuffer;
    }

    let xml     = xmlFile.asText();
    let patched = 0;

    for (const { find, replace: repl } of replacements) {
      if (!find || !repl || find === repl) continue;

      // Word XML splits text runs across multiple <w:t> tags.
      // Simple approach: replace in plain text within <w:t>...</w:t> tags only.
      // This avoids corrupting XML attributes.
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re      = new RegExp(`(<w:t[^>]*>)(.*?)(${escaped})(.*?)(</w:t>)`, 'g');
      const next    = xml.replace(re, (_, open, pre, _match, post, close) =>
        `${open}${pre}${repl}${post}${close}`
      );

      if (next !== xml) {
        xml = next;
        patched++;
        logger.debug(`[Resume DOCX] Patched: "${find}" → "${repl}"`);
      }
    }

    if (patched === 0) {
      // Fallback: try plain XML string replacement (catches cases where text isn't split)
      for (const { find, replace: repl } of replacements) {
        if (!find || !repl || find === repl) continue;
        if (xml.includes(find)) {
          xml = xml.split(find).join(repl);
          patched++;
        }
      }
    }

    logger.info(`[Resume DOCX] ${patched} replacements applied`);
    zip.file('word/document.xml', xml);
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch (err) {
    const logger = require('../../config/logger');
    logger.warn(`[Resume DOCX] Patching failed (${err.message}) — returning original`);
    return docxBuffer;
  }
};

// ── Main export ───────────────────────────────────────────────────
const optimizeResumeForJob = async ({
  resumeUrl,
  resumePublicId,
  resumeDbBuffer,      // MongoDB-stored buffer — highest priority, no CDN needed
  resumeDocxBuffer,    // Original DOCX — enables pixel-perfect keyword patching
  userProvidedText,
  profileFallbackText, // profile-derived text when PDF extraction is empty
  existingSkills,
  experienceYears,     // from user.profile.experience — drives level selection
  templateId,          // ResumeTemplate _id — null means "keep original format" (PDFKit basic)
  jobTitle,
  jobDescription,
  company,
  userName,
}) => {
  const logger = require('../../config/logger');

  // 1. Get resume text and original PDF buffer
  let originalBuffer = null;
  let originalText   = '';

  // Priority 1: MongoDB-stored buffer (never blocked by CDN)
  if (resumeDbBuffer) {
    originalBuffer = Buffer.isBuffer(resumeDbBuffer) ? resumeDbBuffer : Buffer.from(resumeDbBuffer);
    logger.info(`[Resume] Using DB-stored buffer (${originalBuffer.length} bytes)`);
  }

  if (userProvidedText?.trim()) {
    originalText = userProvidedText.trim();
    // If we don't have the buffer yet, try Cloudinary as fallback
    if (!originalBuffer && resumeUrl) {
      try { originalBuffer = await downloadPdfBuffer(resumeUrl, resumePublicId); } catch { /* ok */ }
    }
  } else if (originalBuffer) {
    // Extract text from DB buffer
    originalText = await extractResumeText(originalBuffer);
  } else if (resumeUrl) {
    // Priority 2: Cloudinary download
    try {
      originalBuffer = await downloadPdfBuffer(resumeUrl, resumePublicId);
      if (originalBuffer) {
        originalText = await extractResumeText(originalBuffer);
      }
    } catch (err) {
      logger.warn(`Resume download error: ${err.message}`);
    }
  }

  if (!originalText.trim() && profileFallbackText?.trim()) {
    originalText = profileFallbackText.trim();
  }

  // If we could not get resume text, surface a clear error (profile fallback already tried)
  if (!originalText.trim()) {
    const err = new Error(
      'RESUME_TEXT_UNAVAILABLE: Could not read text from your resume file. ' +
      'Try re-uploading a text-based PDF, upload a .docx in Profile, or complete your Profile skills and summary.'
    );
    err.code = 'PASTE_REQUIRED';
    throw err;
  }

  // 2. Two-call AI pipeline
  const level = deriveExperienceLevel(experienceYears);
  logger.info(`[Resume] Experience level: ${level} (${experienceYears || 0} yrs)`);

  // Call 1 — decode the JD into structured brief (cheap, cached 30 days)
  const jdBrief = await decodeJobDescription({ jobTitle, jobDescription });

  // Call 2 — level-aware resume rewrite using the decoded brief (gpt-4o, cached 7 days)
  const aiResult = await optimizeResumeContent({
    resumeText: originalText,
    jdBrief,
    level,
    jobTitle,
    company,
    userSkills: existingSkills,
  });

  // 3. Build output PDF
  let optimizedPdfBuffer;
  let usedTemplate = null;

  if (templateId && aiResult.sections) {
    // Template mode: render structured sections with the chosen PDFKit template
    try {
      const ResumeTemplate        = require('../../models/ResumeTemplate');
      const { renderResumeWithTemplate } = require('../resume/templateRenderer');
      const tpl = await ResumeTemplate.findById(templateId).lean();
      if (tpl) {
        usedTemplate = tpl;
        logger.info(`[Resume] Rendering with template "${tpl.name}" (style=${tpl.style})`);
        optimizedPdfBuffer = await renderResumeWithTemplate(aiResult.sections, tpl);
        logger.info(`[Resume] Template PDF: ${optimizedPdfBuffer.length} bytes`);
      }
    } catch (tplErr) {
      logger.warn(`[Resume] Template render failed (${tplErr.message}) — falling back to basic PDF`);
    }
  }

  if (!optimizedPdfBuffer) {
    // "Keep original format" or template render failed: basic PDFKit from AI text
    logger.info(`[Resume] Generating basic PDF (${aiResult.updatedResumeText?.length || 0} chars)`);
    const atsCleanText = normalizeTextForATS(aiResult.updatedResumeText || '');
    optimizedPdfBuffer = await generateResumePdf(atsCleanText, userName);
    logger.info(`[Resume] Basic PDF: ${optimizedPdfBuffer.length} bytes`);
  }

  // DOCX: if user uploaded a .docx, patch keywords directly in the XML — exact layout preserved
  let optimizedDocxBuffer = null;
  if (resumeDocxBuffer) {
    const docxBuf = Buffer.isBuffer(resumeDocxBuffer)
      ? resumeDocxBuffer
      : Buffer.from(resumeDocxBuffer);
    logger.info(`[Resume] Patching DOCX (${docxBuf.length} bytes) with ${aiResult.textReplacements?.length || 0} replacements`);
    optimizedDocxBuffer = await patchDocxWithReplacements(docxBuf, aiResult.textReplacements);
    logger.info(`[Resume] DOCX patched: ${optimizedDocxBuffer.length} bytes`);
  }

  return {
    originalText,
    originalBuffer,
    optimizedPdfBuffer,
    optimizedDocxBuffer,    // null if no DOCX uploaded; Buffer if patched
    updatedResumeText:  aiResult.updatedResumeText,
    sections:           aiResult.sections,
    textReplacements:   aiResult.textReplacements,
    keywordsAdded:      aiResult.keywordsAdded,
    atsScoreBefore:     aiResult.atsScoreBefore,
    atsScoreAfter:      aiResult.atsScoreAfter,
    fitScore:           aiResult.fitScore,
    gapAnalysis:        aiResult.gapAnalysis,
    changesMade:        aiResult.changesMade,
    optimizationNotes:  aiResult.optimizationNotes,
    level,
    usedTemplate:       usedTemplate ? { _id: usedTemplate._id, name: usedTemplate.name, style: usedTemplate.style } : null,
    tokensUsed:         aiResult.tokensUsed,
    usedOriginalPdf:    false,
    hasDocx:            !!optimizedDocxBuffer,
  };
};

module.exports = {
  downloadPdfBuffer,
  extractResumeText,
  optimizeResumeForJob,
  normalizeTextForATS,
  generateResumePdf,
  deriveExperienceLevel,
  decodeJobDescription,
};
