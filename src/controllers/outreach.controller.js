const OutreachEmail = require('../models/OutreachEmail');
const Job           = require('../models/Job');
const User          = require('../models/User');
const UserCredits   = require('../models/UserCredits');
const { generateOutreachEmail }  = require('../services/ai/emailWriter.service');
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
    const { company, jobTitle, jobUrl, recruiterName, jobId } = req.body;

    if (!company || !jobTitle) {
      throw new ValidationError('Company and job title are required');
    }

    const user = await User.findById(req.user._id);

    const candidate = {
      name:        user.fullName || `${user.profile?.firstName} ${user.profile?.lastName}`,
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

// ── Send email ────────────────────────────────────────────────────
exports.sendEmail = async (req, res, next) => {
  try {
    const {
      to, subject, body, company, recruiterName, jobId, emailId,
      attachResume = false,          // attach original resume PDF
      resumeBuffer,                  // pre-built optimized resume (base64)
      resumeFilename,
    } = req.body;

    if (!to || !subject || !body) {
      throw new ValidationError('to, subject and body are required');
    }

    const user = await User.findById(req.user._id).select('+smtpAccounts +resumeBuffer');
    const defaultSmtp = (user.smtpAccounts || []).find(a => a.isDefault) || (user.smtpAccounts || [])[0];
    const smtpUser = defaultSmtp?.email || process.env.SMTP_USER;
    const smtpPass = defaultSmtp?.pass  || process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
      throw new ValidationError('Email credentials not configured. Please add your Gmail in Profile → Email Setup.');
    }

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
        }, { new: true })
      : await OutreachEmail.create({
          userId: req.user._id, jobId: jobId || null,
          to, subject, body, company, recruiterName,
          status: 'pending', senderEmail: smtpUser, aiGenerated: false,
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
      await sendOutreachEmail({ smtpUser, smtpPass, to, subject, body,
        fromName: user.fullName || user.profile?.firstName, attachments });
      await OutreachEmail.findByIdAndUpdate(record._id, { status: 'sent', sentAt: new Date() });
      if (jobId) await Job.findOneAndUpdate(
        { _id: jobId, userId: req.user._id }, { $set: { status: 'applied', appliedAt: new Date() } }
      );
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