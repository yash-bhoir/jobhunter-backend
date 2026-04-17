// ── Skills synonym map ──────────────────────────────────────────────────────
// When a user lists "JS", we also search for "javascript" etc.
// Each entry: canonical → array of aliases (all lowercase)
const SKILL_SYNONYMS = {
  'javascript':    ['js', 'es6', 'es2015', 'ecmascript', 'vanilla js'],
  'typescript':    ['ts'],
  'node.js':       ['node', 'nodejs', 'node js'],
  'react':         ['reactjs', 'react.js', 'react js'],
  'vue':           ['vuejs', 'vue.js', 'vue js'],
  'angular':       ['angularjs', 'angular.js', 'ng'],
  'python':        ['py'],
  'c#':            ['csharp', 'c sharp', 'dotnet', '.net'],
  'c++':           ['cpp', 'c plus plus'],
  'golang':        ['go lang', 'go programming'],
  'postgresql':    ['postgres', 'pg'],
  'mongodb':       ['mongo'],
  'mysql':         ['my sql'],
  'kubernetes':    ['k8s', 'kube'],
  'docker':        ['containerization', 'containers'],
  'aws':           ['amazon web services', 'amazon aws'],
  'gcp':           ['google cloud', 'google cloud platform'],
  'azure':         ['microsoft azure'],
  'machine learning': ['ml', 'machine-learning'],
  'artificial intelligence': ['ai', 'a.i.'],
  'natural language processing': ['nlp'],
  'large language model': ['llm', 'llms'],
  'graphql':       ['graph ql'],
  'rest api':      ['rest', 'restful', 'restful api'],
  'ci/cd':         ['cicd', 'ci cd', 'continuous integration', 'continuous deployment'],
  'html':          ['html5'],
  'css':           ['css3'],
  'tailwind':      ['tailwindcss', 'tailwind css'],
  'next.js':       ['nextjs', 'next js'],
  'express':       ['expressjs', 'express.js'],
  'fastapi':       ['fast api'],
  'spring':        ['spring boot', 'springboot'],
  'redux':         ['redux toolkit'],
  'elasticsearch': ['elastic search', 'es'],
  'redis':         ['redis cache'],
};

// Build reverse lookup: alias → canonical
const ALIAS_TO_CANONICAL = {};
for (const [canonical, aliases] of Object.entries(SKILL_SYNONYMS)) {
  for (const alias of aliases) ALIAS_TO_CANONICAL[alias] = canonical;
}

// Normalize a skill string: replace aliases with canonical form
const normalizeSkill = (sk) => {
  const lower = sk.toLowerCase().trim();
  return ALIAS_TO_CANONICAL[lower] || lower;
};

// Expand a skill to all its variants (canonical + aliases)
const expandSkill = (sk) => {
  const canonical = normalizeSkill(sk);
  const aliases = SKILL_SYNONYMS[canonical] || [];
  return [canonical, ...aliases, sk.toLowerCase().trim()];
};

// ── Title / role normalization ───────────────────────────────────────────────
const ROLE_SYNONYMS = {
  'software engineer':     ['swe', 'software developer', 'sw engineer', 'dev', 'programmer'],
  'frontend engineer':     ['front end engineer', 'front-end engineer', 'ui engineer', 'frontend developer', 'front end developer'],
  'backend engineer':      ['back end engineer', 'back-end engineer', 'backend developer', 'server engineer'],
  'full stack engineer':   ['fullstack engineer', 'full-stack engineer', 'full stack developer', 'fullstack developer'],
  'data scientist':        ['data science engineer', 'ml engineer', 'machine learning engineer'],
  'devops engineer':       ['site reliability engineer', 'sre', 'platform engineer', 'infrastructure engineer', 'cloud engineer'],
  'product manager':       ['pm', 'product owner', 'po'],
  'designer':              ['ux designer', 'ui designer', 'ux/ui designer', 'product designer', 'visual designer'],
  'data engineer':         ['data infrastructure engineer', 'etl engineer', 'analytics engineer'],
  'engineering manager':   ['em', 'engineering lead', 'tech lead'],
};

const expandRole = (role) => {
  const lower = role.toLowerCase().trim();
  // Check if it's an alias
  for (const [canonical, aliases] of Object.entries(ROLE_SYNONYMS)) {
    if (aliases.includes(lower)) return [lower, canonical, ...aliases];
    if (lower === canonical)     return [lower, ...aliases];
  }
  return [lower];
};

