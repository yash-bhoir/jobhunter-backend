const express = require('express');
const router  = express.Router();

router.use('/auth',       require('./auth.routes'));
router.use('/user',       require('./user.routes'));
router.use('/profile',    require('./profile.routes'));
router.use('/search',     require('./search.routes'));
router.use('/jobs',       require('./jobs.routes'));
router.use('/recruiters', require('./recruiters.routes'));
router.use('/outreach',   require('./outreach.routes'));
router.use('/billing',    require('./billing.routes'));
router.use('/admin',      require('./admin'));
router.use('/linkedin',  require('./linkedin.routes'));
router.use('/geo-jobs', require('./geoJobs.routes'));

router.use('/config',     require('./config.routes'));

// ── Frontend error reporting (authenticated users) ────────────────
const { authenticate } = require('../middleware/auth.middleware');
const { reportFrontendError } = require('../controllers/admin/logs.controller');
router.post('/errors/report', authenticate, reportFrontendError);

router.get('/ping', (_req, res) => {
  res.json({ success: true, message: 'API is running', timestamp: new Date() });
});

module.exports = router;