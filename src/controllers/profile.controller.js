const User    = require('../models/User');
const logger  = require('../config/logger');
const { success }         = require('../utils/response.util');
const { NotFoundError, ValidationError, AuthError } = require('../utils/errors');
const { invalidateUserCache } = require('../middleware/auth.middleware');

// ── Get profile ───────────────────────────────────────────────────
exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) throw new NotFoundError('User not found');
    return success(res, user.toSafeObject());
  } catch (err) {
    next(err);
  }
};

// ── Update profile ────────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    const allowed = [
      'firstName', 'lastName', 'phone', 'city', 'country', 'linkedinUrl', 'portfolioUrl',
      'currentRole', 'experience', 'currentCTC', 'expectedCTC', 'noticePeriod',
      'targetRole', 'targetIndustries', 'workType', 'companySize', 'companyType',
      'preferredLocations', 'openToRelocation', 'skills', 'secondarySkills',
      'languages', 'certifications', 'education',
    ];

    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates[`profile.${field}`] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No valid fields provided');
    }

    const user   = await User.findById(req.user._id);
    const merged = { ...user.profile?.toObject?.() || {}, ...req.body };

    const hasResume = !!(
      user.resume?.url
      || (user.resumeItems || []).some((r) => r.url || (r.pdfBuffer && r.pdfBuffer.length))
    );
    updates['profile.completionPct'] = calcCompletion({ ...merged, _hasResume: hasResume });

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    invalidateUserCache(req.user._id);
    logger.info(`Profile updated: ${req.user.email}`);
    return success(res, updated.toSafeObject(), 'Profile updated');
  } catch (err) {
    next(err);
  }
};

// ── Change password ───────────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new ValidationError('Current and new password are required');
    }
    if (newPassword.length < 8) {
      throw new ValidationError('New password must be at least 8 characters');
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      throw new ValidationError('Password must have uppercase, lowercase and number');
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) throw new NotFoundError('User not found');

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) throw new AuthError('Current password is incorrect');

    user.password = newPassword;
    await user.save();

    logger.info(`Password changed: ${req.user.email}`);
    return success(res, null, 'Password changed successfully');
  } catch (err) {
    next(err);
  }
};

function buildResumePayloadFromFile(reqFile, cloud) {
  const resumeData = {
    originalName: reqFile.originalname,
    uploadedAt:   new Date(),
    isParsed:     false,
  };
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    resumeData.url      = cloud.secure_url;
    resumeData.publicId = cloud.public_id;
  } else {
    resumeData.url = `local_${reqFile.originalname}`;
    logger.warn('Cloudinary not configured — resume not stored in cloud (dev only)');
  }
  return resumeData;
}

async function syncPrimaryResumeFields(userId) {
  const fresh = await User.findById(userId).select('+resumeItems.pdfBuffer +resumeBuffer resumeItems resume');
  const def = (fresh.resumeItems || []).find((r) => r.isDefault) || (fresh.resumeItems || [])[0];
  if (!def) {
    await User.findByIdAndUpdate(userId, { $unset: { resume: '', resumeBuffer: '' } });
    return;
  }
  await User.findByIdAndUpdate(userId, {
    $set: {
      resume: {
        url:          def.url,
        publicId:     def.publicId,
        originalName: def.originalName,
        uploadedAt:   def.uploadedAt,
        isParsed:     def.isParsed,
        extractedSkills:    def.extractedSkills || [],
        extractedCompanies: def.extractedCompanies || [],
        summary:            def.summary,
        totalExperience:    def.totalExperience,
        parsedAt:           def.parsedAt,
      },
      resumeBuffer: def.pdfBuffer,
    },
  });
}

