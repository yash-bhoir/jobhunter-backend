const axios  = require('axios');
const logger = require('../../config/logger');

// Recruitee Careers Site API (no auth): GET https://{subdomain}.recruitee.com/api/offers
// Docs: https://docs.recruitee.com/reference/intro-to-careers-site-api
// Slugs must be refreshed — companies migrate off Recruitee or change subdomain often.

const COMPANIES = [
  // Verified returning JSON with `offers` (Apr 2026)
  'bunq',
  'personio',
  'improvado',
  'sendcloud',
];

function titleMatchesRole(title, roleKeyword) {
  if (!roleKeyword) return true;
  const tokens = roleKeyword.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!tokens.length) return true;
  const t = (title || '').toLowerCase();
  return tokens.some(tok => t.includes(tok));
}

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data, status } = await axios.get(
      `https://${company}.recruitee.com/api/offers`,
      { timeout: 8000, validateStatus: s => s < 500 },
    );
    if (status === 404) return [];

    if (!data?.offers) return [];

    return data.offers
      .filter(j => titleMatchesRole(j.title, roleKeyword))
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
  } catch (err) {
    // 404 = company no longer on Recruitee; log other errors only
    if (err.response?.status !== 404) {
      logger.debug(`[recruitee] ${company}: ${err.response?.status ?? err.message}`);
    }
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
