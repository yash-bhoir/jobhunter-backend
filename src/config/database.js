const mongoose = require('mongoose');
const logger   = require('./logger');

const connectDB = async () => {
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

  mongoose.connection.on('error',        (err) => logger.error('MongoDB error:',       err.message));
  mongoose.connection.on('disconnected', ()    => logger.warn ('MongoDB disconnected — will auto-reconnect'));
  mongoose.connection.on('reconnected',  ()    => logger.info ('MongoDB reconnected'));
};

module.exports = { connectDB };