// ── Upload resume (library: max 3; mode=add | replace_default; replaceResumeId targets one slot) ──
exports.uploadResume = async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');

    let cloud = null;
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      const { uploadResume } = require('../config/cloudinary');
      cloud = await uploadResume(req.file.buffer, req.user._id);
    }

    const resumeData = buildResumePayloadFromFile(req.file, cloud || {});

    const user = await User.findById(req.user._id).select('+resumeItems.pdfBuffer +resumeBuffer resumeItems resume');
    user.resumeItems = user.resumeItems || [];
    if (!user.resumeItems.length && user.resume?.url) {
      user.resumeItems.push({
        name:                 user.resume.originalName,
        originalName:         user.resume.originalName,
        url:                  user.resume.url,
        publicId:             user.resume.publicId,
        uploadedAt:           user.resume.uploadedAt || new Date(),
        isDefault:            true,
        isParsed:             user.resume.isParsed,
        extractedSkills:      user.resume.extractedSkills || [],
        extractedCompanies:   user.resume.extractedCompanies || [],
        summary:              user.resume.summary,
        totalExperience:      user.resume.totalExperience,
        parsedAt:             user.resume.parsedAt,
        pdfBuffer:            user.resumeBuffer,
      });
    }

    const mode            = (req.body.mode || 'replace_default').toLowerCase();
    const replaceResumeId = req.body.replaceResumeId;
    const displayName     = (req.body.name || req.file.originalname || '').trim();

    const newItem = {
      name:                 displayName,
      originalName:         resumeData.originalName,
      url:                  resumeData.url,
      publicId:             resumeData.publicId,
      uploadedAt:           resumeData.uploadedAt,
      isParsed:             false,
      extractedSkills:      [],
      extractedCompanies:   [],
      pdfBuffer:            req.file.buffer,
      isDefault:            !(user.resumeItems || []).length,
    };

    if (replaceResumeId) {
      const item = user.resumeItems.id(replaceResumeId);
      if (!item) throw new ValidationError('Resume slot not found');
      item.originalName = newItem.originalName;
      item.url          = newItem.url;
      item.publicId     = newItem.publicId;
      item.uploadedAt   = newItem.uploadedAt;
      item.name         = displayName || newItem.originalName;
      item.isParsed      = false;
      item.pdfBuffer = req.file.buffer;
    } else if (mode === 'add') {
      if ((user.resumeItems || []).length >= 3) {
        throw new ValidationError('Maximum 3 resumes. Delete one in Profile or replace an existing file.');
      }
      if (req.body.setDefault === 'true' || req.body.setDefault === true) {
        (user.resumeItems || []).forEach((r) => { r.isDefault = false; });
        newItem.isDefault = true;
      }
      user.resumeItems.push(newItem);
    } else {
      let defIdx = (user.resumeItems || []).findIndex((r) => r.isDefault);
      if (defIdx < 0) defIdx = 0;
      if ((user.resumeItems || []).length === 0) {
        user.resumeItems.push({ ...newItem, isDefault: true });
      } else {
        const slot = user.resumeItems[defIdx];
        slot.originalName = newItem.originalName;
        slot.url          = newItem.url;
        slot.publicId     = newItem.publicId;
        slot.uploadedAt   = newItem.uploadedAt;
        slot.name         = displayName || newItem.originalName;
        slot.isParsed     = false;
        slot.pdfBuffer = req.file.buffer;
      }
    }

    const merged = { ...user.profile?.toObject?.() || {}, _hasResume: true };
    user.profile.completionPct = calcCompletion(merged);
    await user.save();
    await syncPrimaryResumeFields(req.user._id);
    invalidateUserCache(req.user._id);

    logger.info(`Resume uploaded: ${req.user.email}`);
    return success(res, {
      originalName: resumeData.originalName,
      url:          resumeData.url,
      uploadedAt:   resumeData.uploadedAt,
      resumes:      user.toSafeObject().resumes,
    }, 'Resume uploaded successfully');
  } catch (err) {
    next(err);
  }
};

