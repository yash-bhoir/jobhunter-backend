/**
 * One-off: populate SearchCluster.clusterFamilyId, roleKeywords, queryRoleRaw
 * from the latest JobSearch row matching each cluster's clusterHash (searchHash).
 *
 *   node src/scripts/backfillSearchClusterFamilyFromJobSearch.js
 *
 * Requires MONGODB_URI in env (.env).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const SearchCluster = require('../models/SearchCluster');
const JobSearch = require('../models/JobSearch');
const {
  buildClusterFamilyId,
  roleTokens,
} = require('../services/jobSearch/queryCluster.util');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const filter = {
    $or: [
      { clusterFamilyId: { $exists: false } },
      { clusterFamilyId: '' },
    ],
  };

  const total = await SearchCluster.countDocuments(filter);
  console.log(`Clusters to consider: ${total}`);

  const cursor = SearchCluster.find(filter).select('clusterHash').cursor();
  let updated = 0;
  let skipped = 0;

  for await (const c of cursor) {
    const js = await JobSearch.findOne({ searchHash: c.clusterHash })
      .sort({ createdAt: -1 })
      .select('query.role query.location query.workType')
      .lean();

    if (!js?.query?.role) {
      skipped += 1;
      continue;
    }

    const { role, location, workType } = js.query;
    const clusterFamilyId = buildClusterFamilyId(role, location, workType);
    const roleKeywords = roleTokens(role || '').slice(0, 24);

    await SearchCluster.updateOne(
      { _id: c._id },
      {
        $set: {
          clusterFamilyId,
          roleKeywords,
          queryRoleRaw: String(role || ''),
        },
      },
    );
    updated += 1;
    if (updated % 50 === 0) console.log(`  updated ${updated}…`);
  }

  console.log(`Done. Updated: ${updated}, skipped (no JobSearch role): ${skipped}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
