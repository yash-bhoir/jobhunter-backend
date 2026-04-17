const Job                = require('../models/Job');
const RecruiterLookup    = require('../models/RecruiterLookup');
const { findHRContacts } = require('../services/emailFinder');
const hunter             = require('../services/emailFinder/hunter.service');
const apollo             = require('../services/emailFinder/apollo.service');
const pattern            = require('../services/emailFinder/pattern.service');
const { linkLookupToJobs } = require('../services/dataLinker.service');
const { success, paginated } = require('../utils/response.util');
const { ValidationError }    = require('../utils/errors');
const logger = require('../config/logger');

// ── Get all recruiters found so far (jobs + manual lookups) ──────
exports.getRecruiters = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;

    // Fetch both sources in parallel (no pagination at DB level — merge then paginate)
    const [jobRows, lookupRows] = await Promise.all([
      Job.find({
        userId:         req.user._id,
        recruiterEmail: { $exists: true, $ne: null },
      })
      .sort({ createdAt: -1 })
      .limit(500)
      .select('company title recruiterName recruiterEmail recruiterConfidence recruiterSource recruiterLinkedIn careerPageUrl url matchScore createdAt')
      .lean(),

      RecruiterLookup.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
    ]);

    // Shape lookup rows to match job row structure
    const shapedLookups = lookupRows.map(l => ({
      _id:                 l._id,
      company:             l.company,
      title:               null,
      recruiterEmail:      l.email,
      recruiterName:       l.name,
      recruiterConfidence: l.confidence,
      recruiterSource:     l.source,
      recruiterLinkedIn:   l.linkedin,
      careerPageUrl:       l.careerPageUrl,
      url:                 null,
      matchScore:          null,
      createdAt:           l.createdAt,
      _fromLookup:         true,
      allEmails:           l.allEmails,
    }));

    // Merge and deduplicate by company — keep most recent per company
    const companyMap = {};
    for (const row of [...jobRows, ...shapedLookups]) {
      const key = (row.company || '').toLowerCase();
      if (!companyMap[key] || new Date(row.createdAt) > new Date(companyMap[key].createdAt)) {
        companyMap[key] = row;
      }
    }

    // Sort merged list by createdAt desc, then paginate
    const merged = Object.values(companyMap).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    const total = merged.length;
    const skip  = (page - 1) * limit;
    const paged = merged.slice(skip, skip + limit);

    return paginated(res, paged, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Lookup HR email for a company ─────────────────────────────────
exports.lookupEmail = async (req, res, next) => {
  try {
    const { company, jobId } = req.body;
    if (!company) throw new ValidationError('Company name is required');

    const result = await findHRContacts(company, req.user.plan || 'free');
    const top    = result.emails?.[0] || null;

    // Always persist this lookup so it appears in recruiter history
    const savedLookup = await RecruiterLookup.findOneAndUpdate(
      { userId: req.user._id, company: new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      {
        $set: {
          userId:         req.user._id,
          company,
          domain:         result.domain        || null,
          source:         result.source        || 'none',
          email:          top?.email           || null,
          name:           top?.name            || null,
          confidence:     top?.confidence      || null,
          linkedin:       top?.linkedin        || null,
          title:          top?.title           || null,
          status:         top?.status          || 'unknown',
          allEmails:      (result.emails || []).map(e => ({
            email:      e.email,
            name:       e.name       || '',
            confidence: e.confidence || 0,
            linkedin:   e.linkedin   || null,
            title:      e.title      || '',
            source:     e.source     || result.source,
            status:     e.status     || 'unknown',
          })),
          careerPageUrl:  result.careerPageUrl || null,
          linkedinUrl:    result.linkedinUrl   || null,
          employeeSearch: result.employeeSearch|| null,
        },
      },
      { upsert: true, new: true }
    ).catch(err => { logger.warn(`RecruiterLookup save failed: ${err.message}`); return null; });

    // If jobId provided, also save recruiter info to that job
    if (jobId && top) {
      await Job.findOneAndUpdate(
        { _id: jobId, userId: req.user._id },
        {
          $set: {
            recruiterEmail:       top.email,
            recruiterName:        top.name,
            recruiterConfidence:  top.confidence,
            recruiterSource:      result.source,
            recruiterLinkedIn:    top.linkedin,
            recruiterEmailStatus: top.status || 'unknown',
            allRecruiterContacts: (result.emails || []).map(e => ({
              email: e.email, name: e.name || '', title: e.title || '',
              confidence: e.confidence || 0, source: e.source || result.source,
              status: e.status || 'unknown', linkedin: e.linkedin || null,
            })),
            careerPageUrl: result.careerPageUrl,
          },
        }
      );
    }

    // Back-link this lookup to all existing jobs with same company (async)
    if (savedLookup) {
      linkLookupToJobs(req.user._id, company, savedLookup).catch(err =>
        logger.warn(`dataLinker back-link failed: ${err.message}`)
      );
    }

    logger.info(`Email lookup for ${company} — source: ${result.source} — found: ${result.emails?.length}`);

    return success(res, {
      company,
      domain:         result.domain,
      source:         result.source,
      emails:         result.emails,
      careerPageUrl:  result.careerPageUrl,
      linkedinUrl:    result.linkedinUrl,
      employeeSearch: result.employeeSearch,
    });
  } catch (err) {
    next(err);
  }
};

// ── Find employees via Apollo ─────────────────────────────────────
exports.findEmployees = async (req, res, next) => {
  try {
    const { company, titles } = req.body;
    if (!company) throw new ValidationError('Company name is required');

    const defaultTitles = ['HR Manager', 'Recruiter', 'Talent Acquisition', 'Engineering Manager'];
    const employees = await apollo.searchPeople(company, titles || defaultTitles);

    return success(res, {
      company,
      employees,
      total: employees.length,
    });
  } catch (err) {
    next(err);
  }
};

// ── Pattern emails (free — no credits needed) ─────────────────────
exports.patternEmails = async (req, res, next) => {
  try {
    const { company } = req.body;
    if (!company) throw new ValidationError('Company name is required');

    const domain = pattern.extractDomain(company);
    const result = pattern.generate(domain, company);
    const top    = result.emails?.[0] || null;

    // Persist pattern lookup to history (upsert — don't overwrite a better verified result)
    RecruiterLookup.findOneAndUpdate(
      { userId: req.user._id, company: new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), source: 'pattern' },
      {
        $setOnInsert: {
          userId:         req.user._id,
          company,
          domain,
          source:         'pattern',
          email:          top?.email  || null,
          name:           top?.name   || null,
          confidence:     top?.confidence || null,
          allEmails:      result.emails   || [],
          careerPageUrl:  result.careerPageUrl  || null,
          linkedinUrl:    result.linkedinUrl     || null,
          employeeSearch: result.employeeSearch  || null,
        },
      },
      { upsert: true }
    ).catch(err => logger.warn(`RecruiterLookup pattern save failed: ${err.message}`));

    return success(res, {
      company,
      domain,
      emails:         result.emails,
      careerPageUrl:  result.careerPageUrl,
      linkedinUrl:    result.linkedinUrl,
      employeeSearch: result.employeeSearch,
      source:         'pattern',
    });
  } catch (err) {
    next(err);
  }
};


// ── Get all HR contacts for a search ─────────────────────────────
exports.getBySearch = async (req, res, next) => {
  try {
    const { searchId } = req.params;
    const mongoose = require('mongoose');

    if (!mongoose.Types.ObjectId.isValid(searchId)) {
      return res.status(400).json({ success: false, message: 'Invalid search ID. Navigate back and select a valid search.' });
    }

    const jobs = await Job.find({
      searchId,
      userId:   req.user._id,
    })
    .select('company title url recruiterEmail recruiterName recruiterConfidence recruiterSource recruiterLinkedIn careerPageUrl matchScore status')
    .sort({ matchScore: -1 })
    .lean();

    // Group by company
    const byCompany = {};
    for (const job of jobs) {
      if (!byCompany[job.company]) {
        byCompany[job.company] = {
          company:       job.company,
          jobs:          [],
          recruiterEmail:      job.recruiterEmail,
          recruiterName:       job.recruiterName,
          recruiterConfidence: job.recruiterConfidence,
          recruiterSource:     job.recruiterSource,
          recruiterLinkedIn:   job.recruiterLinkedIn,
          careerPageUrl:       job.careerPageUrl,
        };
      }
      byCompany[job.company].jobs.push({
        _id:       job._id,
        title:     job.title,
        url:       job.url,
        matchScore: job.matchScore,
        status:    job.status,
      });
    }

    return success(res, {
      companies:   Object.values(byCompany),
      totalJobs:   jobs.length,
      withEmail:   jobs.filter(j => j.recruiterEmail).length,
      withoutEmail: jobs.filter(j => !j.recruiterEmail).length,
    });
  } catch (err) { next(err); }
};

// ── Find HR emails for all companies in a search (Pro) ───────────
exports.findAllForSearch = async (req, res, next) => {
  try {
    const { searchId } = req.body;

    const jobs = await Job.find({
      searchId:       searchId,
      userId:         req.user._id,
      recruiterEmail: { $exists: false },
    }).lean();

    if (jobs.length === 0) {
      return success(res, { updated: 0 }, 'All jobs already have HR emails');
    }

    const uniqueCompanies = [...new Set(jobs.map(j => j.company))];
    let updated = 0;

    for (const company of uniqueCompanies) {
      try {
        const contacts = await require('../services/emailFinder').findHRContacts(company, req.user.plan);
        if (contacts?.emails?.length > 0) {
          const top = contacts.emails[0];
          await Job.updateMany(
            { searchId, userId: req.user._id, company },
            {
              $set: {
                recruiterEmail:      top.email,
                recruiterName:       top.name,
                recruiterConfidence: top.confidence,
                recruiterSource:     contacts.source,
                recruiterLinkedIn:   top.linkedin || null,
                careerPageUrl:       contacts.careerPageUrl,
              },
            }
          );
          updated++;
        }
      } catch (err) {
        logger.warn(`Failed email find for ${company}: ${err.message}`);
      }
    }

    return success(res, { updated, total: uniqueCompanies.length }, `Found emails for ${updated} companies`);
  } catch (err) { next(err); }
};

// ── Delete a manual lookup history entry ──────────────────────────
exports.deleteLookupHistory = async (req, res, next) => {
  try {
    const deleted = await RecruiterLookup.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!deleted) {
      const { NotFoundError } = require('../utils/errors');
      throw new NotFoundError('Lookup history entry not found');
    }
    return success(res, null, 'Entry removed from history');
  } catch (err) { next(err); }
};