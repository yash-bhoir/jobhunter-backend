const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/admin/resumeTemplates.controller');

router.get('/',    ctrl.list);
router.post('/',   ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
