/**
 * Wellfound — two paths:
 * 1) Optional Apify Actor (thirdwatch/wellfound-jobs-scraper) when APIFY_TOKEN is set — bypasses DataDome.
 * 2) Direct HTML fetch — usually HTTP 403 from DataDome.
 *
 * Apify is pay-per-use (often residential proxy); review terms for your product.
 */
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');
const { getApifyToken, apifyRunSyncGetDatasetItems } = require('./apifyActor.util');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://wellfound.com/',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
};

const INDIA_HINT = /india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|kolkata|gurgaon|noida/i;

const DEFAULT_WELLFOUND_ACTOR = 'thirdwatch~wellfound-jobs-scraper';

/** Matches Apify actor default; override with APIFY_WELLFOUND_PROXY_JSON if needed. */
function wellfoundProxyConfiguration() {
  const raw = (process.env.APIFY_WELLFOUND_PROXY_JSON || '').trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      logger.warn('[wellfound] APIFY_WELLFOUND_PROXY_JSON is not valid JSON; using default Apify residential proxy');
    }
  }
  return { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
}

function wellfoundRoleSlugs(role) {
  const raw = String(role || 'software engineer').trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  const primary = slug.length > 2 ? slug : 'software-engineer';
  const fallbacks = ['software-engineer', 'full-stack-engineer', 'backend-engineer', 'product-manager'];
  const out = [primary];
  for (const f of fallbacks) {
    if (f !== primary && !out.includes(f)) out.push(f);
  }
  return out.slice(0, 4);
}

function wellfoundLocationSlugs(location, workType) {
  if (workType === 'remote') return ['remote'];
  if (location && INDIA_HINT.test(location)) return ['india'];
  return [];
}

function mapApifyWellfound(it) {
  const desc = String(it.description || '').replace(/<[^>]*>/g, '').slice(0, 3000);
  const sal = (it.salary_min != null && it.salary_max != null)
    ? `${it.salary_min}-${it.salary_max} ${it.salary_currency || ''}`.trim()
    : (it.equity || 'Not specified');
  return {
    externalId:  `wellfound-${Buffer.from(`${it.company_name || ''}${it.title || ''}`).toString('base64').slice(0, 16)}`,
    title:       it.title || '',
    company:     it.company_name || '',
    location:    it.location || 'Remote',
    description: desc,
    url:         it.job_url || '',
    salary:      sal,
    source:      'Wellfound (Apify)',
    remote:      Boolean(it.remote),
    postedAt:    it.posted_date || null,
  };
}

const searchViaApify = async (params) => {
  const { role, location, workType } = params;
  const actor = (process.env.APIFY_WELLFOUND_ACTOR || DEFAULT_WELLFOUND_ACTOR).trim();
  const input = {
    roles:                wellfoundRoleSlugs(role),
    locations:            wellfoundLocationSlugs(location, workType),
    maxResults:           Math.min(Math.max(Number(process.env.APIFY_WELLFOUND_MAX_RESULTS) || 25, 1), 100),
    proxyConfiguration: wellfoundProxyConfiguration(),
  };
  const datadome = (process.env.APIFY_WELLFOUND_DATADOME_COOKIE || '').trim();
  if (datadome) input.datadomeCookie = datadome;

  const timeout = Math.min(Math.max(Number(process.env.APIFY_TIMEOUT_MS) || 180000, 30000), 300000);

  const items = await apifyRunSyncGetDatasetItems(actor, input, { timeoutMs: timeout });
  const jobs = items.map(mapApifyWellfound).filter(j => j.title && j.company && j.url);
  logger.info(`[wellfound] Apify actor ${actor}: rawItems=${items.length} jobsAfterMap=${jobs.length}`);
  if (!items.length && !datadome) {
    logger.warn(
      '[wellfound] Apify returned no rows — ensure Apify residential proxy is enabled/billed for your account, ' +
        'or set APIFY_WELLFOUND_DATADOME_COOKIE (datadome cookie from wellfound.com; see actor input on Apify Console).'
    );
  }
  return jobs;
};

function jobsFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return [];

  let root;
  try {
    root = JSON.parse(m[1]);
  } catch {
    return [];
  }

  const out = [];
  const visit = (node, depth = 0) => {
    if (out.length >= 50 || !node || depth > 18) return;
    if (Array.isArray(node)) {
      node.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;

    const title = node.title || node.jobTitle || node.name;
    const company = node.startup_name || node.companyName || node.company?.name || node.startup?.name;
    const url = node.url || node.jobUrl || node.permalink;
    if (title && company && typeof url === 'string' && url.includes('/jobs/')) {
      out.push({
        externalId:  `wellfound-${Buffer.from(`${company}${title}`).toString('base64').slice(0, 12)}`,
        title:         String(title),
        company:       String(company),
        location:      String(node.location || node.locations?.[0] || '') || 'Remote',
        description:   String(node.descriptionSnippet || node.description || '').replace(/<[^>]*>/g, '').slice(0, 400),
        url:           url.startsWith('http') ? url : `https://wellfound.com${url}`,
        salary:        node.compensation || 'Not specified',
        source:        'Wellfound',
        remote:        Boolean(node.remote || String(node.location || '').toLowerCase().includes('remote')),
        postedAt:      null,
      });
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };

  visit(root);
  const seen = new Set();
  return out.filter((j) => {
    const k = j.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const searchDirect = async ({ role, location, workType }) => {
  let url = `https://wellfound.com/jobs?q=${encodeURIComponent(role)}`;
  if (location) url += `&l=${encodeURIComponent(location)}`;
  if (workType === 'remote') url += '&remote=true';

  const { data, status } = await axios.get(url, {
    headers:        HEADERS,
    timeout:        12000,
    validateStatus: () => true,
  });

  if (status === 403) {
    logger.warn('[wellfound] direct HTML HTTP 403 (DataDome); Apify path (if configured) is the supported route');
    return [];
  }
  if (status !== 200 || typeof data !== 'string') {
    logger.warn(`[wellfound] HTTP ${status}`);
    return [];
  }

  const fromNext = jobsFromNextData(data);
  if (fromNext.length) {
    logger.info(`[wellfound] parsed ${fromNext.length} jobs from __NEXT_DATA__`);
    return fromNext.slice(0, 40);
  }

  const $    = cheerio.load(data);
  const jobs = [];

  $('[data-test="StartupResult"], .mb-6.w-full, [class*="styles_component"]').each((_, el) => {
    const card    = $(el);
    const title   = card.find('a[data-test="job-link"], h2, [class*="title"]').first().text().trim();
    const company = card.find('[data-test="startup-link"], [class*="company"], h3').first().text().trim();
    const loc     = card.find('[data-test="location"], [class*="location"]').first().text().trim();
    const jobUrl  = card.find('a[data-test="job-link"], a[href*="/jobs/"]').first().attr('href') || '';
    const salary  = card.find('[data-test="salary"], [class*="salary"]').first().text().trim();

    if (!title || !company) return;

    jobs.push({
      externalId:  `wellfound-${Buffer.from(`${company}${title}`).toString('base64').slice(0, 12)}`,
      title,
      company,
      location:    loc || location || 'Remote',
      description: salary ? `Salary: ${salary}` : '',
      url:         jobUrl.startsWith('http') ? jobUrl : `https://wellfound.com${jobUrl}`,
      salary:      salary || 'Not specified',
      source:      'Wellfound',
      remote:      workType === 'remote' || loc.toLowerCase().includes('remote'),
      postedAt:    null,
    });
  });

  logger.info(`[wellfound] found ${jobs.length} jobs (DOM)`);
  return jobs;
};

const search = async (params) => {
  if (getApifyToken()) {
    try {
      const fromApify = await searchViaApify(params);
      if (fromApify.length) return fromApify;
    } catch (err) {
      logger.warn(`[wellfound] Apify path failed, falling back to direct HTML: ${err.message}`);
    }
  }

  try {
    return await searchDirect(params);
  } catch (err) {
    logger.warn(`[wellfound] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