// ── Patch resume slot (rename / set default) ──────────────────────
exports.patchResumeItem = async (req, res, next) => {
  try {
    const { name, isDefault } = req.body;
    const user = await User.findById(req.user._id).select('resumeItems profile');
    const item = user.resumeItems.id(req.params.id);
    if (!item) throw new NotFoundError('Resume not found');
    if (name !== undefined) item.name = String(name).trim() || item.originalName;
    if (isDefault === true || isDefault === 'true') {
      user.resumeItems.forEach((r) => { r.isDefault = false; });
      item.isDefault = true;
    }
    const merged = { ...user.profile?.toObject?.() || {}, _hasResume: true };
    user.profile.completionPct = calcCompletion(merged);
    await user.save();
    await syncPrimaryResumeFields(req.user._id);
    invalidateUserCache(req.user._id);
    return success(res, user.toSafeObject().resumes, 'Resume updated');
  } catch (err) { next(err); }
};

// ── Delete one resume slot ────────────────────────────────────────
exports.deleteResumeItem = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+resumeItems.pdfBuffer resumeItems resume profile');
    const item = user.resumeItems.id(req.params.id);
    if (!item) throw new NotFoundError('Resume not found');
    if (user.resumeItems.length === 1) {
      if (item.publicId && process.env.CLOUDINARY_CLOUD_NAME) {
        const { deleteFile } = require('../config/cloudinary');
        await deleteFile(item.publicId).catch(() => {});
      }
      user.resumeItems = [];
      user.resume = undefined;
      user.resumeBuffer = undefined;
    } else {
      const wasDefault = item.isDefault;
      if (item.publicId && process.env.CLOUDINARY_CLOUD_NAME) {
        const { deleteFile } = require('../config/cloudinary');
        await deleteFile(item.publicId).catch(() => {});
      }
      user.resumeItems.pull(req.params.id);
      if (wasDefault && user.resumeItems.length) {
        user.resumeItems[0].isDefault = true;
      }
    }
    const merged = { ...user.profile?.toObject?.() || {}, _hasResume: !!(user.resumeItems?.length) };
    user.profile.completionPct = calcCompletion(merged);
    await user.save();
    await syncPrimaryResumeFields(req.user._id);
    invalidateUserCache(req.user._id);
    return success(res, user.toSafeObject().resumes, 'Resume removed');
  } catch (err) { next(err); }
};

// ── Upload DOCX resume (for keyword-exact patching) ──────────────
// Stores the .docx buffer in MongoDB. When ATS optimization runs,
// this is patched via XML string replacement — preserving exact fonts,
// spacing and layout that PDF glyph encoding can't support.
exports.uploadResumeDocx = async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('No .docx file uploaded');

    await User.findByIdAndUpdate(req.user._id, {
      $set: { resumeDocxBuffer: req.file.buffer },
    });

    logger.info(`DOCX resume uploaded: ${req.user.email} (${req.file.size} bytes)`);
    return success(res, {
      originalName: req.file.originalname,
      size:         req.file.size,
      uploadedAt:   new Date(),
    }, 'DOCX resume saved — keyword patching will now preserve your exact layout');
  } catch (err) {
    next(err);
  }
};

// ── Delete resume (clears entire library + legacy fields) ─────────
exports.deleteResume = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('resume resumeItems profile');
    if (!user) throw new NotFoundError('User not found');

    const { deleteFile } = require('../config/cloudinary');
    for (const item of user.resumeItems || []) {
      if (item.publicId && process.env.CLOUDINARY_CLOUD_NAME) {
        await deleteFile(item.publicId).catch(() => {});
      }
    }
    if (user.resume?.publicId && process.env.CLOUDINARY_CLOUD_NAME) {
      await deleteFile(user.resume.publicId).catch(() => {});
    }

    const merged = { ...user.profile?.toObject?.() || {}, _hasResume: false };
    const completionPct = calcCompletion(merged);

    await User.findByIdAndUpdate(req.user._id, {
      $set:   { resumeItems: [], 'profile.completionPct': completionPct },
      $unset: { resume: '', resumeBuffer: '' },
    });

    invalidateUserCache(req.user._id);
    return success(res, null, 'All resumes deleted');
  } catch (err) {
    next(err);
  }
};

