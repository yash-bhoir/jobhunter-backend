const axios  = require('axios');
const logger = require('../../config/logger');

/**
 * Fetch all open jobs for a company on Greenhouse's public board API.
 * Docs: https://developers.greenhouse.io/job-board.html
 * Zero auth required — completely public.
 */
const fetchGreenhouse = async ({ name, slug }) => {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const { data } = await axios.get(url, { timeout: 10000 });

    return (data.jobs || []).map(j => ({
      id:          `gh_${slug}_${j.id}`,
      title:       j.title        || '',
      company:     name,
      location:    j.location?.name || 'Remote',
      url:         j.absolute_url  || `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
      description: j.content       || '',
      remote:      /remote/i.test(j.location?.name || ''),
      postedAt:    j.updated_at    ? new Date(j.updated_at) : new Date(),
      source:      'career_page',
      platform:    'greenhouse',
    }));
  } catch (err) {
    if (err.response?.status === 404) return [];   // company not on Greenhouse / slug wrong
    logger.warn(`Greenhouse fetch failed for ${name}: ${err.message}`);
    return [];
  }
};

module.exports = { fetchGreenhouse };
