const axios = require('axios');

const search = async ({ role }) => {
  const { data } = await axios.get('https://www.arbeitnow.com/api/job-board-api', {
    params:  { search: role, page: 1 },
    timeout: 8000,
  });

  return (data?.data || []).map(j => ({
    externalId:  j.slug         || '',
    title:       j.title        || '',
    company:     j.company_name || '',
    location:    j.location     || 'Remote',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.url          || '',
    salary:      'Not specified',
    source:      'Arbeitnow',
    remote:      j.remote       || false,
    postedAt:    j.created_at   || null,
  }));
};

module.exports = { search };