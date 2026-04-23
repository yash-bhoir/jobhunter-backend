const { verifyAccessToken }         = require('../utils/jwt.util');
const { AuthError, ForbiddenError } = require('../utils/errors');
const User                          = require('../models/User');
const { cache }                     = require('../config/redis');

// ── How long to cache a user object (seconds) ─────────────────────
// Short TTL so plan/ban changes propagate quickly.
// At 500K users doing ~10 requests/session:
//   Without cache: 5M DB queries/session-day
//   With 60s cache: ~83K DB queries/session-day (≈ 98% reduction)
const USER_CACHE_TTL = 60;

// Cache key helper
const userCacheKey = (id) => `auth:user:${id}`;

const authenticate = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      throw new AuthError('No token provided');

    const decoded = verifyAccessToken(header.split(' ')[1]);
    const cacheKey = userCacheKey(decoded.id);

    // ── Try Redis cache first ──────────────────────────────────────
    let userData = await cache.get(cacheKey);

    if (userData) {
      // Rehydrate as a plain object (no Mongoose methods needed for middleware)
      req.user = userData;
    } else {
      // Cache miss — hit DB and store result
      const user = await User.findById(decoded.id).select('-password').lean();

      if (!user) throw new AuthError('User not found');

      await cache.set(cacheKey, user, USER_CACHE_TTL);
      req.user = user;
    }

    if (req.user.status === 'banned') throw new ForbiddenError('Account suspended');

    // Align access JWT with refreshSessionVersion (logout / password change / refresh rotation).
    const uRsv = Number(req.user.refreshSessionVersion ?? 0);
    const hasRsvClaim = decoded.rsv !== undefined && decoded.rsv !== null;
    if (!hasRsvClaim) {
      if (uRsv > 0) throw new AuthError('Session expired');
    } else {
      const tokenRsv = Number(decoded.rsv);
      if (!Number.isFinite(tokenRsv) || tokenRsv !== uRsv) throw new AuthError('Session expired');
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ── Call this after profile/plan changes to invalidate stale cache ─
const invalidateUserCache = (userId) => {
  cache.del(userCacheKey(String(userId))).catch(() => {});
};

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role))
    return next(new ForbiddenError('Insufficient permissions'));
  next();
};

module.exports = { authenticate, requireRole, invalidateUserCache };
