/**
 * Reed.co.uk — UK's largest job board (PAID, admin-controlled)
 * Free tier: 100 calls/day. Paid: unlimited.
 * Requires REED_API_KEY. Disabled by default — admin must enable.
 *
 * Docs: https://www.reed.co.uk/developers/jobseeker
 */
const axios  = require('axios');
const logger = require('../../config/logger');

const search = async ({ role, location, workType }) => {
  const apiKey = process.env.REED_API_KEY;
  if (!apiKey) return []; // not configured — skip silently

  try {
    const params = {
      keywords:     role,
      locationName: location || '',
      resultsToTake: 25,
    };

    if (workType === 'remote') params.distanceFromLocation = 0;

    // Reed uses HTTP Basic Auth: api_key as username, empty password
    const { data } = await axios.get('https://www.reed.co.uk/api/1.0/search', {
      params,
      auth:    { username: apiKey, password: '' },
      timeout: 12000,
    });

    return (data?.results || []).map(j => ({
      externalId:  `reed-${j.jobId}`,
      title:       j.jobTitle       || '',
      company:     j.employerName   || '',
      location:    j.locationName   || location || '',
      description: j.jobDescription || '',
      url:         j.jobUrl         || `https://www.reed.co.uk/jobs/${j.jobId}`,
      salary:      j.minimumSalary
                     ? `£${j.minimumSalary.toLocaleString()} - £${(j.maximumSalary || j.minimumSalary).toLocaleString()}`
                     : 'Not specified',
      source:      'Reed',
      remote:      j.locationName?.toLowerCase().includes('remote') || workType === 'remote' || false,
      postedAt:    j.date || null,
    }));
  } catch (err) {
    logger.warn(`[reed] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
