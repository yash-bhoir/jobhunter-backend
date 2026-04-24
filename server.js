require('dotenv').config();
const logger = require('./src/config/logger');

// ── Global crash protection (also written to logs/error.log via Winston) ──
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — shutting down:', err.message, err.stack);
  logger.error(`UNCAUGHT_EXCEPTION — ${err.message}`, { stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error(`UNHANDLED_REJECTION — ${msg}`, { stack });
});

const http   = require('http');
const app    = require('./src/app');
const { connectDB, stopDevMemoryMongo } = require('./src/config/database');
const { connectRedis }     = require('./src/config/redis');
const { initSocket }       = require('./src/config/socket');
const { initQueues, startEmailWorker, closeQueues } = require('./src/config/queue');

const PORT = process.env.PORT || 5000;

// ── PM2 cluster: only the first instance runs schedulers ──────────
// When running multiple workers (pm2 cluster mode), each gets a unique
// PM2_APP_INSTANCE id starting at 0. We only want ONE worker to run
// cron jobs to avoid duplicate API calls and DB writes.
const isLeader = !process.env.pm_id || process.env.pm_id === '0';

async function startServer() {
  try {
    // 1. Database
    await connectDB();

    // 2. Redis (optional — graceful degradation if unavailable)
    try { await connectRedis(); }
    catch (err) { logger.warn('Redis not available:', err.message); }

    // 3. HTTP + Socket.IO
    const server = http.createServer(app);
    await initSocket(server);

    // 4. Queue system
    await initQueues();
    await startEmailWorker();

    // 5. Schedulers — only on leader instance
    if (isLeader) {
      try {
        const { startScheduler } = require('./src/services/linkedin/scheduler.service');
        startScheduler();
        logger.info('LinkedIn scheduler started (leader instance)');
      } catch (err) {
        logger.warn('LinkedIn scheduler failed to start:', err.message);
      }

      try {
        const { startJobMaintenanceScheduler } = require('./src/crons/jobMaintenance.cron');
        startJobMaintenanceScheduler();
        logger.info('Job maintenance scheduler started (leader instance)');
      } catch (err) {
        logger.warn('Job maintenance scheduler failed:', err.message);
      }

      try {
        const { startCreditResetScheduler } = require('./src/crons/resetCredits.cron');
        startCreditResetScheduler();
        logger.info('Credit reset scheduler started (leader instance)');
      } catch (err) {
        logger.warn('Credit reset scheduler failed to start:', err.message);
      }

      try {
        const { startCareerScanner } = require('./src/services/careerScanner/scheduler');
        startCareerScanner();
        logger.info('Career page scanner started (leader instance)');
      } catch (err) {
        logger.warn('Career scanner failed to start:', err.message);
      }
    } else {
      logger.info(`Instance ${process.env.pm_id} — schedulers skipped (not leader)`);
    }

    // 6. Listen — attach error handler first so EADDRINUSE is not an uncaughtException
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use (EADDRINUSE).`);
        logger.error('Another API instance is probably still running. Stop it, then restart.');
        logger.error(`Windows: netstat -ano | findstr :${PORT}  →  note the PID in the last column, then: taskkill /PID <pid> /F`);
        logger.error(`Or use a different port: set PORT=5001 in backend .env and point the frontend proxy at that port.`);
      } else {
        logger.error(`HTTP server error (${err.code || 'n/a'}): ${err.message}`);
      }
      const mongoose = require('mongoose');
      mongoose.connection.close().catch(() => {}).finally(() => process.exit(1));
    });

    server.listen(PORT, () => {
      const instance = process.env.pm_id ? ` (worker ${process.env.pm_id})` : '';
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info(`  JobHunter API ready${instance}`);
      logger.info(`  Port  : ${PORT}`);
      logger.info(`  Health: http://localhost:${PORT}/health`);
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    });

    // 7. Graceful shutdown — drain all connections before exit
    const gracefulShutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully…`);
      server.close(async () => {
        try {
          await closeQueues();
          const mongoose = require('mongoose');
          await mongoose.connection.close();
          await stopDevMemoryMongo();
          const { getRedis, getPubClient, getSubClient } = require('./src/config/redis');
          await Promise.allSettled([
            getRedis()?.quit(),
            getPubClient()?.quit(),
            getSubClient()?.quit(),
          ]);
          logger.info('All connections closed — exiting.');
          process.exit(0);
        } catch (err) {
          logger.error('Shutdown error:', err.message);
          process.exit(1);
        }
      });

      // Force exit after 30s if connections don't drain
      setTimeout(() => {
        logger.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

  } catch (err) {
    const msg = err?.message || String(err);
    logger.error(`Startup failed: ${msg}`);
    if (err?.stack) logger.error(err.stack);
    process.exit(1);
  }
}

startServer();
