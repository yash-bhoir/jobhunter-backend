const axios  = require('axios');
const logger = require('../../config/logger');

const search = async ({ role }) => {
  // Jobicy tag param expects a slug (e.g. "software-developer"), not a phrase.
  const tag = (role || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  let data;
  try {
    ({ data } = await axios.get('https://jobicy.com/api/v2/remote-jobs', {
      params:         { tag, count: 20 },
      timeout:        8000,
      validateStatus: s => s < 500,
    }));
  } catch (err) {
    logger.warn(`[jobicy] ${err.message}`);
    return [];
  }
  if (!data?.jobs) {
    logger.warn('[jobicy] unexpected response — no jobs key');
    return [];
  }

  return (data.jobs || []).map(j => ({
    externalId:  String(j.id || ''),
    title:       j.jobTitle    || '',
    company:     j.companyName || '',
    location:    j.jobGeo      || 'Remote',
    description: (j.jobExcerpt || '').replace(/<[^>]*>/g, ''),
    url:         j.url         || '',
    salary:      j.annualSalaryMin
                   ? `${j.annualSalaryMin} - ${j.annualSalaryMax}`
                   : 'Not specified',
    source:      'Jobicy',
    remote:      true,
    postedAt:    j.pubDate     || null,
  }));
};

module.exports = { search };