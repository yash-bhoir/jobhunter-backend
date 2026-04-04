const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/profile.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { upload, uploadDocx } = require('../middleware/upload.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

router.use(authenticate);

router.get   ('/',                ctrl.getProfile);
router.patch ('/',                ctrl.updateProfile);
router.patch ('/password',        ctrl.changePassword);
router.post  ('/resume',          upload.single('resume'),     ctrl.uploadResume);
router.post  ('/resume/docx',     uploadDocx.single('resume'), ctrl.uploadResumeDocx);
router.delete('/resume',          ctrl.deleteResume);
router.get   ('/resume/debug',    ctrl.debugResume);
router.post  ('/delete-account',  ctrl.deleteAccount);
router.post('/gap-analysis', planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.getGapAnalysis);

// SMTP — multiple accounts
router.get   ('/smtp/status',     ctrl.getSMTPStatus);
router.post  ('/smtp',            ctrl.saveSMTP);
router.post  ('/smtp/default',    ctrl.setDefaultSMTP);
router.delete('/smtp',            ctrl.removeSMTP);

module.exports = router;