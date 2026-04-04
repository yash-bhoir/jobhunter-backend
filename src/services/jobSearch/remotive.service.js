const axios = require('axios');

const search = async ({ role }) => {
  const { data } = await axios.get('https://remotive.com/api/remote-jobs', {
    params:  { search: role, limit: 20 },
    timeout: 8000,
  });

  return (data?.jobs || []).map(j => ({
    externalId:  String(j.id || ''),
    title:       j.title        || '',
    company:     j.company_name || '',
    location:    j.candidate_required_location || 'Remote',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.url          || '',
    salary:      j.salary       || 'Not specified',
    source:      'Remotive',
    remote:      true,
    postedAt:    j.publication_date || null,
  }));
};

module.exports = { search };