const logger         = require('../../config/logger');
const { score }       = require('./scorer');
const { deduplicate } = require('./deduplicator');
const { normalize }   = require('./normalizer');
const {
  findOrCreateCompany,
  ingestJob,
}                     = require('../companyStore.service');

// ── All platform services ─────────────────────────────────────────
const SERVICES = {
  // ── Existing paid/free platforms ───────────────────────────────
  jsearch:        require('./jsearch.service'),
  adzuna:         require('./adzuna.service'),
  remoteok:       require('./remoteok.service'),
  remotive:       require('./remotive.service'),
  arbeitnow:      require('./arbeitnow.service'),
  jobicy:         require('./jobicy.service'),
  himalayas:      require('./himalayas.service'),
  themuse:        require('./themuse.service'),
  careerjet:      require('./careerjet.service'),
  // ── New free platforms ──────────────────────────────────────────
  'linkedin-rss': require('./linkedin-rss.service'),
  'indeed-rss':   require('./indeed-rss.service'),
  naukri:         require('./naukri.service'),
  wellfound:      require('./wellfound.service'),
  // ── New aggregators (require API keys, admin-controlled) ─────────
  jooble:         require('./jooble.service'),     // Global aggregator  — needs JOOBLE_API_KEY
  findwork:       require('./findwork.service'),   // Tech jobs          — needs FINDWORK_API_KEY
  // ── ATS direct listings (FREE — no API key needed) ───────────────
  greenhouse:     require('./greenhouse.service'), // Big Tech (Stripe, Airbnb, Coinbase…)
  lever:          require('./lever.service'),      // Startups (Figma, Vercel, Notion…)
  ashby:          require('./ashby.service'),      // High-growth (Ramp, Supabase, Clerk…)
  recruitee:      require('./recruitee.service'), // EU companies (Adyen, Mollie, Mews…)
  // ── Paid platforms (admin-controlled, disabled by default) ──────
  serpapi:        require('./serpapi.service'),   // Google Jobs — needs SERPAPI_KEY
  reed:           require('./reed.service'),       // Reed.co.uk   — needs REED_API_KEY
};

// ── Platform metadata ─────────────────────────────────────────────
// type: 'free' | 'paid'  •  defaultEnabled: whether on without admin action
const PLATFORM_META = {
  jsearch:        { type: 'paid', defaultEnabled: true  },
  adzuna:         { type: 'paid', defaultEnabled: true  },
  remoteok:       { type: 'free', defaultEnabled: true  },
  remotive:       { type: 'free', defaultEnabled: true  },
  arbeitnow:      { type: 'free', defaultEnabled: true  },
  jobicy:         { type: 'free', defaultEnabled: true  },
  himalayas:      { type: 'free', defaultEnabled: true  },
  themuse:        { type: 'free', defaultEnabled: true  },
  careerjet:      { type: 'free', defaultEnabled: true  },
  'linkedin-rss': { type: 'free', defaultEnabled: true  },
  'indeed-rss':   { type: 'free', defaultEnabled: true  },
  naukri:         { type: 'free', defaultEnabled: true  },
  wellfound:      { type: 'free', defaultEnabled: true  },
  // ── New aggregators ──────────────────────────────────────────────
  jooble:         { type: 'paid', defaultEnabled: true  }, // JOOBLE_API_KEY set
  findwork:       { type: 'paid', defaultEnabled: true  }, // FINDWORK_API_KEY set
  // ── ATS free direct listings (on by default) ─────────────────────
  greenhouse:     { type: 'free', defaultEnabled: true  }, // Big Tech direct listings
  lever:          { type: 'free', defaultEnabled: true  }, // Startup direct listings
  ashby:          { type: 'free', defaultEnabled: true  }, // High-growth company listings
  recruitee:      { type: 'free', defaultEnabled: true  }, // EU company listings
  // ── Paid platforms ───────────────────────────────────────────────
  serpapi:        { type: 'paid', defaultEnabled: true  }, // SERPAPI_KEY set
  reed:           { type: 'paid', defaultEnabled: true  }, // REED_API_KEY set
};

