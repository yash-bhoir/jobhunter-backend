const cron        = require('node-cron');
const User        = require('../../models/User');
const LinkedInJob = require('../../models/LinkedInJob');
const { fetchLinkedInRSS, scrapeLinkedInJobs } = require('./rss.service');
const { findHRContacts } = require('../emailFinder');
const { score }   = require('../jobSearch/scorer');
const logger      = require('../../config/logger');

// Run every hour — fetch LinkedIn jobs for Pro users who have alerts configured
const startScheduler = () => {
  cron.schedule('0 * * * *', async () => {
    logger.info('LinkedIn alert scheduler started');

    try {
      // Find all pro/team users with target role set
      const users = await User.find({
        plan:   { $in: ['pro', 'team'] },
        status: 'active',
        'profile.targetRole': { $exists: true, $ne: '' },
      }).lean();

      logger.info(`Processing LinkedIn alerts for ${users.length} Pro users`);

      for (const user of users) {
        try {
          await fetchAndSaveForUser(user);
          // Rate limit — wait 2s between users
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          logger.warn(`LinkedIn fetch failed for ${user.email}: ${err.message}`);
        }
      }

    } catch (err) {
      logger.error(`LinkedIn scheduler error: ${err.message}`);
    }
  });

  logger.info('LinkedIn alert scheduler registered (runs every hour)');
};

const fetchAndSaveForUser = async (user) => {
  const role     = user.profile?.targetRole || user.profile?.currentRole;
  const location = user.profile?.preferredLocations?.[0] || user.profile?.city || 'India';
  const workType = user.profile?.workType || 'any';

  if (!role) return;

  // Try API then scrape as fallback
  let jobs = await fetchLinkedInRSS({ role, location });
  if (jobs.length === 0) {
    jobs = await scrapeLinkedInJobs({ role, location, workType });
  }

  if (jobs.length === 0) {
    logger.info(`No new LinkedIn jobs for ${user.email} (${role})`);
    return;
  }

  // Filter duplicates — check URLs already saved
  const existingUrls = await LinkedInJob.find({ userId: user._id })
    .select('url').lean();
  const existingSet  = new Set(existingUrls.map(j => j.url).filter(Boolean));

  const newJobs = jobs.filter(j => !j.url || !existingSet.has(j.url));

  if (newJobs.length === 0) {
    logger.info(`No new LinkedIn jobs (all duplicates) for ${user.email}`);
    return;
  }

  // Score jobs
  const scored = score(newJobs, user);

  // Save to DB
  const jobDocs = scored.map(j => ({
    userId:    user._id,
    title:     j.title,
    company:   j.company,
    location:  j.location,
    url:       j.url,
    postedAt:  j.postedAt,
    remote:    j.remote,
    source:    j.source || 'linkedin_alert',
    matchScore: j.matchScore || 0,
    status:    'new',
  }));

  await LinkedInJob.insertMany(jobDocs, { ordered: false }).catch(() => {});

  // Auto-find HR emails for top 3 companies
  const topCompanies = [...new Set(scored.slice(0, 3).map(j => j.company))];
  for (const company of topCompanies) {
    try {
      const contacts = await findHRContacts(company, user.plan);
      if (contacts?.emails?.length > 0) {
        await LinkedInJob.updateMany(
          { userId: user._id, company, recruiterEmail: null },
          {
            $set: {
              recruiterEmail: contacts.emails[0].email,
              recruiterName:  contacts.emails[0].name,
            },
          }
        );
      }
    } catch {}
  }

  logger.info(`LinkedIn: saved ${jobDocs.length} new jobs for ${user.email} (${role})`);
};

module.exports = { startScheduler, fetchAndSaveForUser };