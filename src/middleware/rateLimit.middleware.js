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
// At 500K users: 200 req/15min per user = 1.3 req/sec sustained
const generalLimiter = rateLimit(makeOptions(
  15 * 60 * 1000,  // 15 min window
  300,
  { message: 'Too many requests. Slow down.' }
));

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
  searchLimiter,
  emailLimiter,
  generalLimiter,
  rankingEventLimiter,
};
