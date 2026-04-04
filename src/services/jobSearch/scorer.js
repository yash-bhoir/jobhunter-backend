const score = (jobs, user) => {
  const skills = [
    ...(user?.profile?.skills         || []),
    ...(user?.resume?.extractedSkills || []),
  ].map(s => s.toLowerCase());

  const targetRole  = (user?.profile?.targetRole || '').toLowerCase();
  const workType    = (user?.profile?.workType   || '').toLowerCase();
  const companyType = (user?.profile?.companyType|| []).map(c => c.toLowerCase());

  return jobs.map(job => {
    // Guard against missing fields
    if (!job || typeof job !== 'object') return job;

    let s = 0;
    const title       = (job.title       || '').toLowerCase();
    const description = (job.description || '').toLowerCase();
    const location    = (job.location    || '').toLowerCase();
    const text        = `${title} ${description}`;

    // Skills match — up to 40pts
    if (skills.length > 0) {
      const matched = skills.filter(sk => sk.length > 2 && text.includes(sk)).length;
      s += Math.min(matched * 10, 40);
    }

    // Role match — 25pts
    if (targetRole) {
      const roleWords = targetRole.split(/\s+/).filter(w => w.length > 3);
      if (roleWords.some(w => title.includes(w))) s += 25;
    }

    // Work type — up to 15pts
    const isRemote = job.remote || location.includes('remote');
    if      (workType === 'remote' && isRemote)  s += 15;
    else if (workType === 'onsite' && !isRemote) s += 10;
    else if (workType === 'hybrid')              s += 5;
    else if (!workType || workType === 'any')    s += 5;

    // Company type — 10pts
    if (companyType.length && companyType.some(ct => text.includes(ct))) s += 10;

    // Description quality — 5pts
    if (description.length > 150) s += 5;

    return {
      ...job,
      matchScore: Math.max(0, Math.min(Math.round(s), 99)),
    };
  }).filter(Boolean);
};

module.exports = { score };