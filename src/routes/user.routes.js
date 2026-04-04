const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.get   ('/me',       ctrl.getMe);
router.get   ('/credits',  ctrl.getCredits);
router.get   ('/stats',    ctrl.getStats);
router.get   ('/activity', ctrl.getActivity);
router.patch ('/plan',     ctrl.updatePlan);

module.exports = router;