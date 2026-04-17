const User        = require('../models/User');
const UserCredits = require('../models/UserCredits');
const { generateTokens, verifyRefreshToken } = require('../utils/jwt.util');
const { generateToken, hashToken }           = require('../utils/crypto.util');
const { sendEmail, templates }               = require('../config/mailer');
const { success, created }                   = require('../utils/response.util');
const { AuthError, ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { PLAN_CREDITS } = require('../utils/constants');
const logger = require('../config/logger');

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

    // Check email verified
    if (!user.emailVerified) {
      throw new AuthError('Please verify your email before logging in');
    }

    // ── Admin 2-FA: send OTP instead of issuing tokens directly ──
    if (['admin', 'super_admin'].includes(user.role)) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

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

    // Generate tokens
    const tokens = generateTokens({
      id:   user._id,
      role: user.role,
      plan: user.plan,
    });

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    });

    logger.info(`User logged in: ${email}`);

    return success(res, {
      accessToken: tokens.accessToken,
      user:        user.toSafeObject(),
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
};

// ── Logout ────────────────────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    res.clearCookie('refreshToken');
    return success(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

// ── Refresh Token ─────────────────────────────────────────────────
exports.refresh = async (req, res, next) => {
  try {
    // Token can come from cookie or body
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!token) throw new AuthError('No refresh token provided');

    const decoded = verifyRefreshToken(token);
    const user    = await User.findById(decoded.id);

    if (!user)                    throw new AuthError('User not found');
    if (user.status === 'banned') throw new AuthError('Account suspended');

    const tokens = generateTokens({
      id:   user._id,
      role: user.role,
      plan: user.plan,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });

    return success(res, { accessToken: tokens.accessToken }, 'Token refreshed');

  } catch (err) {
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
      id:   user._id,
      role: user.role,
      plan: user.plan,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });

    logger.info(`Admin verified OTP and logged in: ${user.email}`);

    return success(res, {
      accessToken: tokens.accessToken,
      user:        user.toSafeObject(),
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
};

exports.googleCallback = (req, res, next) => {
  const passport = require('../config/passport');
  passport.authenticate('google', { session: false }, async (err, user) => {
    if (err || !user) {
      logger.error('Google callback error:', err?.message);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_failed`);
    }

    try {
      const tokens = generateTokens({
        id:   user._id,
        role: user.role,
        plan: user.plan,
      });

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge:   30 * 24 * 60 * 60 * 1000,
      });

      // Redirect to frontend with token
      res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${tokens.accessToken}`);
    } catch (callbackErr) {
      res.redirect(`${process.env.CLIENT_URL}/login?error=server_error`);
    }
  })(req, res, next);
};