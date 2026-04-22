const Job              = require('../../models/Job');
const JobRankingEvent  = require('../../models/JobRankingEvent');
const { computeContentFingerprint } = require('../jobSearch/jobFingerprint.util');
const logger           = require('../../config/logger');

/**
 * Log one impression row per job shown on the search results surface.
 */
async function recordSearchImpressions({ userId, searchId, clusterHash, displayJobs }) {
  if (!userId || !searchId || !displayJobs?.length) return;

  const fps = displayJobs.map((j) => j.contentFingerprint || computeContentFingerprint(j));

  const jobs = await Job.find({
    userId,
    searchId,
    contentFingerprint: { $in: fps },
  })
    .select('_id contentFingerprint matchScore source')
    .lean();

  const idByFp = {};
  for (const j of jobs) {
    if (j.contentFingerprint) idByFp[j.contentFingerprint] = j._id;
  }

  const docs = displayJobs.map((j, position) => {
    const fp = j.contentFingerprint || computeContentFingerprint(j);
    return {
      userId,
      searchId,
      clusterHash: clusterHash || null,
      jobId:       idByFp[fp] || null,
      contentFingerprint: fp,
      eventType:   'impression',
      position,
      matchScore:  j.matchScore ?? null,
      jobSource:   j.source || '',
      meta:        { surface: 'search_run' },
    };
  });

  try {
    await JobRankingEvent.insertMany(docs, { ordered: false });
  } catch (err) {
    logger.warn(`[rankingFeedback] impression insert: ${err.message}`);
  }
}

module.exports = { recordSearchImpressions };
