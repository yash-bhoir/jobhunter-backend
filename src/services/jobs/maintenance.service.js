const cron   = require('node-cron');
const Job    = require('../../models/Job');
const logger = require('../../config/logger');

// Mark jobs as expired after 30 days
const markExpiredJobs = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const result = await Job.updateMany(
      {
        createdAt: { $lt: thirtyDaysAgo },
        status:    { $in: ['found', 'saved'] },
        expired:   { $ne: true },
      },
      {
        $set: {
          expired:   true,
          expiredAt: new Date(),
        },
      }
    );

    if (result.modifiedCount > 0) {
      logger.info(`Job expiry: marked ${result.modifiedCount} jobs as expired`);
    }
  } catch (err) {
    logger.error(`Job expiry error: ${err.message}`);
  }
};

// Check duplicate application
const checkDuplicateApplication = async (userId, company, jobTitle) => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const existing = await Job.findOne({
    userId,
    company:   { $regex: new RegExp(company, 'i') },
    status:    { $in: ['applied', 'interview', 'offer'] },
    appliedAt: { $gte: thirtyDaysAgo },
  }).lean();

  if (existing) {
    return {
      isDuplicate: true,
      message:     `You applied to ${company} ${Math.floor((Date.now() - new Date(existing.appliedAt)) / (1000 * 60 * 60 * 24))} days ago`,
      previousJob: {
        title:     existing.title,
        status:    existing.status,
        appliedAt: existing.appliedAt,
      },
    };
  }

  return { isDuplicate: false };
};

// Start scheduler
const startJobMaintenanceScheduler = () => {
  // Run every day at 2 AM
  cron.schedule('0 2 * * *', async () => {
    logger.info('Running job maintenance...');
    await markExpiredJobs();
  });

  logger.info('Job maintenance scheduler registered (runs daily at 2 AM)');
};

module.exports = { markExpiredJobs, checkDuplicateApplication, startJobMaintenanceScheduler };