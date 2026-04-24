const axios  = require('axios');
const GeoJob = require('../models/GeoJob');
const Job    = require('../models/Job');
const { buildTitleFilter } = require('../utils/geoJobQuery.util');
const {
  buildStoredMapJobs,
  mergeStoredWithLive,
} = require('../services/geo/storedGeoJobs.service');
const { enrichOneJob, enrichBatchForUser } = require('../services/geo/jobGeoEnrichment.service');
const { score } = require('../services/jobSearch/scorer');
const { success } = require('../utils/response.util');
const logger = require('../config/logger');

// ── Helpers ────────────────────────────────────────────────────────

// Reverse geocode lat/lng → { city, state, countryCode } via Nominatim (free, no key)
async function reverseGeocode(lat, lng) {
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { format: 'json', lat, lon: lng },
      headers: { 'User-Agent': 'JobHunterApp/1.0 (contact@jobhunter.app)' },
      timeout: 6000,
    });
    const addr = data?.address || {};
    const city =
      addr.city || addr.town || addr.village || addr.municipality || addr.county || addr.state || '';
    const state = addr.state || addr.region || '';
    const countryCode = (addr.country_code || 'in').toLowerCase().slice(0, 2);
    return { city, state, countryCode };
  } catch {
    return { city: '', state: '', countryCode: 'in' };
  }
}

