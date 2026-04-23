/**
 * Daily career page scanner.
 *
 * Flow:
 *  1. Scan all 80+ company career pages via Greenhouse / Ashby / Lever APIs
 *  2. For each Pro/Team user with a target role, filter matching jobs
 *  3. Deduplicate against already-saved jobs
 *  4. Score using existing scorer
 *  5. Save to LinkedInJob collection (source: career_page)
 *  6. Send email digest notification
 */

const cron         = require('node-cron');
const User         = require('../../models/User');
const LinkedInJob  = require('../../models/LinkedInJob');
const { scanAllPortals, matchJobsForUser } = require('./index');
const { fetchJobsForBoard } = require('./boardProbe.service');
const { score }    = require('../jobSearch/scorer');
const { sendEmail, templates } = require('../../config/mailer');
const logger       = require('../../config/logger');

// Cache portal scan results for 24h so every user doesn't trigger a full re-scan
let cachedScan     = null;
let cacheExpiresAt = 0;

const getPortalJobs = async () => {
  if (cachedScan && Date.now() < cacheExpiresAt) return cachedScan;
  const jobs     = await scanAllPortals();
  cachedScan     = jobs;
  cacheExpiresAt = Date.now() + 23 * 60 * 60 * 1000;  // 23h cache
  return jobs;
};

const runDailyCareerScan = async () => {
  logger.info('Career page scanner started');

  try {
    const allJobs = await getPortalJobs();
    if (allJobs.length === 0) {
      logger.warn('Career scanner: no jobs fetched from any portal');
      return;
    }

    // Get all Pro/Team users with a target role
    const users = await User.find({
      plan:   { $in: ['pro', 'team'] },
      status: 'active',
      'profile.targetRole': { $exists: true, $ne: '' },
      $or: [
        { 'linkedinAlerts.enabled': true },
        { 'linkedinAlerts.enabled': { $exists: false } },
      ],
    }).lean();

    logger.info(`Career scanner: processing ${users.length} users against ${allJobs.length} portal jobs`);

    for (const user of users) {
      try {
        await processUserCareerJobs(user, allJobs);
        await new Promise(r => setTimeout(r, 500)); // gentle rate-limit
      } catch (err) {
        logger.warn(`Career scan failed for ${user.email}: ${err.message}`);
      }
    }

  } catch (err) {
    logger.error(`Career scanner fatal: ${err.message}`);
  }
};

const processUserCareerJobs = async (user, allJobs) => {
  const matched = matchJobsForUser(allJobs, user);
  if (matched.length === 0) return;

  // Dedup against existing career-page jobs
  const existing    = await LinkedInJob.find({
    userId: user._id,
    source: 'career_page',
  }).select('url').lean();
  const existingSet = new Set(existing.map(j => j.url).filter(Boolean));

  const newJobs = matched.filter(j => !j.url || !existingSet.has(j.url));
  if (newJobs.length === 0) return;

  // Score
  const scored = score(newJobs, user);

  // Save
  const jobDocs = scored.map(j => ({
    userId:     user._id,
    title:      j.title,
    company:    j.company,
    location:   j.location,
    url:        j.url,
    description: j.description,
    postedAt:   j.postedAt,
    remote:     j.remote,
    source:     'career_page',
    matchScore: j.matchScore || 0,
    status:     'new',
  }));

  await LinkedInJob.insertMany(jobDocs, { ordered: false }).catch(() => {});

  logger.info(`Career scan: saved ${jobDocs.length} new jobs for ${user.email}`);

  // Email digest (only if alerts are enabled + frequency allows)
  const freq     = user.linkedinAlerts?.frequency || 'daily';
  const lastSent = user.linkedinAlerts?.lastSentAt;
  const diffHrs  = lastSent ? (Date.now() - new Date(lastSent).getTime()) / 36e5 : Infinity;
  const canSend  = freq === 'hourly' ? diffHrs >= 1
                 : freq === 'weekly' ? diffHrs >= 167
                 : diffHrs >= 23;

  if (canSend) {
    try {
      const name   = user.profile?.firstName || 'there';
      const role   = user.profile?.targetRole || user.profile?.currentRole || 'your role';
      const { subject, html } = templates.jobAlert(
        name,
        jobDocs.map((j, i) => ({ ...j, matchScore: scored[i]?.matchScore || 0 })),
        role,
        process.env.CLIENT_URL || 'https://jobhunter-ti0b.onrender.com'
      );
      await sendEmail({ to: user.email, subject, html });
      await User.findByIdAndUpdate(user._id, { 'linkedinAlerts.lastSentAt': new Date() });
      logger.info(`Career alert email sent to ${user.email}: ${jobDocs.length} jobs`);
    } catch (emailErr) {
      logger.warn(`Career alert email failed for ${user.email}: ${emailErr.message}`);
    }
  }
};

