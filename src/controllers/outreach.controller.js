const OutreachEmail = require('../models/OutreachEmail');
const Job           = require('../models/Job');
const LinkedInJob   = require('../models/LinkedInJob');
const User          = require('../models/User');
const UserCredits   = require('../models/UserCredits');
const { generateOutreachEmail, enhanceOutreachEmail } = require('../services/ai/emailWriter.service');
const { sendOutreachEmail }      = require('../services/outreach/smtp.service');
const { optimizeResumeForJob, downloadPdfBuffer } = require('../services/ai/resumeOptimizer.service');
const { enqueueEmail }           = require('../config/queue');
const { success, paginated }     = require('../utils/response.util');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { CREDIT_COSTS }           = require('../utils/constants');
const logger = require('../config/logger');

// ── Get all outreach emails ───────────────────────────────────────
exports.getEmails = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;

    const filter = { userId: req.user._id };
    if (status) filter.status = status;

    const [emails, total] = await Promise.all([
      OutreachEmail.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      OutreachEmail.countDocuments(filter),
    ]);

    return paginated(res, emails, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Generate AI email ─────────────────────────────────────────────
exports.generateEmail = async (req, res, next) => {
  try {
    const { company, jobTitle, jobUrl, recruiterName, jobId, jobDescription } = req.body;

    if (!company || !jobTitle) {
      throw new ValidationError('Company and job title are required');
    }

    const user = await User.findById(req.user._id);

    // Enrich jobDescription from the stored Job/LinkedInJob if not provided in body
    let resolvedJd = jobDescription || '';
    if (!resolvedJd && jobId) {
      try {
        const storedJob = await Job.findOne({ _id: jobId, userId: req.user._id }).select('description').lean()
          || await LinkedInJob.findOne({ _id: jobId, userId: req.user._id }).select('description').lean();
        resolvedJd = storedJob?.description || '';
      } catch { /* silent — JD enrichment is best-effort */ }
    }

    const candidate = {
      name:        user.fullName || `${user.profile?.firstName} ${user.profile?.lastName}`.trim(),
      currentRole: user.profile?.currentRole  || 'Professional',
      experience:  user.profile?.experience   || 0,
      skills:      user.profile?.skills       || [],
      expectedCTC: user.profile?.expectedCTC  || 'negotiable',
      phone:       user.profile?.phone        || '',
      linkedinUrl: user.profile?.linkedinUrl  || '',
    };

    const result = await generateOutreachEmail({
      recruiterName,
      company,
      jobTitle,
      jobUrl,
      jobDescription: resolvedJd,
      candidate,
    });

    // Save as draft
    const draft = await OutreachEmail.create({
      userId:       req.user._id,
      jobId:        jobId || null,
      to:           '',
      subject:      result.subject,
      body:         result.body,
      company,
      recruiterName,
      status:       'pending',
      aiGenerated:  true,
      tokensUsed:   result.tokensUsed,
    });

    logger.info(`AI email generated for ${company} — ${result.tokensUsed} tokens`);

    return success(res, {
      emailId: draft._id,
      subject: result.subject,
      body:    result.body,
      tokensUsed: result.tokensUsed,
    }, 'Email generated');
  } catch (err) {
    next(err);
  }
};

// ── Enhance existing email ────────────────────────────────────────
exports.enhanceEmail = async (req, res, next) => {
  try {
    const { subject, body, company, jobTitle, jobDescription } = req.body;
    if (!subject || !body) throw new ValidationError('subject and body are required');

    const user = await User.findById(req.user._id);
    const candidate = {
      name:        user.fullName || `${user.profile?.firstName} ${user.profile?.lastName}`.trim(),
      currentRole: user.profile?.currentRole || 'Professional',
      experience:  user.profile?.experience  || 0,
      skills:      user.profile?.skills      || [],
      phone:       user.profile?.phone       || '',
      linkedinUrl: user.profile?.linkedinUrl || '',
    };

    const result = await enhanceOutreachEmail({
      subject, body, jobTitle, company, jobDescription, candidate,
    });

    return success(res, result, 'Email enhanced');
  } catch (err) {
    next(err);
  }
};

// ── Send email ────────────────────────────────────────────────────
exports.sendEmail = async (req, res, next) => {
  try {
    const {
      to, subject, body, company, recruiterName, jobId, emailId,
      attachResume = false,          // attach original resume PDF
      resumeBuffer,                  // pre-built optimized resume (base64)
      resumeFilename,
      latexTemplate,                 // LaTeX source to save in history
      resumeSnapshot,                // base64 PDF snapshot for history
    } = req.body;

    if (!to || !subject || !body) {
      throw new ValidationError('to, subject and body are required');
    }

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL     || 'yash51217@gmail.com';
    const ADMIN_PASS  = process.env.ADMIN_EMAIL_PASS || process.env.SMTP_PASS || '';

    const user = await User.findById(req.user._id).select('+smtpAccounts +resumeBuffer +gmailRefreshToken +gmailAccessToken +gmailEmail');
    const defaultSmtp = (user.smtpAccounts || []).find(a => a.isDefault) || (user.smtpAccounts || [])[0];
    const hasGmail    = !!user.gmailRefreshToken;
    const smtpUser    = defaultSmtp?.email || ADMIN_EMAIL;
    const smtpPass    = defaultSmtp?.pass  || ADMIN_PASS;

    // With OAuth the smtp.service handles auth itself; only hard-fail if no method at all
    if (!hasGmail && !defaultSmtp && !ADMIN_PASS) {
      throw new ValidationError('Email credentials not configured. Please connect your Gmail in Profile → Email Setup.');
    }

    const usingAdminFallback = !hasGmail && !defaultSmtp && smtpUser === ADMIN_EMAIL;

    // Build attachments array
    const attachments = [];

    if (resumeBuffer) {
      // Pre-built buffer (ATS-optimized PDF) passed as base64 from frontend
      attachments.push({
        filename:    resumeFilename || 'resume.pdf',
        content:     Buffer.from(resumeBuffer, 'base64'),
        contentType: 'application/pdf',
      });
    } else if (attachResume) {
      // User wants original resume attached
      if (!user.resume?.url && !user.resume?.buffer) {
        return res.status(400).json({
          success: false,
          message: 'No resume found on your profile. Upload one in Profile → Resume first.',
          code: 'NO_RESUME',
        });
      }
      // Primary: use MongoDB-stored buffer (never blocked by CDN)
      let buf = user.resumeBuffer || null;
      // Fallback: try Cloudinary if MongoDB buffer missing (old uploads)
      if (!buf && user.resume?.url) {
        buf = await downloadPdfBuffer(user.resume.url, user.resume.publicId);
      }
      if (!buf) {
        return res.status(400).json({
          success: false,
          message: 'Could not retrieve your resume. Please re-upload it in Profile → Resume.',
          code: 'RESUME_DOWNLOAD_FAILED',
        });
      }
      const name = user.resume.originalName || 'resume.pdf';
      attachments.push({ filename: name, content: buf, contentType: 'application/pdf' });
      logger.info(`Resume attached from ${user.resumeBuffer ? 'DB' : 'Cloudinary'}: ${name} (${buf.length} bytes)`);
    }

    // Create pending record immediately so frontend sees it in history
    const record = emailId
      ? await OutreachEmail.findByIdAndUpdate(emailId, {
          to, subject, body, company, recruiterName,
          status: 'pending', senderEmail: smtpUser,
          resumeAttached: !!(resumeBuffer || attachResume),
          ...(latexTemplate    && { latexTemplate }),
          ...(resumeSnapshot   && { resumeSnapshot }),
        }, { new: true })
      : await OutreachEmail.create({
          userId: req.user._id, jobId: jobId || null,
          to, subject, body, company, recruiterName,
          status: 'pending', senderEmail: smtpUser, aiGenerated: false,
          resumeAttached: !!(resumeBuffer || attachResume),
          ...(latexTemplate    && { latexTemplate }),
          ...(resumeSnapshot   && { resumeSnapshot }),
        });

    // Try to enqueue — fall back to direct send if queue unavailable
    const jobQueueId = await enqueueEmail({
      smtpUser, smtpPass, to, subject, body,
      fromName:   user.fullName || user.profile?.firstName,
      attachments: attachments.map(a => ({ ...a, content: a.content?.toString('base64'), _base64: true })),
      emailId:    record._id.toString(),
      jobId:      jobId || null,
      company,
      recruiterName,
      userId:     req.user._id.toString(),
    }).catch(() => null);

    if (!jobQueueId) {
      // Queue unavailable — send directly (original synchronous path)
      await sendOutreachEmail({ userId: req.user._id, smtpUser, smtpPass, to, subject, body,
        fromName: user.fullName || user.profile?.firstName, attachments, useAdminFallback: true });
      await OutreachEmail.findByIdAndUpdate(record._id, { status: 'sent', sentAt: new Date() });
      if (jobId) {
        // Try Job model first; if no match, try LinkedInJob (email-parsed + LinkedIn alert jobs)
        const updatedJob = await Job.findOneAndUpdate(
          { _id: jobId, userId: req.user._id },
          { $set: { status: 'applied', appliedAt: new Date() } }
        );
        if (!updatedJob) {
          await LinkedInJob.findOneAndUpdate(
            { _id: jobId, userId: req.user._id },
            { $set: { status: 'applied', appliedAt: new Date(), statusUpdatedAt: new Date() } }
          );
        }
      }
    }

    logger.info(`Outreach email ${jobQueueId ? 'queued' : 'sent'} by ${req.user.email} to ${to}`);

    return success(res, { to, company, queued: !!jobQueueId }, 'Email sent successfully');
  } catch (err) {
    next(err);
  }
};

// ── Bulk send ─────────────────────────────────────────────────────
exports.bulkSend = async (req, res, next) => {
  try {
    const { emails, attachResume = false } = req.body;

    if (!emails?.length)   throw new ValidationError('No emails provided');
    if (emails.length > 20) throw new ValidationError('Max 20 emails per bulk send');

    const user        = await User.findById(req.user._id).select('+smtpAccounts');
    const defaultSmtp = (user.smtpAccounts || []).find(a => a.isDefault) || (user.smtpAccounts || [])[0];
    const smtpUser    = defaultSmtp?.email || process.env.SMTP_USER;
    const smtpPass    = defaultSmtp?.pass  || process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
      throw new ValidationError('Email credentials not configured. Please add your Gmail in Profile → Email Setup.');
    }

    // ── Credit check before sending (EMAIL_SEND per email) ───────
    const costPerEmail = CREDIT_COSTS.EMAIL_SEND;   // 2 credits
    const totalCost    = emails.length * costPerEmail;

    const creditsDoc = await UserCredits.findOne({ userId: req.user._id });
    const available  = creditsDoc
      ? creditsDoc.totalCredits + creditsDoc.topupCredits - creditsDoc.usedCredits
      : 0;

    if (available < totalCost) {
      return res.status(402).json({
        success:   false,
        message:   `Insufficient credits. Need ${totalCost} (${costPerEmail} per email × ${emails.length}), have ${available}.`,
        code:      'INSUFFICIENT_CREDITS',
        required:  totalCost,
        available,
      });
    }

    // Pre-download resume once for the whole batch
    let resumeAttachment = null;
    if (attachResume && user.resume?.url) {
      try {
        const buf  = await downloadPdfBuffer(user.resume.url, user.resume.publicId);
        const name = user.resume.originalName || 'resume.pdf';
        resumeAttachment = { filename: name, content: buf, contentType: 'application/pdf' };
      } catch (err) {
        logger.warn(`Bulk send resume download failed: ${err.message}`);
      }
    }

    const results = { sent: 0, failed: 0, details: [], creditsUsed: 0 };

    for (const email of emails) {
      try {
        const attachments = email.resumeBuffer
          ? [{ filename: email.resumeFilename || 'resume-optimized.pdf', content: Buffer.from(email.resumeBuffer, 'base64'), contentType: 'application/pdf' }]
          : resumeAttachment ? [resumeAttachment] : [];

        await sendOutreachEmail({
          smtpUser, smtpPass,
          to:       email.to,
          subject:  email.subject,
          body:     email.body,
          fromName: user.fullName || user.profile?.firstName,
          attachments,
        });

        // Deduct credits atomically per email
        await UserCredits.findOneAndUpdate(
          { userId: req.user._id },
          { $inc: { usedCredits: costPerEmail, 'breakdown.emailsSent': 1 } }
        );

        await OutreachEmail.create({
          userId:         req.user._id,
          jobId:          email.jobId   || null,
          to:             email.to,
          subject:        email.subject,
          body:           email.body,
          company:        email.company,
          status:         'sent',
          sentAt:         new Date(),
          senderEmail:    smtpUser,
          aiGenerated:    email.aiGenerated || false,
          resumeAttached: attachments.length > 0,
        });

        results.sent++;
        results.creditsUsed += costPerEmail;
        results.details.push({ to: email.to, status: 'sent' });

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        results.failed++;
        results.details.push({ to: email.to, status: 'failed', error: err.message });
      }
    }

    return success(res, results, `${results.sent} emails sent, ${results.failed} failed`);
  } catch (err) {
    next(err);
  }
};