/** Normalized map-centre city → substrings that often appear on local job addresses (no broad state-only tokens). */
const METRO_ADDRESS_ALIASES = {
  mumbai: [
    'mumbai', 'bombay', 'thane', 'navi mumbai', 'bkc', 'andheri', 'powai', 'bandra',
    'kurla', 'vikroli', 'vikhroli', 'mira bhayandar', 'mira-bhayandar', 'vasai', 'virar',
    'kalyan', 'dombivli', 'panvel', 'borivali', 'dadar', 'worli', 'malad', 'chembur',
  ],
  bengaluru: ['bengaluru', 'bangalore', 'electronic city', 'whitefield', 'koramangala'],
  bangalore: ['bengaluru', 'bangalore', 'electronic city', 'whitefield', 'koramangala'],
  delhi: ['delhi', 'new delhi', 'ncr', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad'],
  hyderabad: ['hyderabad', 'cyberabad', 'hitech city', 'gachibowli', 'secunderabad'],
  chennai: ['chennai', 'ambattur', 'tambaram', 'omr', 'guindy'],
  pune: [
    'pune', 'hinjewadi', 'wakad', 'kharadi', 'viman nagar', 'hadapsar', 'pimpri', 'chinchwad',
    'pcmc', 'aundh', 'baner', 'kothrud', 'magarpatta', 'bibvewadi', 'bavdhan', 'warje',
    'undri', 'wagholi', 'lohegaon', 'yerwada', 'kalyani nagar', 'koregaon park',
  ],
  kolkata: ['kolkata', 'calcutta', 'salt lake', 'howrah'],
  ahmedabad: ['ahmedabad', 'gandhinagar', 'sg highway'],
};

function metroTokensForHint(hint) {
  const c = String(hint.city || '').toLowerCase().trim();
  if (!c) return null;
  if (METRO_ADDRESS_ALIASES[c]) return METRO_ADDRESS_ALIASES[c];
  const norm = c.replace(/\s+/g, '');
  if (METRO_ADDRESS_ALIASES[norm]) return METRO_ADDRESS_ALIASES[norm];
  for (const key of Object.keys(METRO_ADDRESS_ALIASES)) {
    if (c.includes(key) || key.includes(c)) return METRO_ADDRESS_ALIASES[key];
  }
  return null;
}

// Return a valid coord number, or null if unusable (0, NaN, Infinity, out-of-range).
function parseCoord(v) {
  const n = parseFloat(v);
  return (Number.isFinite(n) && n !== 0) ? n : null;
}

/** Great-circle distance in km (for filtering API jobs whose real coords are far from the map centre). */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Regex + centroid for Indian cities named in addresses (pin vs text mismatch). */
const INDIAN_CITY_GEO_HINTS = [
  { re: /\bbengaluru\b|\bbangalore\b/i, lat: 12.9716, lng: 77.5946 },
  { re: /\bhyderabad\b|\bhitech city\b|\bgachibowli\b/i, lat: 17.3850, lng: 78.4867 },
  { re: /\bsecunderabad\b/i, lat: 17.4399, lng: 78.4983 },
  { re: /\bchennai\b|\bambattur\b|\btambaram\b/i, lat: 13.0827, lng: 80.2707 },
  { re: /\bmumbai\b|\bbombay\b|\bthane\b|\bnavi mumbai\b/i, lat: 19.0760, lng: 72.8777 },
  { re: /\bpune\b|\bhinjewadi\b|\bwakad\b|\bkharadi\b/i, lat: 18.5204, lng: 73.8567 },
  { re: /\bnoida\b/i, lat: 28.5355, lng: 77.3910 },
  { re: /\bgurgaon\b|\bgurugram\b/i, lat: 28.4595, lng: 77.0266 },
  { re: /\bnew delhi\b|\bdelhi\b/i, lat: 28.6139, lng: 77.2090 },
  { re: /\bkolkata\b|\bcalcutta\b/i, lat: 22.5726, lng: 88.3639 },
  { re: /\bahmedabad\b/i, lat: 23.0225, lng: 72.5714 },
  { re: /\bjaipur\b/i, lat: 26.9124, lng: 75.7873 },
  { re: /\bkochi\b|\bcochin\b/i, lat: 9.9312, lng: 76.2673 },
];

function mapOptsHasCenter(opts) {
  if (!opts || typeof opts !== 'object') return false;
  const { centerLat, centerLng, radiusKm } = opts;
  return Number.isFinite(centerLat) && Number.isFinite(centerLng) && Number.isFinite(radiusKm) && radiusKm > 0;
}

function jobPinCoords(job) {
  const c = job.location?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return { jobLat: null, jobLng: null };
  const jobLng = c[0];
  const jobLat = c[1];
  if (!Number.isFinite(jobLat) || !Number.isFinite(jobLng)) return { jobLat: null, jobLng: null };
  return { jobLat, jobLng };
}

/** Reverse-geocode centre is clearly Mumbai / Maharashtra (not match % — text from map pin). */
function hintIsMumbaiMaharashtra(hint) {
  const s = String(hint.state || '').toLowerCase();
  if (s.includes('maharashtra')) return true;
  const c = String(hint.city || '').toLowerCase();
  if (c.includes('mumbai') || c.includes('thane') || c.includes('navi')) return true;
  const m = METRO_ADDRESS_ALIASES.mumbai;
  return !!(m && m.some((t) => t.length >= 3 && c.includes(t)));
}

function hintIsBangaloreKarnataka(hint) {
  const s = String(hint.state || '').toLowerCase();
  if (s.includes('karnataka')) return true;
  const c = String(hint.city || '').toLowerCase();
  if (c.includes('bangalore') || c.includes('bengaluru')) return true;
  const b = METRO_ADDRESS_ALIASES.bengaluru || METRO_ADDRESS_ALIASES.bangalore;
  return !!(b && b.some((t) => t.length >= 4 && c.includes(t)));
}

/**
 * Address text names Karnataka / Bangalore without also naming a Maharashtra anchor
 * (blocks “Bangalore role” rows that were pinned near Mumbai because APIs omitted coords).
 */
function addrClearlyKarnatakaOrBangalore(addrLower) {
  const ka = /\bkarnataka\b/.test(addrLower);
  const blr = /\b(bangalore|bengaluru)\b/i.test(addrLower);
  if (!ka && !blr) return false;
  const mhAnchor = /\b(mumbai|bombay|maharashtra|thane|navi\s*mumbai|andheri|bandra|powai|bkc)\b/i.test(addrLower);
  return !mhAnchor;
}

/** Mumbai-area search but address is only Karnataka / Bangalore — wrong region. */
function addrClearlyMaharashtraMumbaiOnly(addrLower) {
  const mh = /\bmaharashtra\b/.test(addrLower);
  const mu = /\b(mumbai|bombay|thane|navi\s*mumbai)\b/i.test(addrLower);
  if (!mh && !mu) return false;
  const kaAnchor = /\b(karnataka|bangalore|bengaluru|mysuru|mysore)\b/i.test(addrLower);
  return !kaAnchor;
}

/**
 * Address names a major city far from the map centre while the pin sits near the centre
 * (typical when APIs lack coords and we jitter around the viewport).
 */
function addressCentroidConflictsWithPins(centerLat, centerLng, radiusKm, addrLower, jobLat, jobLng) {
  if (!mapOptsHasCenter({ centerLat, centerLng, radiusKm }) || jobLat == null || jobLng == null) {
    return false;
  }
  const r = Math.max(1, radiusKm);
  const dJob = haversineKm(jobLat, jobLng, centerLat, centerLng);
  if (dJob > r * 1.35 + 18) return false;

  for (const { re, lat, lng } of INDIAN_CITY_GEO_HINTS) {
    if (!re.test(addrLower)) continue;
    const dCityFromCenter = haversineKm(lat, lng, centerLat, centerLng);
    if (dCityFromCenter > r + 55) return true;
  }
  return false;
}

/**
 * Jobs are geo-placed inside the radius (sometimes jittered). Address text can still name
 * another city (e.g. Bangalore listings on a Mumbai map). Keep rows whose address matches
 * the search centre's state/city/metro, or has no usable address (trust coordinates only).
 *
 * When reverse-geocode hint is empty (weak), do **not** allow every addressed job: require
 * pin within radius and no address-vs-centroid conflict.
 *
 * @param {{ centerLat?: number, centerLng?: number, radiusKm?: number }} mapOpts
 */
function jobMatchesSearchArea(job, hint, mapOpts = {}) {
  const { centerLat, centerLng, radiusKm } = mapOpts;
  const { jobLat, jobLng } = jobPinCoords(job);

  const raw = job.location?.address;
  if (!raw || typeof raw !== 'string' || !String(raw).trim()) return true;

  const addr = String(raw).toLowerCase();
  if (mapOptsHasCenter(mapOpts) && jobLat != null && addressCentroidConflictsWithPins(
    centerLat, centerLng, radiusKm, addr, jobLat, jobLng
  )) {
    return false;
  }

  const city = String(hint.city || '').toLowerCase().trim();
  const state = String(hint.state || '').toLowerCase().trim();
  const cc = String(hint.countryCode || '').toLowerCase().slice(0, 2);

  if (cc === 'in') {
    if (/\b(united states|u\.s\.a?\.?|usa|united kingdom|u\.k\.|canada|australia|germany|france)\b/i.test(addr)) {
      return addr.includes('india');
    }
    if (hintIsMumbaiMaharashtra(hint) && addrClearlyKarnatakaOrBangalore(addr)) return false;
    if (hintIsBangaloreKarnataka(hint) && addrClearlyMaharashtraMumbaiOnly(addr)) return false;
  }

  if (state.length >= 2 && addr.includes(state)) return true;
  if (city.length >= 2 && addr.includes(city)) return true;

  const metro = metroTokensForHint(hint);
  if (metro && metro.some((t) => addr.includes(t))) return true;

  if (state.length >= 2) return false;
  if (city.length >= 2) return false;

  // Weak / empty hint: require pin within radius (reverse geocode failed or returned nothing).
  if (!mapOptsHasCenter(mapOpts) || jobLat == null) return false;
  const d = haversineKm(jobLat, jobLng, centerLat, centerLng);
  return d <= radiusKm * 1.22 + 12;
}

// Deterministic jitter — produces a value in [-range, +range].
// Uses Knuth multiplicative hash + avalanche mixing for good spread
// even when seeds differ only in the last character (sequential IDs).
function jitterCoord(seed, range) {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // avalanche pass so high/low bits mix well
  h ^= h >>> 16;
  h  = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (((h >>> 0) / 0xffffffff) - 0.5) * 2 * range;
}

/** Flatten GeoJSON / string location + remote flags for the shared job scorer. */
function normalizeMapJobForScorer(job) {
  const loc = job.location;
  const address = typeof loc === 'string'
    ? loc
    : (loc && typeof loc === 'object' ? String(loc.address || '') : '');
  const remote = job.remote === true
    || job.workMode === 'remote'
    || job.jobType === 'remote';
  return { ...job, location: address, remote };
}

// How far (degrees) to spread markers away from their base coordinate.
// 1° ≈ 111 km. Jobs with real city-level coords use a spread that fills
// ~60% of the search radius visually. Jobs without any coord use ~80%.
function spreadRange(radiusKm, hasRealCoord) {
  const factor = hasRealCoord ? 0.006 : 0.008;
  return Math.min(radiusKm * factor, 0.5); // cap at 0.5° ≈ 55 km
}

function adzunaJobType(j) {
  if (j.contract_time === 'part_time') return 'part-time';
  if (j.contract_type === 'contract')  return 'contract';
  const t = (j.title || '').toLowerCase();
  if (t.includes('remote')) return 'remote';
  if (t.includes('hybrid')) return 'hybrid';
  return 'full-time';
}

function jsearchJobType(j) {
  const t = (j.job_employment_type || '').toUpperCase();
  if (t.includes('PART'))     return 'part-time';
  if (t.includes('CONTRACT')) return 'contract';
  if (j.job_is_remote) return 'remote';
  if ((j.job_title || '').toLowerCase().includes('hybrid')) return 'hybrid';
  return 'full-time';
}

// ── API fetchers ───────────────────────────────────────────────────

async function fetchAdzunaGeoJobs(what, where, countryCode, centerLat, centerLng, radiusKm, expiresAt) {
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) return [];

  const { data } = await axios.get(
    `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/1`,
    {
      params: {
        app_id:           process.env.ADZUNA_APP_ID,
        app_key:          process.env.ADZUNA_APP_KEY,
        what:             what || 'developer',
        where:            where || 'India',
        results_per_page: 50,
        sort_by:          'date',
      },
      timeout: 12000,
    }
  );

  return (data?.results || []).map(j => {
    const rawLat = parseCoord(j.latitude);
    const rawLng = parseCoord(j.longitude);
    if (rawLat !== null && rawLng !== null) {
      const d = haversineKm(rawLat, rawLng, centerLat, centerLng);
      if (d > radiusKm * 1.25) return null;
    }
    // Base: real city-level coord (if valid) or search centre
    const baseLat = rawLat ?? centerLat;
    const baseLng = rawLng ?? centerLng;
    // Always jitter — Adzuna returns the same city-centroid for every job in a city,
    // so without jitter all markers stack at a single pixel.
    const range = spreadRange(radiusKm, rawLat !== null);
    const jLat  = baseLat + jitterCoord(`adzuna_${j.id}lat`, range);
    const jLng  = baseLng + jitterCoord(`adzuna_${j.id}lng`, range);

    const salaryMin = j.salary_min ? Math.round(j.salary_min) : null;
    const salaryMax = j.salary_max ? Math.round(j.salary_max) : salaryMin;

    return {
      externalId:    `adzuna_${j.id}`,
      title:         j.title || '',
      company:       j.company?.display_name || '',
      location: {
        type:        'Point',
        coordinates: [jLng, jLat],
        address:     j.location?.display_name || where,
      },
      salary:        salaryMin || undefined,
      salaryDisplay: salaryMin ? `${salaryMin.toLocaleString()}–${(salaryMax || salaryMin).toLocaleString()}` : '',
      description:   (j.description || '').replace(/<[^>]*>/g, '').slice(0, 600),
      jobType:       adzunaJobType(j),
      applyUrl:      j.redirect_url || '',
      tags:          j.category?.tag ? [j.category.tag] : [],
      source:        'Adzuna',
      postedAt:      j.created ? new Date(j.created) : new Date(),
      expiresAt,
    };
  }).filter(Boolean);
}

