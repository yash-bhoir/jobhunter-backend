const UserCredits = require('../models/UserCredits');
const ActivityLog = require('../models/ActivityLog');
const { CreditError, ForbiddenError } = require('../utils/errors');
const { CREDIT_BREAKDOWN_MAP, PLAN_LIMITS, PLAN_CREDITS } = require('../utils/constants');
const { getCreditCosts, getAppConfig } = require('../utils/appConfig');
const { sendEmail, templates } = require('../config/mailer');
const logger = require('../config/logger');

// ── Next monthly reset date ───────────────────────────────────────
const getNextMonthReset = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
};

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
    const userPlan  = req.user?.plan || 'free';
    const planKey   = `${userPlan}PlanLimits`;
    const dbLimits  = await getAppConfig(planKey);
    const limit     = dbLimits?.searchesPerDay ?? PLAN_LIMITS[userPlan]?.searchesPerDay ?? 999;
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

    // Create if not exists — always include resetDate so monthly cron has a baseline
    if (!credits) {
      const planKey    = `${req.user.plan || 'free'}PlanLimits`;
      const dbLimits   = await getAppConfig(planKey);
      const planCreds  = dbLimits?.creditsPerMonth ?? PLAN_CREDITS[req.user.plan || 'free'];
      credits = await UserCredits.create({
        userId:       req.user._id,
        plan:         req.user.plan || 'free',
        totalCredits: planCreds,
        resetDate:    getNextMonthReset(),
        lastResetAt:  new Date(),
      });
    }

    // Fix missing resetDate on old records
    if (!credits.resetDate) {
      await UserCredits.findByIdAndUpdate(credits._id, {
        $set: { resetDate: getNextMonthReset() },
      });
    }

    const available = credits.totalCredits + credits.topupCredits - credits.usedCredits;
    if (available < cost) return next(new CreditError(cost, available));

    // Atomic deduction — include topupCredits in the check to prevent race conditions
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

    const remaining = available - cost;

    // Log async — fire and forget
    ActivityLog.create({
      userId:        req.user._id,
      event:         'credits.deducted',
      category:      'billing',
      creditsUsed:   cost,
      creditsBefore: available,
      creditsAfter:  remaining,
      metadata:      { action },
      ip:            req.ip,
    }).catch(() => {});

    // ── Low-credit email warning ──────────────────────────────────
    // Notify when first crossing below 20% of total allocation
    const total      = credits.totalCredits + credits.topupCredits;
    const threshold  = Math.ceil(total * 0.2);
    if (remaining <= threshold && available > threshold && req.user.email) {
      const name = req.user.profile?.firstName || 'there';
      const { subject, html } = templates.lowCredits(name, remaining);
      sendEmail({ to: req.user.email, subject, html })
        .catch(e => logger.warn(`Low-credit email failed: ${e.message}`));
    }

    // ── Auto-reload grace credits for Pro/Team mid-month ─────────
    // When a Pro/Team user hits 0 credits, give them 50 grace credits
    // once per calendar month so they aren't hard-blocked mid-cycle.
    if (remaining <= 0 && ['pro', 'team'].includes(req.user.plan || 'free')) {
      const now       = new Date();
      const lastReset = credits.lastResetAt ? new Date(credits.lastResetAt) : null;
      const sameMonth = lastReset &&
        lastReset.getMonth()    === now.getMonth() &&
        lastReset.getFullYear() === now.getFullYear();

      // Only grant grace if we haven't already done so this month
      if (!credits.graceGiven || !sameMonth) {
        const graceCredits = req.user.plan === 'team' ? 100 : 50;
        await UserCredits.findByIdAndUpdate(credits._id, {
          $inc: { topupCredits: graceCredits },
          $set: { graceGiven: true, graceGivenAt: now },
        });
        logger.info(`Grace credits granted: ${graceCredits} → ${req.user.email}`);

        // Notify user
        if (req.user.email) {
          const name = req.user.profile?.firstName || 'there';
          sendEmail({
            to:      req.user.email,
            subject: `⚡ ${graceCredits} bonus credits added to keep you going`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
                <h2 style="color:#2563eb">Credits Running Low</h2>
                <p>Hi ${name}, you've used all your monthly credits — so we've automatically added <strong>${graceCredits} bonus credits</strong> to your account to keep you going.</p>
                <p>These will be deducted from your next billing cycle. To get more credits, top up anytime from your dashboard.</p>
                <a href="${process.env.CLIENT_URL}/credits"
                   style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
                  View Credits
                </a>
              </div>
            `,
          }).catch(() => {});
        }
      }
    }

    req.creditsDeducted  = cost;
    req.creditsRemaining = remaining;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { requireCredits, planGuard, checkDailySearchLimit };
