const logger      = require('../config/logger');
const ErrorLog    = require('../models/ErrorLog');
const UserCredits = require('../models/UserCredits');
const { sendEmail, templates } = require('../config/mailer');

// Rate-limit error emails: max 1 per unique (method+endpoint+code) per 2 minutes
// Prevents flooding if a broken endpoint gets hammered
const _errorEmailCache = new Map();
const ALERT_COOLDOWN_MS = 2 * 60 * 1000;

function shouldSendErrorEmail(method, endpoint, code) {
  const key = `${method}:${endpoint}:${code}`;
  const lastSent = _errorEmailCache.get(key);
  if (lastSent && Date.now() - lastSent < ALERT_COOLDOWN_MS) return false;
  _errorEmailCache.set(key, Date.now());
  return true;
}

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

  // ── Auto-refund credits on system errors (5xx) ───────────────────
  // If the middleware already deducted credits and the controller threw
  // a system error (not a user/validation error), give them back.
  // This covers search failures, AI timeouts, HR lookup errors, etc.
  if (statusCode >= 500 && req.creditsDeducted > 0 && req.user?._id) {
    UserCredits.findOneAndUpdate(
      { userId: req.user._id },
      { $inc: { usedCredits: -req.creditsDeducted } }
    ).catch(e => logger.warn(`Credit auto-refund failed for ${req.user.email}: ${e.message}`));

    logger.info(
      `Credits auto-refunded: ${req.creditsDeducted} → ${req.user.email} ` +
      `(${req.method} ${req.originalUrl} failed with ${statusCode})`
    );
    req.creditsDeducted = 0; // prevent double-refund if error handler called twice
  }

  // ── Log to console ────────────────────────────────────────────────
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.originalUrl} — ${err.message}`, {
      userId: req.user?._id,
      body:   process.env.NODE_ENV === 'development' ? req.body : '[hidden]',
      stack:  err.stack,
    });

    // ── Email alert to admin ──────────────────────────────────────
    const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL;
    if (adminEmail && shouldSendErrorEmail(req.method, req.originalUrl, code)) {
      const alertData = {
        method:    req.method,
        endpoint:  req.originalUrl,
        statusCode,
        errorCode: code,
        message,
        stack:     err.stack || null,
        userId:    req.user?._id?.toString() || null,
        userEmail: req.user?.email           || null,
        ip:        req.ip || req.connection?.remoteAddress || null,
        userAgent: req.headers?.['user-agent'] || null,
        timestamp: new Date().toISOString(),
      };
      sendEmail({
        to:      adminEmail,
        subject: templates.errorAlert(alertData).subject,
        html:    templates.errorAlert(alertData).html,
      }).catch(e => logger.warn(`Error alert email failed: ${e.message}`));
    }
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

  // Only expose stack for 5xx in development — avoid leaking paths on routine 401s
  if (process.env.NODE_ENV === 'development' && statusCode >= 500) payload.stack = err.stack;

  return res.status(statusCode).json(payload);
};

module.exports = { errorHandler };
