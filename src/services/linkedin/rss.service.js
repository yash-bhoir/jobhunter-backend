const Parser  = require('rss-parser');
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');

const parser = new Parser({
  customFields: {
    item: [
      ['title',       'title'],
      ['link',        'link'],
      ['pubDate',     'pubDate'],
      ['description', 'description'],
      ['guid',        'guid'],
    ],
  },
  timeout:    10000,
  headers:    {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
});

// Build LinkedIn job search RSS URL
const buildRssUrl = ({ role, location, workType }) => {
  const keywords = encodeURIComponent(role);
  const loc      = encodeURIComponent(location || 'India');

  // f_WT: 2 = remote, 1 = onsite, 3 = hybrid
  const remoteFilter =
    workType === 'remote' ? '&f_WT=2' :
    workType === 'onsite' ? '&f_WT=1' :
    workType === 'hybrid' ? '&f_WT=3' : '';

  return `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}${remoteFilter}&f_TPR=r86400&sortBy=DD`;
};

// Scrape LinkedIn jobs page (RSS is not always available)
const scrapeLinkedInJobs = async ({ role, location, workType }) => {
  try {
    const url = buildRssUrl({ role, location, workType });

    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);
    const jobs = [];

    // LinkedIn job cards
    $('div.base-card, li.jobs-search-results__list-item, .job-search-card').each((_, el) => {
      const title   = $(el).find('.base-search-card__title, h3.base-search-card__title').text().trim();
      const company = $(el).find('.base-search-card__subtitle, h4.base-search-card__subtitle').text().trim();
      const loc     = $(el).find('.job-search-card__location, .base-search-card__metadata').first().text().trim();
      const link    = $(el).find('a.base-card__full-link, a[href*="/jobs/view/"]').attr('href');
      const posted  = $(el).find('time').attr('datetime');

      if (title && company) {
        jobs.push({
          title:    title.replace(/\n/g, ' ').trim(),
          company:  company.replace(/\n/g, ' ').trim(),
          location: loc.replace(/\n/g, ' ').trim(),
          url:      link ? (link.startsWith('http') ? link : `https://linkedin.com${link}`) : '',
          postedAt: posted || new Date().toISOString(),
          remote:   workType === 'remote' ||
                    loc.toLowerCase().includes('remote'),
          source:   'linkedin_scrape',
        });
      }
    });

    logger.info(`LinkedIn scrape: found ${jobs.length} jobs for "${role}" in "${location}"`);
    return jobs;

  } catch (err) {
    logger.warn(`LinkedIn scrape failed: ${err.message}`);
    return [];
  }
};

// Try LinkedIn RSS feed
const fetchLinkedInRSS = async ({ role, location }) => {
  try {
    const keywords = encodeURIComponent(role);
    const loc      = encodeURIComponent(location || 'India');

    // LinkedIn RSS for job alerts
    const rssUrl = `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}&f_TPR=r86400&sortBy=DD`;

    // Try the JSON API endpoint that LinkedIn exposes
    const apiUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${keywords}&location=${loc}&f_TPR=r86400&start=0`;

    const { data: html } = await axios.get(apiUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept':          'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.linkedin.com',
      },
      timeout: 15000,
    });

    const $    = cheerio.load(html);
    const jobs = [];

    $('li').each((_, el) => {
      const title   = $(el).find('.base-search-card__title').text().trim();
      const company = $(el).find('.base-search-card__subtitle').text().trim();
      const loc     = $(el).find('.job-search-card__location').text().trim();
      const link    = $(el).find('a.base-card__full-link').attr('href');
      const posted  = $(el).find('time').attr('datetime');

      if (title && company) {
        jobs.push({
          title:    title.replace(/\s+/g, ' ').trim(),
          company:  company.replace(/\s+/g, ' ').trim(),
          location: loc.replace(/\s+/g, ' ').trim(),
          url:      link || '',
          postedAt: posted || null,
          remote:   loc.toLowerCase().includes('remote'),
          source:   'linkedin_api',
        });
      }
    });

    return jobs;

  } catch (err) {
    logger.warn(`LinkedIn API fetch failed: ${err.message}`);
    return [];
  }
};

module.exports = { scrapeLinkedInJobs, fetchLinkedInRSS, buildRssUrl };