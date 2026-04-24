const axios = require('axios');

// Findwork.dev — clean tech job aggregator, free API
// Get key at: https://findwork.dev/api/#authentication
// Add FINDWORK_API_KEY in admin panel → API Keys

const search = async ({ role, location, workType }) => {
  if (!process.env.FINDWORK_API_KEY) return [];

  const params = {
    search:   role     || '',
    ordering: '-date',
  };

  // Remote + city together over-constrains Findwork (US-centric index); use remote flag only.
  if (workType === 'remote') params.remote = true;
  else if (location) params.location = location;

  const { data } = await axios.get('https://findwork.dev/api/jobs/', {
    params,
    headers: { Authorization: `Token ${process.env.FINDWORK_API_KEY}` },
    timeout: 10000,
  });

  return (data?.results || []).map(j => ({
    externalId:  String(j.id    || ''),
    title:       j.role         || '',
    company:     j.company_name || '',
    location:    j.location     || (j.remote ? 'Remote' : ''),
    description: (j.text        || '').replace(/<[^>]*>/g, ''),
    url:         j.url          || '',
    salary:      'Not specified',
    source:      'Findwork',
    remote:      j.remote       || false,
    postedAt:    j.date_posted  || null,
  }));
};

module.exports = { search };
