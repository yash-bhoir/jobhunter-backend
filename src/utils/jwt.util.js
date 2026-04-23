const jwt = require('jsonwebtoken');
const { AuthError } = require('./errors');

/**
 * @param {object} payload — must include `id`, `role`, `plan`, `refreshSessionVersion` (number).
 *        Optional: `impersonatedBy` (ObjectId) for admin impersonation.
 */
const generateTokens = (payload) => {
  const { id, role, plan, refreshSessionVersion, impersonatedBy } = payload;
  const rsv = Number(refreshSessionVersion);
  if (!Number.isFinite(rsv) || rsv < 0) {
    throw new Error('generateTokens: refreshSessionVersion must be a non-negative number');
  }
  const accessBody = { id, role, plan, rsv, ...(impersonatedBy ? { impersonatedBy: String(impersonatedBy) } : {}) };
  const refreshBody = { id, rsv };
  return {
    accessToken:  jwt.sign(accessBody, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '15m' }),
    refreshToken: jwt.sign(refreshBody, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }),
  };
};

const verifyAccessToken = (token) => {
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { throw new AuthError('Invalid or expired token'); }
};

const verifyRefreshToken = (token) => {
  try { return jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
  catch { throw new AuthError('Refresh token expired'); }
};

module.exports = { generateTokens, verifyAccessToken, verifyRefreshToken };