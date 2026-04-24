/**
 * Removes legacy demo / placeholder GeoJob rows so map search only uses real API cache data.
 *
 *   node src/scripts/seedGeoJobs.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const GeoJob = require('../models/GeoJob');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    let total = 0;
    let r = await GeoJob.deleteMany({ applyUrl: { $in: ['#', '', null] } });
    total += r.deletedCount;
    r = await GeoJob.deleteMany({ externalId: { $exists: false } });
    total += r.deletedCount;
    r = await GeoJob.deleteMany({ externalId: '' });
    total += r.deletedCount;
    r = await GeoJob.deleteMany({
      $and: [
        { externalId: { $exists: true, $type: 'string' } },
        { externalId: { $not: /^(adzuna_|jsearch_|serpapi_)/i } },
      ],
    });
    total += r.deletedCount;
    console.log(`Removed ${total} non-production geo job document(s) in total.`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

run();
