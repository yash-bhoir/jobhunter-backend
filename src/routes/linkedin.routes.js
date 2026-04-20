const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/linkedin.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

// Public route — Google redirects here with no JWT (userId comes from state param)
router.get ('/gmail/callback',  ctrl.gmailCallback);

router.use(authenticate);

router.get ('/jobs',                      ctrl.getJobs);
router.post('/jobs',                      ctrl.addJob);
router.post('/fetch',                     ctrl.fetchAlerts);
router.get ('/jobs/:id',                  ctrl.getJob);
router.patch('/jobs/:id/status',          ctrl.updateStatus);
router.post('/jobs/:id/find-hr',          planGuard('pro', 'team'), requireCredits('HUNTER_LOOKUP'), ctrl.findHR);
router.delete('/jobs/:id',                ctrl.deleteJob);
router.post('/jobs/:id/deep-evaluate',    planGuard('pro', 'team'), requireCredits('DEEP_EVALUATE'),    ctrl.deepEvaluate);
router.post('/jobs/:id/interview-prep',   planGuard('pro', 'team'), requireCredits('INTERVIEW_PREP'),   ctrl.generateInterviewPrep);
router.get ('/jobs/:id/explain',          requireCredits('AI_ANALYSIS'), ctrl.explainMatch);
router.get ('/jobs/:id/company',          requireCredits('AI_ANALYSIS'), ctrl.getCompanyResearch);
router.get ('/jobs/:id/description',      ctrl.fetchDescription);
router.get ('/unread-count',       ctrl.getUnreadCount);
router.get ('/alerts/settings',   ctrl.getAlertSettings);
router.patch('/alerts/settings',  ctrl.updateAlertSettings);
router.get ('/connect',           ctrl.getConnectInfo);
router.get ('/gmail/jobs',      ctrl.getEmailJobs);
router.get ('/gmail/connect',   ctrl.gmailConnect);
router.post('/gmail/fetch',     ctrl.fetchFromGmail);
router.get ('/gmail/status',    ctrl.gmailStatus);
router.delete('/gmail/disconnect', ctrl.gmailDisconnect);

module.exports = router;