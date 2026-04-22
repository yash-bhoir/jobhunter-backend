const axios  = require('axios');
const logger = require('../../config/logger');

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'in', 'to', 'of', 'with', 'at']);

function roleTokens(role) {
  return String(role || '')
    .toLowerCase()
    .split(/[\s+,/|_-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * RemoteOK returns ~200 recent listings at GET /api (first element is metadata).
 * The `?tag=` filter uses single-tag slugs (e.g. javascript); multi-word roles
 * often return nothing — so we fetch the full feed and match client-side.
 */
const search = async ({ role }) => {
  const { data } = await axios.get('https://remoteok.com/api', {
    timeout:  12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JobHunter/1.0; +https://remoteok.com)',
    },
  }).catch((err) => {
    logger.warn(`[remoteok] ${err.message}`);
    return { data: [] };
  });

  const rows = Array.isArray(data) ? data.slice(1) : [];
  const tokens = roleTokens(role);

  let picked = rows;
  if (tokens.length) {
    picked = rows.filter((j) => {
      const tags = Array.isArray(j.tags) ? j.tags.join(' ') : '';
      const hay = `${j.position || ''} ${tags} ${(j.description || '').replace(/<[^>]*>/g, ' ')}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    });
  }

  if (!picked.length && rows.length) {
    picked = rows;
  }

  return picked.slice(0, 50).map((j) => ({
    externalId:  String(j.id || ''),
    title:       j.position || '',
    company:     j.company || '',
    location:    'Remote',
    description: (j.description || '').replace(/<[^>]*>/g, ''),
    url:         j.url || '',
    salary:      j.salary || 'Not specified',
    source:      'RemoteOK',
    remote:      true,
    postedAt:    j.date || null,
  }));
};

module.exports = { search };
