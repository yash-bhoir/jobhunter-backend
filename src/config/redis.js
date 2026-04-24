const logger = require('./logger');

let client    = null;   // main client (cache / rate-limit / auth cache)
let pubClient = null;   // Socket.IO pub
let subClient = null;   // Socket.IO sub

const connectRedis = async () => {
  const url = process.env.REDIS_URL;
  if (!url || url === 'skip') {
    logger.warn('Redis skipped — running without cache/pubsub (single-instance mode)');
    return null;
  }
  try {
    const { createClient } = require('redis');

    // Main client
    client = createClient({
      url,
      socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
    });
    client.on('error',       (err) => logger.error('Redis error:', err.message));
    client.on('reconnecting', ()   => logger.warn ('Redis reconnecting…'));
    await client.connect();

    // Pub/Sub clients for Socket.IO adapter (need separate connections)
    pubClient = client.duplicate();
    subClient = client.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    logger.info('Redis connected (main + pub + sub clients)');
    return client;
  } catch (err) {
    logger.warn('Redis unavailable — single-instance mode:', err.message);
    client = pubClient = subClient = null;
    return null;
  }
};

const getRedis    = ()  => client;
const getPubClient = () => pubClient;
const getSubClient = () => subClient;

// ── Simple cache helper (graceful no-op when Redis is unavailable) ──
const cache = {
  get: async (key) => {
    try {
      if (!client) return null;
      const val = await client.get(key);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  },
  set: async (key, value, ttl = 3600) => {
    try {
      if (!client) return;
      await client.setEx(key, ttl, JSON.stringify(value));
    } catch { }
  },
  del: async (key) => {
    try {
      if (!client) return;
      await client.del(key);
    } catch { }
  },
  // Delete multiple keys matching a pattern
  delPattern: async (pattern) => {
    try {
      if (!client) return;
      if (typeof client.scanIterator === 'function') {
        const keys = [];
        for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          keys.push(key);
          if (keys.length >= 500) {
            await client.del(keys);
            keys.length = 0;
          }
        }
        if (keys.length > 0) await client.del(keys);
        return;
      }

      let cursor = '0';
      do {
        const [next, batch] = await client.scan(cursor, { MATCH: pattern, COUNT: 200 });
        cursor = next;
        if (batch.length > 0) await client.del(batch);
      } while (cursor !== '0');
    } catch { }
  },
};

module.exports = { connectRedis, getRedis, getPubClient, getSubClient, cache };