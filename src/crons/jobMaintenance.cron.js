const cron   = require('node-cron');
const logger = require('../config/logger');
const Job    = require('../models/Job');
const { runLivenessCheck } = require('../services/liveness/liveness.service');

// ── Follow-up date setter ─────────────────────────────────────────
// When a job transitions to 'applied' it gets followUpDate = now + 7d.
// This cron also handles 'interview' jobs → +1d reminder if no date set.
const setFollowUpDates = async () => {
  try {
    const now = new Date();

    // Applied jobs with no followUpDate → set 7 days out
    const appliedResult = await Job.updateMany(
      { status: 'applied', followUpDate: null },
      [{ $set: { followUpDate: { $add: [now, 7 * 24 * 60 * 60 * 1000] } } }]
    );

    // Interview jobs with no followUpDate → set 1 day out
    const interviewResult = await Job.updateMany(
      { status: 'interview', followUpDate: null },
      [{ $set: { followUpDate: { $add: [now, 1 * 24 * 60 * 60 * 1000] } } }]
    );

    logger.info(
      `[FollowUp] Set dates — applied: ${appliedResult.modifiedCount}, ` +
      `interview: ${interviewResult.modifiedCount}`
    );
  } catch (err) {
    logger.error(`[FollowUp] Date setter failed: ${err.message}`);
  }
};

// ── Liveness batch check ──────────────────────────────────────────
// Runs daily at 03:00. Checks up to 20 active jobs per user.
// Skips jobs checked within the last 48h to avoid hammering job boards.
const runDailyLivenessCheck = async () => {
  try {
    // Get distinct userIds who have applied/saved jobs
    const userIds = await Job.distinct('userId', {
      status: { $in: ['applied', 'saved', 'found'] },
      $or: [
        { livenessCheckedAt: null },
        { livenessCheckedAt: { $lt: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
      ],
    });

    logger.info(`[Liveness] Daily check starting — ${userIds.length} users`);
    let checked = 0;

    for (const userId of userIds) {
      try {
        await runLivenessCheck(userId, 10); // 10 jobs per user per run
        checked++;
      } catch (err) {
        logger.warn(`[Liveness] Failed for user ${userId}: ${err.message}`);
      }
    }

    logger.info(`[Liveness] Daily check done — ${checked}/${userIds.length} users processed`);
  } catch (err) {
    logger.error(`[Liveness] Daily check failed: ${err.message}`);
  }
};

// ── Scheduler entry point ─────────────────────────────────────────
const startJobMaintenanceScheduler = () => {
  // Follow-up dates — every hour
  cron.schedule('0 * * * *', async () => {
    logger.info('[FollowUp] Hourly follow-up date setter running...');
    await setFollowUpDates();
  });

  // Liveness check — daily at 03:00
  cron.schedule('0 3 * * *', async () => {
    logger.info('[Liveness] Daily liveness check running...');
    await runDailyLivenessCheck();
  });

  logger.info('[JobMaintenance] Schedulers registered — follow-up (hourly), liveness (03:00 daily)');
};

module.exports = { startJobMaintenanceScheduler };
