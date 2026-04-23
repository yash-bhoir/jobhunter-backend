const rateLimit  = require('express-rate-limit');

// ── Build Redis store if available, else fall back to memory ──────
// This is called lazily so Redis has time to connect before first request
const makeStore = () => {
  try {
    const { getRedis } = require('../config/redis');
    const client = getRedis();
    if (client) {
      const { RedisStore } = require('rate-limit-redis');
      return new RedisStore({
        sendCommand: (...args) => client.sendCommand(args),
        // Prefix so rate-limit keys don't collide with cache keys
        prefix: 'rl:',
      });
    }
  } catch { /* fall through */ }
  return undefined; // express-rate-limit defaults to memory store
};

const makeOptions = (windowMs, max, message) => ({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, ...message, code: 'RATE_LIMIT' },
  skip:            () => process.env.NODE_ENV === 'test',
  // Store is evaluated lazily on first request — Redis should be up by then
  store:           makeStore(),
});

// ── Auth routes — strict limit ────────────────────────────────────
const authLimiter = rateLimit(makeOptions(
  15 * 60 * 1000,  // 15 min window
  20,
  { message: 'Too many auth attempts. Try again in 15 minutes.' }
));

// ── Refresh / OAuth code exchange — tighter burst control ─────────
const refreshLimiter = rateLimit(makeOptions(
  15 * 60 * 1000,
  60,
  { message: 'Too many session refreshes. Try again in 15 minutes.' }
));

// ── Search — prevent expensive API abuse ─────────────────────────
const searchLimiter = rateLimit(makeOptions(
  60 * 1000,  // 1 min window
  5,
  { message: 'Too many searches. Please wait a moment.' }
));

// ── Email sending ─────────────────────────────────────────────────
const emailLimiter = rateLimit(makeOptions(
  60 * 60 * 1000,  // 1 hour window
  50,
  { message: 'Email send limit reached. Try again in an hour.' }
));

// ── General API — generous for normal use ────────────────────────
// Skip session bootstrap: GET /auth/me is called on every full load / tab; counting it here
// stacks with HMR reloads and SPA navigations and causes 429 → false "logged out" loops.
// POST /auth/refresh has its own refreshLimiter on the route.
const generalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, message: 'Too many requests. Slow down.', code: 'RATE_LIMIT' },
  skip: (req) => {
    if (process.env.NODE_ENV === 'test') return true;
    const url = req.originalUrl || req.url || '';
    if (req.method === 'GET' && url.includes('/auth/me')) return true;
    if (req.method === 'POST' && url.includes('/auth/refresh')) return true;
    return false;
  },
  store: makeStore(),
});

// ── Ranking UX events — per-user, generous but stops spam / loops ─
const rankingEventLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             180,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, message: 'Too many ranking events. Slow down.', code: 'RATE_LIMIT' },
  skip:            () => process.env.NODE_ENV === 'test',
  store:           makeStore(),
  keyGenerator:    (req) => (req.user?._id ? `rank:${req.user._id}` : `rank:${req.ip}`),
});

module.exports = {
  authLimiter,
  refreshLimiter,
  searchLimiter,
  emailLimiter,
  generalLimiter,
  rankingEventLimiter,
};
