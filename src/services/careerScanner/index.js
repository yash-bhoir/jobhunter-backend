const { GREENHOUSE, ASHBY, LEVER } = require('./portals');
const { fetchGreenhouse } = require('./greenhouse');
const { fetchAshby }      = require('./ashby');
const { fetchLever }      = require('./lever');
const logger              = require('../../config/logger');

/**
 * Scan all portals in parallel (up to concurrencyLimit at a time).
 * Returns a flat array of normalised job objects.
 */
const scanAllPortals = async (concurrencyLimit = 8) => {
  const tasks = [
    ...GREENHOUSE.map(c => () => fetchGreenhouse(c)),
    ...ASHBY.map(c      => () => fetchAshby(c)),
    ...LEVER.map(c      => () => fetchLever(c)),
  ];

  const results = [];
  for (let i = 0; i < tasks.length; i += concurrencyLimit) {
    const batch = tasks.slice(i, i + concurrencyLimit).map(fn => fn());
    const settled = await Promise.allSettled(batch);
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(...r.value);
    }
  }

  logger.info(`Career scanner: fetched ${results.length} jobs from ${tasks.length} companies`);
  return results;
};

/**
 * Match a flat job list against a user's target role / skills / location.
 * Returns only jobs that are a reasonable match.
 *
 * Scoring (simple keyword pass — scorer.js handles deep scoring later):
 *   - Title contains a word from the target role → included
 *   - Any of the user's skills appear in title or description → bonus weight
 */
const matchJobsForUser = (jobs, user) => {
  const role      = (user.profile?.targetRole || user.profile?.currentRole || '').toLowerCase();
  const skills    = (user.profile?.skills || []).map(s => s.toLowerCase());
  const locations = (user.profile?.preferredLocations || []).map(l => l.toLowerCase());
  const workType  = user.profile?.workType || 'any';

  if (!role) return [];

  const roleWords = role.split(/[\s,/]+/).filter(w => w.length > 2);

  return jobs.filter(job => {
    const titleLower = job.title.toLowerCase();
    const descLower  = (job.description || '').toLowerCase().slice(0, 2000);

    // Must match at least one role keyword in the title
    const roleMatch = roleWords.some(w => titleLower.includes(w));
    if (!roleMatch) return false;

    // Work-type filter
    if (workType === 'remote' && !job.remote) return false;

    // Location filter — skip only if user has specific locations AND job doesn't match AND not remote
    if (locations.length > 0 && !job.remote) {
      const jobLoc  = job.location.toLowerCase();
      const locMatch = locations.some(l => jobLoc.includes(l) || l.includes(jobLoc.split(',')[0]));
      if (!locMatch) return false;
    }

    return true;
  });
};

module.exports = { scanAllPortals, matchJobsForUser };
