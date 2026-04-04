const Subscription   = require('../../models/Subscription');
const User           = require('../../models/User');
const UserCredits    = require('../../models/UserCredits');
const { success, paginated } = require('../../utils/response.util');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../config/logger');

// ── Get all subscriptions ─────────────────────────────────────────
exports.getSubscriptions = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.plan)   filter.plan   = req.query.plan;
    if (req.query.status) filter.status = req.query.status;

    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .populate('userId', 'email profile.firstName profile.lastName plan')
        .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Subscription.countDocuments(filter),
    ]);

    return paginated(res, subs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get revenue stats ─────────────────────────────────────────────
exports.getRevenue = async (req, res, next) => {
  try {
    const PRO_PRICE  = 499;
    const TEAM_PRICE = 1999;

    const [proCount, teamCount, totalSubs] = await Promise.all([
      User.countDocuments({ plan: 'pro',  status: 'active' }),
      User.countDocuments({ plan: 'team', status: 'active' }),
      Subscription.countDocuments({ status: 'active' }),
    ]);

    const mrr = (proCount * PRO_PRICE) + (teamCount * TEAM_PRICE);

    return success(res, {
      mrr,
      proUsers:  proCount,
      teamUsers: teamCount,
      totalActiveSubs: totalSubs,
      breakdown: {
        pro:  { users: proCount,  revenue: proCount  * PRO_PRICE  },
        team: { users: teamCount, revenue: teamCount * TEAM_PRICE },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Grant free credits to user ────────────────────────────────────
exports.grantCredits = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { credits, reason } = req.body;

    if (!credits || credits <= 0) throw new ValidationError('Credits amount must be positive');

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    await UserCredits.findOneAndUpdate(
      { userId },
      { $inc: { topupCredits: credits } },
      { upsert: true }
    );

    logger.info(`Admin ${req.user.email} granted ${credits} credits to ${user.email}. Reason: ${reason || 'none'}`);
    return success(res, { userId, credits, reason }, `${credits} credits granted`);
  } catch (err) {
    next(err);
  }
};
