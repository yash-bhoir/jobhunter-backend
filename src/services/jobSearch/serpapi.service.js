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

const search = async ({ role, location, workType }) => {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return []; // key not configured — skip silently

  try {
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

    return (data?.jobs_results || []).map(j => ({
      externalId:  `serpapi-${j.job_id || Buffer.from(j.title + j.company_name).toString('base64').slice(0, 12)}`,
      title:       j.title       || '',
      company:     j.company_name || '',
      location:    j.location    || location || '',
      description: (j.description || '').slice(0, 600),
      url:         j.share_link  || j.related_links?.[0]?.link || '',
      salary:      j.detected_extensions?.salary || 'Not specified',
      source:      `Google Jobs (${j.via || 'SerpAPI'})`,
      remote:      j.detected_extensions?.work_from_home || workType === 'remote' || false,
      postedAt:    j.detected_extensions?.posted_at || null,
    }));
  } catch (err) {
    logger.warn(`[serpapi] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
