/**
 * Shared httpOnly refresh cookie options (path must match clearCookie).
 */
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   30 * 24 * 60 * 60 * 1000,
  };
}

function clearRefreshCookie(res) {
  res.clearCookie('refreshToken', {
    path:     '/',
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
  });
}

module.exports = { refreshCookieOptions, clearRefreshCookie };
