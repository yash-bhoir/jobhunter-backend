const JobRankingEvent = require('../../models/JobRankingEvent');
const JobSearch       = require('../../models/JobSearch');

/** Client-postable types (server also logs `impression` separately). */
const RANKING_EVENT_TYPES_CLIENT = [
  'click', 'save', 'unsave', 'hide', 'apply', 'open_detail', 'email_click',
];

function normalizeMeta(meta) {
  return meta && typeof meta === 'object' ? { ...meta } : {};
}

/**
 * @param {{ userId: import('mongoose').Types.ObjectId, job: object, type: string, meta?: object }} p
 */
async function recordClientEventForJob({ userId, job, type, meta = {} }) {
  if (!RANKING_EVENT_TYPES_CLIENT.includes(type)) {
    const { ValidationError } = require('../../utils/errors');
    throw new ValidationError(`Invalid type. Allowed: ${RANKING_EVENT_TYPES_CLIENT.join(', ')}`);
  }

  let clusterHash = null;
  if (job.searchId) {
    const s = await JobSearch.findById(job.searchId).select('searchHash').lean();
    clusterHash = s?.searchHash || null;
  }

  await JobRankingEvent.create({
    userId,
    searchId:           job.searchId || null,
    clusterHash,
    jobId:              job._id,
    linkedinJobId:      null,
    contentFingerprint: job.contentFingerprint || null,
    eventType:          type,
    matchScore:         job.matchScore ?? null,
    jobSource:          job.source || '',
    meta:               normalizeMeta(meta),
  });
}

/**
 * @param {{ userId: import('mongoose').Types.ObjectId, linkedInJob: object, type: string, meta?: object }} p
 */
async function recordClientEventForLinkedInJob({ userId, linkedInJob, type, meta = {} }) {
  if (!RANKING_EVENT_TYPES_CLIENT.includes(type)) {
    const { ValidationError } = require('../../utils/errors');
    throw new ValidationError(`Invalid type. Allowed: ${RANKING_EVENT_TYPES_CLIENT.join(', ')}`);
  }

  await JobRankingEvent.create({
    userId,
    searchId:           null,
    clusterHash:        null,
    jobId:              null,
    linkedinJobId:      linkedInJob._id,
    contentFingerprint: null,
    eventType:          type,
    matchScore:         linkedInJob.matchScore ?? null,
    jobSource:          linkedInJob.source || 'linkedin',
    meta:               normalizeMeta(meta),
  });
}

module.exports = {
  RANKING_EVENT_TYPES_CLIENT,
  recordClientEventForJob,
  recordClientEventForLinkedInJob,
};