// ── Get stats ─────────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const [total, sent, pending, replied] = await Promise.all([
      OutreachEmail.countDocuments({ userId: req.user._id }),
      OutreachEmail.countDocuments({ userId: req.user._id, status: 'sent' }),
      OutreachEmail.countDocuments({ userId: req.user._id, status: 'pending' }),
      OutreachEmail.countDocuments({ userId: req.user._id, status: 'replied' }),
    ]);

    return success(res, { total, sent, pending, replied });
  } catch (err) {
    next(err);
  }
};

// ── Generate LaTeX resume from user profile ───────────────────────
exports.generateLatex = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('profile fullName email');
    const p    = user?.profile || {};
    const name = user?.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Your Name';
    const phone = p.phone || '+91-XXXXXXXXXX';
    const email = user?.email || '';
    const city  = p.city || 'Mumbai, India';

    // Skills from profile
    const skills = (p.skills || []).join(', ') || 'JavaScript, React, Node.js, MongoDB';

    const latex = `%-------------------------
% Resume in Latex
% Author : Jake Gutierrez
% Based off of: https://github.com/sb2nov/resume
%------------------------

\\documentclass[letterpaper,10.5pt]{article}

\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\input{glyphtounicode}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\addtolength{\\oddsidemargin}{-0.5in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.5in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{
  \\vspace{-6pt}\\scshape\\raggedright\\large
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5pt}]

\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-2pt}}}}
\\newcommand{\\resumeSubheading}[4]{
  \\vspace{-2pt}\\item
    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{#1} & #2 \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeProjectHeading}[2]{
    \\item
    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\small#1 & #2 \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeSubItem}[1]{\\resumeItem{#1}\\vspace{-4pt}}
\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.15in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}[topsep=0pt]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-5pt}}

\\begin{document}

%----------HEADING----------
\\begin{center}
    \\textbf{\\Huge \\scshape ${name.replace(/&/g,'\\&').replace(/#/g,'\\#')}} \\\\ \\vspace{1pt}
    \\small ${phone} $|$
    \\href{mailto:${email}}{\\underline{${email}}} $|$
    ${city}
\\end{center}

%-----------EXPERIENCE-----------
\\section{Experience}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Software Developer \\& Team Lead (MERN Stack Developer)}{Mar. 2026 -- Present}
      {Konnect Insights}{Mumbai, India}
      \\resumeItemListStart
        \\resumeItem{Promoted to Team Lead, overseeing development workflow, conducting code reviews, and mentoring junior developers.}
        \\resumeItem{Drive sprint planning and task delegation, ensuring on-time delivery of features across the team.}
      \\resumeItemListEnd
    \\resumeSubheading
      {Software Developer}{Jun. 2023 -- Feb. 2026}
      {Konnect Insights}{Mumbai, India}
      \\resumeItemListStart
        \\resumeItem{Developed and maintained scalable web applications using the MERN stack, enhancing internal tooling and customer-facing products.}
        \\resumeItem{Led development of an internal CMS tool used across departments for content management and analytics.}
        \\resumeItem{Integrated third-party APIs and improved backend performance by optimizing MongoDB queries, implementing caching, and ensuring efficient data retrieval.}
        \\resumeItem{Collaborated with cross-functional teams to deliver new features and enhancements, reducing bug reports by 30\\% through effective communication and agile methodologies.}
      \\resumeItemListEnd
  \\resumeSubHeadingListEnd

%-----------PROJECTS-----------
\\section{Projects}
    \\resumeSubHeadingListStart
      \\resumeProjectHeading
          {\\textbf{Job Search Automation Bot} $|$ \\emph{Python, Selenium, LinkedIn API, Node.js, MongoDB}}{2026}
          \\resumeItemListStart
            \\resumeItem{Built an end-to-end job hunting bot that automatically searches listings, scrapes HR emails and LinkedIn profiles using Node.js and MongoDB.}
            \\resumeItem{Automated personalized outreach emails requesting referrals, reducing manual job search time by 80\\%.}
            \\resumeItem{Implemented anti-detection mechanisms and rate limiting to ensure stable, long-running automation.}
          \\resumeItemListEnd
      \\resumeProjectHeading
          {\\textbf{Real-Time Fantasy Gaming App} $|$ \\emph{React, Node.js, Express, MongoDB, WebSockets, JWT}}{2025}
          \\resumeItemListStart
            \\resumeItem{Built a live fantasy sports platform using React and Node.js with real-time scoring through WebSockets.}
            \\resumeItem{Implemented JWT-based authentication; optimized MongoDB queries for high concurrency and performance.}
          \\resumeItemListEnd
      \\resumeProjectHeading
          {\\textbf{YouTube Video Automation} $|$ \\emph{Python, FFmpeg, Telegram Bot API, YouTube Data API}}{2026}
          \\resumeItemListStart
            \\resumeItem{Developed a Telegram-controlled pipeline that generates, edits, and auto-publishes videos to YouTube channels.}
            \\resumeItem{Integrated AI script generation, text-to-speech, and FFmpeg for automated video assembly and rendering.}
          \\resumeItemListEnd
      \\resumeProjectHeading
          {\\textbf{Product Shipping Software} $|$ \\emph{React, Node.js, MongoDB}}{2025}
          \\resumeItemListStart
            \\resumeItem{Built a production logistics application managing shipments, customer details, and real-time order tracking.}
            \\resumeItem{Designed scalable REST APIs and responsive UI; actively deployed in a live business environment.}
          \\resumeItemListEnd
    \\resumeSubHeadingListEnd

%-----------TECHNICAL SKILLS-----------
\\section{Technical Skills}
 \\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages}{: JavaScript, TypeScript, Python, C\\#, C++, SQL, HTML, CSS} \\\\
     \\textbf{Frameworks}{: React, Node.js, Express, MERN Stack, .NET (ASP.NET MVC), Prisma ORM} \\\\
     \\textbf{Tools \\& Technologies}{: MongoDB, REST APIs, JWT, WebSockets, Docker, Git, Postman, Figma, CI/CD} \\\\
     \\textbf{Soft Skills}{: Communication, Problem Solving, Teamwork, Time Management, Agile Development, Leadership}
    }}
 \\end{itemize}

%-----------EDUCATION-----------
\\section{Education}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Mumbai University}{Mumbai, India}
      {Master of Computer Applications}{Jan. 2024 -- Jan. 2026}
    \\resumeSubheading
      {Somaiya Vidyavihar University}{Mumbai, India}
      {Bachelor of Information Technology $|$ GPA: 8.6 CGPA}{Jan. 2020 -- Jan. 2023}
  \\resumeSubHeadingListEnd

\\end{document}`;

    return success(res, { latex, filename: `${name.replace(/\s+/g, '_')}_Resume.tex` });
  } catch (err) { next(err); }
};

