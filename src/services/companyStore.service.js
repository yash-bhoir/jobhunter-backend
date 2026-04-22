/**
 * companyStore.service.js
 *
 * The central intelligence layer. All data flows through here.
 *
 * Responsibilities:
 *  1. findOrCreateCompany   — normalize + dedup + upsert Company
 *  2. ingestJob             — dedup + upsert GlobalJob, return companyId + globalJobId
 *  3. ingestRecruiter       — dedup + upsert GlobalRecruiter, update Company.dataQuality
 *  4. ingestEmployee        — dedup + upsert GlobalEmployee
 *  5. ingestRecruiters      — bulk version of ingestRecruiter
 *  6. getCompanyContext      — return Company + all recruiters + employees for a job's company
 *  7. shouldRefreshRecruiters — stale check (saves API calls)
 *  8. markRecruitersRefreshed — update refresh timestamp
 *
 * API cost savings:
 *  - Before calling Hunter/Apollo, call shouldRefreshRecruiters()
 *  - If false → use existing GlobalRecruiters, skip API call entirely
 *  - Recruiters go stale after RECRUITER_TTL_DAYS (default: 30)
 *  - Employees go stale after EMPLOYEE_TTL_DAYS (default: 60)
 */

const Company         = require('../models/Company');
const GlobalJob       = require('../models/GlobalJob');
const GlobalRecruiter = require('../models/GlobalRecruiter');
const GlobalEmployee  = require('../models/GlobalEmployee');
const logger          = require('../config/logger');
const {
  embedJob,
  cosineSimilarity,
  EMBEDDING_MODEL_VERSION,
} = require('./ai/jobEmbedding.service');

// ── Staleness TTLs (in days) ──────────────────────────────────────
const RECRUITER_TTL_DAYS = 30;
const EMPLOYEE_TTL_DAYS  = 60;

// ── Company name normalization ────────────────────────────────────
const NOISE = /\s+(pvt\.?|ltd\.?|inc\.?|llc\.?|private limited|limited|llp|technologies|tech|solutions|systems|software|services|group|co\.?|corp\.?|gmbh|ag|bv|sas|srl)\.?\s*$/gi;

