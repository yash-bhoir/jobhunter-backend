const mongoose = require('mongoose');

/**
 * Shared aggregated search pool for a normalized query (clusterHash = searchHash).
 * Lets User B reuse a fresh snapshot from User A without re-calling external job APIs.
 * Jobs are re-scored per-user at read time; this store is intent + corpus only.
 */
const snapshotJobSchema = new mongoose.Schema({
  externalId:           String,
  title:                String,
  company:              String,
  location:             String,
  description:          String,
  url:                  String,
  salary:               String,
  source:               String,
  remote:               { type: Boolean, default: false },
  postedAt:             Date,
  contentFingerprint:   String,
}, { _id: false });

const searchClusterSchema = new mongoose.Schema({
  clusterHash: { type: String, required: true, unique: true, index: true },
  /** Same geo + workType + broad role family — sibling queries can reuse this snapshot */
  clusterFamilyId: { type: String, default: '', index: true },
  /** Tokenized role query for Jaccard match against sibling searches */
  roleKeywords:    { type: [String], default: [] },
  queryRoleRaw:    { type: String, default: '' },

  lastFetchedAt: { type: Date, default: Date.now, index: true },
  totalFound:    { type: Number, default: 0 },
  /** Plain object: platform → raw count from last API run */
  platformBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Bounded corpus for reuse (max ~200 jobs ≪ 16MB doc limit) */
  jobsSnapshot: { type: [snapshotJobSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('SearchCluster', searchClusterSchema);
