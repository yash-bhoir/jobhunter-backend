const Job  = require('../models/Job');
const { success, paginated } = require('../utils/response.util');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { getCompanyContext } = require('../services/companyStore.service');

// ── Get all jobs ──────────────────────────────────────────────────
exports.getJobs = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const sort   = req.query.sort   || 'matchScore';
    const status = req.query.status || null;
    const source = req.query.source || null;
    const remote = req.query.remote || null;

    const searchId = req.query.searchId || null;

    const filter = { userId: req.user._id };
    if (status)   filter.status   = status;
    if (source)   filter.source   = source;
    if (remote !== null) filter.remote = remote === 'true';
    if (searchId) filter.searchId = searchId;

    const sortObj = sort === 'matchScore'
      ? { matchScore: -1 }
      : sort === 'date'
        ? { createdAt: -1 }
        : { matchScore: -1 };

    const [jobs, total] = await Promise.all([
      Job.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      Job.countDocuments(filter),
    ]);

    return paginated(res, jobs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get saved jobs ────────────────────────────────────────────────
exports.getSavedJobs = async (req, res, next) => {
  try {
    const jobs = await Job.find({
      userId: req.user._id,
      status: 'saved',
    }).sort({ createdAt: -1 }).lean();

    return success(res, jobs);
  } catch (err) {
    next(err);
  }
};

// ── Get single job (with full company context) ────────────────────
exports.getJob = async (req, res, next) => {
  try {
    const job = await Job.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    }).lean();
    if (!job) throw new NotFoundError('Job not found');

    // Attach all recruiters + employees from global store if company is linked
    let companyContext = null;
    if (job.companyId) {
      companyContext = await getCompanyContext(job.companyId, {
        recruiterLimit: 20,
        employeeLimit:  10,
      });
    }

    return success(res, {
      ...job,
      companyData:  companyContext?.company   || null,
      recruiters:   companyContext?.recruiters || [],
      employees:    companyContext?.employees  || [],
    });
  } catch (err) {
    next(err);
  }
};

// ── Update status ─────────────────────────────────────────────────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const allowed = ['found', 'saved', 'applied', 'interview', 'offer', 'rejected'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const update = {
      status,
      statusUpdatedAt: new Date(),
    };
    if (notes !== undefined) update.notes = notes;
    if (status === 'applied') update.appliedAt = new Date();

    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: update },
      { new: true }
    );
    if (!job) throw new NotFoundError('Job not found');

    return success(res, job, 'Status updated');
  } catch (err) {
    next(err);
  }
};

// ── Save job ──────────────────────────────────────────────────────
exports.saveJob = async (req, res, next) => {
  try {
    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { status: 'saved', statusUpdatedAt: new Date() } },
      { new: true }
    );
    if (!job) throw new NotFoundError('Job not found');
    return success(res, job, 'Job saved');
  } catch (err) {
    next(err);
  }
};

// ── Unsave job ────────────────────────────────────────────────────
exports.unsaveJob = async (req, res, next) => {
  try {
    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { status: 'found', statusUpdatedAt: new Date() } },
      { new: true }
    );
    if (!job) throw new NotFoundError('Job not found');
    return success(res, job, 'Job unsaved');
  } catch (err) {
    next(err);
  }
};

