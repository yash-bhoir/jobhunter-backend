const axios = require('axios');

// Jooble — global job aggregator, free tier available
// Get key at: https://jooble.org/api/about
// Add JOOBLE_API_KEY in admin panel → API Keys

const search = async ({ role, location }) => {
  if (!process.env.JOOBLE_API_KEY) return [];

  const { data } = await axios.post(
    `https://jooble.org/api/${process.env.JOOBLE_API_KEY}`,
    {
      keywords: role       || '',
      location: location   || '',
      page:     '1',
      resultsOnPage: 15,
    },
    { timeout: 10000 }
  );

  return (data?.jobs || []).map(j => ({
    externalId:  String(j.id    || ''),
    title:       j.title        || '',
    company:     j.company      || '',
    location:    j.location     || '',
    description: (j.snippet     || '').replace(/<[^>]*>/g, ''),
    url:         j.link         || '',
    salary:      j.salary       || 'Not specified',
    source:      'Jooble',
    remote:      (j.type        || '').toLowerCase().includes('remote') ||
                 (j.title       || '').toLowerCase().includes('remote'),
    postedAt:    j.updated      || null,
  }));
};

module.exports = { search };
