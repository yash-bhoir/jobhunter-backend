const Job       = require('../../models/Job');
const JobSearch = require('../../models/JobSearch');
const { computeContentFingerprint } = require('./jobFingerprint.util');

/**
 * Fingerprints the user has already been shown for this exact search cluster (searchHash).
 */
async function getSeenFingerprints(userId, searchHash) {
  if (!userId || !searchHash) return new Set();

  const searches = await JobSearch.find({
    userId,
    searchHash,
    status: 'completed',
  })
    .select('_id')
    .lean();

  const ids = searches.map((s) => s._id);
  if (!ids.length) return new Set();

  const jobs = await Job.find({
    userId,
    searchId: { $in: ids },
  })
    .select('contentFingerprint url company title')
    .lean();

  const out = new Set();
  for (const j of jobs) {
    const fp = j.contentFingerprint || computeContentFingerprint(j);
    out.add(fp);
  }
  return out;
}

function filterUnseen(jobs, seen) {
  if (!seen?.size) return jobs;
  return jobs.filter((j) => {
    const fp = j.contentFingerprint || computeContentFingerprint(j);
    return !seen.has(fp);
  });
}

function tokenBag(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[\s,.|/\\()[\]{}:;+\-_]+/)
      .filter((t) => t.length > 2)
  );
}

/** Jaccard similarity on token sets (cheap diversity proxy). */
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * Maximal Marginal Relevance–style selection: prefer high matchScore while
 * penalizing similarity to jobs already picked (title + company tokens).
 */
function mmrSelect(jobs, k, lambda = 0.72) {
  if (!jobs?.length || k <= 0) return [];

  const work = jobs.map((j) => ({
    j,
    bag: new Set([...tokenBag(j.title), ...tokenBag(j.company)]),
  }));

  const selected = [];
  while (selected.length < k && work.length) {
    let bestI = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < work.length; i += 1) {
      const rel = (work[i].j.matchScore ?? 0) / 100;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(work[i].bag, s.bag);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestI = i;
      }
    }
    selected.push(work.splice(bestI, 1)[0]);
  }
  return selected.map((r) => r.j);
}

module.exports = {
  getSeenFingerprints,
  filterUnseen,
  mmrSelect,
};
