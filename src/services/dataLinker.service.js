/**
 * dataLinker.service.js
 *
 * Automatically links recruiter/contact data already in RecruiterLookup
 * to jobs that share the same company name. Runs after:
 *   1. A new job search completes  → linkRecruitersToJobs(userId, jobIds)
 *   2. A new recruiter lookup completes → linkLookupToJobs(userId, company, lookupData)
 *
 * Never overwrites a higher-confidence email with a lower-confidence one.
 */

const Job             = require('../models/Job');
const RecruiterLookup = require('../models/RecruiterLookup');
const logger          = require('../config/logger');
const {
  findOrCreateCompany,
  ingestRecruiters,
  ingestEmployee,
  getCompanyContext,
  shouldRefreshRecruiters,
  markRecruitersRefreshed,
}                     = require('./companyStore.service');

// ── Normalize company name for fuzzy matching ─────────────────────
const NOISE = /\s+(pvt\.?|ltd\.?|inc\.?|llc\.?|private limited|limited|llp|technologies|tech|solutions|systems|software|services|group|co\.?|corp\.?)\.?\s*$/gi;

function normalizeCompany(name = '') {
  return name.toLowerCase().replace(NOISE, '').replace(/[^a-z0-9\s]/g, '').trim();
}

// ── Build an update payload from a RecruiterLookup document ──────
function buildJobUpdate(lookup) {
  const top = lookup.email
    ? {
        recruiterEmail:       lookup.email,
        recruiterName:        lookup.name        || null,
        recruiterConfidence:  lookup.confidence  || 0,
        recruiterSource:      lookup.source      || 'pattern',
        recruiterLinkedIn:    lookup.linkedin     || null,
        recruiterEmailStatus: lookup.status       || 'unknown',
        careerPageUrl:        lookup.careerPageUrl || null,
        linkedinUrl:          lookup.linkedinUrl   || null,
        employeeSearch:       lookup.employeeSearch|| null,
      }
    : null;

  const allContacts = (lookup.allEmails || []).map(e => ({
    email:      e.email,
    name:       e.name       || '',
    title:      e.title      || '',
    confidence: e.confidence || 0,
    source:     e.source     || lookup.source || 'unknown',
    status:     e.status     || 'unknown',
    linkedin:   e.linkedin   || null,
  }));

  return { top, allContacts };
}

// ── Link existing RecruiterLookups → newly saved jobs ────────────
async function linkRecruitersToJobs(userId, jobIds) {
  if (!jobIds?.length) return;

  try {
    const jobs = await Job.find({
      _id:    { $in: jobIds },
      userId,
    }).select('_id company recruiterEmail recruiterConfidence').lean();

    if (!jobs.length) return;

    // Gather unique normalized company names
    const companyNames = [...new Set(jobs.map(j => normalizeCompany(j.company)))];

    // Fetch all lookups for this user (batch, not per-job)
    const lookups = await RecruiterLookup.find({ userId }).lean();

    // Build a map: normalizedCompany → best lookup
    const lookupMap = {};
    for (const l of lookups) {
      const key = normalizeCompany(l.company);
      if (
        !lookupMap[key] ||
        (l.confidence || 0) > (lookupMap[key].confidence || 0)
      ) {
        lookupMap[key] = l;
      }
    }

    const ops = [];
    for (const job of jobs) {
      const key    = normalizeCompany(job.company);
      const lookup = lookupMap[key];
      if (!lookup) continue;

      // Only update if job has no email OR lookup has higher confidence
      const existingConf = job.recruiterConfidence || 0;
      const newConf      = lookup.confidence || 0;
      if (job.recruiterEmail && newConf <= existingConf) continue;

      const { top, allContacts } = buildJobUpdate(lookup);
      if (!top) continue;

      ops.push({
        updateOne: {
          filter: { _id: job._id },
          update: { $set: { ...top, allRecruiterContacts: allContacts } },
        },
      });
    }

    if (ops.length) {
      await Job.bulkWrite(ops, { ordered: false });
      logger.info(`dataLinker: linked ${ops.length} jobs for user ${userId}`);
    }
  } catch (err) {
    logger.warn(`dataLinker.linkRecruitersToJobs failed: ${err.message}`);
  }
}

