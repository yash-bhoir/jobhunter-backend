const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/logs.controller');

router.get('/',       ctrl.getLogs);
router.get('/audit',  ctrl.getAuditLog);
router.get('/export', ctrl.exportLogs);
router.get('/errors', ctrl.getErrors);

module.exports = router;