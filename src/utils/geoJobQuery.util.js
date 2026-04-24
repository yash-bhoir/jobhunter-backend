/**
 * Shared title / text matching for map + list parity (OR on meaningful tokens).
 */
const GENERIC_WORDS = new Set([
  'developer', 'engineer', 'senior', 'junior', 'lead', 'manager', 'associate', 'intern',
  'staff', 'principal', 'head', 'director', 'vp', 'cto', 'coo', 'and', 'the', 'for', 'with',
  'jobs', 'role', 'position', 'level', 'remote', 'full', 'part', 'time', 'contract', 'hybrid',
  'entry', 'mid', 'experienced', 'fresher', 'graduate', 'trainee',
]);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTitleFilter(raw) {
  if (!raw || !String(raw).trim()) return null;
  const rawTrim = String(raw).trim();
  const terms = rawTrim.toLowerCase().split(/[\s,/|&()+]+/)
    .filter(w => w.length > 2 && !GENERIC_WORDS.has(w))
    .map(escapeRegex)
    .filter(Boolean);
  const pattern = terms.length > 0 ? terms.join('|') : escapeRegex(rawTrim);
  if (!pattern) return null;
  return { $regex: pattern, $options: 'i' };
}

module.exports = { buildTitleFilter, GENERIC_WORDS, escapeRegex };
