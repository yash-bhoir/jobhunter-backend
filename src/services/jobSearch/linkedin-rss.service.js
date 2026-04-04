/**
 * LinkedIn Jobs — guest HTML API (no auth required)
 * Uses LinkedIn's public job search endpoint that returns HTML job cards.
 * Free, no API key needed.
 */
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.linkedin.com/',
};

const search = async ({ role, location, workType }) => {
  try {
    const params = {
      keywords: role,
      location: location || '',
      start:    0,
      count:    25,
    };

    // f_WT: 1=onsite, 2=remote, 3=hybrid
    if (workType === 'remote')  params.f_WT = 2;
    if (workType === 'onsite')  params.f_WT = 1;
    if (workType === 'hybrid')  params.f_WT = 3;

    const { data } = await axios.get(BASE, {
      params,
      headers: HEADERS,
      timeout: 12000,
    });

    const $ = cheerio.load(data);
    const jobs = [];

    $('li').each((_, el) => {
      const card       = $(el);
      const title      = card.find('.base-search-card__title').text().trim();
      const company    = card.find('.base-search-card__subtitle').text().trim();
      const loc        = card.find('.job-search-card__location').text().trim();
      const url        = card.find('a.base-card__full-link').attr('href') || '';
      const postedText = card.find('time').attr('datetime') || null;
      const jobId      = card.attr('data-entity-urn')?.split(':').pop() || url;

      if (!title || !company) return;

      jobs.push({
        externalId:  `linkedin-${jobId}`,
        title,
        company,
        location:    loc,
        description: '',            // LinkedIn doesn't give description in listing
        url:         url.split('?')[0], // clean tracking params
        salary:      'Not specified',
        source:      'LinkedIn',
        remote:      workType === 'remote' || loc.toLowerCase().includes('remote'),
        postedAt:    postedText || null,
      });
    });

    logger.info(`[linkedin-rss] found ${jobs.length} jobs`);
    return jobs;
  } catch (err) {
    logger.warn(`[linkedin-rss] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
