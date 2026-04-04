const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/linkedin.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

router.use(authenticate);

router.get ('/jobs',              ctrl.getJobs);
router.post('/jobs',              ctrl.addJob);
router.post('/fetch',             ctrl.fetchAlerts);        // ← NEW auto-fetch
router.get ('/jobs/:id',          ctrl.getJob);
router.patch('/jobs/:id/status',  ctrl.updateStatus);
router.post('/jobs/:id/find-hr',  planGuard('pro', 'team'), requireCredits('HUNTER_LOOKUP'), ctrl.findHR);
router.delete('/jobs/:id',        ctrl.deleteJob);
router.get ('/connect',           ctrl.getConnectInfo);
router.get ('/gmail/connect',   ctrl.gmailConnect);
router.get ('/gmail/callback',  ctrl.gmailCallback);
router.post('/gmail/fetch',     ctrl.fetchFromGmail);
router.get ('/gmail/status',    ctrl.gmailStatus);
router.delete('/gmail/disconnect', ctrl.gmailDisconnect);

module.exports = router;