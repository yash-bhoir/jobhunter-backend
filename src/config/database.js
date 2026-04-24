const dns      = require('dns');
const mongoose = require('mongoose');
const logger   = require('./logger');
const { migrateResumeItemsPdfBuffer } = require('../migrations/migrateResumeItemsPdfBuffer');

let memoryMongo = null;

function useInMemoryMongo() {
  if (process.env.NODE_ENV === 'production') return false;
  return ['1', 'true', 'yes'].includes(String(process.env.USE_IN_MEMORY_MONGO || '').toLowerCase());
}

async function stopDevMemoryMongo() {
  if (!memoryMongo) return;
  try {
    await memoryMongo.stop();
    logger.info('[MongoDB] In-memory server stopped');
  } catch (e) {
    logger.warn('[MongoDB] In-memory stop:', e.message);
  }
  memoryMongo = null;
}

async function startDevMemoryMongo() {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch {
    throw new Error(
      'USE_IN_MEMORY_MONGO is set but mongodb-memory-server is missing. From jobhunter-backend run: npm install',
    );
  }
  memoryMongo = await MongoMemoryServer.create({
    instance: { dbName: 'job_search_db' },
  });
  return memoryMongo.getUri();
}

function applyMongoDnsServersFromEnv() {
  const raw = String(process.env.MONGODB_DNS_SERVERS || '').trim();
  if (!raw) return;
  const servers = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return;
  try {
    dns.setServers(servers);
    logger.info(`[MongoDB] DNS servers for SRV lookup: ${servers.join(', ')}`);
  } catch (e) {
    logger.warn('[MongoDB] MONGODB_DNS_SERVERS ignored:', e.message);
  }
}

const connectDB = async () => {
  applyMongoDnsServersFromEnv();

  let uri;
  if (useInMemoryMongo()) {
    uri = await startDevMemoryMongo();
    logger.warn(
      '[MongoDB] In-memory database (USE_IN_MEMORY_MONGO). Data is lost when the server stops. For production use MONGODB_URI only.',
    );
  } else {
    if (!process.env.MONGODB_URI || String(process.env.MONGODB_URI).trim() === '') {
      throw new Error(
        'MONGODB_URI is missing. Fix Atlas/local Mongo, or run: npm run dev:local (see jobhunter-backend package.json).',
      );
    }
    uri = String(process.env.MONGODB_URI).trim();
  }

  const pool = memoryMongo ? { maxPoolSize: 20, minPoolSize: 1 } : { maxPoolSize: 100, minPoolSize: 10 };
  const conn = await mongoose.connect(uri, {
    ...pool,
    serverSelectionTimeoutMS:  10000,
    socketTimeoutMS:           45000,
    connectTimeoutMS:          10000,
    heartbeatFrequencyMS:      10000,
    maxConnecting:             10,
  });

  const hostLabel = memoryMongo ? 'in-memory (dev)' : conn.connection.host;
  logger.info(`MongoDB connected: ${hostLabel}${memoryMongo ? '' : ' (pool 10→100)'}`);

  try {
    await migrateResumeItemsPdfBuffer();
  } catch (e) {
    logger.warn('[migrate] migrateResumeItemsPdfBuffer:', e.message);
  }

  mongoose.connection.on('error',        (err) => logger.error('MongoDB error:',       err.message));
  mongoose.connection.on('disconnected', ()    => logger.warn ('MongoDB disconnected — will auto-reconnect'));
  mongoose.connection.on('reconnected',  ()    => logger.info ('MongoDB reconnected'));
};

function isInMemoryMongoEnabled() {
  return !!memoryMongo;
}

module.exports = { connectDB, stopDevMemoryMongo, isInMemoryMongoEnabled };
