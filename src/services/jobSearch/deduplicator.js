const { canonicalizeUrl, normalizeCompany, normalizeTitle } = require('./jobFingerprint.util');

/**
 * Multi-key dedupe across heterogeneous job APIs.
 * Order: canonical URL → company+title stem → loose company+title.
 */
const deduplicate = (jobs) => {
  const seenUrl = new Set();
  const seenStem = new Set();
  const out = [];

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;

    const cu = canonicalizeUrl(job.url || '');
    if (cu) {
      if (seenUrl.has(cu)) continue;
      seenUrl.add(cu);
    }

    const comp = normalizeCompany(job.company);
    const tit = normalizeTitle(job.title);
    const stemKey = `${comp}|||${tit}`;
    if (seenStem.has(stemKey)) continue;
    seenStem.add(stemKey);

    out.push(job);
  }

  return out;
};

module.exports = { deduplicate };
