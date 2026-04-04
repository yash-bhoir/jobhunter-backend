const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/analytics.controller');

router.get('/overview',  ctrl.getOverview);
router.get('/users',     ctrl.getUserStats);
router.get('/revenue',   ctrl.getRevenue);
router.get('/searches',  ctrl.getSearchStats);
router.get('/platforms', ctrl.getPlatformStats);

module.exports = router;