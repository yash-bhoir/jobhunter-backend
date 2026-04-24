const ACCESS_COOKIE  = process.env.AUTH_ACCESS_COOKIE_NAME  || 'accessToken';
const REFRESH_COOKIE = process.env.AUTH_REFRESH_COOKIE_NAME || 'refreshToken';

const durationMs = (expiresIn) => {
  if (expiresIn == null) return 15 * 60 * 1000;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) return expiresIn * 1000;

  const s = String(expiresIn).trim();
  const m = s.match(/^(\d+)\s*([smhd])$/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const mult = u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : 86_400_000;
    return n * mult;
  }

  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) return asNum * 1000;

  return 15 * 60 * 1000;
};

const cookieBase = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const crossSite = String(process.env.AUTH_COOKIE_CROSS_SITE || '').toLowerCase() === 'true';

  let sameSite = process.env.AUTH_COOKIE_SAMESITE || (crossSite ? 'none' : 'lax');
  if (!['lax', 'strict', 'none'].includes(sameSite)) sameSite = 'lax';

  let secure = process.env.AUTH_COOKIE_SECURE != null
    ? String(process.env.AUTH_COOKIE_SECURE).toLowerCase() === 'true'
    : isProd || sameSite === 'none';

  if (sameSite === 'none' && !secure) {
    secure = true;
  }

  const domain = process.env.AUTH_COOKIE_DOMAIN || undefined;

  return {
    path:     '/',
    domain,
    secure,
    sameSite,
    httpOnly: true,
  };
};

const maxAgeFromJwtExpiresIn = (expiresIn) => {
  const n = durationMs(expiresIn || '15m');
  if (!Number.isFinite(n) || n <= 0) return 15 * 60 * 1000;
  return Math.min(n, 365 * 24 * 60 * 60 * 1000);
};

const setAuthCookies = (res, tokens) => {
  const base = cookieBase();

  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: maxAgeFromJwtExpiresIn(process.env.JWT_EXPIRE || '15m'),
  });

  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: maxAgeFromJwtExpiresIn(process.env.JWT_REFRESH_EXPIRE || '30d'),
  });
};

const clearAuthCookies = (res) => {
  const base = cookieBase();
  res.clearCookie(ACCESS_COOKIE,  { path: base.path, domain: base.domain, sameSite: base.sameSite, secure: base.secure });
  res.clearCookie(REFRESH_COOKIE, { path: base.path, domain: base.domain, sameSite: base.sameSite, secure: base.secure });
};

module.exports = { ACCESS_COOKIE, REFRESH_COOKIE, setAuthCookies, clearAuthCookies };