// ── Generate resume PDF from profile (Jake Gutierrez style) ──────
exports.generateResumePdf = async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const user  = await User.findById(req.user._id).select('profile fullName email');
    const p     = user?.profile || {};
    const name  = user?.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Your Name';
    const phone = p.phone || '+91-8411097644';
    const email = user?.email || '';
    const city  = p.city  || 'Mumbai, India';

    const doc    = new PDFDocument({ size: 'LETTER', margins: { top: 40, bottom: 40, left: 50, right: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    await new Promise((resolve) => {
      doc.on('end', resolve);

      const W     = doc.page.width - 100;   // usable width
      const L     = 50;                      // left margin
      const BLACK = '#000000';
      const DARK  = '#111111';
      const MID   = '#555555';

      // ─ helpers ────────────────────────────────────────────────

      // Draw a full-width rule then advance
      const rule = (color = '#bbbbbb', weight = 0.5) => {
        const y = doc.y;
        doc.moveTo(L, y).lineTo(L + W, y).strokeColor(color).lineWidth(weight).stroke();
        doc.y = y + 4;
      };

      // Section header: BOLD CAPS + underline rule
      const section = (title) => {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK)
           .text(title.toUpperCase(), L, doc.y, { width: W });
        doc.moveDown(0.05);
        rule('#888888', 0.6);
        doc.moveDown(0.1);
      };

      // Two-column row: left bold, right grey — both on same baseline
      const row2 = (left, right, lFont = 'Helvetica-Bold', lSize = 9.5, rSize = 9.5) => {
        const y = doc.y;
        // Right side first (doesn't advance Y if we use explicit coords)
        doc.font('Helvetica').fontSize(rSize).fillColor(MID)
           .text(right, L, y, { width: W, align: 'right' });
        // Left side over the same line
        doc.font(lFont).fontSize(lSize).fillColor(DARK)
           .text(left, L, y, { width: W * 0.68 });
      };

      // Italic sub-row: company/degree on left, date on right
      const row2italic = (left, right) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor(MID)
           .text(right, L, y, { width: W, align: 'right' });
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(MID)
           .text(left, L, y, { width: W * 0.68 });
      };

      // Bullet point
      const bullet = (text) => {
        const y  = doc.y;
        const bx = L + 11;
        // Draw bullet dot at the vertical center of the first text line (~5pt down)
        doc.circle(L + 4, y + 5, 1.5).fill(DARK);
        doc.font('Helvetica').fontSize(9).fillColor(DARK)
           .text(text, bx, y, { width: W - 11 });
      };

      // Project heading row
      const projectHeading = (title, tech, year) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor(MID)
           .text(year, L, y, { width: W, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
           .text(title, L, y, { continued: true })
           .font('Helvetica').fillColor(MID).text(`  |  ${tech}`, { width: W * 0.82 });
      };

      // ─ NAME / HEADER ──────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(22).fillColor(BLACK)
         .text(name, L, 40, { width: W, align: 'center' });
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(9).fillColor(MID)
         .text(`${phone}  |  ${email}  |  ${city}`, L, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.3);
      rule(BLACK, 0.8);
      doc.moveDown(0.2);

      // ─ EDUCATION ─────────────────────────────────────────────
      section('Education');

      row2('Mumbai University', 'Mumbai, India');
      doc.moveDown(0.1);
      row2italic('Master of Computer Applications', 'Jan. 2024 – Jan. 2026');
      doc.moveDown(0.45);

      row2('Somaiya Vidyavihar University', 'Mumbai, India');
      doc.moveDown(0.1);
      row2italic('Bachelor of Information Technology  |  GPA: 8.6 CGPA', 'Jan. 2020 – Jan. 2023');
      doc.moveDown(0.3);

      // ─ EXPERIENCE ────────────────────────────────────────────
      section('Experience');

      row2('Software Developer & Team Lead (MERN Stack Developer)', 'Mar. 2026 – Present');
      doc.moveDown(0.1);
      row2italic('Konnect Insights', 'Mumbai, India');
      doc.moveDown(0.15);
      bullet('Promoted to Team Lead, overseeing development workflow, conducting code reviews, and mentoring junior developers.');
      doc.moveDown(0.05);
      bullet('Drive sprint planning and task delegation, ensuring on-time delivery of features across the team.');
      doc.moveDown(0.35);

      row2('Software Developer', 'Jun. 2023 – Feb. 2026');
      doc.moveDown(0.1);
      row2italic('Konnect Insights', 'Mumbai, India');
      doc.moveDown(0.15);
      bullet('Developed and maintained scalable web applications using the MERN stack, enhancing internal tooling and customer-facing products.');
      doc.moveDown(0.05);
      bullet('Led development of an internal CMS tool used across departments for content management and analytics.');
      doc.moveDown(0.05);
      bullet('Integrated third-party APIs and improved backend performance by optimizing MongoDB queries, implementing caching, and ensuring efficient data retrieval.');
      doc.moveDown(0.05);
      bullet('Collaborated with cross-functional teams to deliver new features, reducing bug reports by 30% through agile methodologies.');
      doc.moveDown(0.3);

      // ─ PROJECTS ──────────────────────────────────────────────
      section('Projects');

      projectHeading('Job Search Automation Bot', 'Python, Selenium, LinkedIn API, Node.js, MongoDB', '2026');
      doc.moveDown(0.15);
      bullet('Built an end-to-end job hunting bot that automatically searches listings, scrapes HR emails and LinkedIn profiles.');
      doc.moveDown(0.05);
      bullet('Automated personalized outreach emails requesting referrals, reducing manual job search time by 80%.');
      doc.moveDown(0.05);
      bullet('Implemented anti-detection mechanisms and rate limiting to ensure stable, long-running automation.');
      doc.moveDown(0.25);

      projectHeading('Real-Time Fantasy Gaming App', 'React, Node.js, Express, MongoDB, WebSockets, JWT', '2025');
      doc.moveDown(0.15);
      bullet('Built a live fantasy sports platform with real-time scoring through WebSockets.');
      doc.moveDown(0.05);
      bullet('Implemented JWT-based authentication; optimized MongoDB queries for high concurrency and performance.');
      doc.moveDown(0.25);

      projectHeading('YouTube Video Automation', 'Python, FFmpeg, Telegram Bot API, YouTube Data API', '2026');
      doc.moveDown(0.15);
      bullet('Developed a Telegram-controlled pipeline that generates, edits, and auto-publishes videos to YouTube channels.');
      doc.moveDown(0.05);
      bullet('Integrated AI script generation, text-to-speech, and FFmpeg for automated video assembly and rendering.');
      doc.moveDown(0.25);

      projectHeading('Product Shipping Software', 'React, Node.js, MongoDB', '2025');
      doc.moveDown(0.15);
      bullet('Built a production logistics application managing shipments, customer details, and real-time order tracking.');
      doc.moveDown(0.05);
      bullet('Designed scalable REST APIs and responsive UI; actively deployed in a live business environment.');
      doc.moveDown(0.3);

      // ─ TECHNICAL SKILLS ──────────────────────────────────────
      section('Technical Skills');

      const skillLine = (label, val) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
           .text(`${label}: `, L, doc.y, { continued: true })
           .font('Helvetica').fillColor(MID).text(val, { width: W });
        doc.moveDown(0.2);
      };

      skillLine('Languages',           'JavaScript, TypeScript, Python, C#, C++, SQL, HTML, CSS');
      skillLine('Frameworks',          'React, Node.js, Express, MERN Stack, .NET (ASP.NET MVC), Prisma ORM');
      skillLine('Tools & Technologies','MongoDB, REST APIs, JWT, WebSockets, Docker, Git, Postman, Figma, CI/CD');
      skillLine('Soft Skills',         'Communication, Problem Solving, Teamwork, Time Management, Agile Development, Leadership');

      doc.end();
    });

    const pdfBuffer = Buffer.concat(chunks);
    const safeName  = name.replace(/\s+/g, '_');
    return success(res, { resumeBuffer: pdfBuffer.toString('base64'), filename: `${safeName}_Resume.pdf` });
  } catch (err) { next(err); }
};

