const express = require('express');
const router  = express.Router();
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

router.use(authenticate);
router.use(requireRole('admin', 'super_admin'));

router.use('/users',     require('./users.routes'));
router.use('/analytics', require('./analytics.routes'));
router.use('/config',    require('./config.routes'));
router.use('/logs',      require('./logs.routes'));
router.use('/comms',     require('./comms.routes'));
router.use('/api-keys',  require('./apikeys.routes'));
router.use('/career-scan', require('./careerScan.routes'));

module.exports = router;