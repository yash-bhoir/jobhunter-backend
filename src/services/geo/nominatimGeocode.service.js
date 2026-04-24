const crypto = require('crypto');
const axios  = require('axios');
const GeocodeCache = require('../../models/GeocodeCache');
const logger   = require('../../config/logger');

const UA = process.env.NOMINATIM_USER_AGENT || 'JobHunter/1.0 (https://example.com; contact@jobhunter.app)';

let lastCallAt = 0;
const MIN_INTERVAL_MS = Math.max(1100, parseInt(process.env.NOMINATIM_MIN_INTERVAL_MS || '1100', 10) || 1100);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function throttle() {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function normalizeQuery(q) {
  return String(q || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cacheKey(norm) {
  return crypto.createHash('sha256').update(`nom|${norm}`).digest('hex');
}

/**
 * Forward geocode. Returns { lat, lng, confidence, displayName } or null.
 */
async function forwardGeocode(locationText, countryHint) {
  const base = normalizeQuery(locationText);
  if (!base) return null;

  const q = countryHint
    ? `${locationText}, ${countryHint}`
    : locationText;
  const norm = normalizeQuery(q);
  const key  = cacheKey(norm);

  const cached = await GeocodeCache.findOne({ key }).lean();
  if (cached) {
    await GeocodeCache.updateOne({ key }, { $inc: { hitCount: 1 } }).catch(() => {});
    return {
      lat:         cached.lat,
      lng:         cached.lng,
      confidence:  cached.confidence,
      displayName: cached.displayName || locationText,
    };
  }

  await throttle();

  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        format:         'json',
        q,
        limit:          1,
        addressdetails: 1,
      },
      headers: {
        'User-Agent': UA,
        'Accept':       'application/json',
      },
      timeout: 10000,
    });

    const hit = Array.isArray(data) && data[0];
    if (!hit || !hit.lat || !hit.lon) return null;

    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const addr = hit.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || '';
    const conf = (hit.type === 'city' || hit.type === 'administrative' || hit.class === 'place')
      ? 'high'
      : 'medium';

    const displayName = hit.display_name || locationText;

    await GeocodeCache.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          queryNorm:   norm,
          lat,
          lng,
          confidence:  conf,
          provider:    'nominatim',
          displayName,
          hitCount:    1,
        },
      },
      { upsert: true }
    ).catch(() => {});

    return { lat, lng, confidence: conf, displayName };
  } catch (e) {
    logger.warn(`[nominatim] forwardGeocode failed: ${e.message}`);
    return null;
  }
}

module.exports = { forwardGeocode, normalizeQuery, cacheKey };
