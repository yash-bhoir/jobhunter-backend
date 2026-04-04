const User        = require('../../models/User');
const UserCredits = require('../../models/UserCredits');
const ActivityLog = require('../../models/ActivityLog');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { generateTokens } = require('../../utils/jwt.util');
const { success, paginated } = require('../../utils/response.util');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { PLAN_CREDITS } = require('../../utils/constants');
const logger = require('../../config/logger');

// ── List all users ────────────────────────────────────────────────
exports.listUsers = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const search = req.query.search || '';
    const plan   = req.query.plan   || '';
    const status = req.query.status || '';

    const filter = {};
    if (search) filter.email = { $regex: search, $options: 'i' };
    if (plan)   filter.plan   = plan;
    if (status) filter.status = status;

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-password -emailVerifyToken -passwordResetToken')
        .lean(),
      User.countDocuments(filter),
    ]);

    return paginated(res, users, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get single user ───────────────────────────────────────────────
exports.getUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -emailVerifyToken -passwordResetToken');
    if (!user) throw new NotFoundError('User not found');

    const credits = await UserCredits.findOne({ userId: user._id });

    return success(res, { ...user.toObject(), credits });
  } catch (err) {
    next(err);
  }
};

// ── Change plan ───────────────────────────────────────────────────
exports.changePlan = async (req, res, next) => {
  try {
    const { plan, reason } = req.body;
    if (!['free', 'pro', 'team'].includes(plan)) {
      throw new ValidationError('Invalid plan');
    }

    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    const oldPlan = user.plan;
    await User.findByIdAndUpdate(req.params.id, { plan });
    await UserCredits.findOneAndUpdate(
      { userId: req.params.id },
      {
        plan,
        totalCredits: PLAN_CREDITS[plan],
        usedCredits:  0,
      },
      { upsert: true }
    );

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.plan_changed',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      before:      { plan: oldPlan },
      after:       { plan },
      ip:          req.ip,
      reason,
    });

    logger.info(`Admin ${req.user.email} changed ${user.email} plan: ${oldPlan} → ${plan}`);
    return success(res, { plan }, 'Plan updated');
  } catch (err) {
    next(err);
  }
};

// ── Change status ─────────────────────────────────────────────────
exports.changeStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const allowed = ['active', 'pending', 'banned'];
    if (!allowed.includes(status)) throw new ValidationError('Invalid status');

    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    const update = { status };
    if (status === 'banned') {
      update.banReason = reason || 'Banned by admin';
      update.bannedAt  = new Date();
      update.bannedBy  = req.user._id;
    }

    await User.findByIdAndUpdate(req.params.id, update);

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.status_changed',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      before:      { status: user.status },
      after:       { status },
      ip:          req.ip,
      reason,
    });

    logger.info(`Admin ${req.user.email} changed ${user.email} status to ${status}`);
    return success(res, { status }, 'Status updated');
  } catch (err) {
    next(err);
  }
};

// ── Adjust credits ────────────────────────────────────────────────
exports.adjustCredits = async (req, res, next) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || typeof amount !== 'number') {
      throw new ValidationError('Amount must be a number');
    }

    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    let credits = await UserCredits.findOne({ userId: req.params.id });
    if (!credits) {
      credits = await UserCredits.create({
        userId: req.params.id,
        plan:   user.plan,
        totalCredits: PLAN_CREDITS[user.plan],
      });
    }

    // Add or remove credits
    if (amount > 0) {
      await UserCredits.findOneAndUpdate(
        { userId: req.params.id },
        { $inc: { topupCredits: amount } }
      );
    } else {
      await UserCredits.findOneAndUpdate(
        { userId: req.params.id },
        { $inc: { usedCredits: Math.abs(amount) } }
      );
    }

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.credits_adjusted',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      before:      { credits: credits.remaining },
      after:       { adjustment: amount },
      ip:          req.ip,
      reason,
    });

    return success(res, { adjusted: amount }, 'Credits adjusted');
  } catch (err) {
    next(err);
  }
};

// ── Override limits ───────────────────────────────────────────────
exports.overrideLimits = async (req, res, next) => {
  try {
    const { searchesPerDay, creditsPerMonth, hrLookupsPerMonth, emailsPerMonth, reason } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    await User.findByIdAndUpdate(req.params.id, {
      planOverrides: {
        active: true,
        searchesPerDay,
        creditsPerMonth,
        hrLookupsPerMonth,
        emailsPerMonth,
        reason,
        appliedBy: req.user._id,
        appliedAt: new Date(),
      },
    });

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.limits_overridden',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      after:       { searchesPerDay, creditsPerMonth, hrLookupsPerMonth, emailsPerMonth },
      ip:          req.ip,
      reason,
    });

    return success(res, null, 'Limits overridden');
  } catch (err) {
    next(err);
  }
};

// ── Impersonate user ──────────────────────────────────────────────
exports.impersonate = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    const tokens = generateTokens({
      id:          user._id,
      role:        user.role,
      plan:        user.plan,
      impersonatedBy: req.user._id,
    });

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.impersonated',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      ip:          req.ip,
    });

    logger.warn(`Admin ${req.user.email} impersonating ${user.email}`);
    return success(res, { accessToken: tokens.accessToken }, 'Impersonation token generated');
  } catch (err) {
    next(err);
  }
};

// ── Delete user ───────────────────────────────────────────────────
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    // Soft delete
    await User.findByIdAndUpdate(req.params.id, {
      status:    'deleted',
      deletedAt: new Date(),
      email:     `deleted_${Date.now()}_${user.email}`,
    });

    await AdminAuditLog.create({
      adminId:     req.user._id,
      action:      'user.deleted',
      targetType:  'User',
      targetId:    user._id,
      targetEmail: user.email,
      ip:          req.ip,
      reason:      req.body?.reason,
    });

    return success(res, null, 'User deleted');
  } catch (err) {
    next(err);
  }
};

// ── Get user activity ─────────────────────────────────────────────
exports.getUserActivity = async (req, res, next) => {
  try {
    const logs = await ActivityLog.find({ userId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return success(res, logs);
  } catch (err) {
    next(err);
  }
};

// ── Get user credits ──────────────────────────────────────────────
exports.getUserCredits = async (req, res, next) => {
  try {
    const credits = await UserCredits.findOne({ userId: req.params.id });
    if (!credits) throw new NotFoundError('Credits not found');
    return success(res, credits);
  } catch (err) {
    next(err);
  }
};