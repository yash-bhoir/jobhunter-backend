const axios = require('axios');

const search = async ({ role }) => {
  const tag = role.toLowerCase().replace(/\s+/g, '-');
  const { data } = await axios.get(`https://remoteok.com/api?tag=${tag}`, {
    timeout: 8000,
    headers: { 'User-Agent': 'JobHunter/1.0' },
  });

  const jobs = Array.isArray(data) ? data.slice(1) : [];
  return jobs.map(j => ({
    externalId:  String(j.id || ''),
    title:       j.position  || '',
    company:     j.company   || '',
    location:    'Remote',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.url        || '',
    salary:      j.salary     || 'Not specified',
    source:      'RemoteOK',
    remote:      true,
    postedAt:    j.date       || null,
  }));
};

module.exports = { search };