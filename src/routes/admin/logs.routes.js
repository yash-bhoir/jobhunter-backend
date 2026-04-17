const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/logs.controller');

router.get('/',                  ctrl.getLogs);
router.get('/audit',             ctrl.getAuditLog);
router.get('/export',            ctrl.exportLogs);
router.get('/errors',            ctrl.getErrors);

// ── Dedicated ErrorLog routes ─────────────────────────────────────
router.get('/error-logs',        ctrl.getErrorLogs);
router.patch('/error-logs/:id/resolve', ctrl.resolveError);
router.post('/error-logs/bulk-resolve', ctrl.bulkResolve);
router.delete('/error-logs/:id', ctrl.deleteErrorLog);

module.exports = router;