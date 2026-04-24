const crypto = require('crypto');
const User        = require('../models/User');
const UserCredits = require('../models/UserCredits');
const OAuthExchangeTicket = require('../models/OAuthExchangeTicket');
const { generateTokens, verifyRefreshToken } = require('../utils/jwt.util');
const { generateToken, hashToken }           = require('../utils/crypto.util');
const { sendEmail, templates }               = require('../config/mailer');
const { success, created }                   = require('../utils/response.util');
const { AuthError, ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { PLAN_CREDITS } = require('../utils/constants');
const { invalidateUserCache } = require('../middleware/auth.middleware');
const logger = require('../config/logger');
const { setAuthCookies, clearAuthCookies } = require('../utils/authCookies.util');

function isGoogleOAuthReady() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
    process.env.GOOGLE_CLIENT_SECRET?.trim()
  );
}

// ── Helper ────────────────────────────────────────────────────────
function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Register ──────────────────────────────────────────────────────
exports.register = async (req, res, next) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Check duplicate
    const exists = await User.findOne({ email });
    if (exists) throw new ConflictError('Email already registered');

    // Create user
    const user = await User.create({
      email,
      password,
      profile: {
        firstName,
        lastName,
        completionPct: 0,
      },
      status:        'pending',
      emailVerified: false,
    });

    // Create credits record
    await UserCredits.create({
      userId:       user._id,
      plan:         'free',
      totalCredits: PLAN_CREDITS.free,
      resetDate:    getNextMonthReset(),
    });

    // Generate email verification token
    const rawToken    = generateToken(32);
    const hashedToken = hashToken(rawToken);

    user.emailVerifyToken   = hashedToken;
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await user.save();

    // Send verification email (don't fail registration if email fails)
    try {
      const emailContent = templates.verifyEmail(
        firstName,
        rawToken,
        process.env.CLIENT_URL || 'http://localhost:3000'
      );
      await sendEmail({ to: email, ...emailContent });
      logger.info(`Verification email sent to ${email}`);
    } catch (emailErr) {
      logger.error(`Verification email failed for ${email}: ${emailErr.message}`);
    }

    logger.info(`New user registered: ${email}`);

    return created(res, {
      userId:  user._id,
      message: 'Check your email to verify your account',
    }, 'Registration successful');

  } catch (err) {
    next(err);
  }
};

