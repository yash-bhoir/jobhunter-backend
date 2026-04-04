const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/users.controller');

router.get   ('/',                    ctrl.listUsers);
router.get   ('/:id',                 ctrl.getUser);
router.patch ('/:id/plan',            ctrl.changePlan);
router.patch ('/:id/status',          ctrl.changeStatus);
router.patch ('/:id/credits',         ctrl.adjustCredits);
router.patch ('/:id/override-limits', ctrl.overrideLimits);
router.post  ('/:id/impersonate',     ctrl.impersonate);
router.delete('/:id',                 ctrl.deleteUser);
router.get   ('/:id/activity',        ctrl.getUserActivity);
router.get   ('/:id/credits',         ctrl.getUserCredits);

module.exports = router;