// ── Export Excel ──────────────────────────────────────────────────
exports.exportExcel = async (req, res, next) => {
  try {
    const jobs = await Job.find({ userId: req.user._id })
      .sort({ matchScore: -1 })
      .limit(200)
      .lean();

    const XLSX = require('xlsx');

    const headers = [
      'Company', 'Job Title', 'Location', 'Salary', 'Match %',
      'Source', 'Remote', 'Status',
      'HR Email', 'HR Name', 'HR Confidence', 'HR Source',
      'Career Page', 'Job URL', 'Applied Date',
    ];

    const rows = jobs.map(j => [
      j.company        || '',
      j.title          || '',
      j.location       || '',
      j.salary         || '',
      `${j.matchScore  || 0}%`,
      j.source         || '',
      j.remote         ? 'Yes' : 'No',
      j.status         || '',
      j.recruiterEmail || '',           // ← HR email auto-filled
      j.recruiterName  || '',
      j.recruiterConfidence ? `${j.recruiterConfidence}%` : '',
      j.recruiterSource    || '',
      j.careerPageUrl      || '',
      j.url                || '',
      j.appliedAt ? new Date(j.appliedAt).toLocaleDateString() : '',
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = headers.map(() => ({ wch: 22 }));

    // Style header row green
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c: C });
      if (!ws[addr]) continue;
      ws[addr].s = {
        fill: { fgColor: { rgb: 'E8F4FD' } },
        font: { bold: true },
      };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Jobs');

    // Summary sheet
    const emailsWithHR = jobs.filter(j => j.recruiterEmail).length;
    const summary = [
      ['JobHunter - Job Search Report'],
      ['Generated',      new Date().toLocaleString()],
      ['Total Jobs',     jobs.length],
      ['With HR Email',  emailsWithHR],
      ['Remote Jobs',    jobs.filter(j => j.remote).length],
      ['Applied',        jobs.filter(j => j.status === 'applied').length],
      ['Interview',      jobs.filter(j => j.status === 'interview').length],
      ['Offer',          jobs.filter(j => j.status === 'offer').length],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(summary);
    ws2['!cols'] = [{ wch: 20 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=jobhunter-results.xlsx');
    res.send(buffer);

  } catch (err) {
    next(err);
  }
};

// ── Explain match score ───────────────────────────────────────────
exports.explainMatch = async (req, res, next) => {
  try {
    const job  = await Job.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { explainMatch } = require('../services/ai/jobAnalyzer.service');
    const explanation = await explainMatch({ job, user });

    return success(res, explanation);
  } catch (err) { next(err); }
};

// ── Company research ──────────────────────────────────────────────
exports.getCompanyResearch = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    const { researchCompany } = require('../services/ai/jobAnalyzer.service');
    const { extractDomain }   = require('../services/emailFinder/pattern.service');
    const Company             = require('../models/Company');

    // Prefer real domain from Company store, fall back to guessed domain
    let domain = null;
    if (job.companyId) {
      const company = await Company.findById(job.companyId).select('domain').lean();
      domain = company?.domain || null;
    }
    if (!domain) domain = extractDomain(job.company);

    const research = await researchCompany({ company: job.company, domain });

    return success(res, research);
  } catch (err) { next(err); }
};

// ── Find employees for a job via Apollo ──────────────────────────
exports.findJobEmployees = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) throw new NotFoundError('Job not found');

    const apollo  = require('../services/emailFinder/apollo.service');
    const titles  = ['HR Manager', 'Recruiter', 'Talent Acquisition', 'Engineering Manager', 'Tech Lead'];
    const people  = await apollo.searchPeople(job.company, titles);

    // Persist employees to the job document
    if (people.length > 0) {
      job.employees = people.map(p => ({
        name:     p.name,
        title:    p.title,
        email:    p.email || null,
        linkedin: p.linkedin || null,
        source:   'apollo',
        foundAt:  new Date(),
      }));
      await job.save();
    }

    return success(res, {
      company:   job.company,
      employees: job.employees,
      total:     job.employees.length,
    });
  } catch (err) { next(err); }
};

// ── Get all contacts for a job (HR + employees) ───────────────────
exports.getJobContacts = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id })
      .select('company recruiterEmail recruiterName recruiterConfidence recruiterSource recruiterLinkedIn recruiterEmailStatus allRecruiterContacts employees careerPageUrl linkedinUrl employeeSearch')
      .lean();
    if (!job) throw new NotFoundError('Job not found');

    return success(res, {
      company:         job.company,
      hrContacts:      job.allRecruiterContacts?.length > 0
        ? job.allRecruiterContacts
        : job.recruiterEmail
          ? [{ email: job.recruiterEmail, name: job.recruiterName, confidence: job.recruiterConfidence, source: job.recruiterSource, status: job.recruiterEmailStatus, linkedin: job.recruiterLinkedIn }]
          : [],
      employees:       job.employees || [],
      careerPageUrl:   job.careerPageUrl,
      linkedinUrl:     job.linkedinUrl,
      employeeSearch:  job.employeeSearch,
    });
  } catch (err) { next(err); }
};

// ── Check duplicate application ───────────────────────────────────
exports.checkDuplicate = async (req, res, next) => {
  try {
    const { company, jobTitle } = req.body;
    if (!company) throw new ValidationError('Company required');

    const { checkDuplicateApplication } = require('../services/jobs/maintenance.service');
    const result = await checkDuplicateApplication(req.user._id, company, jobTitle);

    return success(res, result);
  } catch (err) { next(err); }
};
