const axios = require('axios');

const search = async ({ role, location }) => {
  const { data } = await axios.get('https://public.api.careerjet.net/search', {
    params: {
      keywords:   role,
      location:   location || 'India',
      affid:      process.env.CAREERJET_AFFID || 'test',
      user_ip:    '1.2.3.4',
      url:        'https://jobhunter.in',
      user_agent: 'JobHunterBot/1.0',
      pagesize:   15,
      page:       1,
    },
    timeout: 8000,
  });

  return (data?.jobs || []).map(j => ({
    externalId:  j.url           || '',
    title:       j.title         || '',
    company:     j.company       || '',
    location:    j.locations     || '',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.url           || '',
    salary:      j.salary        || 'Not specified',
    source:      'CareerJet',
    remote:      (j.title || '').toLowerCase().includes('remote'),
    postedAt:    null,
  }));
};

module.exports = { search };