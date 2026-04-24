/**
 * Naukri.com — two paths:
 * 1) Optional Apify Actor (automation-lab/naukri-scraper) when APIFY_TOKEN is set — bypasses reCAPTCHA.
 * 2) Direct jobapi/v3/search — often 406 without a browser session.
 *
 * Apify is pay-per-use; review Apify + Naukri terms for your use case.
 */
const axios  = require('axios');
const logger = require('../../config/logger');
const { getApifyToken, apifyRunSyncGetDatasetItems } = require('./apifyActor.util');

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

const DEFAULT_NAUKRI_ACTOR = 'automation-lab~naukri-scraper';

function mapApifyJob(it) {
  const desc = String(it.jobDescription || it.description || '').replace(/<[^>]*>/g, '').slice(0, 3000);
  const salaryStr = it.salary
    ? String(it.salary)
    : (it.salaryMin != null && it.salaryMax != null
      ? `${it.salaryMin}-${it.salaryMax} ${it.salaryCurrency || 'INR'}`
      : 'Not specified');
  return {
    externalId:  `naukri-${it.jobId || it.id || ''}`,
    title:       it.title || '',
    company:     it.companyName || it.company || '',
    location:    it.location || 'India',
    description: desc,
    url:         it.jobUrl || (it.jobId ? `https://www.naukri.com/job-listings-${it.jobId}` : 'https://www.naukri.com'),
    salary:      salaryStr,
    source:      'Naukri (Apify)',
    remote:      String(it.workMode || '').toLowerCase() === 'remote' || Boolean(it.remote),
    postedAt:    it.postedDate || null,
  };
}

function buildApifyInput({ role, location, workType }) {
  const keyword = String(role || 'software developer').trim().toLowerCase() || 'software developer';
  const input = {
    keyword,
    maxJobs: Math.min(Math.max(Number(process.env.APIFY_NAUKRI_MAX_JOBS) || 25, 1), 200),
    sortBy: 'relevance',
  };

  if (workType === 'remote') {
    input.workMode = 'remote';
  } else if (location && INDIA_HINT.test(location)) {
    const first = String(location).split(',')[0].trim().toLowerCase();
    if (!/^india$|^all india$/i.test(first)) input.location = first.replace(/\s+/g, ' ');
  }

  return input;
}

const searchViaApify = async (params) => {
  const actor = (process.env.APIFY_NAUKRI_ACTOR || DEFAULT_NAUKRI_ACTOR).trim();
  const input   = buildApifyInput(params);
  const timeout = Math.min(Math.max(Number(process.env.APIFY_TIMEOUT_MS) || 180000, 30000), 300000);

  const items = await apifyRunSyncGetDatasetItems(actor, input, { timeoutMs: timeout });
  const jobs = items.map(mapApifyJob).filter(j => j.title && j.company);
  logger.info(`[naukri] Apify actor ${actor}: rawItems=${items.length} jobsAfterMap=${jobs.length}`);
  return jobs;
};

const searchDirect = async ({ role, location, workType }) => {
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
    logger.warn(`[naukri] blocked (406): ${data?.message || 'not acceptable'} — set APIFY_TOKEN for Apify-backed fetch`);
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
};

const search = async (params) => {
  if (getApifyToken()) {
    try {
      const fromApify = await searchViaApify(params);
      if (fromApify.length) return fromApify;
    } catch (err) {
      logger.warn(`[naukri] Apify path failed, falling back to direct API: ${err.message}`);
    }
  }

  try {
    return await searchDirect(params);
  } catch (err) {
    logger.warn(`[naukri] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
