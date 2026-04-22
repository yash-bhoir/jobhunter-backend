const axios  = require('axios');
const logger = require('../../config/logger');

/** CareerJet v4 publisher API — https://www.careerjet.com/partners/api */
const BASE = 'https://search.api.careerjet.net/v4/query';

const LOCALE_HINTS = [
  [/united states|\busa\b|\bus\b/i, 'en_US'],
  [/united kingdom|\buk\b|\britain\b|\bengland\b/i, 'en_GB'],
  [/india|\bbangalore\b|\bmumbai\b|\bdelhi\b|\bhyderabad\b|\bpune\b|\bchennai\b/i, 'en_IN'],
  [/canada/i, 'en_CA'],
  [/australia/i, 'en_AU'],
  [/germany|deutschland/i, 'de_DE'],
  [/france/i, 'fr_FR'],
];

function pickLocale(location) {
  const loc = String(location || '');
  for (const [re, code] of LOCALE_HINTS) {
    if (re.test(loc)) return code;
  }
  return 'en_GB';
}

const search = async ({ role, location, clientIp, clientUserAgent }) => {
  const apiKey = (process.env.CAREERJET_API_KEY || process.env.CAREERJET_AFFID || '').trim();
  if (!apiKey) {
    logger.debug('[careerjet] Set CAREERJET_API_KEY (publisher key) to enable CareerJet v4');
    return [];
  }

  const userIp = (clientIp && String(clientIp).trim()) || '127.0.0.1';
  const ua = (clientUserAgent && String(clientUserAgent).slice(0, 512)) || 'JobHunter/1.0';

  try {
    const { data, status } = await axios.get(BASE, {
      auth:    { username: apiKey, password: '' },
      params:  {
        locale_code: pickLocale(location),
        keywords:    role,
        location:    location || '',
        user_ip:     userIp,
        user_agent:  ua,
        page_size:   15,
        page:        1,
        sort:        'relevance',
      },
      timeout: 12000,
      validateStatus: s => s < 500,
    });

    if (status !== 200) {
      logger.warn(`[careerjet] HTTP ${status}: ${typeof data === 'string' ? data.slice(0, 120) : JSON.stringify(data).slice(0, 200)}`);
      return [];
    }
    if (data?.type === 'ERROR') {
      logger.warn(`[careerjet] API error: ${data.error || data.message || 'unknown'}`);
      return [];
    }
    if (data?.type === 'LOCATIONS') {
      logger.warn(`[careerjet] location resolution: ${data.message || 'no jobs'}`);
      return [];
    }

    return (data?.jobs || []).map(j => ({
      externalId:  j.url || '',
      title:       j.title || '',
      company:     j.company || '',
      location:    j.locations || '',
      description: (j.description || '').replace(/<[^>]*>/g, ''),
      url:         j.url || '',
      salary:      j.salary || 'Not specified',
      source:      'CareerJet',
      remote:      (j.title || '').toLowerCase().includes('remote'),
      postedAt:    j.date ? new Date(j.date).toISOString() : null,
    }));
  } catch (err) {
    logger.warn(`[careerjet] ${err.message}`);
    return [];
  }
};

module.exports = { search };
