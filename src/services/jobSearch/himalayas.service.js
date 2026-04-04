const axios = require('axios');

const search = async ({ role }) => {
  const { data } = await axios.get('https://himalayas.app/jobs/api/search', {
    params:  { q: role, limit: 20 },
    timeout: 8000,
  });

  return (data?.jobs || []).map(j => ({
    externalId:  String(j.id   || j.slug || ''),
    title:       j.title       || '',
    company:     j.company?.name || '',
    location:    j.location    || 'Remote',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.applicationLink || '',
    salary:      j.salaryRange || 'Not specified',
    source:      'Himalayas',
    remote:      true,
    postedAt:    j.createdAt   || null,
  }));
};

module.exports = { search };