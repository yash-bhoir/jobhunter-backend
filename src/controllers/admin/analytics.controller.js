const User        = require('../../models/User');
const UserCredits = require('../../models/UserCredits');
const ActivityLog = require('../../models/ActivityLog');
const JobSearch   = require('../../models/JobSearch');
const Job         = require('../../models/Job');
const OutreachEmail = require('../../models/OutreachEmail');
const JobRankingEvent = require('../../models/JobRankingEvent');
const { success } = require('../../utils/response.util');

// ── Overview ──────────────────────────────────────────────────────
exports.getOverview = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      proUsers,
      freeUsers,
      teamUsers,
      totalSearches,
      searchesToday,
      totalJobs,
      totalEmails,
      newUsersToday,
      activeToday,
    ] = await Promise.all([
      User.countDocuments({ status: { $ne: 'deleted' } }),
      User.countDocuments({ plan: 'pro',  status: { $ne: 'deleted' } }),
      User.countDocuments({ plan: 'free', status: { $ne: 'deleted' } }),
      User.countDocuments({ plan: 'team', status: { $ne: 'deleted' } }),
      JobSearch.countDocuments(),
      JobSearch.countDocuments({ createdAt: { $gte: today } }),
      Job.countDocuments(),
      OutreachEmail.countDocuments({ status: 'sent' }),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ lastActiveAt: { $gte: today } }),
    ]);

    return success(res, {
      users: { total: totalUsers, pro: proUsers, free: freeUsers, team: teamUsers, newToday: newUsersToday, activeToday },
      searches: { total: totalSearches, today: searchesToday },
      jobs:     { total: totalJobs },
      emails:   { sent: totalEmails },
    });
  } catch (err) {
    next(err);
  }
};

// ── User stats ────────────────────────────────────────────────────
exports.getUserStats = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const from = new Date();
    from.setDate(from.getDate() - days);

    const signups = await User.aggregate([
      { $match: { createdAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const planBreakdown = await User.aggregate([
      { $match: { status: { $ne: 'deleted' } } },
      { $group: { _id: '$plan', count: { $sum: 1 } } },
    ]);

    return success(res, { signups, planBreakdown });
  } catch (err) {
    next(err);
  }
};

// ── Revenue ───────────────────────────────────────────────────────
exports.getRevenue = async (req, res, next) => {
  try {
    const proCount  = await User.countDocuments({ plan: 'pro',  status: 'active' });
    const teamCount = await User.countDocuments({ plan: 'team', status: 'active' });

    const mrr = (proCount * 499) + (teamCount * 1999);

    return success(res, {
      mrr,
      proUsers:  proCount,
      teamUsers: teamCount,
      breakdown: {
        pro:  proCount  * 499,
        team: teamCount * 1999,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Search stats ──────────────────────────────────────────────────
exports.getSearchStats = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const from = new Date();
    from.setDate(from.getDate() - days);

    const searches = await JobSearch.aggregate([
      { $match: { createdAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, totalJobs: { $sum: '$totalFound' } } },
      { $sort: { _id: 1 } },
    ]);

    const topRoles = await JobSearch.aggregate([
      { $group: { _id: '$query.role', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    return success(res, { searches, topRoles });
  } catch (err) {
    next(err);
  }
};

// ── Platform stats ────────────────────────────────────────────────
exports.getPlatformStats = async (req, res, next) => {
  try {
    const stats = await Job.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 }, avgMatch: { $avg: '$matchScore' } } },
      { $sort: { count: -1 } },
    ]);

    return success(res, stats);
  } catch (err) {
    next(err);
  }
};

// ── Ranking / UX feedback (JobRankingEvent) ───────────────────────
/** Query: days (1–90, default 7), eventType (optional filter) */
exports.getRankingEventStats = async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const from   = new Date();
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);

    const match = { createdAt: { $gte: from } };
    const et    = String(req.query.eventType || '').trim();
    if (et) match.eventType = et;

    const [byType, byDay, byListingSurface, total, uniqueUsers] = await Promise.all([
      JobRankingEvent.aggregate([
        { $match: match },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      JobRankingEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      JobRankingEvent.aggregate([
        { $match: match },
        {
          $project: {
            surface: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $type: '$linkedinJobId' }, 'objectId'] }, then: 'linkedin_job' },
                  { case: { $eq: [{ $type: '$jobId' }, 'objectId'] }, then: 'job' },
                ],
                default: 'other',
              },
            },
          },
        },
        { $group: { _id: '$surface', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      JobRankingEvent.countDocuments(match),
      JobRankingEvent.distinct('userId', match).then((ids) => ids.length),
    ]);

    return success(res, {
      days,
      from:     from.toISOString(),
      total,
      uniqueUsers,
      byEventType: Object.fromEntries(byType.map((r) => [r._id || 'unknown', r.count])),
      byListingSurface: Object.fromEntries(byListingSurface.map((r) => [r._id || 'unknown', r.count])),
      byDay:       byDay.map((r) => ({ date: r._id, count: r.count })),
    });
  } catch (err) {
    next(err);
  }
};