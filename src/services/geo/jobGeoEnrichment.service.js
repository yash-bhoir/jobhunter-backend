const Job = require('../../models/Job');
const logger = require('../../config/logger');
const { forwardGeocode } = require('./nominatimGeocode.service');

function deriveWorkMode(job) {
  if (job.remote) return 'remote';
  const t = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  if (t.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function stableJitter01(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  return (Math.abs(h) % 10000) / 10000;
}

/**
 * Remote / unknown-location jobs: place near search centre for map UX (low confidence).
 */
function approximateCoordsForRemote(job, centerLat, centerLng) {
  const seed = String(job._id);
  const j1 = stableJitter01(seed + 'a') - 0.5;
  const j2 = stableJitter01(seed + 'b') - 0.5;
  const d = 0.04;
  return {
    lat: centerLat + j1 * d,
    lng: centerLng + j2 * d,
    confidence: 'low',
    source:       'remote_viewport',
  };
}

/**
 * Set GeoJSON `geo` on a job from location text or existing geoLocation.
 */
async function enrichOneJob(jobId, opts = {}) {
  const { centerLat, centerLng } = opts;
  const job = await Job.findById(jobId).lean();
  if (!job) return { ok: false, reason: 'not_found' };

  if (job.geo?.coordinates?.length === 2 &&
      Number.isFinite(job.geo.coordinates[0]) &&
      Number.isFinite(job.geo.coordinates[1])) {
    return { ok: true, reason: 'already_set' };
  }

  const workMode = deriveWorkMode(job);

  if (job.geoLocation?.lat != null && job.geoLocation?.lng != null) {
    const lat = job.geoLocation.lat;
    const lng = job.geoLocation.lng;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      await Job.updateOne(
        { _id: jobId },
        {
          $set: {
            geo:            { type: 'Point', coordinates: [lng, lat] },
            geoConfidence:  'medium',
            geoSource:      'ingest_legacy',
            workMode,
            geoEnrichedAt:  new Date(),
          },
        }
      );
      return { ok: true, reason: 'geoLocation' };
    }
  }

  if (workMode === 'remote' && (!job.location || !String(job.location).trim())) {
    if (centerLat != null && centerLng != null) {
      const { lat, lng, confidence, source } = approximateCoordsForRemote(job, centerLat, centerLng);
      await Job.updateOne(
        { _id: jobId },
        {
          $set: {
            geo:           { type: 'Point', coordinates: [lng, lat] },
            geoConfidence: confidence,
            geoSource:     source,
            workMode,
            geoEnrichedAt: new Date(),
          },
        }
      );
      return { ok: true, reason: 'remote_approx' };
    }
    await Job.updateOne(
      { _id: jobId },
      { $set: { workMode, geoConfidence: 'low', geoSource: 'none', geoEnrichedAt: new Date() } }
    );
    return { ok: false, reason: 'remote_no_center' };
  }

  const loc = String(job.location || '').trim();
  if (!loc) {
    await Job.updateOne(
      { _id: jobId },
      { $set: { workMode, geoConfidence: 'low', geoSource: 'none', geoEnrichedAt: new Date() } }
    );
    return { ok: false, reason: 'no_location' };
  }

  const geo = await forwardGeocode(loc, null);
  if (!geo) {
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          workMode,
          geoConfidence: 'low',
          geoSource:     'nominatim_miss',
          geoEnrichedAt: new Date(),
        },
        $inc: { geoAttempts: 1 },
      }
    );
    return { ok: false, reason: 'geocode_miss' };
  }

  await Job.updateOne(
    { _id: jobId },
    {
      $set: {
        geo:            { type: 'Point', coordinates: [geo.lng, geo.lat] },
        geoConfidence:  geo.confidence,
        geoSource:      'nominatim',
        workMode,
        geoEnrichedAt:  new Date(),
        geoLocation:    { lat: geo.lat, lng: geo.lng },
      },
      $inc: { geoAttempts: 1 },
    }
  );
  return { ok: true, reason: 'nominatim' };
}

/**
 * Fire-and-forget batch after job ingest (non-blocking for search response).
 */
function scheduleGeoEnrichment(jobIds, opts = {}) {
  if (!jobIds?.length) return;
  setImmediate(async () => {
    for (const id of jobIds) {
      try {
        await enrichOneJob(id, opts);
      } catch (e) {
        logger.warn(`[geoEnrich] job ${id}: ${e.message}`);
      }
    }
  });
}

/**
 * Manual backfill: oldest jobs missing geo first.
 */
async function enrichBatchForUser(userId, limit = 40, opts = {}) {
  const { centerLat, centerLng } = opts;
  const enrichOpts =
    centerLat != null && centerLng != null && Number.isFinite(centerLat) && Number.isFinite(centerLng)
      ? { centerLat, centerLng }
      : {};

  const ids = await Job.find({
    userId,
    expired:     { $ne: true },
    geoAttempts: { $lt: 3 },
    $or: [
      { geo: { $exists: false } },
      { geo: null },
      { 'geo.coordinates': { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

  let ok = 0;
  for (const row of ids) {
    const r = await enrichOneJob(row._id, enrichOpts);
    if (r.ok) ok++;
  }
  return { processed: ids.length, enriched: ok };
}

module.exports = {
  enrichOneJob,
  scheduleGeoEnrichment,
  enrichBatchForUser,
  deriveWorkMode,
};
