const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/outreach.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

router.use(authenticate);

router.get   ('/',                ctrl.getEmails);
router.post  ('/generate',        requireCredits('AI_EMAIL'),          ctrl.generateEmail);
router.post  ('/enhance',         requireCredits('AI_EMAIL'),          ctrl.enhanceEmail);
router.post  ('/send',            requireCredits('EMAIL_SEND'),         ctrl.sendEmail);
router.post  ('/bulk',            ctrl.bulkSend);              // credits checked inside
router.post  ('/optimize-resume', planGuard('pro', 'team'), requireCredits('RESUME_KEYWORD_OPT'), ctrl.optimizeResume);
router.post  ('/auto-outreach',   planGuard('pro', 'team'), ctrl.autoOutreach);
router.get   ('/stats',           ctrl.getStats);
router.get   ('/generate-latex',      ctrl.generateLatex);
router.get   ('/generate-resume-pdf', ctrl.generateResumePdf);
router.delete('/:id',             ctrl.deleteEmail);

module.exports = router;