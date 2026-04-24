const Job = require('../../models/Job');
const { buildTitleFilter } = require('../../utils/geoJobQuery.util');

const EARTH_KM = 6371;

/**
 * Canonical user jobs within radius (uses Job.geo 2dsphere).
 */
async function findStoredJobsInRadius(userId, lat, lng, radiusKm, title) {
  const radiusRad = radiusKm / EARTH_KM;
  const q = {
    userId,
    expired: { $ne: true },
    geo: {
      $geoWithin: {
        $centerSphere: [[lng, lat], radiusRad],
      },
    },
  };
  const tf = title?.trim() ? buildTitleFilter(title.trim()) : null;
  if (tf) q.title = tf;

  return Job.find(q)
    .sort({ matchScore: -1, createdAt: -1 })
    .limit(800)
    .lean();
}

/**
 * Normalize Job → map marker shape (same as GeoJob for frontend).
 */
function normalizeStoredJobForMap(job) {
  const coords = job.geo?.coordinates;
  if (!coords || coords.length < 2 || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    return null;
  }
  const jobType =
    job.workMode === 'remote' || job.remote ? 'remote'
      : job.workMode === 'hybrid' ? 'hybrid'
        : 'full-time';

  return {
    _id:             String(job._id),
    title:           job.title,
    company:         job.company || '',
    externalId:      job.externalId || null,
    geoSource:       job.geoSource || null,
    location:        {
      type:        'Point',
      coordinates: coords,
      address:     job.location || '',
    },
    salary:          job.salaryMin || undefined,
    salaryDisplay:   job.salary || '',
    description:     (job.description || '').slice(0, 600),
    jobType,
    applyUrl:        job.url || '',
    tags:            [],
    source:          job.source || 'stored',
    postedAt:        job.postedAt || job.createdAt,
    matchScore:      job.matchScore,
    status:          job.status,
    geoConfidence:   job.geoConfidence,
    workMode:        job.workMode,
    _canonicalMapJob: true,
  };
}

/**
 * Stored jobs whose real coordinates fall inside the search radius (remote + onsite).
 */
async function buildStoredMapJobs(userId, lat, lng, radiusKm, title) {
  const storedRaw = await findStoredJobsInRadius(userId, lat, lng, radiusKm, title);
  const storedNorm = storedRaw.map(normalizeStoredJobForMap).filter(Boolean).slice(0, 800);
  return { storedNorm };
}

function mergeStoredWithLive(storedNorm, liveJobs) {
  const extSet = new Set(storedNorm.map(s => s.externalId).filter(Boolean));
  const rest = liveJobs.filter(l => !l.externalId || !extSet.has(l.externalId));
  return [...storedNorm, ...rest].slice(0, 800);
}

module.exports = {
  findStoredJobsInRadius,
  normalizeStoredJobForMap,
  mergeStoredWithLive,
  buildStoredMapJobs,
};
