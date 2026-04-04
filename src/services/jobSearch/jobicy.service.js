const axios = require('axios');

const search = async ({ role }) => {
  const { data } = await axios.get('https://jobicy.com/api/v2/remote-jobs', {
    params:  { tag: role, count: 20 },
    timeout: 8000,
  });

  return (data?.jobs || []).map(j => ({
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