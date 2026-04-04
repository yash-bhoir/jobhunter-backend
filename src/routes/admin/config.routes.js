const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/config.controller');

router.get   ('/',      ctrl.getAll);
router.get   ('/:key',  ctrl.getOne);
router.patch ('/:key',  ctrl.update);
router.post  ('/bulk',  ctrl.bulkUpdate);

module.exports = router;