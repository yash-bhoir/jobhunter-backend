const deduplicate = (jobs) => {
  const seen = new Set();
  return jobs.filter(job => {
    const key = `${(job.company || '').toLowerCase().trim()}|||${(job.title || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

module.exports = { deduplicate };