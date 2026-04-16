const axios  = require('axios');
const logger = require('../../config/logger');

// Recruitee ATS — direct job listings from EU & global companies
// Completely FREE — no API key required (public offers API)

const COMPANIES = [
  // Verified active on Recruitee (checked April 2026)
  'mollie', 'sendcloud', 'bynder', 'picnic', 'swapfiets',
  'mews', 'productboard', 'apify', 'rossum', 'lokalise',
  'printify', 'kiwi-com', 'rohlik', 'grammarly', 'preply',
  'epam', 'devexperts', 'paxful', 'cossack-labs', 'mall-group',
];

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.get(
      `https://${company}.recruitee.com/api/offers/`,
      { timeout: 8000 }
    );

    if (!data?.offers) return [];

    const kw = (roleKeyword || '').toLowerCase();
    return data.offers
      .filter(j => !kw || (j.title || '').toLowerCase().includes(kw))
      .map(j => ({
        externalId:  String(j.id    || ''),
        title:       j.title        || '',
        company:     j.company_name || company.charAt(0).toUpperCase() + company.slice(1),
        location:    j.location     || j.city || 'Not specified',
        description: (j.description || '').replace(/<[^>]*>/g, '').substring(0, 3000),
        url:         j.careers_url  || '',
        salary:      'Not specified',
        source:      'Recruitee',
        remote:      (j.remote      || false) ||
                     (j.location    || '').toLowerCase().includes('remote'),
        postedAt:    j.published_at || null,
      }));
  } catch {
    return [];
  }
};

const search = async ({ role }) => {
  const all = [];
  for (let i = 0; i < COMPANIES.length; i += 6) {
    const batch   = COMPANIES.slice(i, i + 6);
    const results = await Promise.all(batch.map(c => fetchCompany(c, role)));
    all.push(...results.flat());
  }
  logger.info(`[recruitee] found ${all.length} jobs`);
  return all;
};

module.exports = { search };
