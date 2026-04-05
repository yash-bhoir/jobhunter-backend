/**
 * appConfig.js — reads admin-editable config from DB with Redis cache fallback.
 * All consumers call getAppConfig(key) instead of hardcoded constants.
 */
const { cache }        = require('../config/redis');
const { CREDIT_COSTS, PLAN_CREDITS, PLAN_LIMITS } = require('./constants');

const CACHE_TTL = 300; // 5 minutes

const DEFAULTS = {
  creditCosts:    CREDIT_COSTS,
  planCredits:    PLAN_CREDITS,
  freePlanLimits: { creditsPerMonth: PLAN_CREDITS.free,  searchesPerDay: PLAN_LIMITS.free?.searchesPerDay  || 2 },
  proPlanLimits:  { creditsPerMonth: PLAN_CREDITS.pro,   searchesPerDay: PLAN_LIMITS.pro?.searchesPerDay   || 999 },
  teamPlanLimits: { creditsPerMonth: PLAN_CREDITS.team,  searchesPerDay: PLAN_LIMITS.team?.searchesPerDay  || 999 },
};

/**
 * Fetch a single config value from DB (cached).
 * Falls back to DEFAULTS[key] if not set.
 */
async function getAppConfig(key) {
  const cacheKey = `appconfig:${key}`;
  try {
    // 1. Try Redis cache
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    // 2. Try DB
    const PlatformConfig = require('../models/PlatformConfig');
    const doc = await PlatformConfig.findOne({ key }).lean();
    const value = doc?.value ?? DEFAULTS[key] ?? null;

    // 3. Cache result
    await cache.set(cacheKey, value, CACHE_TTL);
    return value;
  } catch {
    // If anything fails, return hardcoded default
    return DEFAULTS[key] ?? null;
  }
}

/**
 * Bust the cache for a key — call this after admin updates a config.
 */
async function bustAppConfig(key) {
  await cache.del(`appconfig:${key}`);
}

/**
 * Get all credit costs (merged with defaults so new actions always have a value).
 */
async function getCreditCosts() {
  const saved = await getAppConfig('creditCosts');
  return { ...CREDIT_COSTS, ...(saved || {}) };
}

module.exports = { getAppConfig, bustAppConfig, getCreditCosts };
