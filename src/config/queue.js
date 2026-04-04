/**
 * BullMQ queue configuration
 *
 * Queues move heavy/slow operations out of the HTTP request cycle:
 *   - outreach:email  → SMTP sends (2-5 sec each)
 *   - outreach:bulk   → batch of emails
 *
 * Workers run in the same process (dev) or a separate worker process (prod).
 * If Redis is unavailable, operations fall back to direct execution.
 */
const logger = require('./logger');

let queues  = {};
let workers = [];

const QUEUE_NAMES = {
  EMAIL:  'outreach:email',
  BULK:   'outreach:bulk',
};

// ── Get or create a Queue ─────────────────────────────────────────
const getQueue = (name) => {
  if (!queues[name]) return null;
  return queues[name];
};

// ── Initialize queues (call after Redis connects) ─────────────────
const initQueues = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || redisUrl === 'skip') {
    logger.warn('Queues disabled — no Redis (operations run synchronously)');
    return;
  }

  try {
    const { Queue, Worker, QueueEvents } = require('bullmq');

    const connection = {
      host: new URL(redisUrl).hostname,
      port: parseInt(new URL(redisUrl).port) || 6379,
      password: new URL(redisUrl).password || undefined,
    };

    // Create queues
    for (const name of Object.values(QUEUE_NAMES)) {
      queues[name] = new Queue(name, {
        connection,
        defaultJobOptions: {
          removeOnComplete: { count: 100 },  // keep last 100 completed
          removeOnFail:     { count: 50  },  // keep last 50 failed for debugging
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      });
    }

    logger.info(`BullMQ queues initialized: ${Object.values(QUEUE_NAMES).join(', ')}`);
  } catch (err) {
    logger.warn('Queue init failed — operations run synchronously:', err.message);
  }
};

// ── Start queue workers ───────────────────────────────────────────
const startEmailWorker = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || redisUrl === 'skip') return;

  try {
    const { Worker } = require('bullmq');
    const { sendOutreachEmail } = require('../services/outreach/smtp.service');
    const OutreachEmail = require('../models/OutreachEmail');
    const Job           = require('../models/Job');

    const connection = {
      host: new URL(redisUrl).hostname,
      port: parseInt(new URL(redisUrl).port) || 6379,
      password: new URL(redisUrl).password || undefined,
    };

    const emailWorker = new Worker(
      QUEUE_NAMES.EMAIL,
      async (job) => {
        const {
          smtpUser, smtpPass, to, subject, body, fromName,
          attachments, emailId, jobId, company, recruiterName, userId,
        } = job.data;

        // Attachments were serialized to base64 for queue transport — restore Buffers
        const decodedAttachments = (attachments || []).map(a =>
          a._base64 && typeof a.content === 'string'
            ? { ...a, content: Buffer.from(a.content, 'base64') }
            : a
        );

        await sendOutreachEmail({ smtpUser, smtpPass, to, subject, body, fromName, attachments: decodedAttachments });

        // Update record
        if (emailId) {
          await OutreachEmail.findByIdAndUpdate(emailId, {
            status: 'sent', sentAt: new Date(), senderEmail: smtpUser,
          });
        }

        // Mark job applied
        if (jobId) {
          await Job.findByIdAndUpdate(jobId, { status: 'applied', appliedAt: new Date() });
        }

        logger.info(`[Queue] Email sent to ${to} (job ${job.id})`);
        return { sent: true, to };
      },
      {
        connection,
        concurrency: 5,   // max 5 SMTP connections in parallel per worker process
        limiter: {
          max:      10,   // max 10 jobs per duration
          duration: 1000, // per second (10 emails/sec max across all workers)
        },
      }
    );

    emailWorker.on('failed', (job, err) => {
      logger.error(`[Queue] Email job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    });

    emailWorker.on('completed', (job) => {
      logger.debug(`[Queue] Email job ${job.id} completed → ${job.returnvalue?.to}`);
    });

    workers.push(emailWorker);
    logger.info('Email worker started (concurrency: 5, limit: 10/sec)');
  } catch (err) {
    logger.warn('Email worker failed to start:', err.message);
  }
};

// ── Enqueue a single email ────────────────────────────────────────
// Returns job ID if queued, or null if queues unavailable
const enqueueEmail = async (data, opts = {}) => {
  const queue = getQueue(QUEUE_NAMES.EMAIL);
  if (!queue) return null;  // caller must fall back to direct send

  const job = await queue.add('send', data, {
    priority: opts.priority || 10,
    ...opts,
  });
  return job.id;
};

// ── Queue health stats for /health endpoint ───────────────────────
const getQueueStats = async () => {
  const queue = getQueue(QUEUE_NAMES.EMAIL);
  if (!queue) return null;
  try {
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ]);
    return { waiting, active, failed };
  } catch {
    return null;
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────
const closeQueues = async () => {
  await Promise.all([
    ...workers.map(w => w.close()),
    ...Object.values(queues).map(q => q.close()),
  ]);
};

module.exports = {
  initQueues,
  startEmailWorker,
  enqueueEmail,
  getQueue,
  getQueueStats,
  closeQueues,
  QUEUE_NAMES,
};
