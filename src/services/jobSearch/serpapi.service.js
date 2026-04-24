/**
 * SerpAPI — Google Jobs aggregator (PAID, admin-controlled)
 * Covers 50+ job boards through Google's job index.
 * Requires SERPAPI_KEY in env. Disabled by default — admin must enable.
 *
 * Pricing: ~$50/mo for 5000 searches
 * Docs: https://serpapi.com/google-jobs-api
 */
const axios  = require('axios');
const logger = require('../../config/logger');

/** Raw `jobs_results` rows (shared with indeed-rss Indeed-only fallback). Uses `params._gjCache` for single-flight per search. */
async function fetchGoogleJobsRows(params) {
  const { role, location, workType } = params;
  const apiKey = (process.env.SERPAPI_KEY || '').trim();
  if (!apiKey) return [];

  const c = params && params._gjCache;
  if (c) {
    if (c.rows != null) return c.rows;
    if (!c.promise) {
      c.promise = (async () => {
        const q = workType === 'remote'
          ? `${role} remote`
          : location ? `${role} ${location}` : role;

        const { data } = await axios.get('https://serpapi.com/search', {
          params: {
            engine:     'google_jobs',
            q,
            location:   location || undefined,
            hl:         'en',
            api_key:    apiKey,
          },
          timeout: 15000,
        });
        const rows = data?.jobs_results || [];
        c.rows = rows;
        return rows;
      })();
    }
    return c.promise;
  }

  const q = workType === 'remote'
    ? `${role} remote`
    : location ? `${role} ${location}` : role;

  const { data } = await axios.get('https://serpapi.com/search', {
    params: {
      engine:     'google_jobs',
      q,
      location:   location || undefined,
      hl:         'en',
      api_key:    apiKey,
    },
    timeout: 15000,
  });

  return data?.jobs_results || [];
}

const search = async (params) => {
  if (!(process.env.SERPAPI_KEY || '').trim()) return [];

  try {
    const rows = await fetchGoogleJobsRows(params);

    if (rows.length) {
      const byVia = rows.reduce((acc, j) => {
        const v = (j.via || 'unknown').trim() || 'unknown';
        acc[v] = (acc[v] || 0) + 1;
        return acc;
      }, {});
      logger.info(`[serpapi] ${rows.length} jobs — boards (via): ${JSON.stringify(byVia)}`);
    } else {
      logger.info('[serpapi] 0 jobs for this query (Google Jobs index empty for q/location)');
    }

    return rows.map(j => ({
      externalId:  `serpapi-${j.job_id || Buffer.from(j.title + j.company_name).toString('base64').slice(0, 12)}`,
      title:       j.title       || '',
      company:     j.company_name || '',
      location:    j.location    || params.location || '',
      description: (j.description || '').slice(0, 600),
      url:         j.share_link  || j.related_links?.[0]?.link || '',
      salary:      j.detected_extensions?.salary || 'Not specified',
      source:      `Google Jobs (${j.via || 'SerpAPI'})`,
      remote:      j.detected_extensions?.work_from_home || params.workType === 'remote' || false,
      postedAt:    j.detected_extensions?.posted_at || null,
    }));
  } catch (err) {
    logger.warn(`[serpapi] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search, fetchGoogleJobsRows };