async function fetchJSearchGeoJobs(what, where, centerLat, centerLng, radiusKm, expiresAt) {
  if (!process.env.RAPIDAPI_KEY) return [];

  const query = where ? `${what || 'developer'} jobs in ${where}` : (what || 'developer jobs');

  const { data } = await axios.get('https://jsearch.p.rapidapi.com/search', {
    params: { query, page: '1', num_pages: '2', date_posted: 'month' },
    headers: {
      'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
    timeout: 14000,
  });

  return (data?.data || []).map(j => {
    const rawLat = parseCoord(j.job_latitude);
    const rawLng = parseCoord(j.job_longitude);
    if (rawLat !== null && rawLng !== null) {
      const d = haversineKm(rawLat, rawLng, centerLat, centerLng);
      if (d > radiusKm * 1.25) return null;
    }
    const baseLat = rawLat ?? centerLat;
    const baseLng = rawLng ?? centerLng;
    const range = spreadRange(radiusKm, rawLat !== null);
    const jLat  = baseLat + jitterCoord(`jsearch_${j.job_id}lat`, range);
    const jLng  = baseLng + jitterCoord(`jsearch_${j.job_id}lng`, range);

    const salaryMin = j.job_min_salary;
    const salaryMax = j.job_max_salary;

    return {
      externalId:    `jsearch_${j.job_id}`,
      title:         j.job_title || '',
      company:       j.employer_name || '',
      location: {
        type:        'Point',
        coordinates: [jLng, jLat],
        address:     [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || where,
      },
      salary:        salaryMin || undefined,
      salaryDisplay: salaryMin ? `${Number(salaryMin).toLocaleString()}–${Number(salaryMax || salaryMin).toLocaleString()}` : '',
      description:   (j.job_description || '').slice(0, 600),
      jobType:       jsearchJobType(j),
      applyUrl:      j.job_apply_link || '',
      tags:          (j.job_required_skills || []).slice(0, 6),
      source:        'JSearch',
      postedAt:      j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : new Date(),
      expiresAt,
    };
  }).filter(Boolean);
}

async function fetchSerpApiGeoJobs(what, where, centerLat, centerLng, radiusKm, expiresAt) {
  if (!process.env.SERPAPI_KEY) return [];

  const q = what ? `${what} jobs in ${where}` : `jobs in ${where}`;

  const { data } = await axios.get('https://serpapi.com/search', {
    params: { engine: 'google_jobs', q, location: where, hl: 'en', api_key: process.env.SERPAPI_KEY },
    timeout: 15000,
  });

  return (data?.jobs_results || []).map(j => {
    const range = spreadRange(radiusKm, false);
    const seed  = `serpapi_${j.job_id || j.title + j.company_name}`;
    const jLat  = centerLat + jitterCoord(seed + 'lat', range);
    const jLng  = centerLng + jitterCoord(seed + 'lng', range);

    const extId = `serpapi_${(j.job_id || Buffer.from((j.title || '') + (j.company_name || '')).toString('base64').slice(0, 16))}`;

    return {
      externalId:    extId,
      title:         j.title         || '',
      company:       j.company_name  || '',
      location: {
        type:        'Point',
        coordinates: [jLng, jLat],
        address:     j.location      || where,
      },
      salary:        undefined,
      salaryDisplay: j.detected_extensions?.salary || '',
      description:   (j.description  || '').slice(0, 600),
      jobType:       j.detected_extensions?.work_from_home ? 'remote' : 'full-time',
      applyUrl:      j.share_link    || j.related_links?.[0]?.link || '',
      tags:          [],
      source:        `Google Jobs`,
      postedAt:      new Date(),
      expiresAt,
    };
  });
}

// Fetch from all APIs and upsert into GeoJob collection (24 h TTL cache)
async function fetchAndCacheRealJobs(lat, lng, titleQuery, radiusKm, geoHint = null) {
  const hint = geoHint || await reverseGeocode(lat, lng);
  const city        = hint.city || '';
  const countryCode = (hint.countryCode || 'in').toLowerCase().slice(0, 2);

  const what  = titleQuery?.trim() || '';
  const where = city;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const [adzunaResult, jsearchResult, serpResult] = await Promise.allSettled([
    fetchAdzunaGeoJobs(what, where, countryCode, lat, lng, radiusKm, expiresAt),
    fetchJSearchGeoJobs(what, where, lat, lng, radiusKm, expiresAt),
    fetchSerpApiGeoJobs(what, where, lat, lng, radiusKm, expiresAt),
  ]);

  const allJobs = [
    ...(adzunaResult.status  === 'fulfilled' ? adzunaResult.value  : []),
    ...(jsearchResult.status === 'fulfilled' ? jsearchResult.value : []),
    ...(serpResult.status    === 'fulfilled' ? serpResult.value    : []),
  ];

  if (allJobs.length === 0) return;

  // Upsert each job — externalId is the dedup key
  await Promise.allSettled(
    allJobs.map(job =>
      GeoJob.findOneAndUpdate(
        { externalId: job.externalId },
        { $set: job },
        { upsert: true }
      )
    )
  );
}

/** Cached map rows must come from configured job APIs with a real apply link (no demo/placeholder). */
const GEOJOB_REAL_LISTING_FILTER = {
  externalId: { $regex: /^(adzuna_|jsearch_|serpapi_)/i },
  applyUrl:   { $exists: true, $nin: [null, '', '#'] },
};

function hasRealApplyUrl(job) {
  const u = String(job.applyUrl || '').trim();
  return u.length > 0 && u !== '#';
}

/**
 * DB-backed rows: trust coordinates when there is no address text; otherwise same region rules as APIs
 * (avoids Bangalore-titled jobs appearing on a Mumbai map when geo was enriched to the viewport).
 */
function passesMapListingFilters(job, geoHint, mapOpts = {}) {
  if (String(job.applyUrl || '').trim() === '#') return false;
  const raw = job.location?.address;
  const hasAddr = !!(raw && String(raw).trim());
  if (job._canonicalMapJob && !hasAddr) return true;
  if (!job._canonicalMapJob && !hasRealApplyUrl(job)) return false;
  return jobMatchesSearchArea(job, geoHint, mapOpts);
}

// GET /geo-jobs/nearby — env tunables:
// GEO_NEARBY_BG_ENRICH_LIMIT (default 25), GEO_NEARBY_LOG_METRICS=1,
// GEO_NEARBY_LIVE_LIMIT (default 250) — max cached API jobs per response,
// GEO_NEARBY_SKIP_LIVE_FETCH=1 — opt out of calling external job APIs (default: always fetch).

// ── GET /api/v1/geo-jobs/nearby ─────────────────────────────────────
const getNearbyJobs = async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { lat, lng, radius = 10, title } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }

    const parsedLat    = parseFloat(lat);
    const parsedLng    = parseFloat(lng);
    const parsedRadius = Math.min(Math.max(parseFloat(radius), 1), 100); // clamp 1–100 km

    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      return res.status(400).json({ success: false, message: 'Invalid lat/lng values' });
    }

    const geoHint = await reverseGeocode(parsedLat, parsedLng);
    const searchAreaLabel = [geoHint.city, geoHint.state].filter(Boolean).join(', ')
      .trim()
      || (geoHint.countryCode ? geoHint.countryCode.toUpperCase() : '');
    const searchCtx = {
      searchRole:     title?.trim() || '',
      searchLocation: [geoHint.city, geoHint.state, geoHint.countryCode].filter(Boolean).join(', ').trim(),
      searchWorkType: 'any',
    };

    const userId       = req.user._id;
    const radiusMeters = parsedRadius * 1000;

    const liveLimit = Math.min(
      500,
      Math.max(50, parseInt(process.env.GEO_NEARBY_LIVE_LIMIT || '250', 10) || 250)
    );

    const bgEnrichLimit = Math.min(
      200,
      Math.max(1, parseInt(process.env.GEO_NEARBY_BG_ENRICH_LIMIT || '25', 10) || 25)
    );

    // Background: remote jobs missing geo → low-confidence coords around this viewport centre.
    setImmediate(async () => {
      try {
        const pending = await Job.find({
          userId,
          remote:      true,
          geoAttempts: { $lt: 3 },
          $or: [
            { geo: { $exists: false } },
            { geo: null },
            { 'geo.coordinates': { $exists: false } },
          ],
        }).limit(bgEnrichLimit).select('_id').lean();
        for (const p of pending) {
          await enrichOneJob(p._id, { centerLat: parsedLat, centerLng: parsedLng }).catch(() => {});
        }
      } catch (_) { /* ignore */ }
    });

    const { storedNorm } = await buildStoredMapJobs(
      userId,
      parsedLat,
      parsedLng,
      parsedRadius,
      title
    );

    const withinQuery = {
      location: {
        $geoWithin: {
          $centerSphere: [[parsedLng, parsedLat], parsedRadius / 6371],
        },
      },
    };

    const baseGeoQuery = {
      location: {
        $near: {
          $geometry:    { type: 'Point', coordinates: [parsedLng, parsedLat] },
          $maxDistance: radiusMeters,
        },
      },
    };

    const skipLiveFetch = process.env.GEO_NEARBY_SKIP_LIVE_FETCH === '1';
    let liveFetchError = null;
    if (!skipLiveFetch) {
      try {
        await fetchAndCacheRealJobs(parsedLat, parsedLng, title, parsedRadius, geoHint);
      } catch (fetchErr) {
        liveFetchError = fetchErr.message;
        logger.warn(`[GeoJobs] fetchAndCacheRealJobs: ${fetchErr.message}`);
      }
    }

    const geoCacheBase = { ...withinQuery, ...GEOJOB_REAL_LISTING_FILTER };
    const geoJobsInRadiusAllTitles = await GeoJob.countDocuments(geoCacheBase);
    const titleTrim = title?.trim() || '';
    const titleBuilt = titleTrim ? buildTitleFilter(titleTrim) : null;
    const countQueryTitled = titleBuilt ? { ...geoCacheBase, title: titleBuilt } : geoCacheBase;
    const cachedCount = titleBuilt
      ? await GeoJob.countDocuments(countQueryTitled)
      : geoJobsInRadiusAllTitles;

    const liveNearBase = { ...withinQuery, ...GEOJOB_REAL_LISTING_FILTER };
    const liveGeoJobsInRadiusTotal = await GeoJob.countDocuments(liveNearBase);

    const finalQuery = { ...baseGeoQuery, ...GEOJOB_REAL_LISTING_FILTER };
    if (title?.trim()) {
      finalQuery.title = buildTitleFilter(title.trim());
    }

    let liveJobs = await GeoJob.find(finalQuery).limit(liveLimit).lean();
    if (liveJobs.length === 0 && title?.trim()) {
      liveJobs = await GeoJob.find({ ...baseGeoQuery, ...GEOJOB_REAL_LISTING_FILTER }).limit(liveLimit).lean();
    }

    const mergedRaw = mergeStoredWithLive(storedNorm, liveJobs);
    let merged;
    try {
      const forScoring = mergedRaw.map(normalizeMapJobForScorer);
      const scored = score(forScoring, req.user, searchCtx);
      if (!Array.isArray(scored) || scored.length !== mergedRaw.length) {
        throw new Error('scorer output length mismatch');
      }
      merged = scored
        .map((sj, i) => ({
          ...mergedRaw[i],
          matchScore: sj.matchScore ?? mergedRaw[i].matchScore ?? 0,
        }))
        .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    } catch (e) {
      logger.warn(`[GeoJobs] match scoring skipped: ${e.message}`);
      merged = mergedRaw
        .map((j) => ({ ...j, matchScore: j.matchScore ?? 0 }))
        .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    }

    const mapFilterOpts = {
      centerLat: parsedLat,
      centerLng: parsedLng,
      radiusKm:  parsedRadius,
    };
    const mergedBeforeListingFilter = merged.length;
    merged = merged.filter((j) => passesMapListingFilters(j, geoHint, mapFilterOpts));
    const mapListingFilterRemoved = mergedBeforeListingFilter - merged.length;

    const durationMs = Date.now() - t0;

    if (process.env.GEO_NEARBY_LOG_METRICS === '1') {
      logger.info(
        `[geo-jobs/nearby] ${JSON.stringify({
          durationMs,
          stored: storedNorm.length,
          live: liveJobs.length,
          liveGeoJobsInRadiusTotal,
          geoJobsInRadiusAllTitles,
          cachedTitleMatch: cachedCount,
          mergedBeforeListingFilter,
          mergedAfterListingFilter: merged.length,
          mapListingFilterRemoved,
          liveFetchSkipped: skipLiveFetch,
          liveFetchError,
          radiusKm: parsedRadius,
        })}`
      );
    } else {
      logger.debug(
        `[geo-jobs/nearby] ${JSON.stringify({
          durationMs,
          stored: storedNorm.length,
          live: liveJobs.length,
          merged: merged.length,
          liveFetchSkipped: skipLiveFetch,
        })}`
      );
    }

    return res.json({
      success: true,
      data: {
        jobs:  merged,
        total: merged.length,
        meta: {
          stored:            storedNorm.length,
          live:              liveJobs.length,
          merged:            merged.length,
          liveFetchSkipped:  skipLiveFetch,
          liveFetchError:    liveFetchError || undefined,
          /** GeoJob docs in DB inside radius (real listings only). */
          cachedGeoInRadius: cachedCount,
          /** Same circle, ignoring job-title text filter — shows if title regex is the bottleneck. */
          geoJobsInRadiusAllTitles,
          /** GeoJob docs matching $near + filters (uncapped count; live array is capped by liveLimit). */
          liveGeoJobsInRadiusTotal,
          /** Rows after merge + score, before address/region listing filter. */
          mergedBeforeMapListingFilter: mergedBeforeListingFilter,
          /** Removed by passesMapListingFilters (wrong city in address vs map centre, etc.). */
          mapListingFilterRemoved,
          titleQuery:        titleTrim || undefined,
          titleMongoPattern: titleBuilt && titleBuilt.$regex != null
            ? String(titleBuilt.$regex)
            : undefined,
          searchAreaLabel,
          durationMs,
          /** Echo request params so the client can keep the radius ring aligned with the result set. */
          centerLat:  parsedLat,
          centerLng:  parsedLng,
          radiusKm:   parsedRadius,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/v1/geo-jobs/enrich-stored ───────────────────────────
const enrichStoredJobs = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.body?.limit ?? 40, 10) || 40, 1), 200);
    const centerLat = parseFloat(req.body?.centerLat);
    const centerLng = parseFloat(req.body?.centerLng);
    const centerOpts =
      Number.isFinite(centerLat) && Number.isFinite(centerLng)
        ? { centerLat, centerLng }
        : {};
    const result = await enrichBatchForUser(req.user._id, limit, centerOpts);
    return success(res, result, 'Geo enrichment batch completed');
  } catch (err) {
    next(err);
  }
};

