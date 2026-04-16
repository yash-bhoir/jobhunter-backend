const axios = require('axios');

const searchPeople = async (company, titles = ['HR Manager', 'Recruiter', 'Talent Acquisition']) => {
  if (!process.env.APOLLO_API_KEY) return [];

  try {
    const { data } = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/search',
      {
        organization_names: [company],
        person_titles:      titles,
        page:               1,
        per_page:           5,
      },
      {
        headers: {
          'x-api-key':      process.env.APOLLO_API_KEY,
          'Content-Type':   'application/json',
          'Cache-Control':  'no-cache',
        },
        timeout: 10000,
      }
    );

    return (data?.people || []).map(p => ({
      email:      p.email        || null,
      name:       p.name         || 'Unknown',
      title:      p.title        || 'HR',
      linkedin:   p.linkedin_url || null,
      confidence: p.email ? 85   : 0,
      source:     'apollo',
      // Apollo returns real email addresses from their database → verified
      status:     p.email ? 'verified' : 'unknown',
    }));
  } catch (err) {
    // Apollo free plan has strict limits — return empty instead of crashing
    return [];
  }
};

module.exports = { searchPeople };