/**
 * Probe public ATS boards so users can watch companies not in portals.js.
 */

const axios = require('axios');
const { fetchGreenhouse } = require('./greenhouse');
const { fetchAshby } = require('./ashby');
const { fetchLever } = require('./lever');
const { isValidDreamWatch } = require('./portals');

function normLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')
    .filter(Boolean);
}

/** Apex-ish label from domain, e.g. stripe.com → stripe */
function domainBase(domain) {
  const parts = normLabel(domain);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || '';
}

function slugCandidatesFromDomain(domain) {
  const base = domainBase(domain);
  if (!base) return [];
  const clean = base.replace(/[^a-z0-9-]/gi, '');
  const out = new Set();
  [clean, clean.replace(/-/g, ''), `${clean}-inc`, `${clean}hq`].forEach((s) => {
    if (s && s.length >= 2) out.add(s.toLowerCase());
  });
  return [...out].slice(0, 8);
}

function slugCandidatesFromName(name) {
  const t = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)[0];
  if (!t) return [];
  const out = new Set([t, t.replace(/[^a-z0-9]/gi, '')]);
  return [...out].filter((x) => x && x.length >= 2).slice(0, 4);
}

async function probeGreenhouseSlug(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
  try {
    const { status, data } = await axios.get(url, {
      params:    { per_page: 1 },
      timeout:   6000,
      validateStatus: () => true,
    });
    if (status === 200 && data && typeof data === 'object' && Array.isArray(data.jobs)) return 'greenhouse';
  } catch { /* ignore */ }
  return null;
}

async function probeLeverSlug(slug) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}`;
  try {
    const { status, data } = await axios.get(url, {
      params:    { mode: 'json', limit: 1 },
      timeout:   6000,
      validateStatus: () => true,
    });
    if (status === 200 && Array.isArray(data)) return 'lever';
  } catch { /* ignore */ }
  return null;
}

async function probeAshbySlug(slug) {
  try {
    const { data } = await axios.post(
      'https://jobs.ashbyhq.com/api/non-user-graphql',
      {
        operationName: 'ApiJobBoardWithTeams',
        variables:     { organizationHostedJobsPageName: slug },
        query: `
          query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
            jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
              jobPostings { id }
            }
          }
        `,
      },
      { timeout: 6000, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
    );
    const postings = data?.data?.jobBoard?.jobPostings;
    if (Array.isArray(postings)) return 'ashby';
  } catch { /* ignore */ }
  return null;
}

/**
 * Try platforms in order for slug until one responds like a real board.
 */
async function discoverPlatformForSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return null;
  if (await probeGreenhouseSlug(s)) return 'greenhouse';
  if (await probeLeverSlug(s)) return 'lever';
  if (await probeAshbySlug(s)) return 'ashby';
  return null;
}

/**
 * @returns {{ platform: string, slug: string, name: string } | null}
 */
async function discoverBoardFromHints({ name, domain }) {
  const displayName = (name || '').trim() || domainBase(domain) || 'Company';
  const candidates = [...new Set([
    ...slugCandidatesFromDomain(domain),
    ...slugCandidatesFromName(name),
  ])].slice(0, 12);

  for (const slug of candidates) {
    const platform = await discoverPlatformForSlug(slug);
    if (platform) return { platform, slug, name: displayName };
  }
  return null;
}

/**
 * True if the public API exposes this board (empty job list still counts).
 */
async function verifyBoardLive(platform, slug) {
  const p = String(platform || '').trim();
  const s = String(slug || '').trim();
  if (!p || !s) return false;
  if (p === 'greenhouse') return !!(await probeGreenhouseSlug(s));
  if (p === 'lever') return !!(await probeLeverSlug(s));
  if (p === 'ashby') return !!(await probeAshbySlug(s));
  return false;
}

async function fetchJobsForBoard(platform, slug, displayName) {
  const name = displayName || slug;
  if (platform === 'greenhouse') return fetchGreenhouse({ name, slug });
  if (platform === 'ashby') return fetchAshby({ name, slug });
  if (platform === 'lever') return fetchLever({ name, slug });
  return [];
}

/** Accept watch if in curated list OR live board responds. */
async function isAllowedDreamWatch(platform, slug) {
  if (isValidDreamWatch(platform, slug)) return true;
  return verifyBoardLive(platform, slug);
}

module.exports = {
  discoverBoardFromHints,
  verifyBoardLive,
  fetchJobsForBoard,
  isAllowedDreamWatch,
};
