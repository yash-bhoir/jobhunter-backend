const axios = require('axios');

const COUNTRY_MAP = {
  'India': 'in', 'United States': 'us', 'UK': 'gb',
  'United Kingdom': 'gb', 'Canada': 'ca', 'Australia': 'au',
  'Germany': 'de', 'Singapore': 'sg', 'UAE': 'ae',
};

const search = async ({ role, location }) => {
  if (!process.env.ADZUNA_APP_ID) return [];

  const country = COUNTRY_MAP[location?.split(',')[0]?.trim()] || 'in';
  const { data } = await axios.get(
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1`,
    {
      params: {
        app_id:          process.env.ADZUNA_APP_ID,
        app_key:         process.env.ADZUNA_APP_KEY,
        what:            role,
        where:           location || 'India',
        results_per_page: 15,
      },
      timeout: 10000,
    }
  );

  return (data?.results || []).map(j => ({
    externalId:  String(j.id || ''),
    title:       j.title                  || '',
    company:     j.company?.display_name  || '',
    location:    j.location?.display_name || '',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.redirect_url           || '',
    salary:      j.salary_min
                   ? `${Math.round(j.salary_min)} - ${Math.round(j.salary_max)}`
                   : 'Not specified',
    source:      'Adzuna',
    remote:      (j.title || '').toLowerCase().includes('remote'),
    postedAt:    j.created                || null,
  }));
};

module.exports = { search };