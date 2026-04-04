class AppError extends Error {
  constructor(message, statusCode = 500, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthError extends AppError {
  constructor(msg = 'Authentication failed') { super(msg, 401, 'AUTH_ERROR'); }
}
class ForbiddenError extends AppError {
  constructor(msg = 'Access denied') { super(msg, 403, 'FORBIDDEN'); }
}
class NotFoundError extends AppError {
  constructor(msg = 'Not found') { super(msg, 404, 'NOT_FOUND'); }
}
class ValidationError extends AppError {
  constructor(msg = 'Validation failed', errors = []) {
    super(msg, 422, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}
class CreditError extends AppError {
  constructor(required, available) {
    super(`Insufficient credits. Need ${required}, have ${available}`, 402, 'INSUFFICIENT_CREDITS');
    this.required  = required;
    this.available = available;
  }
}
class ConflictError extends AppError {
  constructor(msg = 'Already exists') { super(msg, 409, 'CONFLICT'); }
}

module.exports = { AppError, AuthError, ForbiddenError, NotFoundError, ValidationError, CreditError, ConflictError };