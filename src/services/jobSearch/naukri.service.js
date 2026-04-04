/**
 * Naukri.com — India's largest job board
 * Uses Naukri's internal search API (same endpoint their website uses).
 * Free, no API key needed. Best for India-based roles.
 */
const axios  = require('axios');
const logger = require('../../config/logger');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.naukri.com/',
  'appid':           '109',
  'systemid':        '109',
};

const search = async ({ role, location, workType }) => {
  try {
    const keyword  = encodeURIComponent(role);
    const loc      = location ? encodeURIComponent(location) : '';
    const urlSlug  = loc
      ? `${keyword.toLowerCase().replace(/%20/g, '-')}-jobs-in-${loc.toLowerCase().replace(/%20/g, '-')}`
      : `${keyword.toLowerCase().replace(/%20/g, '-')}-jobs`;

    const url = `https://www.naukri.com/jobapi/v3/search` +
      `?noOfResults=20&urlType=search_by_keyword&searchType=adv` +
      `&keyword=${keyword}` +
      (loc ? `&location=${loc}` : '') +
      (workType === 'remote' ? `&wfhType=1` : '') +
      `&pageNo=1`;

    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 12000,
    });

    const jobs = data?.jobDetails || [];

    return jobs.map(j => ({
      externalId:  `naukri-${j.jobId || j.footerPlaceholderLabel || Math.random()}`,
      title:       j.title || '',
      company:     j.companyName || '',
      location:    (j.placeholders?.find(p => p.type === 'location')?.label) || location || 'India',
      description: j.jobDescription || j.tagsAndSkills || '',
      url:         j.jdURL ? `https://www.naukri.com${j.jdURL}` : `https://www.naukri.com`,
      salary:      j.placeholders?.find(p => p.type === 'salary')?.label || 'Not specified',
      source:      'Naukri',
      remote:      workType === 'remote' || (j.tagsAndSkills || '').toLowerCase().includes('remote'),
      postedAt:    j.footerPlaceholderLabel || null,
    }));
  } catch (err) {
    logger.warn(`[naukri] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