// ── Debug resume URL ──────────────────────────────────────────────
exports.debugResume = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.resume?.url) {
      return res.json({ hasResume: false, message: 'No resume stored in profile' });
    }

    const { url, publicId, originalName, uploadedAt } = user.resume;
    let httpStatus = null;
    let reachable  = false;

    try {
      const axios = require('axios');
      const r = await axios.head(url, { timeout: 8000 });
      httpStatus = r.status;
      reachable  = true;
    } catch (e) {
      httpStatus = e.response?.status || 'network-error';
    }

    return res.json({
      hasResume:    true,
      originalName,
      uploadedAt,
      url,
      publicId,
      cloudName:    process.env.CLOUDINARY_CLOUD_NAME || '(not set)',
      httpStatus,
      reachable,
      tip: !reachable
        ? 'File not accessible. Re-upload your resume in Profile → Resume tab.'
        : 'File is accessible — download should work.',
    });
  } catch (err) {
    next(err);
  }
};

// ── Delete account ────────────────────────────────────────────────
exports.deleteAccount = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) throw new ValidationError('Password required to delete account');

    const user = await User.findById(req.user._id).select('+password');
    if (!user) throw new NotFoundError('User not found');

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new AuthError('Incorrect password');

    await User.findByIdAndUpdate(req.user._id, {
      status:    'deleted',
      deletedAt: new Date(),
      email:     `deleted_${Date.now()}_${user.email}`,
    });

    res.clearCookie('refreshToken');
    logger.info(`Account deleted: ${req.user.email}`);
    return success(res, null, 'Account deleted successfully');
  } catch (err) {
    next(err);
  }
};

// ── Get SMTP status ───────────────────────────────────────────────
exports.getSMTPStatus = async (req, res, next) => {
  try {
    const user     = await User.findById(req.user._id).select('+smtpAccounts');
    const accounts = (user?.smtpAccounts || []).map(a => ({
      _id:         a._id,
      email:       a.email,
      label:       a.label,
      isDefault:   a.isDefault,
      configuredAt: a.configuredAt,
    }));
    return success(res, {
      configured: accounts.length > 0,
      accounts,
      default:    accounts.find(a => a.isDefault) || accounts[0] || null,
    });
  } catch (err) { next(err); }
};

// ── Add / update SMTP account ─────────────────────────────────────
exports.saveSMTP = async (req, res, next) => {
  try {
    const { email, appPassword, label } = req.body;

    if (!email || !appPassword) {
      throw new ValidationError('Email and app password required');
    }

    const cleaned = appPassword.replace(/\s/g, '');
    if (cleaned.length !== 16) {
      throw new ValidationError('App password must be exactly 16 characters');
    }

    // Test SMTP connection before saving
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: email, pass: cleaned },
    });

    try {
      await transporter.verify();
    } catch (smtpErr) {
      logger.warn(`SMTP verify failed for ${email}: ${smtpErr.message}`);
      throw new ValidationError(
        'Gmail connection failed. Make sure 2-Step Verification is ON and the App Password is correct.'
      );
    }

    const user     = await User.findById(req.user._id).select('+smtpAccounts');
    const accounts = user.smtpAccounts || [];

    // Max 5 accounts
    const existingIdx = accounts.findIndex(a => a.email === email);
    if (existingIdx >= 0) {
      // Update existing
      accounts[existingIdx].pass        = cleaned;
      accounts[existingIdx].label       = label || accounts[existingIdx].label;
      accounts[existingIdx].configuredAt = new Date();
    } else {
      if (accounts.length >= 5) {
        throw new ValidationError('Maximum 5 email accounts allowed. Remove one first.');
      }
      accounts.push({
        email,
        pass:        cleaned,
        label:       label || `Gmail ${accounts.length + 1}`,
        isDefault:   accounts.length === 0,
        configuredAt: new Date(),
      });
    }

    await User.findByIdAndUpdate(req.user._id, { smtpAccounts: accounts });

    logger.info(`SMTP account saved for ${req.user.email}: ${email}`);
    return success(res, {
      email,
      label:     label || 'Gmail',
      isDefault: accounts.length === 1,
      isNew:     existingIdx < 0,
    }, existingIdx >= 0 ? 'Email updated!' : 'Email added successfully!');
  } catch (err) {
    next(err);
  }
};

