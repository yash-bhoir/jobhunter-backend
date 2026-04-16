const axios = require('axios');

// Greenhouse ATS — direct job listings from Big Tech & top companies
// Completely FREE — no API key required (public job board API)
// Covers: Stripe, Airbnb, Coinbase, Discord, Duolingo, Brex, Plaid, Rippling, etc.

const COMPANIES = [
  'stripe', 'airbnb', 'coinbase', 'discord', 'duolingo', 'brex',
  'plaid', 'rippling', 'gusto', 'robinhood', 'chime', 'ramp',
  'scale-ai', 'anduril', 'benchling', 'lattice', 'greenhouse',
  'asana', 'gitlab', 'hashicorp', 'datadog', 'mongodb',
  'confluent', 'dbt-labs', 'huggingface',
];

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.get(
      `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`,
      { params: { content: false }, timeout: 8000 }
    );

    const kw = (roleKeyword || '').toLowerCase();
    return (data?.jobs || [])
      .filter(j => !kw || (j.title || '').toLowerCase().includes(kw))
      .map(j => ({
        externalId:  String(j.id   || ''),
        title:       j.title       || '',
        company:     company.charAt(0).toUpperCase() + company.slice(1).replace(/-/g, ' '),
        location:    j.location?.name || 'Not specified',
        description: '',
        url:         j.absolute_url  || '',
        salary:      'Not specified',
        source:      'Greenhouse',
        remote:      (j.location?.name || '').toLowerCase().includes('remote') ||
                     (j.title          || '').toLowerCase().includes('remote'),
        postedAt:    j.updated_at || null,
      }));
  } catch {
    return [];
  }
};

const search = async ({ role }) => {
  const batches = [];
  // Query companies in batches of 6 to avoid hammering
  for (let i = 0; i < COMPANIES.length; i += 6) {
    const batch = COMPANIES.slice(i, i + 6);
    const results = await Promise.all(batch.map(c => fetchCompany(c, role)));
    batches.push(...results.flat());
  }
  return batches;
};

module.exports = { search };
