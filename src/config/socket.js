const { Server } = require('socket.io');
const logger = require('./logger');

let io;

const initSocket = async (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    // Tuned for high concurrency
    pingInterval:  25000,
    pingTimeout:   20000,
    maxHttpBufferSize: 1e6,  // 1 MB max payload
  });

  // ── Redis adapter (enables multi-process / multi-server scaling) ──
  // When Redis is available, all Node.js instances share the same
  // pub/sub channel so emitToUser() reaches the right socket regardless
  // of which process the user is connected to.
  try {
    const { getPubClient, getSubClient } = require('./redis');
    const pub = getPubClient();
    const sub = getSubClient();
    if (pub && sub) {
      const { createAdapter } = require('@socket.io/redis-adapter');
      io.adapter(createAdapter(pub, sub));
      logger.info('Socket.IO using Redis adapter (multi-instance ready)');
    } else {
      logger.warn('Socket.IO using in-memory adapter (single-instance only)');
    }
  } catch (err) {
    logger.warn('Socket.IO Redis adapter failed, using in-memory:', err.message);
  }

  io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.id}`);

    socket.on('join', (userId) => {
      socket.join(`user:${userId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
};

const getIO    = ()          => io;
const emitToUser = (userId, event, data) => io?.to(`user:${userId}`).emit(event, data);

module.exports = { initSocket, getIO, emitToUser };