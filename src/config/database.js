const mongoose = require('mongoose');
const logger   = require('./logger');
const { migrateResumeItemsPdfBuffer } = require('../migrations/migrateResumeItemsPdfBuffer');

const connectDB = async () => {
  if (!process.env.MONGODB_URI || String(process.env.MONGODB_URI).trim() === '') {
    throw new Error(
      'MONGODB_URI is missing. On Render: Web Service → Environment → add MONGODB_URI (MongoDB Atlas connection string).',
    );
  }
  const conn = await mongoose.connect(process.env.MONGODB_URI, {
    // Pool: 1 connection per expected concurrent request (scale with instance count)
    maxPoolSize:               100,
    minPoolSize:               10,
    // Timeouts
    serverSelectionTimeoutMS:  10000,
    socketTimeoutMS:           45000,
    connectTimeoutMS:          10000,
    // Heartbeat so idle connections are kept warm
    heartbeatFrequencyMS:      10000,
    // Auto-reconnect
    maxConnecting:             10,
  });

  logger.info(`MongoDB connected: ${conn.connection.host} (pool 10→100)`);

  try {
    await migrateResumeItemsPdfBuffer();
  } catch (e) {
    logger.warn('[migrate] migrateResumeItemsPdfBuffer:', e.message);
  }

  mongoose.connection.on('error',        (err) => logger.error('MongoDB error:',       err.message));
  mongoose.connection.on('disconnected', ()    => logger.warn ('MongoDB disconnected — will auto-reconnect'));
  mongoose.connection.on('reconnected',  ()    => logger.info ('MongoDB reconnected'));
};

module.exports = { connectDB };