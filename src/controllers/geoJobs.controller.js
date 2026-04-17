const axios  = require('axios');
const GeoJob = require('../models/GeoJob');
const Job    = require('../models/Job');

// ── Helpers ────────────────────────────────────────────────────────

// Reverse geocode lat/lng → { city, countryCode } via Nominatim (free, no key)
async function reverseGeocode(lat, lng) {
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { format: 'json', lat, lon: lng },
      headers: { 'User-Agent': 'JobHunterApp/1.0 (contact@jobhunter.app)' },
      timeout: 6000,
    });
    const addr = data?.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || addr.state || '';
    const countryCode = (addr.country_code || 'in').toLowerCase().slice(0, 2);
    return { city, countryCode };
  } catch {
    return { city: '', countryCode: 'in' };
  }
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

// Return a valid coord number, or null if unusable (0, NaN, Infinity, out-of-range).
function parseCoord(v) {
  const n = parseFloat(v);
  return (Number.isFinite(n) && n !== 0) ? n : null;
}

// Build a MongoDB title filter that matches individual key tech terms (OR logic)
// so "mern stack developer" matches "MERN Stack Engineer", "Full Stack MERN Developer", etc.
// Generic words are skipped so they don't produce noise matches.
const GENERIC_WORDS = new Set([
  'developer','engineer','senior','junior','lead','manager','associate','intern',
  'staff','principal','head','director','vp','cto','coo','and','the','for','with',
  'jobs','role','position','level','remote','full','part','time','contract','hybrid',
  'entry','mid','experienced','fresher','graduate','trainee',
]);