// ── Delete email ──────────────────────────────────────────────────
exports.deleteEmail = async (req, res, next) => {
  try {
    const email = await OutreachEmail.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!email) throw new NotFoundError('Email not found');
    return success(res, null, 'Email deleted');
  } catch (err) {
    next(err);
  }
};

// ── Optimize resume keywords (Pro only) ──────────────────────────
// Generates a keyword-tailored PDF version of the user's resume
// targeting a specific job description. Layout/structure preserved,
// only skill keywords and summary phrases are updated.
exports.optimizeResume = async (req, res, next) => {
  try {
    const { jobTitle, jobDescription, company, resumeText: userProvidedText } = req.body;

    if (!jobTitle) throw new ValidationError('jobTitle is required');

    // Pro/team only
    if (req.user.plan === 'free') {
      return res.status(403).json({
        success: false,
        message: 'Resume keyword optimization is a Pro feature.',
        code:    'PRO_REQUIRED',
      });
    }

    const user = await User.findById(req.user._id).select('+resumeBuffer +resumeDocxBuffer');

    if (!user.resume?.url && !user.resumeBuffer) {
      throw new ValidationError('Upload your resume first (Profile → Resume) before optimizing.');
    }

    const userName = user.fullName ||
      `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() ||
      'Candidate';

    const result = await optimizeResumeForJob({
      resumeUrl:          user.resume?.url       || null,
      resumePublicId:     user.resume?.publicId  || null,
      resumeDbBuffer:     user.resumeBuffer      || null,
      resumeDocxBuffer:   user.resumeDocxBuffer  || null,  // enables exact DOCX patching
      userProvidedText:   userProvidedText       || null,
      existingSkills:     user.profile?.skills   || [],
      jobTitle,
      jobDescription:     jobDescription         || '',
      company:            company                || '',
      userName,
    });

    logger.info(`Resume optimized: ${req.user.email} → ${jobTitle} at ${company} (${result.tokensUsed} tokens)`);

    const safeName = userName.replace(/\s+/g, '_');
    const safeCo   = (company || 'Optimized').replace(/\s+/g, '_');

    return success(res, {
      resumeBuffer:       result.optimizedPdfBuffer.toString('base64'),
      filename:           `${safeName}_ATS_Optimized_${safeCo}.pdf`,
      // DOCX download — only present when user uploaded a .docx (exact layout preserved)
      resumeDocxBuffer:   result.optimizedDocxBuffer?.toString('base64') || null,
      docxFilename:       result.hasDocx ? `${safeName}_ATS_Optimized_${safeCo}.docx` : null,
      hasDocx:            result.hasDocx,
      // Comparison data
      originalText:       result.originalText,
      updatedResumeText:  result.updatedResumeText,
      textReplacements:   result.textReplacements,
      keywordsAdded:      result.keywordsAdded,
      atsScoreBefore:     result.atsScoreBefore,
      atsScoreAfter:      result.atsScoreAfter,
      optimizationNotes:  result.optimizationNotes,
      tokensUsed:         result.tokensUsed,
      usedOriginalPdf:    !!result.originalBuffer,
    }, 'Resume optimized successfully');
  } catch (err) {
    // PASTE_REQUIRED is a handled business error — return 400 not 500
    if (err.code === 'PASTE_REQUIRED') {
      return res.status(400).json({
        success: false,
        message: err.message,
        code:    'PASTE_REQUIRED',
      });
    }
    next(err);
  }
};

// ── Auto outreach — Pro only ──────────────────────────────────────
// Sends AI-generated emails to all jobs that have HR emails attached
exports.autoOutreach = async (req, res, next) => {
  try {
    const { searchId, limit = 5 } = req.body;
    const user = await User.findById(req.user._id);

    // Check plan
    if (user.plan === 'free') {
      return res.status(403).json({
        success: false,
        message: 'Auto outreach is a Pro feature. Upgrade to send bulk emails automatically.',
        code:    'PRO_REQUIRED',
      });
    }

    // Check SMTP — load from smtpAccounts array
    const userWithSmtp = await User.findById(req.user._id).select('+smtpAccounts');
    const defaultSmtp  = (userWithSmtp.smtpAccounts || []).find(a => a.isDefault) || (userWithSmtp.smtpAccounts || [])[0];
    const smtpUser     = defaultSmtp?.email || process.env.SMTP_USER;
    const smtpPass     = defaultSmtp?.pass  || process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) {
      return res.status(400).json({
        success: false,
        message: 'Email credentials not configured. Add your Gmail in Profile → Email Setup.',
      });
    }

    // Find jobs with HR emails that haven't been emailed yet
    const filter = {
      userId:         req.user._id,
      recruiterEmail: { $exists: true, $ne: null },
      status:         { $in: ['found', 'saved'] },
    };
    if (searchId) filter.searchId = searchId;

    const jobs = await Job.find(filter)
      .sort({ matchScore: -1 })
      .limit(Math.min(parseInt(limit), 20)) // max 20 at once
      .lean();

    if (jobs.length === 0) {
      return success(res, { sent: 0, failed: 0 }, 'No jobs with HR emails found');
    }

    // Check credits — 2 credits per email + 5 per AI generation
    const totalCost = jobs.length * (2 + 5); // EMAIL_SEND + AI_EMAIL per job
    const credits   = await require('../models/UserCredits').findOne({ userId: req.user._id });
    const available = credits ? credits.totalCredits + credits.topupCredits - credits.usedCredits : 0;

    if (available < totalCost) {
      return res.status(402).json({
        success: false,
        message: `Insufficient credits. Need ${totalCost}, have ${available}`,
        code:    'INSUFFICIENT_CREDITS',
        required: totalCost,
        available,
      });
    }

    const candidate = {
      name:        user.fullName || `${user.profile?.firstName} ${user.profile?.lastName}`,
      currentRole: user.profile?.currentRole  || 'Professional',
      experience:  user.profile?.experience   || 0,
      skills:      user.profile?.skills       || [],
      expectedCTC: user.profile?.expectedCTC  || 'negotiable',
      phone:       user.profile?.phone        || '',
      linkedinUrl: user.profile?.linkedinUrl  || '',
    };

    const { generateOutreachEmail } = require('../services/ai/emailWriter.service');
    const { sendOutreachEmail }     = require('../services/outreach/smtp.service');
    const UserCredits = require('../models/UserCredits');

    const results = { sent: 0, failed: 0, details: [] };

    for (const job of jobs) {
      try {
        // Generate AI email
        const emailContent = await generateOutreachEmail({
          recruiterName: job.recruiterName,
          company:       job.company,
          jobTitle:      job.title,
          jobUrl:        job.url,
          candidate,
        });

        // Send email
        await sendOutreachEmail({
          smtpUser,
          smtpPass,
          to:       job.recruiterEmail,
          subject:  emailContent.subject,
          body:     emailContent.body,
          fromName: candidate.name,
        });

        // Deduct credits (AI + send) and track breakdown
        await UserCredits.findOneAndUpdate(
          { userId: req.user._id },
          { $inc: { usedCredits: 7, 'breakdown.aiEmails': 1, 'breakdown.emailsSent': 1 } }
        );

        // Save email record
        await OutreachEmail.create({
          userId:       req.user._id,
          jobId:        job._id,
          to:           job.recruiterEmail,
          subject:      emailContent.subject,
          body:         emailContent.body,
          company:      job.company,
          recruiterName: job.recruiterName,
          status:       'sent',
          sentAt:       new Date(),
          senderEmail:  smtpUser,
          aiGenerated:  true,
          tokensUsed:   emailContent.tokensUsed,
        });

        // Update job status to applied
        await Job.findByIdAndUpdate(job._id, {
          status:    'applied',
          appliedAt: new Date(),
        });

        results.sent++;
        results.details.push({
          company: job.company,
          to:      job.recruiterEmail,
          status:  'sent',
        });

        // Delay between emails to avoid spam filters
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        results.failed++;
        results.details.push({
          company: job.company,
          to:      job.recruiterEmail,
          status:  'failed',
          error:   err.message,
        });
        logger.error(`Auto outreach failed for ${job.company}: ${err.message}`);
      }
    }

    logger.info(`Auto outreach: ${req.user.email} sent ${results.sent} emails`);

    return success(res, {
      ...results,
      creditsUsed: results.sent * 7,
    }, `${results.sent} emails sent, ${results.failed} failed`);

  } catch (err) {
    next(err);
  }
};