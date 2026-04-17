const axios  = require('axios');
const logger = require('../../config/logger');

// Apollo.io — free plan allows organization search + people enrichment
// NOTE: /api/v1/mixed_people/search requires a paid plan ($49/mo)
// Free plan allows: /v1/organizations/search (no emails, but gets company info + LinkedIn)
// To get people with emails on free plan: use the web app export (50/month)
// API docs: https://apolloio.github.io/apollo-api-docs/

// ── Search people (paid plan endpoint) ───────────────────────────
// Only works with Basic plan ($49/mo) or higher
const searchPeople = async (company, titles = ['HR Manager', 'Recruiter', 'Talent Acquisition']) => {
  if (!process.env.APOLLO_API_KEY) return [];

  try {
    const { data } = await axios.post(
      'https://api.apollo.io/v1/mixed_people/search',
      {
        organization_names: [company],
        person_titles:      titles,
        page:               1,
        per_page:           5,
      },
      {
        headers: {
          'x-api-key':     process.env.APOLLO_API_KEY,
          'Content-Type':  'application/json',
          'Cache-Control': 'no-cache',
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
      status:     p.email ? 'verified' : 'unknown',
    }));
  } catch (err) {
    // 403 = free plan — silently return empty, caller falls through to next layer
    if (err.response?.status === 403) {
      logger.info('[Apollo] people search requires paid plan — skipping');
    } else {
      logger.warn(`[Apollo] searchPeople failed for ${company}: ${err.message}`);
    }
    return [];
  }
};

// ── Organization search (FREE plan) ──────────────────────────────
// Returns company LinkedIn URL, website, industry, employee count.
// No emails — but gives us the LinkedIn company page to find HR manually.
const searchOrganization = async (company) => {
  if (!process.env.APOLLO_API_KEY) return null;

  try {
    const { data } = await axios.post(
      'https://api.apollo.io/v1/organizations/search',
      { q_organization_name: company, per_page: 1 },
      {
        headers: {
          'x-api-key':    process.env.APOLLO_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const org = data?.organizations?.[0];
    if (!org) return null;

    return {
      name:          org.name               || company,
      website:       org.website_url        || null,
      linkedin:      org.linkedin_url       || null,
      industry:      org.industry           || null,
      employeeCount: org.estimated_num_employees || null,
      source:        'apollo-org',
    };
  } catch (err) {
    logger.warn(`[Apollo] searchOrganization failed for ${company}: ${err.message}`);
    return null;
  }
};

module.exports = { searchPeople, searchOrganization };
