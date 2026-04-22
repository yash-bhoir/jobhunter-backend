const SearchCluster = require('../../models/SearchCluster');
const { score } = require('./scorer');
const { computeContentFingerprint } = require('./jobFingerprint.util');
const {
  buildClusterFamilyId,
  roleTokens,
  jaccardTokens,
  distinctiveTokens,
} = require('./queryCluster.util');

const DEFAULT_SNAPSHOT_MAX = 200;
const DEFAULT_MIN_JOBS     = 20;

function platformBreakdownToObject(pb) {
  if (!pb) return {};
  if (pb instanceof Map) return Object.fromEntries(pb);
  if (typeof pb === 'object') return { ...pb };
  return {};
}

function filterSnapshotForQueryRole(jobsSnapshot, role) {
  const need = distinctiveTokens(role);
  if (!need.length) return jobsSnapshot.map((j) => (typeof j.toObject === 'function' ? j.toObject() : { ...j }));

  const minHits = Math.max(1, Math.min(need.length, Math.ceil(need.length * 0.34)));
  return jobsSnapshot.filter((j) => {
    const hay = `${j.title || ''} ${j.description || ''}`.toLowerCase();
    const hits = need.filter((t) => hay.includes(t)).length;
    return hits >= minHits;
  });
}

/**
 * @param {string} clusterHash
 * @param {{ rankedAll: object[], totalFound: number, platformBreakdown?: object|Map }} payload
 * @param {{ role?: string, location?: string, workType?: string }} [queryMeta]
 */
async function upsertClusterFromFetch(clusterHash, payload, queryMeta = {}) {
  const ranked = payload.rankedAll || [];
  if (!clusterHash || !ranked.length) return;

  const maxSnap = Number(process.env.SEARCH_CLUSTER_SNAPSHOT_MAX || DEFAULT_SNAPSHOT_MAX);
  const jobsSnapshot = ranked.slice(0, maxSnap).map((j) => ({
    externalId:         j.externalId || '',
    title:              j.title || '',
    company:            j.company || '',
    location:           j.location || '',
    description:        j.description || '',
    url:                j.url || '',
    salary:             j.salary || 'Not specified',
    source:             j.source || '',
    remote:             Boolean(j.remote),
    postedAt:           j.postedAt || null,
    contentFingerprint: j.contentFingerprint || computeContentFingerprint(j),
  }));

  const clusterFamilyId = buildClusterFamilyId(
    queryMeta.role,
    queryMeta.location,
    queryMeta.workType,
  );
  const roleKeywords = roleTokens(queryMeta.role || '').slice(0, 24);

  await SearchCluster.findOneAndUpdate(
    { clusterHash },
    {
      $set: {
        lastFetchedAt:      new Date(),
        totalFound:         payload.totalFound ?? ranked.length,
        platformBreakdown:  platformBreakdownToObject(payload.platformBreakdown),
        jobsSnapshot,
        clusterFamilyId,
        roleKeywords,
        queryRoleRaw:       String(queryMeta.role || ''),
      },
    },
    { upsert: true },
  );
}

/**
 * Load cluster snapshot and re-rank for this user + live query intent.
 * @returns {null | { rankedAll: object[], totalFound: number, platformBreakdown: object }}
 */
function materializeClusterForUser(cluster, user, params) {
  if (!cluster?.jobsSnapshot?.length) return null;

  const raw = cluster.jobsSnapshot.map((j) => ({ ...(typeof j.toObject === 'function' ? j.toObject() : j) }));
  const searchCtx = {
    searchRole:     params.role,
    searchLocation: params.location,
    searchWorkType: params.workType,
  };
  const scored = score(raw, user, searchCtx);
  scored.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

  const rankedAll = scored.map((j) => ({
    ...j,
    contentFingerprint: j.contentFingerprint || computeContentFingerprint(j),
  }));

  return {
    rankedAll,
    totalFound:        cluster.totalFound ?? rankedAll.length,
    platformBreakdown: platformBreakdownToObject(cluster.platformBreakdown),
  };
}

function isClusterReusable(cluster, opts = {}) {
  if (!cluster?.jobsSnapshot?.length) return false;
  const minJobs = Number(opts.minJobs ?? process.env.SEARCH_CLUSTER_MIN_JOBS ?? DEFAULT_MIN_JOBS);
  if (cluster.jobsSnapshot.length < minJobs) return false;

  const ttlHours = Number(opts.ttlHours ?? process.env.SEARCH_CLUSTER_TTL_HOURS ?? 24);
  const ttlMs     = ttlHours * 60 * 60 * 1000;
  const fetched   = new Date(cluster.lastFetchedAt || cluster.updatedAt || 0).getTime();
  if (!fetched || Number.isNaN(fetched)) return false;
  return Date.now() - fetched < ttlMs;
}

/**
 * Exact clusterHash hit, else a fresh sibling in the same role family + geo + modality.
 */
async function findBestClusterForReuse({ clusterHash, role, location, workType }) {
  const exact = await SearchCluster.findOne({ clusterHash }).lean();
  if (exact && isClusterReusable(exact)) {
    return { cluster: exact, reuseMatch: 'exact' };
  }

  const familyId = buildClusterFamilyId(role, location, workType);
  const ttlHours   = Number(process.env.SEARCH_CLUSTER_TTL_HOURS ?? 24);
  const since      = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
  const qTok       = roleTokens(role);
  const minJaccard = parseFloat(process.env.SEARCH_CLUSTER_SIBLING_MIN_JACCARD || '0.18');
  const minAfter   = parseInt(process.env.SEARCH_CLUSTER_SIBLING_MIN_AFTER_FILTER || '20', 10) || 20;

  const candidates = await SearchCluster.find({
    clusterFamilyId: familyId,
    clusterHash:     { $ne: clusterHash },
    lastFetchedAt:   { $gte: since },
    'jobsSnapshot.0': { $exists: true },
  })
    .sort({ lastFetchedAt: -1 })
    .limit(12)
    .lean();

  let best = null;
  let bestJ = -1;
  for (const c of candidates) {
    const j = jaccardTokens(qTok, c.roleKeywords || []);
    if (j > bestJ && j >= minJaccard) {
      bestJ = j;
      best = c;
    }
  }
  if (!best) return { cluster: null, reuseMatch: null };

  const filtered = filterSnapshotForQueryRole(best.jobsSnapshot, role);
  if (filtered.length < minAfter) return { cluster: null, reuseMatch: null };

  const virtual = { ...best, jobsSnapshot: filtered };
  if (!isClusterReusable(virtual)) {
    return { cluster: null, reuseMatch: null };
  }

  return { cluster: virtual, reuseMatch: 'sibling' };
}

module.exports = {
  upsertClusterFromFetch,
  materializeClusterForUser,
  isClusterReusable,
  findBestClusterForReuse,
  platformBreakdownToObject,
};
