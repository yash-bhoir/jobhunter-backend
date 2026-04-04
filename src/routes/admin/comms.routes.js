const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/comms.controller');

router.post  ('/broadcast',   ctrl.broadcast);
router.post  ('/banner',      ctrl.setBanner);
router.delete('/banner',      ctrl.removeBanner);
router.post  ('/maintenance', ctrl.setMaintenance);

module.exports = router;