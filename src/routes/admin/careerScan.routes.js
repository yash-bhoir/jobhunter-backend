const express  = require('express');
const router   = express.Router();
const { GREENHOUSE, ASHBY, LEVER } = require('../../services/careerScanner/portals');
const { runDailyCareerScan, runDreamCompanyScan, getPortalJobs } = require('../../services/careerScanner/scheduler');
const { success } = require('../../utils/response.util');
const LinkedInJob = require('../../models/LinkedInJob');

// GET /admin/career-scan/portals — list all indexed companies
router.get('/portals', (_req, res) => {
  const all = [
    ...GREENHOUSE.map(c => ({ ...c, platform: 'greenhouse' })),
    ...ASHBY.map(c      => ({ ...c, platform: 'ashby'      })),
    ...LEVER.map(c      => ({ ...c, platform: 'lever'      })),
  ];
  return success(res, {
    total:      all.length,
    greenhouse: GREENHOUSE.length,
    ashby:      ASHBY.length,
    lever:      LEVER.length,
    companies:  all,
  });
});

// POST /admin/career-scan/run — trigger a manual full scan
router.post('/run', async (req, res, next) => {
  try {
    // Run in background — don't await (can take 30-60s)
    runDailyCareerScan().catch(err =>
      require('../../config/logger').error(`Manual career scan failed: ${err.message}`)
    );
    runDreamCompanyScan().catch(err =>
      require('../../config/logger').error(`Manual dream-company scan failed: ${err.message}`)
    );
    return success(res, null, 'Career + dream-company scans started in background');
  } catch (err) { next(err); }
});

// GET /admin/career-scan/stats — recent career page jobs saved
router.get('/stats', async (req, res, next) => {
  try {
    const [total, last24h, byCompany] = await Promise.all([
      LinkedInJob.countDocuments({ source: 'career_page' }),
      LinkedInJob.countDocuments({
        source:    'career_page',
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
      LinkedInJob.aggregate([
        { $match: { source: 'career_page' } },
        { $group: { _id: '$company', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
    ]);
    return success(res, { total, last24h, byCompany });
  } catch (err) { next(err); }
});

module.exports = router;
