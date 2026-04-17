const express = require('express');
const router  = express.Router();
const { getCreditCosts, getAppConfig } = require('../utils/appConfig');
const { success } = require('../utils/response.util');

// Public — no auth needed. Returns credit costs and plan limits for display in frontend.
router.get('/public', async (_req, res, next) => {
  try {
    const [creditCosts, freeLimits, proLimits, teamLimits] = await Promise.all([
      getCreditCosts(),
      getAppConfig('freePlanLimits'),
      getAppConfig('proPlanLimits'),
      getAppConfig('teamPlanLimits'),
    ]);
    return success(res, { creditCosts, planLimits: { free: freeLimits, pro: proLimits, team: teamLimits } });
  } catch (err) { next(err); }
});

module.exports = router;