const score = (jobs, user) => {
  const rawSkills = [
    ...(user?.profile?.skills         || []),
    ...(user?.resume?.extractedSkills || []),
  ].map(s => s.toLowerCase().trim()).filter(s => s.length > 1);

  const targetRole   = (user?.profile?.targetRole  || '').toLowerCase().trim();
  const workType     = (user?.profile?.workType    || '').toLowerCase();
  const companyType  = (user?.profile?.companyType || []).map(c => c.toLowerCase());
  const experience   = user?.profile?.experience   || 0;
  const userLocation = (
    user?.profile?.preferredLocations?.[0] || user?.profile?.city || ''
  ).toLowerCase().trim();

  // Expand role words including synonyms
  const roleVariants = expandRole(targetRole);
  const roleWords    = [...new Set(
    roleVariants.flatMap(r => r.split(/\s+/).filter(w => w.length > 2))
  )];

  // Seniority vocabulary — used for experience-level matching
  const SENIOR_TERMS = ['senior', 'sr.', 'sr ', 'lead ', 'principal', 'staff ', 'head of'];
  const JUNIOR_TERMS = ['junior', 'jr.', 'jr ', 'entry', 'fresher', 'trainee', 'intern', 'associate'];

  return jobs.map(job => {
    if (!job || typeof job !== 'object') return job;

    let s = 0;

    const title       = (job.title       || '').toLowerCase();
    const description = (job.description || '').toLowerCase();
    const jobLocation = (job.location    || '').toLowerCase();
    const text        = `${title} ${description}`;

    // ── 1. Skills match — up to 50 pts ──────────────────────────────
    // Rewards breadth (how many of YOUR skills appear) + depth (raw count).
    // Skills are pre-expanded with synonyms so "JS" matches "javascript" etc.
    if (rawSkills.length > 0) {
      // Count how many original user skills have at least one variant present
      const matchedOriginal = rawSkills.filter(sk => {
        const variants = expandSkill(sk);
        return variants.some(v => v.length > 1 && text.includes(v));
      }).length;
      const breadth = matchedOriginal / rawSkills.length;
      s += Math.min(Math.round(breadth * 30 + matchedOriginal * 3), 50);
    }

    // ── 2. Role / title match — up to 30 pts ────────────────────────
    // Match against expanded role variants including synonyms.
    // Full overlap → 30, half+ → 18, any match → 8
    if (roleWords.length > 0) {
      const matchedWords = roleWords.filter(w => title.includes(w)).length;
      const ratio = matchedWords / roleWords.length;
      if (ratio >= 1)        s += 30;
      else if (ratio >= 0.5) s += 18;
      else if (ratio > 0)    s += 8;

      // Bonus: if any full role variant appears verbatim in title
      if (roleVariants.some(rv => title.includes(rv))) s += 5;
      s = Math.min(s, 30 + 5); // cap this section at 35
    }

    // ── 3. Experience-level match — up to 10 pts ────────────────────
    const isSenior  = SENIOR_TERMS.some(t => title.includes(t));
    const isJunior  = JUNIOR_TERMS.some(t => title.includes(t));
    const isNeutral = !isSenior && !isJunior;
    if      (experience >= 6  && isSenior)  s += 10; // 6+ yrs  → wants senior roles
    else if (experience >= 3  && isNeutral) s += 10; // 3–5 yrs → mid-level titles
    else if (experience >= 3  && isSenior)  s += 6;  // 3–5 yrs → overqualified but ok
    else if (experience < 3   && isJunior)  s += 10; // <3 yrs  → entry/junior
    else if (experience < 3   && isNeutral) s += 7;  // <3 yrs  → unlabeled also fine
    else                                    s += 3;  // mismatch — small partial credit

    // ── 4. Work-type match — up to 15 pts ───────────────────────────
    const isRemote = job.remote || jobLocation.includes('remote') || title.includes('remote');
    if      (workType === 'remote' && isRemote)  s += 15;
    else if (workType === 'onsite' && !isRemote) s += 10;
    else if (workType === 'hybrid')              s += 5;
    else if (!workType || workType === 'any')    s += 5;

    // ── 5. Location match — up to 8 pts ─────────────────────────────
    // Only meaningful for onsite/hybrid (remote jobs are everywhere).
    if (userLocation && jobLocation && !isRemote) {
      const locWords = userLocation.split(/[\s,]+/).filter(w => w.length > 2);
      const hit      = locWords.some(w => jobLocation.includes(w));
      if (hit) s += 8;
    }

    // ── 6. Company-type match — 5 pts ───────────────────────────────
    if (companyType.length && companyType.some(ct => text.includes(ct))) s += 5;

    // ── 7. Recency bonus — up to 5 pts ──────────────────────────────
    if (job.postedAt) {
      const daysAgo = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
      if      (daysAgo <= 2)  s += 5;
      else if (daysAgo <= 7)  s += 3;
      else if (daysAgo <= 14) s += 1;
    }

    // ── 8. Description quality — up to 5 pts ────────────────────────
    // Empty description (LinkedIn listings) gets 0; rich descriptions score higher.
    if      (description.length > 500) s += 5;
    else if (description.length > 150) s += 3;
    else if (description.length >  50) s += 1;

    return { ...job, matchScore: Math.max(0, Math.min(Math.round(s), 99)) };
  }).filter(Boolean);
};

module.exports = { score };