function buildTitleFilter(raw) {
  const terms = raw.trim().toLowerCase().split(/[\s,/|&()+]+/)
    .filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
  const pattern = terms.length > 0 ? terms.join('|') : raw.trim();
  return { $regex: pattern, $options: 'i' };
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
  });
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
  });
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
async function fetchAndCacheRealJobs(lat, lng, titleQuery, radiusKm) {
  const { city, countryCode } = await reverseGeocode(lat, lng);

  const what      = titleQuery?.trim() || '';
  const where     = city;
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

// ── Seed data — 20 real-looking jobs around London ─────────────────
const SEED_JOBS = [
  {
    title: 'Senior React Developer',
    company: 'Monzo',
    location: { type: 'Point', coordinates: [-0.0756, 51.5248], address: 'Shoreditch, London' },
    salary: 95000, salaryDisplay: '£95K/yr',
    jobType: 'hybrid',
    tags: ['React', 'TypeScript', 'GraphQL'],
    description: 'Build next-gen banking features for millions of users. Own the frontend architecture across the consumer app.',
    applyUrl: '#',
  },
  {
    title: 'Data Engineer',
    company: 'HSBC',
    location: { type: 'Point', coordinates: [0.0195, 51.5054], address: 'Canary Wharf, London' },
    salary: 85000, salaryDisplay: '£85K/yr',
    jobType: 'full-time',
    tags: ['Python', 'Apache Spark', 'AWS'],
    description: 'Design and build large-scale data pipelines for global banking analytics.',
    applyUrl: '#',
  },
  {
    title: 'Backend Engineer',
    company: 'Revolut',
    location: { type: 'Point', coordinates: [-0.0924, 51.5126], address: 'City of London' },
    salary: 110000, salaryDisplay: '£110K/yr',
    jobType: 'remote',
    tags: ['Kotlin', 'Microservices', 'Kafka'],
    description: 'Scale payment infrastructure to handle billions of transactions per month.',
    applyUrl: '#',
  },
  {
    title: 'UX Designer',
    company: 'DeepMind',
    location: { type: 'Point', coordinates: [-0.1337, 51.5136], address: 'Soho, London' },
    salary: 90000, salaryDisplay: '£90K/yr',
    jobType: 'hybrid',
    tags: ['Figma', 'Design Systems', 'User Research'],
    description: 'Shape the human side of cutting-edge AI research tools used by world-class scientists.',
    applyUrl: '#',
  },
  {
    title: 'Product Manager',
    company: 'Deliveroo',
    location: { type: 'Point', coordinates: [-0.1430, 51.5390], address: 'Camden, London' },
    salary: 105000, salaryDisplay: '£105K/yr',
    jobType: 'full-time',
    tags: ['Agile', 'B2C', 'Growth'],
    description: 'Own the rider experience product from ideation through to launch.',
    applyUrl: '#',
  },
  {
    title: 'Machine Learning Engineer',
    company: 'DeepMind',
    location: { type: 'Point', coordinates: [-0.1921, 51.5000], address: 'Kensington, London' },
    salary: 130000, salaryDisplay: '£130K/yr',
    jobType: 'full-time',
    tags: ['Python', 'PyTorch', 'TensorFlow'],
    description: 'Develop state-of-the-art ML models for real-world healthcare and science impact.',
    applyUrl: '#',
  },
  {
    title: 'DevOps Engineer',
    company: 'Wise',
    location: { type: 'Point', coordinates: [-0.0873, 51.5047], address: 'London Bridge' },
    salary: 88000, salaryDisplay: '£88K/yr',
    jobType: 'hybrid',
    tags: ['Kubernetes', 'Terraform', 'GCP'],
    description: 'Build and maintain infrastructure powering global money transfers at scale.',
    applyUrl: '#',
  },
  {
    title: 'Frontend Engineer',
    company: 'Bulb Energy',
    location: { type: 'Point', coordinates: [-0.0550, 51.5438], address: 'Hackney, London' },
    salary: 80000, salaryDisplay: '£80K/yr',
    jobType: 'remote',
    tags: ['Vue.js', 'TypeScript', 'Tailwind CSS'],
    description: 'Build clean energy management tools that help consumers reduce their carbon footprint.',
    applyUrl: '#',
  },
  {
    title: 'Cloud Architect',
    company: 'BT Group',
    location: { type: 'Point', coordinates: [0.0028, 51.5422], address: 'Stratford, London' },
    salary: 125000, salaryDisplay: '£125K/yr',
    jobType: 'full-time',
    tags: ['AWS', 'Azure', 'Cloud Architecture'],
    description: 'Lead large-scale cloud migration strategy for enterprise-level infrastructure.',
    applyUrl: '#',
  },
  {
    title: 'iOS Developer',
    company: 'Farfetch',
    location: { type: 'Point', coordinates: [-0.2051, 51.5130], address: 'Notting Hill, London' },
    salary: 92000, salaryDisplay: '£92K/yr',
    jobType: 'hybrid',
    tags: ['Swift', 'SwiftUI', 'UIKit'],
    description: 'Craft luxury fashion discovery experiences for millions of iOS users worldwide.',
    applyUrl: '#',
  },
  {
    title: 'Data Scientist',
    company: 'GoCardless',
    location: { type: 'Point', coordinates: [0.0090, 51.4834], address: 'Greenwich, London' },
    salary: 87000, salaryDisplay: '£87K/yr',
    jobType: 'hybrid',
    tags: ['Python', 'SQL', 'Statistics'],
    description: 'Model payment failure and fraud detection patterns using advanced statistical methods.',
    applyUrl: '#',
  },
  {
    title: 'Android Developer',
    company: 'Bumble',
    location: { type: 'Point', coordinates: [-0.3010, 51.4613], address: 'Richmond, London' },
    salary: 88000, salaryDisplay: '£88K/yr',
    jobType: 'remote',
    tags: ['Kotlin', 'Jetpack Compose', 'MVVM'],
    description: 'Build features that help people make meaningful connections on Android.',
    applyUrl: '#',
  },
  {
    title: 'Full Stack Engineer',
    company: 'OakNorth',
    location: { type: 'Point', coordinates: [-0.1133, 51.4613], address: 'Brixton, London' },
    salary: 95000, salaryDisplay: '£95K/yr',
    jobType: 'full-time',
    tags: ['Node.js', 'React', 'PostgreSQL'],
    description: 'Build intelligent banking tools that help entrepreneurs grow their businesses.',
    applyUrl: '#',
  },
  {
    title: 'Security Engineer',
    company: 'Palantir',
    location: { type: 'Point', coordinates: [-0.2240, 51.4934], address: 'Hammersmith, London' },
    salary: 120000, salaryDisplay: '£120K/yr',
    jobType: 'full-time',
    tags: ['AppSec', 'Zero Trust', 'SIEM'],
    description: 'Secure mission-critical data analytics platforms used by governments and enterprises.',
    applyUrl: '#',
  },
  {
    title: 'QA Automation Engineer',
    company: 'Sky',
    location: { type: 'Point', coordinates: [-0.2979, 51.5560], address: 'Wembley, London' },
    salary: 65000, salaryDisplay: '£65K/yr',
    jobType: 'hybrid',
    tags: ['Cypress', 'Playwright', 'Automation'],
    description: 'Ensure quality across streaming and broadcast platforms used by millions daily.',
    applyUrl: '#',
  },
  {
    title: 'Engineering Manager',
    company: 'Experian',
    location: { type: 'Point', coordinates: [-0.1420, 51.5154], address: 'Oxford Circus, London' },
    salary: 140000, salaryDisplay: '£140K/yr',
    jobType: 'full-time',
    tags: ['Leadership', 'Fintech', 'Agile'],
    description: 'Lead a team of 8 engineers building credit decisioning tools used by millions.',
    applyUrl: '#',
  },
  {
    title: 'Blockchain Developer',
    company: 'ConsenSys',
    location: { type: 'Point', coordinates: [-0.1425, 51.4963], address: 'Victoria, London' },
    salary: 115000, salaryDisplay: '£115K/yr',
    jobType: 'remote',
    tags: ['Solidity', 'Ethereum', 'Web3.js'],
    description: 'Build decentralised applications on Ethereum for the next generation of finance.',
    applyUrl: '#',
  },
  {
    title: 'Site Reliability Engineer',
    company: 'Funding Circle',
    location: { type: 'Point', coordinates: [-0.1010, 51.4958], address: 'Elephant & Castle, London' },
    salary: 100000, salaryDisplay: '£100K/yr',
    jobType: 'hybrid',
    tags: ['SRE', 'Prometheus', 'Go'],
    description: 'Improve reliability, observability and incident response for our lending platform.',
    applyUrl: '#',
  },
  {
    title: 'Senior Product Designer',
    company: 'Airtable',
    location: { type: 'Point', coordinates: [-0.1246, 51.4855], address: 'Vauxhall, London' },
    salary: 98000, salaryDisplay: '£98K/yr',
    jobType: 'hybrid',
    tags: ['Figma', 'Product Design', 'B2B SaaS'],
    description: 'Redesign collaboration experiences for knowledge workers and enterprise teams.',
    applyUrl: '#',
  },
  {
    title: 'Marketing Data Analyst',
    company: 'Zalando',
    location: { type: 'Point', coordinates: [-0.0921, 51.5016], address: 'Borough, London' },
    salary: 72000, salaryDisplay: '£72K/yr',
    jobType: 'full-time',
    tags: ['SQL', 'Tableau', 'A/B Testing'],
    description: 'Optimise digital marketing spend and attribution across European e-commerce markets.',
    applyUrl: '#',
  },
];

// ── GET /api/v1/geo-jobs/nearby ─────────────────────────────────────
const getNearbyJobs = async (req, res, next) => {
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

    const radiusMeters = parsedRadius * 1000;

    // $geoWithin works with countDocuments; $near does not (it requires sort)
    const withinQuery = {
      location: {
        $geoWithin: {
          $centerSphere: [[parsedLng, parsedLat], parsedRadius / 6371],
        },
      },
    };

    // Count matching jobs — include title filter so we re-fetch for each new role search
    const countQuery = { ...withinQuery };
    if (title?.trim()) countQuery.title = buildTitleFilter(title.trim());
    const cachedCount = await GeoJob.countDocuments(countQuery);

    // $near query used only for the final find (sorted by distance)
    const baseGeoQuery = {
      location: {
        $near: {
          $geometry:    { type: 'Point', coordinates: [parsedLng, parsedLat] },
          $maxDistance: radiusMeters,
        },
      },
    };

    if (cachedCount < 5) {
      // Not enough matching cached results — fetch from real APIs
      try {
        await fetchAndCacheRealJobs(parsedLat, parsedLng, title, parsedRadius);
      } catch (fetchErr) {
        console.error('[GeoJobs] fetchAndCacheRealJobs error:', fetchErr.message);
      }
    }

    // Final query — smart OR-based title filter (not exact phrase)
    const finalQuery = { ...baseGeoQuery };
    if (title?.trim()) {
      finalQuery.title = buildTitleFilter(title.trim());
    }

    let jobs = await GeoJob.find(finalQuery).limit(100).lean();

    // Fallback: if title filter returns nothing, show all area jobs so map isn't empty
    if (jobs.length === 0 && title?.trim()) {
      jobs = await GeoJob.find(baseGeoQuery).limit(100).lean();
    }

    return res.json({
      success: true,
      data: { jobs, total: jobs.length },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/v1/geo-jobs/seed  (idempotent) ─────────────────────
const seedGeoJobs = async (req, res, next) => {
  try {
    const existing = await GeoJob.countDocuments();
    if (existing > 0) {
      return res.json({
        success: true,
        message: `Already seeded — ${existing} geo jobs exist`,
        data: { count: existing },
      });
    }

    const created = await GeoJob.insertMany(SEED_JOBS);

    return res.status(201).json({
      success: true,
      message: `Seeded ${created.length} geo jobs`,
      data: { count: created.length },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/v1/geo-jobs/:id/save ───────────────────────────────
const saveGeoJob = async (req, res, next) => {
  try {
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
    const jobs = await Job.find({
      userId:     req.user._id,
      source:     'map-search',
      status:     'saved',
      externalId: { $regex: /^geo_/ },
    }).select('externalId _id').lean();

    const ids = jobs.map(j => j.externalId.replace('geo_', ''));

    const docIdMap = {};
    jobs.forEach(j => {
      docIdMap[j.externalId.replace('geo_', '')] = j._id.toString();
    });

    return res.json({ success: true, data: { ids, docIdMap } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getNearbyJobs, seedGeoJobs, saveGeoJob, unsaveGeoJob, getSavedGeoJobIds };
