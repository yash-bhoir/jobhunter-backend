const crypto = require('crypto');

const generateToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

module.exports = { generateToken, hashToken };