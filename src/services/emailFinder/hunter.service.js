const axios = require('axios');

const searchDomain = async (domain) => {
  if (!process.env.HUNTER_API_KEY) return null;

  const { data } = await axios.get('https://api.hunter.io/v2/domain-search', {
    params: {
      domain,
      api_key: process.env.HUNTER_API_KEY,
      limit:   10,
    },
    timeout: 8000,
  });

  const emails = (data?.data?.emails || []).map(e => ({
    email:      e.value,
    name:       `${e.first_name || ''} ${e.last_name || ''}`.trim() || 'Unknown',
    title:      e.position || 'HR',
    confidence: e.confidence || 0,
    source:     'hunter',
    linkedin:   e.linkedin || null,
  }));

  return {
    domain,
    emails,
    organization: data?.data?.organization || null,
    totalEmails:  data?.data?.emails?.length || 0,
  };
};

const findEmail = async (domain, firstName, lastName) => {
  if (!process.env.HUNTER_API_KEY) return null;

  const { data } = await axios.get('https://api.hunter.io/v2/email-finder', {
    params: {
      domain,
      first_name: firstName,
      last_name:  lastName,
      api_key:    process.env.HUNTER_API_KEY,
    },
    timeout: 8000,
  });

  if (!data?.data?.email) return null;

  return {
    email:      data.data.email,
    confidence: data.data.score || 0,
    source:     'hunter',
  };
};

module.exports = { searchDomain, findEmail };