function normalizeCompany(name = '') {
  return name
    .toLowerCase()
    .replace(NOISE, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Extract domain from email ─────────────────────────────────────
function domainFromEmail(email = '') {
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

// ── HR title detector ─────────────────────────────────────────────
const HR_TITLES = /recruit|talent|hr|human resource|people ops|hiring|staffing|headhunt/i;

// ─────────────────────────────────────────────────────────────────
// 1. findOrCreateCompany
// ─────────────────────────────────────────────────────────────────
/**
 * Find existing Company by normalizedName (or domain), or create it.
 * Updates nameVariants and domain if new info is available.
 *
 * @param {string} rawName  — company name as returned by job API
 * @param {object} extras   — { domain, linkedinUrl, careerPageUrl, source }
 * @returns {Company}
 */
async function findOrCreateCompany(rawName, extras = {}) {
  const normalized = normalizeCompany(rawName);
  if (!normalized) return null;

  const domain = extras.domain || null;

  // Build the update payload
  const setOnInsert = {
    name:           rawName,
    normalizedName: normalized,
  };
  const addToSet = {
    nameVariants: rawName,
    ...(extras.source ? { sources: extras.source } : {}),
  };
  const setFields = {};
  if (domain)              setFields.domain         = domain;
  if (extras.linkedinUrl)  setFields.linkedinUrl    = extras.linkedinUrl;
  if (extras.careerPageUrl)setFields.careerPageUrl  = extras.careerPageUrl;

  try {
    // Primary lookup by normalizedName
    let company = await Company.findOneAndUpdate(
      { normalizedName: normalized },
      {
        $setOnInsert: setOnInsert,
        $addToSet:    addToSet,
        ...(Object.keys(setFields).length ? { $set: setFields } : {}),
      },
      { upsert: true, new: true }
    );

    return company;
  } catch (err) {
    // Handle duplicate key race condition
    if (err.code === 11000) {
      return Company.findOne({ normalizedName: normalized });
    }
    logger.warn(`[companyStore] findOrCreateCompany error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. ingestJob
// ─────────────────────────────────────────────────────────────────
/**
 * Find or create a GlobalJob for the given raw job data.
 * Dedup strategy:
 *   1. externalId + companyId (strongest)
 *   2. url (fallback)
 *   3. title + companyId (weakest, last resort)
 *   4. Semantic cosine match vs recent same-company jobs (OpenAI embedding)
 *
 * @param {object} rawJob  — normalized job object from any platform service
 * @param {ObjectId} companyId
 * @returns {{ globalJob, isNew, mergedSemantic?: boolean }}
 */
async function trySemanticMergeGlobalJob(companyId, rawJob, embedding, sourceEntry) {
  if (!embedding?.length) return null;

  const threshold = parseFloat(process.env.GLOBAL_JOB_SEM_DEDUP_THRESHOLD || '0.88');
  const limit     = parseInt(process.env.GLOBAL_JOB_SEM_DEDUP_MAX_NEIGHBORS || '40', 10) || 40;

  const neighbors = await GlobalJob.find({
    companyId,
    'titleEmbedding.0': { $exists: true },
  })
    .sort({ lastSeenAt: -1 })
    .limit(limit)
    .select('titleEmbedding title url _id description')
    .lean();

  let best = null;
  let bestScore = threshold;
  for (const n of neighbors) {
    if (!n.titleEmbedding?.length || n.titleEmbedding.length !== embedding.length) continue;
    const s = cosineSimilarity(embedding, n.titleEmbedding);
    if (s > bestScore) {
      bestScore = s;
      best = n;
    }
  }
  if (!best) return null;

  const longerDesc = String(rawJob.description || '').length > String(best.description || '').length;
  const fillUrl      = rawJob.url && !best.url;

  await GlobalJob.updateOne(
    { _id: best._id },
    {
      $set: {
        lastSeenAt: new Date(),
        expired:      false,
        ...(fillUrl ? { url: rawJob.url } : {}),
        ...(longerDesc ? { description: rawJob.description } : {}),
      },
      $addToSet: { sources: sourceEntry },
    },
  );

  const merged = await GlobalJob.findById(best._id).lean();
  logger.info(`[companyStore] semantic merge GlobalJob ${best._id} (cos≈${bestScore.toFixed(3)})`);
  return merged;
}

async function ingestJob(rawJob, companyId) {
  if (!companyId) return { globalJob: null, isNew: false };

  const sourceEntry = {
    name:       rawJob.source,
    externalId: rawJob.externalId || null,
    url:        rawJob.url        || null,
    seenAt:     new Date(),
  };

  // Build dedup filter
  let filter = null;
  if (rawJob.externalId) {
    filter = { companyId, externalId: rawJob.externalId };
  } else if (rawJob.url) {
    filter = { url: rawJob.url };
  } else {
    // Weak dedup: same title at same company posted recently (within 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    filter = { companyId, title: rawJob.title, createdAt: { $gte: sevenDaysAgo } };
  }

  try {
    const existing = await GlobalJob.findOne(filter).lean();

    if (existing) {
      // Already exists — just update lastSeenAt + add source if new
      await GlobalJob.updateOne(
        { _id: existing._id },
        {
          $set:      { lastSeenAt: new Date(), expired: false },
          $addToSet: { sources: sourceEntry },
        }
      );
      return { globalJob: existing, isNew: false };
    }

    // ── Semantic near-dup (cross-URL / syndicated listings) ─────
    const embedding = await embedJob(rawJob);
    if (embedding?.length) {
      const merged = await trySemanticMergeGlobalJob(companyId, rawJob, embedding, sourceEntry);
      if (merged) return { globalJob: merged, isNew: false, mergedSemantic: true };
    }

    // Create new
    const createPayload = {
      companyId,
      externalId:    rawJob.externalId   || null,
      url:           rawJob.url          || null,
      title:         rawJob.title,
      location:      rawJob.location     || '',
      description:   rawJob.description  || '',
      salary:        rawJob.salary       || 'Not specified',
      remote:        rawJob.remote       || false,
      postedAt:      rawJob.postedAt     || null,
      primarySource: rawJob.source,
      sources:       [sourceEntry],
      lastSeenAt:    new Date(),
    };
    if (embedding?.length) {
      createPayload.titleEmbedding = embedding;
      createPayload.embeddingModel = EMBEDDING_MODEL_VERSION;
    }

    const globalJob = await GlobalJob.create(createPayload);

    return { globalJob, isNew: true };
  } catch (err) {
    if (err.code === 11000) {
      const globalJob = await GlobalJob.findOne(filter).lean();
      return { globalJob, isNew: false };
    }
    logger.warn(`[companyStore] ingestJob error: ${err.message}`);
    return { globalJob: null, isNew: false };
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. ingestRecruiter
// ─────────────────────────────────────────────────────────────────
/**
 * Find or create a GlobalRecruiter. If exists, update confidence if higher.
 * Increments seenCount on re-discovery.
 *
 * @param {object} contact  — { email, name, title, linkedin, confidence, source, status }
 * @param {ObjectId} companyId
 * @returns {GlobalRecruiter}
 */
async function ingestRecruiter(contact, companyId) {
  if (!companyId || (!contact.email && !contact.linkedin)) return null;

  // Pattern-guessed emails are not real — never store them in global store
  if (contact.source === 'pattern') return null;

  // Dedup filter: prefer email, fallback to linkedin
  const filter = contact.email
    ? { companyId, email: contact.email }
    : { companyId, linkedin: contact.linkedin };

  const isHR     = HR_TITLES.test(contact.title || '');
  const newConf  = contact.confidence || 0;

  try {
    const existing = await GlobalRecruiter.findOne(filter);

    if (existing) {
      // Only upgrade confidence, never downgrade
      const updates = {
        lastSeenAt: new Date(),
        $inc: { seenCount: 1 },
      };
      if (newConf > existing.confidence) {
        updates.confidence = newConf;
        updates.status     = contact.status || existing.status;
        updates.source     = contact.source || existing.source;
      }
      if (contact.name  && !existing.name)  updates.name  = contact.name;
      if (contact.title && !existing.title) updates.title = contact.title;
      if (contact.linkedin && !existing.linkedin) updates.linkedin = contact.linkedin;

      await GlobalRecruiter.findOneAndUpdate(filter, { $set: updates });
      return existing;
    }

    // Create new
    const recruiter = await GlobalRecruiter.create({
      companyId,
      email:      contact.email    || null,
      linkedin:   contact.linkedin || null,
      name:       contact.name     || '',
      title:      contact.title    || '',
      confidence: newConf,
      status:     contact.status   || 'unknown',
      source:     contact.source   || 'pattern',
      isHR,
    });
    return recruiter;
  } catch (err) {
    if (err.code === 11000) return GlobalRecruiter.findOne(filter);
    logger.warn(`[companyStore] ingestRecruiter error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. ingestEmployee
// ─────────────────────────────────────────────────────────────────
async function ingestEmployee(employee, companyId) {
  if (!companyId || (!employee.linkedin && !employee.email)) return null;

  const filter = employee.linkedin
    ? { companyId, linkedin: employee.linkedin }
    : { companyId, email: employee.email };

  try {
    await GlobalEmployee.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          companyId,
          linkedin:  employee.linkedin || null,
          email:     employee.email    || null,
          name:      employee.name     || '',
          title:     employee.title    || '',
          source:    employee.source   || 'apollo',
        },
        $set: { lastSeenAt: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code !== 11000) logger.warn(`[companyStore] ingestEmployee error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// 5. ingestRecruiters (bulk)
// ─────────────────────────────────────────────────────────────────
/**
 * Ingest an array of contacts and update Company.dataQuality stats.
 *
 * @param {Array}    contacts   — array of contact objects
 * @param {ObjectId} companyId
 * @param {string}   source     — 'hunter' | 'apollo' | 'pattern'
 */
async function ingestRecruiters(contacts, companyId, source = 'pattern') {
  if (!contacts?.length || !companyId) return;

  const results = await Promise.all(
    contacts.map(c => ingestRecruiter({ ...c, source }, companyId))
  );

  const count = results.filter(Boolean).length;

  // Update Company data quality
  if (count > 0) {
    const total = await GlobalRecruiter.countDocuments({ companyId });
    await Company.findByIdAndUpdate(companyId, {
      $set: {
        'dataQuality.hasRecruiters':  true,
        'dataQuality.recruiterCount': total,
        'dataQuality.score':          Math.min(100, total * 10),
      },
    });
  }

  return count;
}

// ─────────────────────────────────────────────────────────────────
// 6. getCompanyContext
// ─────────────────────────────────────────────────────────────────
/**
 * Return full company context for a job's company:
 *  - Company metadata
 *  - ALL recruiters (sorted by rankScore desc)
 *  - Employees (optional, up to limit)
 *
 * This is what gets attached to search results — replaces single-recruiter lookup.
 *
 * @param {ObjectId} companyId
 * @param {object}   opts  — { recruiterLimit, employeeLimit }
 * @returns {{ company, recruiters, employees }}
 */
async function getCompanyContext(companyId, opts = {}) {
  const recruiterLimit = opts.recruiterLimit || 20;
  const employeeLimit  = opts.employeeLimit  || 10;

  const [company, recruiters, employees] = await Promise.all([
    Company.findById(companyId).lean(),
    GlobalRecruiter.find({ companyId })
      .sort({ rankScore: -1, confidence: -1 })
      .limit(recruiterLimit)
      .lean(),
    GlobalEmployee.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(employeeLimit)
      .lean(),
  ]);

  return { company, recruiters, employees };
}

// ─────────────────────────────────────────────────────────────────
// 7. shouldRefreshRecruiters — API cost gate
// ─────────────────────────────────────────────────────────────────
/**
 * Returns true if we should call Hunter/Apollo for this company.
 * Returns false if we have fresh data (saves API quota).
 *
 * @param {ObjectId} companyId
 * @returns {boolean}
 */
async function shouldRefreshRecruiters(companyId) {
  const company = await Company.findById(companyId)
    .select('recruitersRefreshedAt recruitersStale')
    .lean();

  if (!company) return true;
  if (company.recruitersStale) return true;
  if (!company.recruitersRefreshedAt) return true;

  const ageMs  = Date.now() - new Date(company.recruitersRefreshedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays >= RECRUITER_TTL_DAYS;
}

async function shouldRefreshEmployees(companyId) {
  const company = await Company.findById(companyId)
    .select('employeesRefreshedAt employeesStale')
    .lean();

  if (!company) return true;
  if (company.employeesStale) return true;
  if (!company.employeesRefreshedAt) return true;

  const ageMs  = Date.now() - new Date(company.employeesRefreshedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays >= EMPLOYEE_TTL_DAYS;
}

// ─────────────────────────────────────────────────────────────────
// 8. markRecruitersRefreshed / markEmployeesRefreshed
// ─────────────────────────────────────────────────────────────────
async function markRecruitersRefreshed(companyId) {
  await Company.findByIdAndUpdate(companyId, {
    $set: { recruitersRefreshedAt: new Date(), recruitersStale: false },
  });
}

async function markEmployeesRefreshed(companyId) {
  await Company.findByIdAndUpdate(companyId, {
    $set: { employeesRefreshedAt: new Date(), employeesStale: false },
  });
}

// ─────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────
module.exports = {
  normalizeCompany,
  findOrCreateCompany,
  ingestJob,
  ingestRecruiter,
  ingestEmployee,
  ingestRecruiters,
  getCompanyContext,
  shouldRefreshRecruiters,
  shouldRefreshEmployees,
  markRecruitersRefreshed,
  markEmployeesRefreshed,
};
