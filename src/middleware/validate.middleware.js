const { validationResult } = require('express-validator');
const { ValidationError }  = require('../utils/errors');

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ValidationError(
      'Validation failed',
      errors.array().map(e => ({ field: e.path, message: e.msg }))
    ));
  }
  next();
};

module.exports = { validate };