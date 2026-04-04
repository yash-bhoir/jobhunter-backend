const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/apikeys.controller');

router.get   ('/',                   ctrl.getAll);
router.patch ('/:key',               ctrl.update);
router.post  ('/test/:key',          ctrl.testKey);

// ── Platform on/off control ───────────────────────────────────────
router.get   ('/platforms',          ctrl.getPlatforms);
router.patch ('/platforms/:name',    ctrl.togglePlatform);

module.exports = router;