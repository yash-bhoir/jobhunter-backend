const axios  = require('axios');
const logger = require('../../config/logger');

// Ashby ATS — public job board at jobs.ashbyhq.com/{company}
// The JSON posting API (api.ashbyhq.com/posting-api/...) returns 401 for unauthenticated callers;
// we fall back to parsing embedded "jobPostings" from the HTML job board page.

const COMPANIES = [
  'supabase', 'clerk', 'resend', 'inngest', 'trigger',
  'stytch', 'workos', 'highlight', 'axiom', 'betterstack',
  'speakeasy', 'mintlify', 'readme', 'watershed', 'temporal',
  'neon', 'turso', 'propelauth', 'grafbase', 'fern',
  'mercury', 'ramp', 'wundergraph', 'stoplight', 'zitadel',
];

const JOB_BOARD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function titleMatchesRole(title, roleKeyword) {
  if (!roleKeyword) return true;
  const tokens = roleKeyword.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!tokens.length) return true;
  const t = (title || '').toLowerCase();
  return tokens.some(tok => t.includes(tok));
}

/** Extract the JSON array after `"jobPostings":` from Ashby job-board HTML (SPA bootstrap). */
function extractJobPostingsFromJobBoardHtml(html) {
  if (typeof html !== 'string') return null;
  const key = '"jobPostings":';
  const idx = html.indexOf(key);
  if (idx === -1) return null;
  let pos = idx + key.length;
  while (pos < html.length && ' \t\n\r'.includes(html[pos])) pos += 1;
  if (html[pos] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  const start = pos;
  for (let i = pos; i < html.length; i += 1) {
    const c = html[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function displayCompany(company) {
  return company.charAt(0).toUpperCase() + company.slice(1);
}

function mapAshbyPosting(company, j, fromApi) {
  const url = fromApi && j.jobUrl
    ? j.jobUrl
    : `https://jobs.ashbyhq.com/${company}/${j.id || ''}`;
  const descHtml = j.descriptionHtml || '';
  const fallbackBits = [j.departmentName, j.teamName, j.employmentType]
    .filter(Boolean)
    .join(' · ');
  const description = descHtml
    ? descHtml.replace(/<[^>]*>/g, '').substring(0, 3000)
    : fallbackBits;

  const compLabel = j.compensation?.summaryComponents?.[0]?.label
    ? String(j.compensation.summaryComponents[0].label)
    : (typeof j.compensationTierSummary === 'string'
      ? j.compensationTierSummary
      : (j.compensationTierSummary && typeof j.compensationTierSummary === 'object' && j.compensationTierSummary.label
        ? String(j.compensationTierSummary.label)
        : 'Not specified'));

  const remoteHint = `${j.locationName || ''} ${j.workplaceType || ''}`.toLowerCase();

  return {
    externalId:  j.id               || '',
    title:       j.title            || '',
    company:     displayCompany(company),
    location:    j.locationName     || j.employmentType || 'Not specified',
    description,
    url,
    salary:      compLabel,
    source:      'Ashby',
    remote:      Boolean(j.isRemote) ||
                 remoteHint.includes('remote') ||
                 String(j.workplaceType || '').toLowerCase() === 'remote',
    postedAt:    j.publishedDate    || null,
  };
}

const fetchCompanyFromJobBoardPage = async (company, roleKeyword) => {
  try {
    const { data: html, status } = await axios.get(`https://jobs.ashbyhq.com/${company}`, {
      headers: {
        'User-Agent': JOB_BOARD_UA,
        Accept:         'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      timeout: 12000,
      validateStatus: s => s < 500,
    });
    if (status !== 200 || typeof html !== 'string') return [];

    const postings = extractJobPostingsFromJobBoardHtml(html);
    if (!Array.isArray(postings) || postings.length === 0) return [];

    return postings
      .filter(j => j.isListed !== false)
      .filter(j => titleMatchesRole(j.title, roleKeyword))
      .map(j => mapAshbyPosting(company, j, false));
  } catch (err) {
    logger.debug(`[ashby] job-board HTML ${company}: ${err.message}`);
    return [];
  }
};

const fetchCompany = async (company, roleKeyword) => {
  try {
    const { data, status } = await axios.post(
      `https://api.ashbyhq.com/posting-api/job-board/${company}`,
      {},
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
        validateStatus: s => s < 500,
      }
    );

    if (status === 200 && data && Array.isArray(data.jobPostings) && data.jobPostings.length) {
      return data.jobPostings
        .filter(j => titleMatchesRole(j.title, roleKeyword))
        .map(j => mapAshbyPosting(company, j, true));
    }
  } catch (err) {
    if (err.response?.status && err.response.status !== 401 && err.response.status !== 404) {
      logger.debug(`[ashby] API ${company}: ${err.response.status}`);
    }
  }

  const fromHtml = await fetchCompanyFromJobBoardPage(company, roleKeyword);
  return fromHtml;
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
