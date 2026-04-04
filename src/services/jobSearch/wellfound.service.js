/**
 * Wellfound (formerly AngelList Talent) — startup jobs
 * Uses Wellfound's public search API.
 * Free, no API key needed. Best for startup roles with equity info.
 */
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://wellfound.com/',
};

const search = async ({ role, location, workType }) => {
  try {
    const slug    = role.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const locSlug = (location || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    let url = `https://wellfound.com/jobs?q=${encodeURIComponent(role)}`;
    if (locSlug) url += `&l=${encodeURIComponent(location)}`;
    if (workType === 'remote') url += '&remote=true';

    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 12000,
    });

    const $    = cheerio.load(data);
    const jobs = [];

    // Wellfound job card selectors (may change with site updates)
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

    logger.info(`[wellfound] found ${jobs.length} jobs`);
    return jobs;
  } catch (err) {
    logger.warn(`[wellfound] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
