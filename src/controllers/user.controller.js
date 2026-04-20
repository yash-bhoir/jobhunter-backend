const User           = require('../models/User');
const UserCredits    = require('../models/UserCredits');
const ActivityLog    = require('../models/ActivityLog');
const JobSearch      = require('../models/JobSearch');
const Job            = require('../models/Job');
const LinkedInJob    = require('../models/LinkedInJob');
const RecruiterLookup = require('../models/RecruiterLookup');
const { success } = require('../utils/response.util');
const { NotFoundError } = require('../utils/errors');

// ── Get current user ──────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) throw new NotFoundError('User not found');
    return success(res, user.toSafeObject());
  } catch (err) {
    next(err);
  }
};

// ── Get credits ───────────────────────────────────────────────────
exports.getCredits = async (req, res, next) => {
  try {
    let credits = await UserCredits.findOne({ userId: req.user._id });

    if (!credits) {
      const { PLAN_CREDITS } = require('../utils/constants');
      credits = await UserCredits.create({
        userId:       req.user._id,
        plan:         req.user.plan || 'free',
        totalCredits: PLAN_CREDITS[req.user.plan || 'free'] ?? 100,
        resetDate:    getNextMonthReset(),
        lastResetAt:  new Date(),
      });
    } else if (!credits.resetDate) {
      // Back-fill missing resetDate on old records
      const nextReset = getNextMonthReset();
      await UserCredits.findByIdAndUpdate(credits._id, { $set: { resetDate: nextReset } });
      credits.resetDate = nextReset;
    }

    return success(res, {
      plan:         credits.plan,
      totalCredits: credits.totalCredits,
      usedCredits:  credits.usedCredits,
      topupCredits: credits.topupCredits,
      remaining:    credits.remaining,
      usagePct:     credits.usagePct,
      breakdown:    credits.breakdown,
      resetDate:    credits.resetDate,
      lastResetAt:  credits.lastResetAt,
      graceGiven:   credits.graceGiven   || false,
      graceGivenAt: credits.graceGivenAt || null,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get stats ─────────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [
      totalSearches,
      jobSearchCount,
      linkedinJobCount,
      savedJobs,
      appliedJobSearch,
      appliedLinkedIn,
      interviewJobSearch,
      interviewLinkedIn,
      emailsSent,
      totalRecruiters,
    ] = await Promise.all([
      JobSearch.countDocuments({ userId }),
      Job.countDocuments({ userId }),
      LinkedInJob.countDocuments({ userId }),
      Job.countDocuments({ userId, status: 'saved' }),
      Job.countDocuments({ userId, status: 'applied' }),
      LinkedInJob.countDocuments({ userId, status: 'applied' }),
      Job.countDocuments({ userId, status: 'interview' }),
      LinkedInJob.countDocuments({ userId, status: 'applied' }), // no interview state on LinkedInJob
      ActivityLog.countDocuments({ userId, event: 'email.sent' }),
      RecruiterLookup.countDocuments({ userId }).catch(() => 0),
    ]);

    return success(res, {
      totalSearches,
      totalJobs:     jobSearchCount + linkedinJobCount,
      jobSearchCount,
      linkedinJobCount,
      savedJobs,
      appliedJobs:   appliedJobSearch + appliedLinkedIn,
      interviewJobs: interviewJobSearch,
      emailsSent,
      totalRecruiters,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get activity ──────────────────────────────────────────────────
exports.getActivity = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLog.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments({ userId: req.user._id }),
    ]);

    return success(res, {
      logs,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Update plan (called after payment) ───────────────────────────
exports.updatePlan = async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!['free', 'pro', 'team'].includes(plan)) {
      return res.status(400).json({ success: false, message: 'Invalid plan' });
    }

    const { PLAN_CREDITS } = require('../utils/constants');

    await User.findByIdAndUpdate(req.user._id, { plan });
    await UserCredits.findOneAndUpdate(
      { userId: req.user._id },
      {
        plan,
        totalCredits: PLAN_CREDITS[plan],
        usedCredits:  0,
        resetDate:    getNextMonthReset(),
      },
      { upsert: true }
    );

    return success(res, { plan }, 'Plan updated');
  } catch (err) {
    next(err);
  }
};

// ── Helper ────────────────────────────────────────────────────────
function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}