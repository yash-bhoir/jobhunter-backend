const express  = require('express');
const router   = express.Router();
const { body } = require('express-validator');
const ctrl     = require('../controllers/auth.controller');
const { validate }     = require('../middleware/validate.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { authLimiter }  = require('../middleware/rateLimit.middleware');

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

router.post('/refresh',       ctrl.refresh);
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

// ── Dev only ──────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
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

  router.get('/dev/make-admin/:email', async (req, res) => {
    try {
      const User        = require('../models/User');
      const UserCredits = require('../models/UserCredits');
      const user = await User.findOneAndUpdate(
        { email: req.params.email },
        { role: 'super_admin', status: 'active', emailVerified: true },
        { new: true }
      );
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await UserCredits.findOneAndUpdate(
        { userId: user._id },
        { plan: 'team', totalCredits: 999999, usedCredits: 0 },
        { upsert: true }
      );
      res.json({ success: true, message: `${user.email} is now super_admin` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.get('/dev/seed-config', async (req, res) => {
    try {
      const PlatformConfig = require('../models/PlatformConfig');
      const defaults = [
        { key: 'maintenanceMode',      value: { enabled: false }, category: 'features' },
        { key: 'registrationsEnabled', value: true,               category: 'features' },
        { key: 'enabledPlatforms',     value: ['jsearch','adzuna','remoteok','remotive','arbeitnow','jobicy','himalayas','themuse'], category: 'apis' },
        { key: 'freePlanLimits',       value: { searchesPerDay: 2,   jobsPerSearch: 10, emailsPerMonth: 10  }, category: 'limits' },
        { key: 'proPlanLimits',        value: { searchesPerDay: 999, jobsPerSearch: 30, emailsPerMonth: 999, hrLookupsPerMonth: 50  }, category: 'limits' },
        { key: 'teamPlanLimits',       value: { searchesPerDay: 999, jobsPerSearch: 50, emailsPerMonth: 9999, hrLookupsPerMonth: 200 }, category: 'limits' },
        { key: 'creditCosts',          value: { JOB_SEARCH: 10, HUNTER_LOOKUP: 15, APOLLO_SEARCH: 10, AI_EMAIL: 5, RESUME_PARSE: 20, EMAIL_SEND: 2, EXCEL_EXPORT: 5 }, category: 'credits' },
        { key: 'proPlanPrice',         value: 499,  category: 'billing' },
        { key: 'teamPlanPrice',        value: 1999, category: 'billing' },
        { key: 'aiEmailEnabled',       value: true, category: 'features' },
        { key: 'resumeParseEnabled',   value: true, category: 'features' },
        { key: 'hunterEnabled',        value: true, category: 'features' },
        { key: 'banner',               value: { active: false }, category: 'general' },
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
