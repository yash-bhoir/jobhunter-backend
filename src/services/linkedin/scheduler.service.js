const cron        = require('node-cron');
const User        = require('../../models/User');
const LinkedInJob = require('../../models/LinkedInJob');
const { fetchLinkedInRSS, scrapeLinkedInJobs } = require('./rss.service');
const { findHRContacts } = require('../emailFinder');
const { score }   = require('../jobSearch/scorer');
const { sendEmail, templates } = require('../../config/mailer');
const logger      = require('../../config/logger');

// Check if user's alert frequency allows sending now
const shouldSendAlert = (user) => {
  if (!user.linkedinAlerts?.enabled) return false;
  const freq      = user.linkedinAlerts?.frequency || 'daily';
  const lastSent  = user.linkedinAlerts?.lastSentAt;
  if (!lastSent) return true;

  const diffMs   = Date.now() - new Date(lastSent).getTime();
  const diffHrs  = diffMs / (1000 * 60 * 60);

  if (freq === 'hourly') return diffHrs >= 1;
  if (freq === 'daily')  return diffHrs >= 23;   // slight buffer
  if (freq === 'weekly') return diffHrs >= 167;
  return true;
};

// Run every hour — fetch LinkedIn jobs for Pro users who have alerts configured
const startScheduler = () => {
  cron.schedule('0 * * * *', async () => {
    logger.info('LinkedIn alert scheduler started');

    try {
      // Find all pro/team users with target role set and alerts enabled (or default)
      const users = await User.find({
        plan:   { $in: ['pro', 'team'] },
        status: 'active',
        'profile.targetRole': { $exists: true, $ne: '' },
        $or: [
          { 'linkedinAlerts.enabled': true },
          { 'linkedinAlerts.enabled': { $exists: false } },
        ],
      }).lean();

      logger.info(`Processing LinkedIn alerts for ${users.length} Pro users`);

      for (const user of users) {
        try {
          if (shouldSendAlert(user)) {
            await fetchAndSaveForUser(user);
          }
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

  // Send email digest notification
  try {
    const name = user.profile?.firstName || 'there';
    const { subject, html } = templates.jobAlert(
      name,
      jobDocs.map((j, i) => ({ ...j, matchScore: scored[i]?.matchScore || 0 })),
      role,
      process.env.CLIENT_URL || 'https://jobhunter-ti0b.onrender.com'
    );
    await sendEmail({ to: user.email, subject, html });

    // Update lastSentAt
    await User.findByIdAndUpdate(user._id, { 'linkedinAlerts.lastSentAt': new Date() });
    logger.info(`Job alert email sent to ${user.email}: ${jobDocs.length} jobs`);
  } catch (emailErr) {
    logger.warn(`Job alert email failed for ${user.email}: ${emailErr.message}`);
  }
};

module.exports = { startScheduler, fetchAndSaveForUser };