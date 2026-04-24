const { Server } = require('socket.io');
const logger = require('./logger');
const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwt.util');
const { ACCESS_COOKIE } = require('../utils/authCookies.util');

const parseCookies = (cookieHeader) => {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
};

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

  io.on('connection', async (socket) => {
    logger.debug(`Socket connected: ${socket.id}`);

    // Register handlers immediately — the join guard checks socket.data.userId which
    // is only set after auth completes, so early events are silently dropped safely.
    socket.on('join', (userId) => {
      if (!socket.data.userId || String(userId) !== socket.data.userId) return;
      socket.join(`user:${userId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });

    try {
      const headerCookie =
        socket.handshake.headers?.cookie ||
        socket.request?.headers?.cookie ||
        '';
      const cookies = parseCookies(headerCookie);
      const token =
        socket.handshake.auth?.token ||
        cookies[ACCESS_COOKIE] ||
        null;

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id).select('_id status').lean();
      if (!user || user.status === 'banned') {
        socket.disconnect(true);
        return;
      }

      socket.data.userId = String(user._id);
    } catch {
      socket.disconnect(true);
    }
  });

  return io;
};

const getIO    = ()          => io;
const emitToUser = (userId, event, data) => io?.to(`user:${userId}`).emit(event, data);

module.exports = { initSocket, getIO, emitToUser };