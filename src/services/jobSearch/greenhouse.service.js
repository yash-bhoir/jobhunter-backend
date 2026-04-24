const axios  = require('axios');
const logger = require('../../config/logger');

// Greenhouse ATS — direct job listings from top companies
// Completely FREE — no API key required (public job board API)

const COMPANIES = [
  // Verified active on Greenhouse (checked April 2026)
  'gitlab', 'mongodb', 'datadog', 'hashicorp', 'confluent',
  'dbt-labs', 'huggingface', 'asana', 'benchling', 'lattice',
  'gusto', 'chime', 'plaid', 'brex', 'discord',
  'duolingo', 'coinbase', 'rippling', 'robinhood', 'scale-ai',
  'anduril', 'greenhouse', 'sourcegraph', 'teleport', 'pulumi',
];

// Split role into tokens; match if ANY token appears in the job title.
// "software developer" → ["software","developer"] matches "Software Engineer" via "software".
function titleMatchesRole(title, roleKeyword) {
  if (!roleKeyword) return true;
  const tokens = roleKeyword.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!tokens.length) return true;
  const t = (title || '').toLowerCase();
  return tokens.some(tok => t.includes(tok));
}

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.get(
      `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`,
      { params: { content: false }, timeout: 8000 }
    );

    if (!data?.jobs) return [];

    return data.jobs
      .filter(j => titleMatchesRole(j.title, roleKeyword))
      .map(j => ({
        externalId:  String(j.id   || ''),
        title:       j.title       || '',
        company:     j.company_name || company.charAt(0).toUpperCase() + company.slice(1).replace(/-/g, ' '),
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
  const all = [];
  for (let i = 0; i < COMPANIES.length; i += 6) {
    const batch   = COMPANIES.slice(i, i + 6);
    const results = await Promise.all(batch.map(c => fetchCompany(c, role)));
    all.push(...results.flat());
  }
  logger.info(`[greenhouse] found ${all.length} jobs`);
  return all;
};

module.exports = { search };
