/**
 * LinkedIn Jobs — guest HTML API (no auth required)
 * Uses LinkedIn's public job search endpoint that returns HTML job cards,
 * then fetches full descriptions for the top results so the scorer has
 * real text to match against the user's skills.
 *
 * Free, no API key needed.
 */
const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../config/logger');

const BASE       = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const JOB_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.linkedin.com/',
};

// Map years of experience → LinkedIn f_E filter
// 1=Internship, 2=Entry level, 3=Associate, 4=Mid-Senior, 5=Director, 6=Executive
const expToFilter = (years) => {
  if (years === 0)      return '1,2';  // intern + entry
  if (years <= 2)       return '2,3';  // entry + associate
  if (years <= 5)       return '3,4';  // associate + mid-senior
  if (years <= 10)      return '4';    // mid-senior
  return '5,6';                        // director / exec
};

// Fetch description HTML for a single LinkedIn job id (best-effort)
const fetchDescription = async (jobId) => {
  try {
    const { data } = await axios.get(`${JOB_DETAIL}/${jobId}`, {
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' },
      timeout: 8000,
    });
    const $  = cheerio.load(data);
    // Try multiple selectors in order of specificity
    const desc =
      $('.show-more-less-html__markup').text().trim() ||
      $('.description__text').text().trim()          ||
      $('section.description').text().trim();
    return desc ? desc.substring(0, 3000) : '';
  } catch {
    return '';
  }
};

const search = async ({ role, location, workType, skills = [], experience = 0 }) => {
  try {
    // Build an enriched keyword string:
    // Append the top 3 skills so LinkedIn's internal ranker sees them.
    const topSkills = skills.slice(0, 3).join(' ');
    const keywords  = topSkills ? `${role} ${topSkills}` : role;

    const params = {
      keywords,
      location: location || '',
      start:    0,
      count:    50,                        // increased from 25
    };

    // Work type filter
    if (workType === 'remote')  params.f_WT = 2;
    if (workType === 'onsite')  params.f_WT = 1;
    if (workType === 'hybrid')  params.f_WT = 3;

    // Experience level filter
    params.f_E = expToFilter(experience);

    // Jobs posted within the last month (improves freshness)
    params.f_TPR = 'r2592000';

    const { data } = await axios.get(BASE, {
      params,
      headers: HEADERS,
      timeout: 12000,
    });

    const $    = cheerio.load(data);
    const jobs = [];

    $('li').each((_, el) => {
      const card       = $(el);
      const title      = card.find('.base-search-card__title').text().trim();
      const company    = card.find('.base-search-card__subtitle').text().trim();
      const loc        = card.find('.job-search-card__location').text().trim();
      const url        = card.find('a.base-card__full-link').attr('href') || '';
      const postedText = card.find('time').attr('datetime') || null;
      const jobId      = card.attr('data-entity-urn')?.split(':').pop() || '';

      if (!title || !company) return;

      jobs.push({
        _linkedinJobId: jobId,
        externalId:     `linkedin-${jobId}`,
        title,
        company,
        location:       loc,
        description:    '',
        url:            url.split('?')[0],   // strip tracking params
        salary:         'Not specified',
        source:         'LinkedIn',
        remote:         workType === 'remote' || loc.toLowerCase().includes('remote'),
        postedAt:       postedText || null,
      });
    });

    logger.info(`[linkedin-rss] fetched ${jobs.length} listings`);

    // ── Fetch descriptions for top 15 results (concurrent, best-effort) ──
    // This is the critical improvement: empty descriptions get 0 skill points
    // from the scorer. Fetching descriptions makes skill matching work for LinkedIn.
    const toFetch = jobs.slice(0, 15);
    await Promise.allSettled(
      toFetch.map(async (job) => {
        if (!job._linkedinJobId) return;
        const desc = await fetchDescription(job._linkedinJobId);
        if (desc) job.description = desc;
      })
    );

    // Clean up internal temp field
    jobs.forEach(j => delete j._linkedinJobId);

    const withDesc = jobs.filter(j => j.description.length > 0).length;
    logger.info(`[linkedin-rss] fetched descriptions for ${withDesc}/${toFetch.length} jobs`);

    return jobs;
  } catch (err) {
    logger.warn(`[linkedin-rss] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
