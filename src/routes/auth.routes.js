const express  = require('express');
const router   = express.Router();
const { body } = require('express-validator');
const ctrl     = require('../controllers/auth.controller');
const { validate }     = require('../middleware/validate.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { authLimiter, refreshLimiter } = require('../middleware/rateLimit.middleware');

const passwordRule = [
  body('password')
    .isLength({ min: 8 }).withMessage('Minimum 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Must have uppercase, lowercase and number'),
];

router.post('/register',
  authLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
  ...passwordRule, validate,
  ctrl.register
);

router.post('/login',
  authLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
  validate,
  ctrl.login
);

router.post('/admin/verify-otp',
  authLimiter,
  body('userId').notEmpty().withMessage('userId required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  validate,
  ctrl.verifyAdminOtp
);

router.post('/refresh',        refreshLimiter, ctrl.refresh);

router.post('/oauth-exchange',
  authLimiter,
  body('code').trim().notEmpty().withMessage('Code required'),
  validate,
  ctrl.oauthExchange
);
router.get ('/verify-email',  ctrl.verifyEmail);
router.post('/forgot-password',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  validate, ctrl.forgotPassword
);
router.post('/reset-password',
  body('token').notEmpty(),
  ...passwordRule, validate,
  ctrl.resetPassword
);
router.post('/logout', authenticate, ctrl.logout);
router.get ('/me',     authenticate, ctrl.getMe);

// ── Google OAuth ──────────────────────────────────────────────────
router.get('/google',          ctrl.googleAuth);
router.get('/google/callback', ctrl.googleCallback);

// ── Dev only — on by default in development; set ALLOW_DEV_AUTH_ROUTES=false to disable
const devAuthRoutesEnabled =
  process.env.NODE_ENV === 'development' &&
  (process.env.ALLOW_DEV_AUTH_ROUTES || 'true').toLowerCase() !== 'false';

if (devAuthRoutesEnabled) {
  router.get('/dev/verify/:email', async (req, res) => {
    try {
      const User = require('../models/User');
      const user = await User.findOneAndUpdate(
        { email: req.params.email },
        { emailVerified: true, status: 'active' },
        { new: true }
      );
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      res.json({ success: true, message: `${user.email} verified` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.get('/dev/set-plan/:email/:plan', async (req, res) => {
    try {
      const User        = require('../models/User');
      const UserCredits = require('../models/UserCredits');
      const planCredits = { free: 100, pro: 1000, team: 5000 };
      const plan        = req.params.plan;
      if (!planCredits[plan]) return res.status(400).json({ success: false, message: 'Invalid plan' });
      const user = await User.findOneAndUpdate(
        { email: req.params.email },
        { plan, role: 'user', status: 'active', emailVerified: true },
        { new: true }
      );
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await UserCredits.findOneAndUpdate(
        { userId: user._id },
        { plan, totalCredits: planCredits[plan], usedCredits: 0 },
        { upsert: true }
      );
      res.json({ success: true, message: `${user.email} set to ${plan} plan` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.get('/dev/make-admin/:email/:password?', async (req, res) => {
    try {
      const bcrypt      = require('bcryptjs');
      const User        = require('../models/User');
      const UserCredits = require('../models/UserCredits');

      const password = req.params.password || null;
      const update   = { role: 'super_admin', status: 'active', emailVerified: true };
      if (password) update.password = await bcrypt.hash(password, 12);

      let user = await User.findOneAndUpdate(
        { email: req.params.email },
        update,
        { new: true }
      );

      // Create the user if they don't exist yet
      if (!user) {
        if (!password) return res.status(400).json({ success: false, message: 'User not found — provide a password to create one' });
        user = await User.create({
          email:         req.params.email,
          password:      await bcrypt.hash(password, 12),
          role:          'super_admin',
          status:        'active',
          emailVerified: true,
          profile:       { firstName: 'Admin', lastName: 'User', completionPct: 100 },
        });
      }

      await UserCredits.findOneAndUpdate(
        { userId: user._id },
        { plan: 'team', totalCredits: 999999, usedCredits: 0 },
        { upsert: true }
      );
      res.json({ success: true, message: `${user.email} is now super_admin${password ? ' (password set)' : ''}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.get('/dev/test-error', (req, res, next) => {
    next(new Error('TEST_ERROR: This is a deliberate 500 to verify error alert emails are working.'));
  });

  router.get('/dev/seed-config', async (req, res) => {
    try {
      const PlatformConfig = require('../models/PlatformConfig');
      const defaults = [
        // ── Features ────────────────────────────────────────────────
        { key: 'maintenanceMode',      value: { enabled: false },  category: 'features' },
        { key: 'registrationsEnabled', value: true,                category: 'features' },
        { key: 'aiEmailEnabled',       value: true,                category: 'features' },
        { key: 'resumeParseEnabled',   value: true,                category: 'features' },
        { key: 'hunterEnabled',        value: true,                category: 'features' },
        { key: 'apolloEnabled',        value: true,                category: 'features' },
        { key: 'excelExportEnabled',   value: true,                category: 'features' },
        { key: 'careerScannerEnabled', value: true,                category: 'features' },
        { key: 'linkedinAlertsEnabled',value: true,                category: 'features' },
        { key: 'banner',               value: { active: false },   category: 'general'  },

        // ── Enabled platforms ────────────────────────────────────────
        { key: 'enabledPlatforms', value: [
            'jsearch','adzuna','remoteok','remotive',
            'arbeitnow','jobicy','himalayas','themuse','careerjet',
          ], category: 'apis' },

        // ── Credit costs per action ──────────────────────────────────
        { key: 'creditCosts', value: {
            JOB_SEARCH:          10,
            HUNTER_LOOKUP:       15,
            APOLLO_SEARCH:       10,
            AI_EMAIL:             5,
            RESUME_PARSE:        20,
            RESUME_KEYWORD_OPT:   3,
            AI_ANALYSIS:          3,
            DEEP_EVALUATE:        8,
            EMAIL_SEND:           2,
            EXCEL_EXPORT:         5,
            INTERVIEW_PREP:       3,
            PROXYCURL:           30,
          }, category: 'credits' },

        // ── Plan limits ──────────────────────────────────────────────
        { key: 'freePlanLimits', value: {
            creditsPerMonth:   100,
            searchesPerDay:    2,
            jobsPerSearch:     10,
            emailsPerMonth:    10,
            hrLookupsPerMonth: 0,
            linkedinLookups:   0,
            historyDays:       7,
            graceCredits:      0,
          }, category: 'limits' },
        { key: 'proPlanLimits', value: {
            creditsPerMonth:   1000,
            searchesPerDay:    999,
            jobsPerSearch:     30,
            emailsPerMonth:    999,
            hrLookupsPerMonth: 50,
            linkedinLookups:   0,
            historyDays:       90,
            graceCredits:      50,
          }, category: 'limits' },
        { key: 'teamPlanLimits', value: {
            creditsPerMonth:   5000,
            searchesPerDay:    999,
            jobsPerSearch:     50,
            emailsPerMonth:    9999,
            hrLookupsPerMonth: 200,
            linkedinLookups:   100,
            historyDays:       365,
            graceCredits:      100,
          }, category: 'limits' },

        // ── Billing ──────────────────────────────────────────────────
        { key: 'proPlanPrice',       value: 499,   category: 'billing' },
        { key: 'proPlanPriceAnnual', value: 3999,  category: 'billing' },
        { key: 'teamPlanPrice',      value: 1999,  category: 'billing' },
        { key: 'teamPlanPriceAnnual',value: 15999, category: 'billing' },

        // ── Top-up packs ─────────────────────────────────────────────
        { key: 'topupPacks', value: [
            { name: 'Starter',    credits: 50,   price: 99   },
            { name: 'Power',      credits: 200,  price: 299,  popular: true },
            { name: 'Mega',       credits: 600,  price: 699  },
            { name: 'Enterprise', credits: 2000, price: 1999 },
          ], category: 'billing' },
      ];

      for (const d of defaults) {
        await PlatformConfig.findOneAndUpdate({ key: d.key }, d, { upsert: true });
      }
      res.json({ success: true, message: `${defaults.length} configs seeded` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

module.exports = router;