// ── Circuit breaker — in-memory, resets every 10 minutes ─────────
// Skips platforms that have failed 3+ times recently to save quota.
const _cb = new Map(); // name → { failures, lastFailure }

const cbIsOpen = (name) => {
  const s = _cb.get(name);
  if (!s || s.failures < 3) return false;
  if (Date.now() - s.lastFailure > 10 * 60 * 1000) { _cb.delete(name); return false; }
  return true;
};
const cbFail    = (name) => {
  const s = _cb.get(name) || { failures: 0, lastFailure: 0 };
  _cb.set(name, { failures: s.failures + 1, lastFailure: Date.now() });
};
const cbSuccess = (name) => _cb.delete(name);

// ── Redis cache helpers ───────────────────────────────────────────
// Cache per platform per query for 30 minutes — avoids repeat API calls.
let _cache = null;
const getCache = () => {
  if (!_cache) {
    try { _cache = require('../../config/redis').cache; } catch { _cache = null; }
  }
  return _cache;
};

const cacheKey = (name, role, location, workType, skills = []) => {
  // Include a short skills fingerprint so skill-enriched queries don't
  // collide with plain queries in the Redis cache.
  const skillsTag = skills.length
    ? require('crypto').createHash('md5')
        .update([...skills].sort().join(','))
        .digest('hex')
        .substring(0, 8)
    : 'noskills';
  return `platform:${name}:${(role || '').toLowerCase()}:${(location || '').toLowerCase()}:${workType || 'any'}:${skillsTag}`;
};

const fromCache = async (key) => {
  try { return await getCache()?.get(key); } catch { return null; }
};

const toCache = async (key, data) => {
  try { await getCache()?.set(key, data, 1800); } catch { /* redis optional */ }
};

// ── Load enabled platforms from DB (PlatformConfig) ──────────────
// Admin can toggle any platform on/off via /admin/config.
// Key pattern: "platform.{name}.enabled"  (value: true | false)
const getEnabledPlatforms = async () => {
  try {
    const PlatformConfig = require('../../models/PlatformConfig');
    const allKeys = Object.keys(PLATFORM_META).map(n => `platform.${n}.enabled`);
    const configs = await PlatformConfig.find({ key: { $in: allKeys } }).lean();
    const dbMap   = Object.fromEntries(configs.map(c => [c.key, c.value]));

    return Object.entries(PLATFORM_META)
      .filter(([name, meta]) => {
        const dbKey  = `platform.${name}.enabled`;
        // DB value takes precedence over default
        return Object.prototype.hasOwnProperty.call(dbMap, dbKey)
          ? dbMap[dbKey] === true
          : meta.defaultEnabled;
      })
      .map(([name]) => name);
  } catch (err) {
    logger.warn(`[jobSearch] PlatformConfig read failed — using defaults: ${err.message}`);
    // Fall back to defaults
    return Object.entries(PLATFORM_META)
      .filter(([, meta]) => meta.defaultEnabled)
      .map(([name]) => name);
  }
};

// ── Global store ingest (runs after search, non-blocking) ─────────
// For each scored job: find-or-create Company, find-or-create GlobalJob.
// Mutates job objects in place — adds companyId + globalJobId so the
// caller (search controller) can persist them on the UserJob record.
const _ingestIntoGlobalStore = async (jobs) => {
  for (const job of jobs) {
    try {
      const company = await findOrCreateCompany(job.company, {
        source: job.source,
      });
      if (!company) continue;

      const { globalJob } = await ingestJob(job, company._id);

      // Attach IDs so caller can save them to the Job (UserJob) record
      job.companyId   = company._id;
      job.globalJobId = globalJob?._id || null;
    } catch (err) {
      logger.warn(`[globalStore] ingest failed for "${job.company}": ${err.message}`);
    }
  }
};

