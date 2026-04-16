const axios = require('axios');

// Ashby ATS — direct job listings from modern high-growth companies
// Completely FREE — no API key required (public posting API)
// Covers: Ramp, Watershed, Temporal, Supabase, PlanetScale, etc.

const COMPANIES = [
  'ramp', 'watershed', 'temporal', 'supabase', 'planetscale',
  'turso', 'neon', 'clerk', 'resend', 'inngest',
  'trigger', 'stytch', 'workos', 'propelauth', 'zitadel',
  'highlight', 'axiom', 'betterstack', 'grafbase', 'wundergraph',
  'speakeasy', 'fern', 'mintlify', 'readme', 'stoplight',
];

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data } = await axios.post(
      `https://api.ashbyhq.com/posting-api/job-board/${company}`,
      {},
      { timeout: 8000 }
    );

    const kw = (roleKeyword || '').toLowerCase();
    return (data?.jobPostings || [])
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
  const batches = [];
  for (let i = 0; i < COMPANIES.length; i += 6) {
    const batch = COMPANIES.slice(i, i + 6);
    const results = await Promise.all(batch.map(c => fetchCompany(c, role)));
    batches.push(...results.flat());
  }
  return batches;
};

module.exports = { search };
