require('dotenv').config();
const express        = require('express');
const helmet         = require('helmet');
const cors           = require('cors');
const morgan         = require('morgan');
const mongoSanitize  = require('express-mongo-sanitize');
const compression    = require('compression');
const cookieParser   = require('cookie-parser');
const passport = require('./config/passport');

const routes                 = require('./routes');
const { errorHandler }       = require('./middleware/errorHandler.middleware');
const { generalLimiter }     = require('./middleware/rateLimit.middleware');
const logger                 = require('./config/logger');

const app = express();

// Security
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
}));
app.use(cors({
  origin:      process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(mongoSanitize());

// General
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Handle malformed JSON before routes
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON in request body', code: 'INVALID_JSON' });
  }
  next(err);
});

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(morgan('dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// Add unique request ID to every request for tracing
app.use((req, _res, next) => {
  req.id = require('crypto').randomUUID();
  next();
});

// Rate limiting — Redis-backed so counters are shared across all PM2 workers
app.use('/api', generalLimiter);

// Health check — detailed system status for load balancers and monitoring
app.get('/health', async (_req, res) => {
  const mongoose = require('mongoose');
  const os       = require('os');
  const { isInMemoryMongoEnabled } = require('./config/database');

  // MongoDB
  const dbState  = mongoose.connection.readyState;
  const dbStatus = ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown';

  // Redis
  let redisStatus = 'unavailable';
  try {
    const { getRedis } = require('./config/redis');
    const client = getRedis();
    if (client) {
      await client.ping();
      redisStatus = 'connected';
    }
  } catch { /* Redis not available */ }

  // Queue
  let queueStatus = 'unavailable';
  try {
    const { getQueueStats } = require('./config/queue');
    const stats = await getQueueStats();
    queueStatus = stats || 'ok';
  } catch { /* Queue not available */ }

  // Memory
  const mem  = process.memoryUsage();
  const heap = Math.round(mem.heapUsed  / 1024 / 1024);
  const rss  = Math.round(mem.rss       / 1024 / 1024);
  const free = Math.round(os.freemem()  / 1024 / 1024);

  const healthy = dbStatus === 'connected';
  res.status(healthy ? 200 : 503).json({
    status:    healthy ? 'ok' : 'degraded',
    timestamp: new Date(),
    env:       process.env.NODE_ENV,
    instance:  process.env.pm_id ?? 'standalone',
    uptime:    Math.round(process.uptime()),
    db:        dbStatus,
    /** `ephemeral-memory` = dev:local / USE_IN_MEMORY_MONGO — not your Atlas data */
    mongoBackend: isInMemoryMongoEnabled() ? 'ephemeral-memory' : 'persistent',
    redis:     redisStatus,
    queue:     queueStatus,
    memory: {
      heapMB: heap,
      rssMB:  rss,
      freeSystemMB: free,
    },
  });
});

// API routes
app.use('/api/v1', routes);

// 404
app.use('*', (_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use(errorHandler);

module.exports = app;