// ── Main orchestrator ─────────────────────────────────────────────
const runJobSearch = async (params, user, plan, onProgress) => {
  const maxJobs = plan === 'free' ? 10 : plan === 'pro' ? 30 : 50;

  // Which platforms to use:
  // If user passed specific platforms → filter to only enabled ones from that list
  // Otherwise → all admin-enabled platforms
  const enabledByAdmin = await getEnabledPlatforms();

  const platforms = params.platforms?.length
    ? params.platforms.filter(p => SERVICES[p] && enabledByAdmin.includes(p))
    : enabledByAdmin.filter(p => SERVICES[p]);

  logger.info(`[jobSearch] platforms (${platforms.length}): ${platforms.join(', ')}`);

  // Build profile enrichment — merged skills from profile + resume, deduplicated.
  // Passed to every platform service so they can tailor queries.
  const profileSkills = [
    ...(user?.profile?.skills         || []),
    ...(user?.resume?.extractedSkills || []),
  ].map(s => s.trim()).filter(Boolean);
  const uniqueSkills  = [...new Set(profileSkills)];
  const experience    = user?.profile?.experience || 0;

  // Run all platforms concurrently — skip circuit-broken ones
  const promises = platforms.map(async (name) => {
    // Circuit breaker check
    if (cbIsOpen(name)) {
      logger.warn(`[${name}] circuit open — skipping`);
      if (onProgress) onProgress({ platform: name, found: 0, status: 'skipped' });
      return { name, jobs: [], error: 'circuit_open' };
    }

    // Redis cache check (keyed by skills fingerprint so enriched queries stay separate)
    const ck     = cacheKey(name, params.role, params.location, params.workType, uniqueSkills);
    const cached = await fromCache(ck);
    if (cached) {
      logger.info(`[${name}] cache hit (${cached.length} jobs)`);
      if (onProgress) onProgress({ platform: name, found: cached.length, status: 'cached' });
      cbSuccess(name);
      return { name, jobs: cached, error: null };
    }

    // Enrich params with user profile so services can build better queries
    const enrichedParams = { ...params, skills: uniqueSkills, experience };

    return SERVICES[name].search(enrichedParams)
      .then(async (jobs) => {
        logger.info(`[${name}] found ${jobs.length} jobs`);
        if (onProgress) onProgress({ platform: name, found: jobs.length, status: 'done' });
        cbSuccess(name);
        await toCache(ck, jobs); // cache result
        return { name, jobs, error: null };
      })
      .catch(err => {
        logger.warn(`[${name}] failed: ${err.message}`);
        if (onProgress) onProgress({ platform: name, found: 0, status: 'error', error: err.message });
        cbFail(name);
        return { name, jobs: [], error: err.message };
      });
  });

  const results = await Promise.allSettled(promises);

  // Flatten, normalize, deduplicate, score
  const allRaw     = results.flatMap(r => r.status === 'fulfilled' ? r.value.jobs : []);
  const normalized = allRaw.map(normalize).filter(j => j.title && j.company);
  const unique     = deduplicate(normalized);
  const scored     = score(unique, user);
  scored.sort((a, b) => b.matchScore - a.matchScore);

  // Platform breakdown
  const platformBreakdown = {};
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      platformBreakdown[r.value.name] = r.value.jobs.length;
    }
  });

  return {
    jobs:              scored.slice(0, maxJobs),
    totalFound:        scored.length,
    platformBreakdown,
    errors: results
      .filter(r => r.status === 'fulfilled' && r.value.error)
      .map(r => ({ platform: r.value.name, error: r.value.error })),
  };
};

// ── Expose platform registry for admin UI ─────────────────────────
const getPlatformList = () =>
  Object.entries(PLATFORM_META).map(([name, meta]) => ({ name, ...meta }));

module.exports = { runJobSearch, getPlatformList };
