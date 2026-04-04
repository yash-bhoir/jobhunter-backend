const express = require('express');
const router  = express.Router();
const { authenticate }    = require('../middleware/auth.middleware');
const { requireCredits, checkDailySearchLimit } = require('../middleware/credits.middleware');
const { searchLimiter }   = require('../middleware/rateLimit.middleware');
const ctrl = require('../controllers/search.controller');

// Check cache before committing to a search (no credits charged)
router.get('/check-cache', authenticate, ctrl.checkCache);

// Profile smart search pre-fill
router.get('/profile-search', authenticate, ctrl.profileSearch);

// Resume-based search suggestions (no credits — user picks one, then runs /run)
router.get('/resume-suggest', authenticate, ctrl.resumeSuggest);

// Run a new search (charges credits — cache check is built into controller)
router.post('/run', authenticate, searchLimiter, checkDailySearchLimit, requireCredits('JOB_SEARCH'), ctrl.runSearch);

// History
router.get('/history', authenticate, ctrl.getHistory);

// Individual search
router.get('/:id',      authenticate, ctrl.getSearchById);
router.get('/:id/jobs', authenticate, ctrl.getSearchJobs);

module.exports = router;
