const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/jobs.controller');
const { authenticate }   = require('../middleware/auth.middleware');
const { requireCredits, planGuard } = require('../middleware/credits.middleware');
const { rankingEventLimiter } = require('../middleware/rateLimit.middleware');

router.use(authenticate);

router.get   ('/',             ctrl.getJobs);
router.get   ('/saved',        ctrl.getSavedJobs);

// ── Insights & follow-ups (before /:id to avoid param collision) ──
router.get   ('/insights',             ctrl.getInsights);
router.get   ('/follow-ups',           ctrl.getFollowUps);

router.get   ('/:id',          ctrl.getJob);
router.post  ('/:id/ranking-event', rankingEventLimiter, ctrl.logRankingEvent);
router.patch ('/:id/status',   ctrl.updateStatus);
router.post  ('/:id/save',     ctrl.saveJob);
router.post  ('/:id/unsave',   ctrl.unsaveJob);
router.post  ('/export/excel',  planGuard('pro', 'team'), requireCredits('EXCEL_EXPORT'), ctrl.exportExcel);
router.get ('/:id/explain',      planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.explainMatch);
router.get ('/:id/company',      planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.getCompanyResearch);
router.get ('/:id/contacts',     ctrl.getJobContacts);
router.post('/:id/find-employees', planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.findJobEmployees);
router.post('/check-duplicate',  ctrl.checkDuplicate);

// ── Liveness detection ────────────────────────────────────────────
router.post('/:id/check-liveness', ctrl.checkLiveness);

// ── Follow-up management ──────────────────────────────────────────
router.post('/:id/follow-up/sent',   ctrl.markFollowUpSent);
router.post('/:id/follow-up/snooze', ctrl.snoozeFollowUp);

// ── Deep evaluation (A-F scoring) ────────────────────────────────
router.post('/:id/deep-evaluate', planGuard('pro', 'team'), requireCredits('AI_ANALYSIS'), ctrl.deepEvaluate);

// ── Interview prep generator ──────────────────────────────────────
router.post('/:id/interview-prep', requireCredits('AI_ANALYSIS'), ctrl.generateInterviewPrep);

module.exports = router;