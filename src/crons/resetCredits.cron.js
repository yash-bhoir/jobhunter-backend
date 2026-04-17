const cron        = require('node-cron');
const UserCredits = require('../models/UserCredits');
const User        = require('../models/User');
const { PLAN_CREDITS } = require('../utils/constants');
const logger      = require('../config/logger');

// ── Monthly credit reset — runs at 00:00 on the 1st of every month ──
const startCreditResetScheduler = () => {
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[CreditReset] Monthly reset starting...');

    try {
      // Only active users
      const users = await User.find({ status: 'active' })
        .select('_id plan planOverrides')
        .lean();

      let resetCount  = 0;
      let errorCount  = 0;

      for (const user of users) {
        try {
          const plan = user.plan || 'free';

          // Respect admin-level credit overrides
          let totalCredits = PLAN_CREDITS[plan] ?? 100;
          if (user.planOverrides?.active && user.planOverrides?.creditsPerMonth) {
            totalCredits = user.planOverrides.creditsPerMonth;
          }

          const nextReset = new Date();
          nextReset.setMonth(nextReset.getMonth() + 1, 1);
          nextReset.setHours(0, 0, 0, 0);

          await UserCredits.findOneAndUpdate(
            { userId: user._id },
            {
              $set: {
                plan,
                totalCredits,
                usedCredits: 0,
                // Reset all breakdown counters
                'breakdown.searches':     0,
                'breakdown.emailLookups': 0,
                'breakdown.aiEmails':     0,
                'breakdown.emailsSent':   0,
                'breakdown.resumeParses': 0,
                'breakdown.exports':      0,
                lastResetAt:  new Date(),
                resetDate:    nextReset,
                // Clear grace flag so mid-month auto-reload can fire again next cycle
                graceGiven:   false,
                graceGivenAt: null,
              },
              // topupCredits intentionally NOT reset — user paid for them
            },
            { upsert: true, new: true }
          );

          resetCount++;
        } catch (err) {
          errorCount++;
          logger.warn(`[CreditReset] Failed for user ${user._id}: ${err.message}`);
        }
      }

      logger.info(
        `[CreditReset] Done — ${resetCount} reset, ${errorCount} failed, ` +
        `${users.length} total users`
      );
    } catch (err) {
      logger.error(`[CreditReset] Monthly reset failed: ${err.message}`);
    }
  });

  logger.info('[CreditReset] Scheduler registered — runs on 1st of each month at 00:00');
};

module.exports = { startCreditResetScheduler };
