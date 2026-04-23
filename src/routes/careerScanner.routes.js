const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const User    = require('../models/User');
const { GREENHOUSE, ASHBY, LEVER } = require('../services/careerScanner/portals');
const { getCompanySuggestions } = require('../services/careerScanner/companySuggest.service');
const { discoverBoardFromHints } = require('../services/careerScanner/boardProbe.service');
const { success } = require('../utils/response.util');
const { ValidationError, NotFoundError } = require('../utils/errors');

router.use(authenticate);

/** GET /api/v1/career-scanner/company-suggest?q= — indexed boards + directory names (Clearbit when reachable) */
/** POST /api/v1/career-scanner/discover-board — probe GH / Lever / Ashby from name + domain */
router.post('/discover-board', async (req, res, next) => {
  try {
    const name   = (req.body.name || '').toString().trim();
    const domain = (req.body.domain || '').toString().trim();
    if (!name && !domain) throw new ValidationError('Provide a company name or domain');
    const found = await discoverBoardFromHints({ name, domain });
    if (!found) throw new NotFoundError('No public Greenhouse, Lever, or Ashby job board matched that company');
    return success(res, found, 'Board found');
  } catch (err) {
    next(err);
  }
});

router.get('/company-suggest', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString();
    const user = await User.findById(req.user._id).select('dreamCompanyWatches').lean();
    const exclude = new Set((user?.dreamCompanyWatches || []).map((w) => `${w.platform}:${w.slug}`));
    const suggestions = await getCompanySuggestions(q, exclude);
    return success(res, { suggestions });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/career-scanner/portals — curated companies (Greenhouse / Ashby / Lever boards) */
router.get('/portals', (_req, res) => {
  const companies = [
    ...GREENHOUSE.map((c) => ({ ...c, platform: 'greenhouse' })),
    ...ASHBY.map((c) => ({ ...c, platform: 'ashby' })),
    ...LEVER.map((c) => ({ ...c, platform: 'lever' })),
  ];
  return success(res, {
    total:      companies.length,
    greenhouse: GREENHOUSE.length,
    ashby:      ASHBY.length,
    lever:      LEVER.length,
    companies,
  });
});

module.exports = router;
