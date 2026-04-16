const axios  = require('axios');
const logger = require('../../config/logger');

// Ashby ATS — direct job listings from modern high-growth companies
// Completely FREE — no API key required (public posting API)

const COMPANIES = [
  'supabase', 'clerk', 'resend', 'inngest', 'trigger',
  'stytch', 'workos', 'highlight', 'axiom', 'betterstack',
  'speakeasy', 'mintlify', 'readme', 'watershed', 'temporal',
  'neon', 'turso', 'propelauth', 'grafbase', 'fern',
  'mercury', 'ramp', 'wundergraph', 'stoplight', 'zitadel',
];

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.post(
      `https://api.ashbyhq.com/posting-api/job-board/${company}`,
      {},
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      }
    );

    // Guard against unexpected responses
    if (!data || !Array.isArray(data.jobPostings)) return [];

    const kw = (roleKeyword || '').toLowerCase();
    return data.jobPostings
      .filter(j => !kw || (j.title || '').toLowerCase().includes(kw))
      .map(j => ({
        externalId:  j.id               || '',
        title:       j.title            || '',
        company:     company.charAt(0).toUpperCase() + company.slice(1),
        location:    j.locationName     || j.employmentType || 'Not specified',
        description: (j.descriptionHtml || '').replace(/<[^>]*>/g, '').substring(0, 3000),
        url:         j.jobUrl           || '',
        salary:      j.compensation
                       ? `${j.compensation.summaryComponents?.[0]?.label || 'Not specified'}`
                       : 'Not specified',
        source:      'Ashby',
        remote:      (j.isRemote        || false) ||
                     (j.locationName    || '').toLowerCase().includes('remote'),
        postedAt:    j.publishedDate    || null,
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
  logger.info(`[ashby] found ${all.length} jobs`);
  return all;
};

module.exports = { search };
