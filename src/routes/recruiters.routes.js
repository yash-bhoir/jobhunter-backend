const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/recruiters.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

router.use(authenticate);

router.get ('/',                    ctrl.getRecruiters);
router.post('/lookup',              planGuard('pro', 'team'), requireCredits('HUNTER_LOOKUP'), ctrl.lookupEmail);
router.post('/employees',           planGuard('pro', 'team'), requireCredits('APOLLO_SEARCH'), ctrl.findEmployees);
router.post('/pattern',             ctrl.patternEmails);
router.delete('/lookup-history/:id', ctrl.deleteLookupHistory);
router.get('/by-search/:searchId',  ctrl.getBySearch);
router.post('/find-all',            planGuard('pro', 'team'), requireCredits('HUNTER_LOOKUP'), ctrl.findAllForSearch);

module.exports = router;