// ── Login ─────────────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user — include password for comparison
    const user = await User.findOne({ email }).select('+password');
    if (!user) throw new AuthError('Invalid email or password');

    // Check lock
    if (user.isLocked()) {
      const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
      throw new AuthError(`Account locked. Try again in ${mins} minutes`);
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      user.loginAttempts += 1;
      if (user.loginAttempts >= 5) {
        user.lockUntil     = new Date(Date.now() + 30 * 60 * 1000);
        user.loginAttempts = 0;
        logger.warn(`Account locked after failed attempts: ${email}`);
      }
      await user.save();
      throw new AuthError('Invalid email or password');
    }

    // Check status
    if (user.status === 'banned')  throw new AuthError('Account suspended. Contact support.');
    if (user.status === 'deleted') throw new AuthError('Account not found');

    // Same message as bad password to avoid email / state enumeration
    if (!user.emailVerified) {
      throw new AuthError('Invalid email or password');
    }

    // ── Admin 2-FA: send OTP instead of issuing tokens directly ──
    if (['admin', 'super_admin'].includes(user.role)) {
      const otp = crypto.randomInt(100000, 1000000).toString();

      user.adminOtpCode    = otp;
      user.adminOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      user.loginAttempts   = 0;
      user.lockUntil       = undefined;
      await user.save();

      try {
        const emailContent = templates.adminOtp(
          user.profile?.firstName || 'Admin',
          otp,
        );
        // Send to the admin's registered email
        await sendEmail({ to: user.email, ...emailContent });
        // Also send to the owner's personal security email if configured
        const securityEmail = process.env.ADMIN_SECURITY_EMAIL;
        if (securityEmail && securityEmail !== user.email) {
          await sendEmail({ to: securityEmail, ...emailContent }).catch(() => {});
        }
        logger.info(`Admin OTP sent to ${email}`);
      } catch (emailErr) {
        logger.error(`Admin OTP email failed for ${email}: ${emailErr.message}`);
        throw new AuthError('Failed to send verification code. Please try again.');
      }

      return success(res, {
        otpRequired: true,
        userId:      user._id.toString(),
      }, 'Verification code sent to your email');
    }

    // Reset failed attempts
    user.loginAttempts = 0;
    user.lockUntil     = undefined;
    user.lastLoginAt   = new Date();
    user.status        = 'active';
    await user.save();

    const tokens = generateTokens({
      id:                     user._id,
      role:                   user.role,
      plan:                   user.plan,
      refreshSessionVersion:  user.refreshSessionVersion ?? 0,
    });

    setAuthCookies(res, tokens);

    logger.info(`User logged in: ${email}`);

    return success(res, {
      user: user.toSafeObject(),
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
};

// ── Logout ────────────────────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $inc: { refreshSessionVersion: 1 } });
    invalidateUserCache(String(req.user._id));
    clearAuthCookies(res);
    return success(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

// ── Refresh Token ─────────────────────────────────────────────────
exports.refresh = async (req, res, next) => {
  try {
    let token = req.cookies?.refreshToken;
    if (!token && process.env.ALLOW_REFRESH_TOKEN_BODY === 'true') {
      token = req.body?.refreshToken;
    }
    if (!token) throw new AuthError('No refresh token provided');

    const decoded = verifyRefreshToken(token);
    const user    = await User.findById(decoded.id).select('refreshSessionVersion status role plan');

    if (!user) throw new AuthError('User not found');
    if (user.status === 'banned') throw new AuthError('Account suspended');

    let tokenRsv = Number(decoded.rsv);
    const legacyNoRsv = !Number.isFinite(tokenRsv);
    if (legacyNoRsv) tokenRsv = 0;
    const currentRsv = Number(user.refreshSessionVersion ?? 0);
    if (legacyNoRsv && currentRsv > 0) {
      throw new AuthError('Session expired');
    }
    if (tokenRsv !== currentRsv) throw new AuthError('Session expired');

    const updated = await User.findOneAndUpdate(
      { _id: decoded.id, refreshSessionVersion: currentRsv },
      { $inc: { refreshSessionVersion: 1 } },
      { new: true }
    ).select('role plan refreshSessionVersion');

    if (!updated) throw new AuthError('Session expired');

    const tokens = generateTokens({
      id:                     updated._id,
      role:                   updated.role,
      plan:                   updated.plan,
      refreshSessionVersion:  updated.refreshSessionVersion,
    });

    invalidateUserCache(String(decoded.id));
    setAuthCookies(res, tokens);

    return success(res, null, 'Token refreshed');

  } catch (err) {
    // Drop stale httpOnly cookies so the browser stops sending them on every /auth/me + refresh loop.
    clearAuthCookies(res);
    next(err);
  }
};

// ── Google OAuth: redeem one-time code (no JWT in URL) ───────────
exports.oauthExchange = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') throw new ValidationError('Exchange code is required');

    const ticket = await OAuthExchangeTicket.findOneAndDelete({
      code: String(code).trim(),
    });

    if (!ticket) throw new AuthError('Invalid or expired login code');

    const user = await User.findById(ticket.userId);
    if (!user) throw new AuthError('User not found');
    if (user.status === 'banned') throw new AuthError('Account suspended');

    const tokens = generateTokens({
      id:                     user._id,
      role:                   user.role,
      plan:                   user.plan,
      refreshSessionVersion:  user.refreshSessionVersion ?? 0,
    });

    setAuthCookies(res, tokens);

    return success(res, { user: user.toSafeObject() }, 'Login successful');
  } catch (err) {
    clearAuthCookies(res);
    next(err);
  }
};

// ── Verify Email ──────────────────────────────────────────────────
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) throw new ValidationError('Verification token is required');

    const hashedToken = hashToken(token);

    const user = await User.findOne({
      emailVerifyToken:   hashedToken,
      emailVerifyExpires: { $gt: Date.now() },
    }).select('+emailVerifyToken +emailVerifyExpires');

    if (!user) throw new AuthError('Invalid or expired verification link');

    user.emailVerified      = true;
    user.status             = 'active';
    user.emailVerifyToken   = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();

    logger.info(`Email verified: ${user.email}`);

    return success(res, null, 'Email verified. You can now log in.');

  } catch (err) {
    next(err);
  }
};

