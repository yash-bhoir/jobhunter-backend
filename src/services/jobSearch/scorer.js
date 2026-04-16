const score = (jobs, user) => {
  const skills = [
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

  // Words in the user's target role (length > 2 to skip "at", "in", etc.)
  const roleWords = targetRole.split(/\s+/).filter(w => w.length > 2);

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
    if (skills.length > 0) {
      const matched = skills.filter(sk => sk.length > 1 && text.includes(sk)).length;
      const breadth = matched / skills.length;            // 0–1 ratio
      s += Math.min(Math.round(breadth * 30 + matched * 3), 50);
    }

    // ── 2. Role / title match — up to 30 pts ────────────────────────
    // Full overlap → 30, half+ → 18, any match → 8
    if (roleWords.length > 0) {
      const matchedWords = roleWords.filter(w => title.includes(w)).length;
      const ratio = matchedWords / roleWords.length;
      if (ratio >= 1)    s += 30;
      else if (ratio >= 0.5) s += 18;
      else if (ratio > 0)    s += 8;
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