// ── POST /api/v1/geo-jobs/seed  (disabled — no demo data in production) ──
const seedGeoJobs = async (_req, res) => res.status(410).json({
  success: false,
  message:
    'Demo geo seed is disabled. Map jobs are only your real saved jobs (with coordinates) plus live listings from Adzuna, JSearch, and SerpAPI when API keys are configured.',
});

// ── POST /api/v1/geo-jobs/:id/save ───────────────────────────────
const saveGeoJob = async (req, res, next) => {
  try {
    // Canonical Job id (same collection as list search) — bookmark without geo_ shim.
    const canonical = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { status: 'saved', statusUpdatedAt: new Date() } },
      { new: true }
    );
    if (canonical) {
      return res.json({ success: true, data: canonical, message: 'Job saved' });
    }

    const geoJob = await GeoJob.findById(req.params.id).lean();
    if (!geoJob) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    const externalId = `geo_${geoJob._id}`;

    const job = await Job.findOneAndUpdate(
      { userId: req.user._id, externalId },
      {
        $set: {
          status:          'saved',
          statusUpdatedAt: new Date(),
        },
        $setOnInsert: {
          userId:      req.user._id,
          externalId,
          title:       geoJob.title,
          company:     geoJob.company,
          location:    geoJob.location?.address || '',
          description: geoJob.description || '',
          url:         geoJob.applyUrl || '',
          salary:      geoJob.salaryDisplay || '',
          salaryMin:   geoJob.salary || 0,
          source:      'map-search',
          remote:      geoJob.jobType === 'remote',
          matchScore:  0,
          postedAt:    geoJob.postedAt,
        },
      },
      { upsert: true, new: true }
    );

    return res.json({ success: true, data: job, message: 'Job saved' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/v1/geo-jobs/:id/unsave ─────────────────────────────
const unsaveGeoJob = async (req, res, next) => {
  try {
    const canonical = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'saved' },
      { $set: { status: 'found', statusUpdatedAt: new Date() } },
      { new: true }
    );
    if (canonical) {
      return res.json({ success: true, data: canonical, message: 'Job unsaved' });
    }

    const externalId = `geo_${req.params.id}`;

    const job = await Job.findOneAndUpdate(
      { userId: req.user._id, externalId },
      { $set: { status: 'found', statusUpdatedAt: new Date() } },
      { new: true }
    );

    return res.json({ success: true, data: job, message: 'Job unsaved' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/v1/geo-jobs/saved-ids ───────────────────────────────
const getSavedGeoJobIds = async (req, res, next) => {
  try {
    const geoLinked = await Job.find({
      userId:     req.user._id,
      source:     'map-search',
      status:     'saved',
      externalId: { $regex: /^geo_/ },
    }).select('externalId _id').lean();

    const canonicalSaved = await Job.find({
      userId: req.user._id,
      status: 'saved',
      $expr: {
        $not: {
          $regexMatch: { input: { $ifNull: ['$externalId', ''] }, regex: '^geo_' },
        },
      },
    }).select('_id').lean();

    const ids = [...new Set([
      ...geoLinked.map(j => j.externalId.replace('geo_', '')),
      ...canonicalSaved.map(j => String(j._id)),
    ])];

    const docIdMap = {};
    geoLinked.forEach(j => {
      docIdMap[j.externalId.replace('geo_', '')] = j._id.toString();
    });
    canonicalSaved.forEach(j => {
      docIdMap[String(j._id)] = j._id.toString();
    });

    return res.json({ success: true, data: { ids, docIdMap } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getNearbyJobs,
  seedGeoJobs,
  saveGeoJob,
  unsaveGeoJob,
  getSavedGeoJobIds,
  enrichStoredJobs,
};
