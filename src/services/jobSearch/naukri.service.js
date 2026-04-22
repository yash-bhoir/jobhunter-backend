/**
 * Naukri.com — internal search API used by their web app.
 * As of 2026 many requests return 406 + `{ message: "recaptcha required" }` without
 * a real browser session; we handle that and return [].
 */
const axios  = require('axios');
const logger = require('../../config/logger');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':          '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.naukri.com/',
  'Origin':          'https://www.naukri.com',
  'appid':           '109',
  'systemid':        'Naukri',
};

const INDIA_HINT = /india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|kolkata|gurgaon|noida|ahmedabad|kochi|coimbatore|indore|jaipur/i;

const search = async ({ role, location, workType }) => {
  try {
    const keyword = String(role || '').trim();
    const loc = String(location || '').trim();

    const params = {
      noOfResults: 20,
      pageNo:      1,
      searchType:  'adv',
    };

    if (loc && INDIA_HINT.test(loc)) {
      params.urlType  = 'search_by_key_loc';
      params.keyword  = keyword;
      params.location = loc;
    } else {
      params.urlType = 'search_by_keyword';
      params.keyword = keyword;
      if (workType === 'remote') params.wfhType = 1;
    }

    const { data, status } = await axios.get('https://www.naukri.com/jobapi/v3/search', {
      headers:        HEADERS,
      params,
      timeout:        12000,
      validateStatus: (s) => s < 500,
    });

    if (status === 406 || data?.statusCode === 406) {
      logger.warn(`[naukri] blocked (406): ${data?.message || 'not acceptable'} — requires browser/reCAPTCHA`);
      return [];
    }
    if (status !== 200) {
      logger.warn(`[naukri] HTTP ${status}`);
      return [];
    }

    const jobs = data?.jobDetails || [];
    return jobs.map((j) => ({
      externalId:  `naukri-${j.jobId || j.footerPlaceholderLabel || Math.random()}`,
      title:       j.title || '',
      company:     j.companyName || '',
      location:    (j.placeholders?.find((p) => p.type === 'location')?.label) || location || 'India',
      description: j.jobDescription || j.tagsAndSkills || '',
      url:         j.jdURL ? `https://www.naukri.com${j.jdURL}` : 'https://www.naukri.com',
      salary:      j.placeholders?.find((p) => p.type === 'salary')?.label || 'Not specified',
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
