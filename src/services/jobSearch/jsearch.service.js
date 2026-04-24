const axios = require('axios');

const search = async ({ role, location, workType, skills = [] }) => {
  if (!process.env.RAPIDAPI_KEY) return [];
  // Build an enriched query: include top skills so JSearch's ranker
  // returns results that actually mention the user's tech stack.
  const topSkills   = skills.slice(0, 4).join(' ');
  const roleQuery   = topSkills ? `${role} ${topSkills}` : role;
  // For remote jobs, skip location — remote_jobs_only=true already scopes it globally.
  // Including a specific city (e.g. "in Bengaluru") with remote_jobs_only returns 0 results.
  const query = (workType === 'remote' || !location)
    ? roleQuery
    : `${roleQuery} in ${location}`;

  // Map experience to JSearch employment type / date filter
  // JSearch uses date_posted to trim staleness; keep to 'month' for freshness.
  const { data } = await axios.get('https://jsearch.p.rapidapi.com/search', {
    params: {
      query,
      page:             '1',
      num_pages:        '2',
      date_posted:      'month',
      remote_jobs_only: workType === 'remote' ? 'true' : 'false',
    },
    headers: {
      'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
    timeout: 20000,
  });

  return (data?.data || []).map(j => ({
    externalId:  j.job_id,
    title:       j.job_title,
    company:     j.employer_name,
    location:    `${j.job_city || ''}, ${j.job_country || ''}`,
    description: j.job_description || '',
    url:         j.job_apply_link  || '',
    salary:      j.job_min_salary
                   ? `${j.job_min_salary} - ${j.job_max_salary}`
                   : 'Not specified',
    source:      j.job_publisher || 'JSearch',
    remote:      j.job_is_remote || false,
    postedAt:    j.job_posted_at_datetime_utc || null,
  }));
};

module.exports = { search };
