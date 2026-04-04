const jwt = require('jsonwebtoken');
const { AuthError } = require('./errors');

const generateTokens = (payload) => ({
  accessToken:  jwt.sign(payload, process.env.JWT_SECRET,         { expiresIn: process.env.JWT_EXPIRE         || '15m' }),
  refreshToken: jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }),
});

const verifyAccessToken = (token) => {
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { throw new AuthError('Invalid or expired token'); }
};

const verifyRefreshToken = (token) => {
  try { return jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
  catch { throw new AuthError('Refresh token expired'); }
};

module.exports = { generateTokens, verifyAccessToken, verifyRefreshToken };