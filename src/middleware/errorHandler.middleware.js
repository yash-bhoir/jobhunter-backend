const logger   = require('../config/logger');
const ErrorLog = require('../models/ErrorLog');

// Severity based on status code
const getSeverity = (statusCode) => {
  if (statusCode >= 500) return 'critical';
  if (statusCode === 429) return 'medium';
  if (statusCode >= 400) return 'low';
  return 'low';
};

const errorHandler = (err, req, res, _next) => {
  let { statusCode = 500, message = 'Internal server error', code = 'SERVER_ERROR' } = err;

  // ── Mongoose Validation ───────────────────────────────────────────
  if (err.name === 'ValidationError') {
    statusCode = 422; code = 'VALIDATION_ERROR';
    message = Object.values(err.errors).map(e => e.message).join(', ');
  }

  // ── Mongoose Duplicate Key ────────────────────────────────────────
  if (err.code === 11000) {
    statusCode = 409; code = 'DUPLICATE_KEY';
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    message = `${field} already in use`;
  }

  // ── Mongoose Cast Error ───────────────────────────────────────────
  if (err.name === 'CastError') {
    statusCode = 400; code = 'INVALID_ID';
    message = 'Invalid ID format';
  }

  // ── JWT ───────────────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') { statusCode = 401; code = 'INVALID_TOKEN';  message = 'Invalid token'; }
  if (err.name === 'TokenExpiredError') { statusCode = 401; code = 'EXPIRED_TOKEN';  message = 'Token expired'; }
  if (err.name === 'NotBeforeError')    { statusCode = 401; code = 'TOKEN_NOT_ACTIVE'; message = 'Token not yet active'; }

  // ── Malformed JSON body ───────────────────────────────────────────
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    statusCode = 400; code = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
  }

  // ── Multer (file upload) ──────────────────────────────────────────
  if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 413; code = 'FILE_TOO_LARGE';
    message = 'File too large. Maximum size is 5MB.';
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    statusCode = 400; code = 'UNEXPECTED_FILE';
    message = 'Unexpected file field in upload';
  }

  // ── Mongoose disconnected ─────────────────────────────────────────
  if (err.name === 'MongoNetworkError' || err.name === 'MongooseServerSelectionError') {
    statusCode = 503; code = 'DATABASE_ERROR';
    message = 'Database connection error. Please try again.';
  }

  // ── Axios / external API ──────────────────────────────────────────
  if (err.isAxiosError) {
    statusCode = 502; code = 'UPSTREAM_ERROR';
    message = 'External API error. Please try again later.';
  }

  // ── Log to console ────────────────────────────────────────────────
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.originalUrl} — ${err.message}`, {
      userId: req.user?._id,
      body:   process.env.NODE_ENV === 'development' ? req.body : '[hidden]',
      stack:  err.stack,
    });
  } else if (statusCode >= 400) {
    logger.warn(`[${req.method}] ${req.originalUrl} — ${statusCode} ${message}`);
  }

  // ── Persist to ErrorLog collection (async, non-blocking) ──────────
  // Skip 401/404 noise and health checks
  const skipLog = statusCode === 401 || statusCode === 404 ||
    req.originalUrl.includes('/health') || req.originalUrl.includes('/favicon');

  if (!skipLog) {
    ErrorLog.create({
      userId:     req.user?._id   || null,
      userEmail:  req.user?.email || null,
      type:       'backend',
      severity:   getSeverity(statusCode),
      message,
      code,
      stack:      statusCode >= 500 ? err.stack : null,
      endpoint:   req.originalUrl,
      method:     req.method,
      statusCode,
      ip:         req.ip || req.connection?.remoteAddress,
      userAgent:  req.headers?.['user-agent'],
      metadata: {
        body:   statusCode >= 500 && process.env.NODE_ENV === 'development' ? req.body : undefined,
        params: req.params,
        query:  req.query,
      },
    }).catch(() => {}); // never block the response
  }

  const payload = { success: false, message, code };
  if (err.errors)    payload.errors    = err.errors;
  if (err.required)  payload.required  = err.required;
  if (err.available) payload.available = err.available;

  // Only expose stack in development
  if (process.env.NODE_ENV === 'development') payload.stack = err.stack;

  return res.status(statusCode).json(payload);
};

module.exports = { errorHandler };