// ── Forgot Password ───────────────────────────────────────────────
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always return success — prevents email enumeration
    if (!user) {
      return success(res, null, 'If that email exists, a reset link has been sent');
    }

    const rawToken    = generateToken(32);
    const hashedToken = hashToken(rawToken);

    user.passwordResetToken   = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    try {
      const emailContent = templates.resetPassword(
        user.profile?.firstName || 'User',
        rawToken,
        process.env.CLIENT_URL || 'http://localhost:3000'
      );
      await sendEmail({ to: email, ...emailContent });
      logger.info(`Password reset email sent to ${email}`);
    } catch (emailErr) {
      logger.error(`Password reset email failed for ${email}: ${emailErr.message}`);
    }

    return success(res, null, 'If that email exists, a reset link has been sent');

  } catch (err) {
    next(err);
  }
};

// ── Reset Password ────────────────────────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    const hashedToken = hashToken(token);

    const user = await User.findOne({
      passwordResetToken:   hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) throw new AuthError('Invalid or expired reset link');

    user.password             = password;
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    user.loginAttempts        = 0;
    user.lockUntil            = undefined;
    await user.save();

    await User.findByIdAndUpdate(user._id, { $inc: { refreshSessionVersion: 1 } });
    invalidateUserCache(String(user._id));

    logger.info(`Password reset: ${user.email}`);

    return success(res, null, 'Password reset successfully. You can now log in.');

  } catch (err) {
    next(err);
  }
};

// ── Get Me ────────────────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) throw new NotFoundError('User not found');
    return success(res, user.toSafeObject());
  } catch (err) {
    next(err);
  }
};

// ── Google OAuth ──────────────────────────────────────────────────
exports.googleAuth = (req, res, next) => {
  if (!isGoogleOAuthReady()) {
    const back = process.env.CLIENT_URL || 'http://localhost:3000';
    logger.warn('GET /auth/google — Google OAuth env vars missing');
    return res.status(503).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Google sign-in unavailable</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:36rem;line-height:1.5">
<h1 style="font-size:1.25rem">Google sign-in is not configured</h1>
<p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <strong>jobhunter-backend/.env</strong>, then restart the API.</p>
<p><a href="${back}/login">← Back to login</a></p>
</body></html>`);
  }
  const passport = require('../config/passport');
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  })(req, res, next);
};

// ── Verify Admin OTP ──────────────────────────────────────────────
exports.verifyAdminOtp = async (req, res, next) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp) throw new ValidationError('userId and otp are required');

    const user = await User.findById(userId).select('+adminOtpCode +adminOtpExpires');
    if (!user) throw new AuthError('Invalid request');

    if (
      !user.adminOtpCode ||
      !user.adminOtpExpires ||
      user.adminOtpExpires < Date.now()
    ) {
      throw new AuthError('Verification code has expired. Please log in again.');
    }

    if (user.adminOtpCode !== otp.trim()) {
      throw new AuthError('Incorrect verification code');
    }

    // Clear OTP and complete login
    user.adminOtpCode    = undefined;
    user.adminOtpExpires = undefined;
    user.lastLoginAt     = new Date();
    user.status          = 'active';
    await user.save();

    const tokens = generateTokens({
      id:                     user._id,
      role:                   user.role,
      plan:                   user.plan,
      refreshSessionVersion:  user.refreshSessionVersion ?? 0,
    });

    setAuthCookies(res, tokens);

    logger.info(`Admin verified OTP and logged in: ${user.email}`);

    return success(res, {
      user: user.toSafeObject(),
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
};

exports.googleCallback = (req, res, next) => {
  if (!isGoogleOAuthReady()) {
    const back = process.env.CLIENT_URL || 'http://localhost:3000';
    return res.redirect(`${back}/login?error=google_not_configured`);
  }
  const passport = require('../config/passport');
  passport.authenticate('google', { session: false }, async (err, user) => {
    if (err || !user) {
      logger.error('Google callback error:', err?.message);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_failed`);
    }

    try {
      const code = crypto.randomBytes(32).toString('hex');
      await OAuthExchangeTicket.create({ code, userId: user._id });

      res.redirect(
        `${process.env.CLIENT_URL}/auth/callback?code=${encodeURIComponent(code)}`
      );
    } catch (callbackErr) {
      res.redirect(`${process.env.CLIENT_URL}/login?error=server_error`);
    }
  })(req, res, next);
};