// ── Link a freshly saved lookup → existing jobs with same company ─
async function linkLookupToJobs(userId, company, lookup) {
  if (!lookup?.email) return;

  try {
    const normalized = normalizeCompany(company);

    // Find all jobs for this user where company normalizes to same value
    const jobs = await Job.find({ userId })
      .select('_id company recruiterEmail recruiterConfidence')
      .lean();

    const matches = jobs.filter(j => normalizeCompany(j.company) === normalized);
    if (!matches.length) return;

    const { top, allContacts } = buildJobUpdate(lookup);
    if (!top) return;

    const ops = matches
      .filter(j => {
        const existingConf = j.recruiterConfidence || 0;
        const newConf      = lookup.confidence || 0;
        return !j.recruiterEmail || newConf > existingConf;
      })
      .map(j => ({
        updateOne: {
          filter: { _id: j._id },
          update: { $set: { ...top, allRecruiterContacts: allContacts } },
        },
      }));

    if (ops.length) {
      await Job.bulkWrite(ops, { ordered: false });
      logger.info(`dataLinker: back-linked ${ops.length} jobs for company "${company}"`);
    }
  } catch (err) {
    logger.warn(`dataLinker.linkLookupToJobs failed: ${err.message}`);
  }
}

// ── New: ingest recruiter lookup into global store ────────────────
/**
 * Called after Hunter/Apollo returns data for a company.
 * 1. Finds or creates the Company in global store
 * 2. Ingests all contacts as GlobalRecruiters
 * 3. Updates Company.recruitersRefreshedAt (prevents future redundant API calls)
 * 4. Back-links to existing user Jobs via old flow (backward compat)
 *
 * @param {string}   userId
 * @param {string}   companyName
 * @param {object}   lookupData  — { email, allEmails, name, title, linkedin, ... }
 * @param {string}   source      — 'hunter' | 'apollo' | 'pattern'
 */
async function linkLookupToGlobalStore(userId, companyName, lookupData, source = 'pattern') {
  try {
    // 1. Find or create Company
    const company = await findOrCreateCompany(companyName, {
      domain: lookupData.domain || null,
      careerPageUrl: lookupData.careerPageUrl || null,
      source,
    });
    if (!company) return;

    // 2. Ingest all contacts (top + allEmails) as GlobalRecruiters
    const contacts = [
      ...(lookupData.allEmails || []),
      // Ensure the top contact is included if not already in allEmails
      ...(lookupData.email && !(lookupData.allEmails || []).find(e => e.email === lookupData.email)
        ? [{ email: lookupData.email, name: lookupData.name, title: lookupData.title,
             linkedin: lookupData.linkedin, confidence: lookupData.confidence,
             status: lookupData.status }]
        : []),
    ];

    await ingestRecruiters(contacts, company._id, source);
    await markRecruitersRefreshed(company._id);

    // 3. Also update companyId on user's Job records for this company (backward compat)
    await Job.updateMany(
      { userId, company: { $regex: new RegExp(normalizeCompany(companyName).replace(/\s+/g, '\\s+'), 'i') } },
      { $set: { companyId: company._id } }
    ).catch(() => {});

    logger.info(`[dataLinker] ingested ${contacts.length} recruiters → Company "${companyName}"`);
  } catch (err) {
    logger.warn(`[dataLinker] linkLookupToGlobalStore failed: ${err.message}`);
  }
}

// ── New: ingest employees from Apollo into global store ───────────
async function linkEmployeesToGlobalStore(companyName, employees = [], source = 'apollo') {
  try {
    const company = await findOrCreateCompany(companyName, { source });
    if (!company) return;

    await Promise.all(employees.map(e => ingestEmployee({ ...e, source }, company._id)));

    logger.info(`[dataLinker] ingested ${employees.length} employees → Company "${companyName}"`);
  } catch (err) {
    logger.warn(`[dataLinker] linkEmployeesToGlobalStore failed: ${err.message}`);
  }
}

// ── New: check if we should skip API call (data is fresh) ─────────
async function isRecruiterDataFresh(companyName) {
  try {
    const Company = require('../models/Company');
    const { normalizeCompany: nc } = require('./companyStore.service');
    const company = await Company.findOne({ normalizedName: nc(companyName) })
      .select('_id recruitersRefreshedAt recruitersStale')
      .lean();
    if (!company) return false;
    return !(await shouldRefreshRecruiters(company._id));
  } catch {
    return false;
  }
}

// ── New: get all recruiters for a company from global store ───────
async function getGlobalRecruitersForCompany(companyName) {
  try {
    const Company = require('../models/Company');
    const { normalizeCompany: nc } = require('./companyStore.service');
    const company = await Company.findOne({ normalizedName: nc(companyName) }).lean();
    if (!company) return [];
    const { recruiters } = await getCompanyContext(company._id, { recruiterLimit: 50 });
    return recruiters;
  } catch {
    return [];
  }
}

module.exports = {
  linkRecruitersToJobs,
  linkLookupToJobs,
  normalizeCompany,
  // New global-store functions
  linkLookupToGlobalStore,
  linkEmployeesToGlobalStore,
  isRecruiterDataFresh,
  getGlobalRecruitersForCompany,
};
