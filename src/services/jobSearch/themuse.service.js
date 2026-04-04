const axios = require('axios');

const search = async ({ role }) => {
  const { data } = await axios.get('https://www.themuse.com/api/public/jobs', {
    params:  { role, page: 1 },
    timeout: 8000,
  });

  return (data?.results || []).map(j => ({
    externalId:  String(j.id || ''),
    title:       j.name             || '',
    company:     j.company?.name    || '',
    location:    j.locations?.[0]?.name || 'Not specified',
    description: (j.contents || '').replace(/<[^>]*>/g, ''),
    url:         j.refs?.landing_page || '',
    salary:      'Not specified',
    source:      'The Muse',
    remote:      j.locations?.some(l => l.name?.toLowerCase().includes('remote')) || false,
    postedAt:    j.publication_date  || null,
  }));
};

module.exports = { search };