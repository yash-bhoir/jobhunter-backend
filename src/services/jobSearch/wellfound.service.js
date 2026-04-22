/**
 * Wellfound — HTML job search.
 * Listings are protected by DataDome; server-side fetches usually return HTTP 403.
 * We try a lightweight parse when HTML succeeds; otherwise return [].
 */
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://wellfound.com/',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
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

const search = async ({ role, location, workType }) => {
  try {
    let url = `https://wellfound.com/jobs?q=${encodeURIComponent(role)}`;
    if (location) url += `&l=${encodeURIComponent(location)}`;
    if (workType === 'remote') url += '&remote=true';

    const { data, status } = await axios.get(url, {
      headers:        HEADERS,
      timeout:        12000,
      validateStatus: () => true,
    });

    if (status === 403) {
      logger.warn('[wellfound] HTTP 403 (DataDome) — startup listings need a real browser session');
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
  } catch (err) {
    logger.warn(`[wellfound] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
