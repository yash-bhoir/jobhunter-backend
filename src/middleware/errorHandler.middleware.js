const logger = require('../config/logger');

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

  // ── Log server errors ─────────────────────────────────────────────
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.originalUrl} — ${err.message}`, {
      userId:  req.user?._id,
      body:    process.env.NODE_ENV === 'development' ? req.body : '[hidden]',
      stack:   err.stack,
    });
  } else if (statusCode >= 400) {
    logger.warn(`[${req.method}] ${req.originalUrl} — ${statusCode} ${message}`);
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