// ── Set default SMTP account ──────────────────────────────────────
exports.setDefaultSMTP = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) throw new ValidationError('Email required');

    const user     = await User.findById(req.user._id).select('+smtpAccounts');
    const accounts = (user?.smtpAccounts || []).map(a => ({
      ...a.toObject(),
      isDefault: a.email === email,
    }));

    const found = accounts.find(a => a.email === email);
    if (!found) throw new NotFoundError('Email account not found');

    await User.findByIdAndUpdate(req.user._id, { smtpAccounts: accounts });
    return success(res, null, `${email} set as default sending account`);
  } catch (err) { next(err); }
};

// ── Remove SMTP account ───────────────────────────────────────────
exports.removeSMTP = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) throw new ValidationError('Email required');

    const user     = await User.findById(req.user._id).select('+smtpAccounts');
    let accounts   = (user?.smtpAccounts || []).filter(a => a.email !== email);

    // If we removed the default, promote the next one
    if (accounts.length > 0 && !accounts.find(a => a.isDefault)) {
      accounts = accounts.map((a, i) => ({ ...a.toObject(), isDefault: i === 0 }));
    }

    await User.findByIdAndUpdate(req.user._id, { smtpAccounts: accounts });
    logger.info(`SMTP account removed for ${req.user.email}: ${email}`);
    return success(res, null, 'Email removed');
  } catch (err) { next(err); }
};

// ── Helper: calculate profile completion % ────────────────────────
// Total of all required weights = 90. Resume = 10. Grand total = 100.
// portfolioUrl / noticePeriod / workType are optional bonuses (not in the 100).
function calcCompletion(profile) {
  const checks = [
    // Identity — 20 pts
    { field: 'firstName',    weight: 10 },
    { field: 'lastName',     weight: 5  },
    { field: 'phone',        weight: 5  },
    // Location — 5 pts
    { field: 'city',         weight: 5  },
    // Career — 40 pts
    { field: 'currentRole',  weight: 10 },
    { field: 'targetRole',   weight: 10 },
    { field: 'experience',   weight: 5  },
    { field: 'expectedCTC',  weight: 5  },
    { field: 'workType',     weight: 5  },
    { field: 'noticePeriod', weight: 5  },
    // Skills — 15 pts
    { field: 'skills',       weight: 15 },
    // Links — 10 pts (either LinkedIn OR portfolio counts; having both = full 10)
    { field: 'linkedinUrl',  weight: 5  },
    { field: 'portfolioUrl', weight: 5  },
  ];
  // Required total from above = 20+5+40+15+10 = 90
  // Resume = 10 pts → grand total possible = 100

  let total = 0;
  for (const { field, weight } of checks) {
    const val    = profile[field];
    const filled = val !== undefined
      && val !== null
      && val !== ''
      && val !== 0
      && !(Array.isArray(val) && val.length === 0);
    if (filled) total += weight;
  }

  // Resume = 10 pts
  if (profile._hasResume) total += 10;

  return Math.min(total, 100);
}

// ── Resume gap analysis ───────────────────────────────────────────
exports.getGapAnalysis = async (req, res, next) => {
  try {
    const { targetRole } = req.body;
    const user = await User.findById(req.user._id).lean();

    const { analyzeResumeGaps } = require('../services/ai/jobAnalyzer.service');
    const analysis = await analyzeResumeGaps({ user, targetRole });

    return success(res, analysis);
  } catch (err) { next(err); }
};