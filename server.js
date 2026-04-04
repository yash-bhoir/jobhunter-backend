require('dotenv').config();

// ── Global crash protection ────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — shutting down:', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  // Don't crash — log and continue
});

const http   = require('http');
const app    = require('./src/app');
const { connectDB }        = require('./src/config/database');
const { connectRedis }     = require('./src/config/redis');
const { initSocket }       = require('./src/config/socket');
const { initQueues, startEmailWorker, closeQueues } = require('./src/config/queue');
const logger               = require('./src/config/logger');

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
        const { startJobMaintenanceScheduler } = require('./src/services/jobs/maintenance.service');
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
    } else {
      logger.info(`Instance ${process.env.pm_id} — schedulers skipped (not leader)`);
    }

    // 6. Listen
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
    logger.error('Startup failed:', err.message);
    process.exit(1);
  }
}

startServer();
