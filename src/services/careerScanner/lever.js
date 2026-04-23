const axios  = require('axios');
const logger = require('../../config/logger');

/**
 * Fetch all open jobs from Lever's public posting API.
 * Used by Atlassian, Shopify, Discord, Razorpay, CRED, etc.
 * Docs: https://hire.lever.co/developer/postings
 */
const fetchLever = async ({ name, slug }) => {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=500`;
    const { data } = await axios.get(url, { timeout: 10000 });

    return (data || []).map(j => ({
      id:          `lever_${slug}_${j.id}`,
      title:       j.text         || '',
      company:     name,
      location:    j.categories?.location || j.workplaceType || 'On-site',
      url:         j.hostedUrl    || j.applyUrl || `https://jobs.lever.co/${slug}/${j.id}`,
      description: j.descriptionPlain || j.description || '',
      remote:      /remote/i.test(j.categories?.location || '') || j.workplaceType === 'remote',
      postedAt:    j.createdAt    ? new Date(j.createdAt) : new Date(),
      source:      'career_page',
      platform:    'lever',
      boardKey:    `lever:${slug}`,
    }));
  } catch (err) {
    if (err.response?.status === 404) return [];
    logger.warn(`Lever fetch failed for ${name}: ${err.message}`);
    return [];
  }
};

module.exports = { fetchLever };
