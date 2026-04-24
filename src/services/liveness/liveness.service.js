/**
 * Ghost Job / Liveness Detection Service
 * Inspired by career-ops liveness-core.mjs
 *
 * Checks whether a job posting URL is still active by:
 *  1. HTTP status code (404/410 → expired)
 *  2. Expiration phrase patterns in page body (multi-language)
 *  3. Apply-button presence
 *  4. Minimal body content check (< 300 chars → likely redirect/footer-only)
 *
 * Returns: 'active' | 'expired' | 'uncertain'
 */

const axios = require('axios');
const { URL } = require('url');
const Job   = require('../../models/Job');
const logger = require('../../config/logger');

const isBlockedHostname = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;

  // Common cloud metadata endpoints
  if (h === 'metadata.google.internal') return true;
  if (h === '169.254.169.254') return true;

  // IPv6 loopback and private ranges
  if (h === '::1') return true;
  if (h === '0:0:0:0:0:0:0:1') return true;
  // Strip brackets from [::1] style URLs
  const stripped = h.replace(/^\[|\]$/g, '');
  if (stripped === '::1') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(stripped)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(stripped) || /^fd[0-9a-f]{2}:/i.test(stripped)) return true;

  // IPv4 literal checks (basic)
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const oct = m.slice(1, 5).map(n => Number(n));
    if (oct.some(n => n > 255)) return true;
    const [a, b, c, d] = oct;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return false;
};

const assertPublicHttpUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.length > 2048) return null;

  let u;
  try { u = new URL(raw); } catch { return null; }

  const protocol = u.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  if (u.username || u.password) return null;

  const hostname = u.hostname;
  if (isBlockedHostname(hostname)) return null;

  return u.toString();
};

// ── Expiration phrases (EN + HI + DE + FR + JA + ES + PT) ──────────
const EXPIRED_PATTERNS = [
  // English
  /job is no longer available/i,
  /position has been filled/i,
  /this job has expired/i,
  /this posting has been closed/i,
  /no longer accepting applications/i,
  /this job listing has been removed/i,
  /requisition is closed/i,
  /posting is closed/i,
  /this role has been filled/i,
  /job not found/i,
  /opening is no longer active/i,
  /this position is no longer open/i,
  /application closed/i,
  // German
  /stelle ist nicht mehr besetzt/i,
  /bewerbungsschluss/i,
  // French
  /offre expirée/i,
  /poste pourvu/i,
  // Spanish
  /oferta no disponible/i,
  /puesto cubierto/i,
  // Portuguese
  /vaga encerrada/i,
];

// ── Apply button patterns ───────────────────────────────────────────
const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bapply now\b/i,
  /\bapply for this job\b/i,
  /\bsubmit application\b/i,
  /\beasy apply\b/i,
  /\bsolicitar\b/i,   // Spanish
  /\bbewerben\b/i,    // German
  /\bpostuler\b/i,    // French
  /\b応募する\b/,      // Japanese
];

/**
 * Classify a URL as active | expired | uncertain
 */
const classifyLiveness = async (url) => {
  const safeUrl = assertPublicHttpUrl(url);
  if (!safeUrl) return 'uncertain';

  try {
    const response = await axios.get(safeUrl, {
      timeout: 8000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JobHunter-Liveness-Check/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      validateStatus: (status) => status < 500, // don't throw on 4xx
    });

    // 1. Hard expiration via HTTP status
    if (response.status === 404 || response.status === 410) {
      return 'expired';
    }

    const body = typeof response.data === 'string' ? response.data : '';
    const bodyLower = body.toLowerCase();

    // 2. Check expiration phrases
    for (const pattern of EXPIRED_PATTERNS) {
      if (pattern.test(body)) return 'expired';
    }

    // 3. Insufficient content (footer-only redirect pages)
    const textContent = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (textContent.length < 300) return 'expired';

    // 4. Apply button presence → active
    for (const pattern of APPLY_PATTERNS) {
      if (pattern.test(bodyLower)) return 'active';
    }

    // 5. Meaningful content but no apply button → uncertain
    return 'uncertain';
  } catch (err) {
    // Network error, DNS failure, timeout
    logger.warn(`[liveness] Error checking ${url}: ${err.message}`);
    return 'uncertain';
  }
};

/**
 * Check liveness of a single job by ID and persist result.
 */
const checkJobLiveness = async (jobId) => {
  const job = await Job.findById(jobId);
  if (!job) return null;

  const url = job.applyUrl || job.url;
  if (!url) {
    await Job.updateOne({ _id: jobId }, { $set: { liveness: 'uncertain', livenessCheckedAt: new Date() } });
    return 'uncertain';
  }

  const liveness = await classifyLiveness(url);

  await Job.updateOne(
    { _id: jobId },
    { $set: { liveness, livenessCheckedAt: new Date() } }
  );

  return liveness;
};

/**
 * Bulk check — runs on all jobs that haven't been checked in 24h.
 * Called by cron. Processes in small batches to avoid hammering servers.
 */
const runLivenessCheck = async (userId = null, batchSize = 20) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago

  const filter = {
    url:      { $exists: true, $ne: null },
    status:   { $in: ['found', 'saved', 'applied'] },
    $or: [
      { livenessCheckedAt: { $lt: cutoff } },
      { livenessCheckedAt: { $exists: false } },
    ],
  };
  if (userId) filter.userId = userId;

  const jobs = await Job.find(filter)
    .select('_id url applyUrl')
    .sort({ livenessCheckedAt: 1 })
    .limit(batchSize)
    .lean();

  if (jobs.length === 0) return { checked: 0, expired: 0, active: 0, uncertain: 0 };

  const results = { checked: 0, expired: 0, active: 0, uncertain: 0 };

  // Stagger requests — 500ms gap to avoid hammering servers
  for (const job of jobs) {
    const liveness = await classifyLiveness(job.url || job.applyUrl);
    await Job.updateOne(
      { _id: job._id },
      { $set: { liveness, livenessCheckedAt: new Date() } }
    );
    results.checked++;
    results[liveness]++;
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info(`[liveness] Checked ${results.checked} jobs: ${results.active} active, ${results.expired} expired, ${results.uncertain} uncertain`);
  return results;
};

module.exports = { classifyLiveness, checkJobLiveness, runLivenessCheck };