// ── Dream company watches (any opening on selected boards) ────────
const processDreamCompanyJobs = async (user, allJobs) => {
  const watches = user.dreamCompanyWatches || [];
  if (!watches.length) return;

  const keySet = new Set(watches.map((w) => `${w.platform}:${w.slug}`));
  const globalKeys = new Set((allJobs || []).map((j) => j.boardKey).filter(Boolean));
  let pool = [...(allJobs || [])];

  for (const w of watches) {
    const k = `${w.platform}:${w.slug}`;
    if (!globalKeys.has(k)) {
      try {
        const extra = await fetchJobsForBoard(w.platform, w.slug, w.name);
        if (Array.isArray(extra) && extra.length) pool.push(...extra);
      } catch (err) {
        logger.warn(`Dream watch fetch ${k}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  const matched = pool.filter((j) => j.boardKey && keySet.has(j.boardKey));
  if (!matched.length) return;

  const existing = await LinkedInJob.find({ userId: user._id }).select('url').lean();
  const urlSet   = new Set(existing.map((j) => j.url).filter(Boolean));
  const newJobs  = matched.filter((j) => j.url && !urlSet.has(j.url));
  if (!newJobs.length) return;

  const jobDocs = newJobs.map((j) => ({
    userId:      user._id,
    title:       j.title,
    company:     j.company,
    location:    j.location,
    url:         j.url,
    description: j.description,
    postedAt:    j.postedAt,
    remote:      j.remote,
    source:      'dream_company',
    matchScore:  0,
    status:      'new',
  }));

  await LinkedInJob.insertMany(jobDocs, { ordered: false }).catch(() => {});
  logger.info(`Dream company: saved ${jobDocs.length} new jobs for ${user.email}`);

  const last    = user.dreamCompanyLastEmailAt;
  const diffHrs = last ? (Date.now() - new Date(last).getTime()) / 36e5 : Infinity;
  if (diffHrs < 23) return;

  try {
    const name = user.profile?.firstName || 'there';
    const { subject, html } = templates.dreamCompanyAlert(
      name,
      newJobs,
      process.env.CLIENT_URL || 'http://localhost:3000'
    );
    await sendEmail({ to: user.email, subject, html });
    await User.findByIdAndUpdate(user._id, { dreamCompanyLastEmailAt: new Date() });
    logger.info(`Dream company email sent to ${user.email}: ${newJobs.length} jobs`);
  } catch (emailErr) {
    logger.warn(`Dream company email failed for ${user.email}: ${emailErr.message}`);
  }
};

const runDreamCompanyScan = async () => {
  logger.info('Dream company scanner started');
  try {
    const allJobs = await getPortalJobs();
    if (!allJobs.length) {
      logger.warn('Dream company scanner: global portal cache empty — user-specific boards only');
    }

    const users = await User.find({
      status:              'active',
      emailVerified:       true,
      dreamCompanyWatches: { $exists: true, $not: { $size: 0 } },
      $or: [
        { 'linkedinAlerts.enabled': true },
        { 'linkedinAlerts.enabled': { $exists: false } },
      ],
    }).lean();

    logger.info(`Dream company scanner: ${users.length} users with watches`);

    for (const user of users) {
      try {
        await processDreamCompanyJobs(user, allJobs);
        await new Promise((r) => setTimeout(r, 400));
      } catch (err) {
        logger.warn(`Dream company scan failed for ${user.email}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`Dream company scanner fatal: ${err.message}`);
  }
};

const startCareerScanner = () => {
  cron.schedule('0 8 * * *', async () => {
    await runDailyCareerScan();
    await runDreamCompanyScan();
  });

  logger.info('Career page + dream-company scanners registered (daily 08:00)');
};

module.exports = {
  startCareerScanner,
  runDailyCareerScan,
  runDreamCompanyScan,
  getPortalJobs,
};
