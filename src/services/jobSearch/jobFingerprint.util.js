const crypto = require('crypto');

/** Strip tracking params for stable URL identity */
function canonicalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    const drop = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'msclkid', '_ga', 'mc_eid', 'ref',
    ]);
    [...u.searchParams.keys()].forEach((k) => {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
    });
    u.hash = '';
    return `${u.origin}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().split('#')[0];
  }
}

function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

/**
 * Stable fingerprint for cross-search "seen" tracking and dedupe hints.
 * Not a cryptographic secret — SHA256 for fixed length + low collision rate.
 */
function computeContentFingerprint(job) {
  const url = canonicalizeUrl(job.url || '');
  const comp = normalizeCompany(job.company);
  const title = normalizeTitle(job.title);
  const ext = String(job.externalId || '').toLowerCase();
  const src = String(job.source || '').toLowerCase();
  const basis = url
    ? `url:${url}`
    : `fallback:${src}|${ext}|${comp}|${title}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

module.exports = {
  canonicalizeUrl,
  computeContentFingerprint,
  normalizeCompany,
  normalizeTitle,
};
