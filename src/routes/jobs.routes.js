const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/jobs.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');

router.use(authenticate);

router.get   ('/',             ctrl.getJobs);
router.get   ('/saved',        ctrl.getSavedJobs);
router.get   ('/:id',          ctrl.getJob);
router.patch ('/:id/status',   ctrl.updateStatus);
router.post  ('/:id/save',     ctrl.saveJob);
router.post  ('/:id/unsave',   ctrl.unsaveJob);
router.post  ('/export/excel',  planGuard('pro', 'team'), requireCredits('EXCEL_EXPORT'), ctrl.exportExcel);
router.get ('/:id/explain',     planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.explainMatch);
router.get ('/:id/company',     planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.getCompanyResearch);
router.post('/check-duplicate', ctrl.checkDuplicate);

module.exports = router;