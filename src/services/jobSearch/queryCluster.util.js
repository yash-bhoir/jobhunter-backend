const crypto = require('crypto');

const STOP = new Set([
  'the', 'a', 'an', 'for', 'and', 'or', 'in', 'to', 'of', 'with', 'at', 'as', 'on',
  'remote', 'hybrid', 'onsite', 'any', 'full', 'time', 'part', 'contract',
  'engineer', 'developer', 'development', 'software', 'web', 'application',
  'senior', 'junior', 'mid', 'lead', 'staff', 'principal', 'intern', 'ii', 'iii', 'iv',
  'level', 'job', 'role', 'stack',
]);

function normLoc(loc) {
  return String(loc || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Meaningful tokens from the role / query string */
function roleTokens(role) {
  return String(role || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+/]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Broad engineering family for cross-query snapshot reuse (same geo + modality).
 */
function roleFamily(role) {
  const t = roleTokens(role).join(' ');
  if (/mern|mean|mevn|mongo|mongoose|express\.?js|nestjs|fastapi|django|flask|rails|spring|laravel|php|java|\.net|dotnet|backend|api\b|server|go\b|golang|rust|kotlin/.test(t)) {
    return 'backend';
  }
  if (/react|vue|svelte|angular|frontend|front-end|front\s*end|ui\b|css|html|webpack|typescript|javascript/.test(t)) {
    return 'frontend';
  }
  if (/full\s*stack|fullstack|full-stack/.test(t)) return 'fullstack';
  if (/data\s*science|machine\s*learning|\bml\b|\bai\b|nlp|analyst|analytics/.test(t)) return 'data';
  if (/devops|sre|cloud|kubernetes|k8s|docker|aws|azure|gcp|platform|infra/.test(t)) return 'devops';
  if (/mobile|ios|android|flutter|react\s*native/.test(t)) return 'mobile';
  if (/qa|test|quality|automation|sdet/.test(t)) return 'qa';
  if (/product\s*manager|project\s*manager|\bpm\b/.test(t)) return 'pm';
  return 'software';
}

function buildClusterFamilyId(role, location, workType) {
  const key = `${normLoc(location)}|${String(workType || '').toLowerCase().trim()}|${roleFamily(role)}`;
  return crypto.createHash('md5').update(key).digest('hex');
}

function jaccardTokens(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** Tokens that should match listing text when reusing a sibling snapshot */
function distinctiveTokens(role) {
  const tok = roleTokens(role);
  const generic = new Set(['software', 'developer', 'engineer', 'web', 'application', 'stack']);
  const d = tok.filter((t) => !generic.has(t));
  return d.length ? d : tok;
}

module.exports = {
  normLoc,
  roleTokens,
  roleFamily,
  buildClusterFamilyId,
  jaccardTokens,
  distinctiveTokens,
};
