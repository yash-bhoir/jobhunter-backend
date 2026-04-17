const axios  = require('axios');
const logger = require('../../config/logger');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://himalayas.app/jobs',
  'Origin':          'https://himalayas.app',
  'sec-ch-ua':       '"Chromium";v="122", "Not(A:Brand";v="24"',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-origin',
};

const search = async ({ role, workType }) => {
  try {
    const params = { q: role, limit: 20 };
    if (workType === 'remote') params.remote = true;

    const { data } = await axios.get('https://himalayas.app/jobs/api', {
      params,
      headers: HEADERS,
      timeout: 10000,
    });

    // Guard: Cloudflare challenge page returns HTML, not JSON
    if (!data || typeof data !== 'object' || !Array.isArray(data.jobs)) {
      logger.warn('[himalayas] unexpected response — likely Cloudflare challenge');
      return [];
    }

    return data.jobs.map(j => ({
      externalId:  String(j.id   || j.slug || ''),
      title:       j.title       || '',
      company:     j.company?.name || j.companyName || '',
      location:    j.location    || 'Remote',
      description: (j.description || j.shortDescription || '').replace(/<[^>]*>/g, ''),
      url:         j.applicationLink || j.url || '',
      salary:      j.salaryRange || 'Not specified',
      source:      'Himalayas',
      remote:      true,
      postedAt:    j.createdAt   || null,
    }));
  } catch (err) {
    logger.warn(`[himalayas] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
