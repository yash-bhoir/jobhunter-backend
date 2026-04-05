const UserCredits = require('../models/UserCredits');
const ActivityLog = require('../models/ActivityLog');
const { CreditError, ForbiddenError } = require('../utils/errors');
const { CREDIT_BREAKDOWN_MAP, PLAN_LIMITS } = require('../utils/constants');
const { getCreditCosts } = require('../utils/appConfig');

// ── Guard: restrict endpoint to specific plan tiers ──────────────
const planGuard = (...allowedPlans) => (req, _res, next) => {
  const userPlan = req.user?.plan || 'free';
  if (allowedPlans.includes(userPlan)) return next();
  const minPlan = allowedPlans.includes('pro') ? 'Pro' : 'Team';
  return next(new ForbiddenError(
    `This feature requires a ${minPlan} plan. Upgrade at Settings → Billing.`
  ));
};

// ── Guard: enforce per-plan daily search limit ────────────────────
const checkDailySearchLimit = async (req, _res, next) => {
  try {
    const userPlan = req.user?.plan || 'free';
    const limit    = PLAN_LIMITS[userPlan]?.searchesPerDay ?? 999;
    if (limit >= 999) return next(); // pro/team: unlimited

    const JobSearch  = require('../models/JobSearch');
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await JobSearch.countDocuments({
      userId:    req.user._id,
      status:    'completed',
      createdAt: { $gte: startOfDay },
    });

    if (todayCount >= limit) {
      return next(new ForbiddenError(
        `Daily search limit reached (${limit} search${limit === 1 ? '' : 'es'}/day on Free plan). ` +
        `Upgrade to Pro for unlimited searches.`
      ));
    }
    next();
  } catch (err) {
    next(err);
  }
};

const requireCredits = (action) => async (req, _res, next) => {
  try {
    const CREDIT_COSTS = await getCreditCosts();
    const cost = CREDIT_COSTS[action] || 0;
    if (cost === 0) return next();

    let credits = await UserCredits.findOne({ userId: req.user._id });

    // Create if not exists
    if (!credits) {
      const { PLAN_CREDITS } = require('../utils/constants');
      credits = await UserCredits.create({
        userId:       req.user._id,
        plan:         req.user.plan || 'free',
        totalCredits: PLAN_CREDITS[req.user.plan || 'free'],
      });
    }

    const available = credits.totalCredits + credits.topupCredits - credits.usedCredits;
    if (available < cost) return next(new CreditError(cost, available));

    // Atomic deduction — include topupCredits in the check to prevent race conditions
    // Also increment the breakdown counter for this action type
    const breakdownField = CREDIT_BREAKDOWN_MAP[action];
    const breakdownInc   = breakdownField ? { [`breakdown.${breakdownField}`]: 1 } : {};

    const updated = await UserCredits.findOneAndUpdate(
      {
        userId: req.user._id,
        $expr: {
          $gte: [
            { $subtract: [{ $add: ['$totalCredits', '$topupCredits'] }, '$usedCredits'] },
            cost,
          ],
        },
      },
      { $inc: { usedCredits: cost, ...breakdownInc }, $set: { updatedAt: new Date() } },
      { new: true }
    );

    if (!updated) return next(new CreditError(cost, available));

    // Log async — fire and forget
    ActivityLog.create({
      userId:        req.user._id,
      event:         'credits.deducted',
      category:      'billing',
      creditsUsed:   cost,
      creditsBefore: available,
      creditsAfter:  available - cost,
      metadata:      { action },
      ip:            req.ip,
    }).catch(() => {});

    req.creditsDeducted  = cost;
    req.creditsRemaining = available - cost;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { requireCredits, planGuard, checkDailySearchLimit };
