const Job             = require('../models/Job');
const { recordClientEventForJob } = require('../services/ranking/rankingEvent.service');
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

    const searchId     = req.query.searchId     || null;
    const excludeSource = req.query.excludeSource || null;

    const filter = { userId: req.user._id };
    if (status)   filter.status   = status;
    if (source)   filter.source   = source;
    else if (excludeSource) filter.source = { $ne: excludeSource };
    if (remote !== null) filter.remote = remote === 'true';
    if (searchId) filter.searchId = searchId;

    const sortObj = sort === 'matchScore'
      ? { matchScore: -1 }
      : sort === 'date'
        ? { createdAt: -1 }
        : { matchScore: -1 };

    const [jobs, total, platformAgg] = await Promise.all([
      Job.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      Job.countDocuments(filter),
      // Platform breakdown on page 1 only
      page === 1
        ? Job.aggregate([
            { $match: filter },
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]).catch(() => null)
        : Promise.resolve(null),
    ]);

    const platformBreakdown = platformAgg
      ? Object.fromEntries(platformAgg.map(p => [p._id || 'Unknown', p.count]))
      : undefined;

    return paginated(res, jobs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
      ...(platformBreakdown ? { platformBreakdown } : {}),
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

    const ExcelJS = require('exceljs');

    const headers = [
      'Company', 'Job Title', 'Location', 'Salary', 'Match %',
      'Source', 'Remote', 'Status',
      'HR Email', 'HR Name', 'HR Confidence', 'HR Source',
      'Career Page', 'Job URL', 'Applied Date',
    ];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Jobs', { views: [{ state: 'frozen', ySplit: 1 }] });

    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8F4FD' },
    };

    for (const j of jobs) {
      ws.addRow([
        j.company        || '',
        j.title          || '',
        j.location       || '',
        j.salary         || '',
        `${j.matchScore  || 0}%`,
        j.source         || '',
        j.remote         ? 'Yes' : 'No',
        j.status         || '',
        j.recruiterEmail || '',
        j.recruiterName  || '',
        j.recruiterConfidence ? `${j.recruiterConfidence}%` : '',
        j.recruiterSource    || '',
        j.careerPageUrl      || '',
        j.url                || '',
        j.appliedAt ? new Date(j.appliedAt).toLocaleDateString() : '',
      ]);
    }

    ws.columns = headers.map(() => ({ width: 22 }));

    // Summary sheet
    const emailsWithHR = jobs.filter(j => j.recruiterEmail).length;
    const ws2 = wb.addWorksheet('Summary');
    ws2.addRows([
      ['JobHunter - Job Search Report'],
      ['Generated',      new Date().toLocaleString()],
      ['Total Jobs',     jobs.length],
      ['With HR Email',  emailsWithHR],
      ['Remote Jobs',    jobs.filter(j => j.remote).length],
      ['Applied',        jobs.filter(j => j.status === 'applied').length],
      ['Interview',      jobs.filter(j => j.status === 'interview').length],
      ['Offer',          jobs.filter(j => j.status === 'offer').length],
    ]);
    ws2.getColumn(1).width = 20;
    ws2.getColumn(2).width = 30;

    const buffer = await wb.xlsx.writeBuffer();

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

// ── Check liveness of a single job ───────────────────────────────
exports.checkLiveness = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    const { checkJobLiveness } = require('../services/liveness/liveness.service');
    const liveness = await checkJobLiveness(req.params.id);

    return success(res, { liveness }, `Job is ${liveness}`);
  } catch (err) { next(err); }
};

// ── Get follow-up reminders for user ─────────────────────────────
exports.getFollowUps = async (req, res, next) => {
  try {
    const now = new Date();
    const jobs = await Job.find({
      userId: req.user._id,
      status: { $in: ['applied', 'interview'] },
      followUpDate: { $lte: now },
    })
      .sort({ followUpDate: 1 })
      .select('title company status appliedAt followUpDate followUpCount statusUpdatedAt')
      .lean();

    const categorized = jobs.map(j => {
      const daysAgo   = Math.floor((now - new Date(j.appliedAt || j.statusUpdatedAt || j.createdAt)) / 86400000);
      const urgency   =
        j.status === 'interview' ? 'urgent' :
        j.followUpCount >= 2     ? 'cold'   :
        daysAgo > 7              ? 'overdue': 'waiting';
      return { ...j, daysAgo, urgency };
    });

    return success(res, {
      total:    categorized.length,
      urgent:   categorized.filter(j => j.urgency === 'urgent').length,
      overdue:  categorized.filter(j => j.urgency === 'overdue').length,
      followUps: categorized,
    });
  } catch (err) { next(err); }
};

// ── Mark a follow-up as sent ──────────────────────────────────────
exports.markFollowUpSent = async (req, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) throw new NotFoundError('Job not found');

    const nextFollowUp = new Date();
    if (job.status === 'applied') {
      nextFollowUp.setDate(nextFollowUp.getDate() + 7);
    } else if (job.status === 'interview') {
      nextFollowUp.setDate(nextFollowUp.getDate() + 3);
    }

    job.followUpCount = (job.followUpCount || 0) + 1;
    job.followUpDate  = job.followUpCount >= 2 ? null : nextFollowUp;
    await job.save();

    return success(res, { followUpCount: job.followUpCount, nextFollowUpDate: job.followUpDate }, 'Follow-up marked');
  } catch (err) { next(err); }
};

// ── Snooze follow-up by N days ────────────────────────────────────
exports.snoozeFollowUp = async (req, res, next) => {
  try {
    const { days = 3 } = req.body;
    const nextDate     = new Date();
    nextDate.setDate(nextDate.getDate() + parseInt(days));

    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { followUpDate: nextDate } },
      { new: true }
    );
    if (!job) throw new NotFoundError('Job not found');

    return success(res, { followUpDate: job.followUpDate }, `Follow-up snoozed ${days} days`);
  } catch (err) { next(err); }
};

// ── Deep evaluate a job (A-F scoring) ────────────────────────────
exports.deepEvaluate = async (req, res, next) => {
  try {
    const job  = await Job.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    // Return cached result if < 7 days old
    if (job.deepEval?.generatedAt) {
      const age = Date.now() - new Date(job.deepEval.generatedAt).getTime();
      if (age < 7 * 24 * 60 * 60 * 1000) {
        return success(res, job.deepEval, 'Using cached evaluation');
      }
    }

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { deepEvaluateJob } = require('../services/ai/jobAnalyzer.service');
    const evalResult = await deepEvaluateJob({ job, user });

    await Job.updateOne(
      { _id: req.params.id },
      { $set: { deepEval: { ...evalResult, generatedAt: new Date() } } }
    );

    return success(res, evalResult);
  } catch (err) { next(err); }
};

// ── Generate interview prep for a job ────────────────────────────
exports.generateInterviewPrep = async (req, res, next) => {
  try {
    const job  = await Job.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    // Return cached if < 14 days old
    if (job.interviewPrep?.generatedAt) {
      const age = Date.now() - new Date(job.interviewPrep.generatedAt).getTime();
      if (age < 14 * 24 * 60 * 60 * 1000) {
        return success(res, job.interviewPrep, 'Using cached prep');
      }
    }

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { generateInterviewPrep } = require('../services/ai/jobAnalyzer.service');
    const prep = await generateInterviewPrep({ job, user });

    await Job.updateOne(
      { _id: req.params.id },
      { $set: { interviewPrep: { ...prep, generatedAt: new Date() } } }
    );

    return success(res, prep);
  } catch (err) { next(err); }
};

// ── Rejection pattern analytics ───────────────────────────────────
exports.getInsights = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [allJobs, appliedJobs] = await Promise.all([
      Job.find({ userId }).select('status source remote location matchScore company title recruiterEmail deepEval').lean(),
      Job.find({ userId, status: { $in: ['applied', 'interview', 'offer', 'rejected'] } })
         .select('status source remote matchScore company title deepEval appliedAt').lean(),
    ]);

    const total    = allJobs.length;
    const byStatus = {};
    for (const j of allJobs) {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    }

    // Callback rate (interview or offer out of applied)
    const applied   = appliedJobs.length;
    const callbacks = appliedJobs.filter(j => ['interview', 'offer'].includes(j.status)).length;
    const callbackRate = applied > 0 ? Math.round((callbacks / applied) * 100) : 0;

    // Remote vs onsite performance
    const remoteApplied   = appliedJobs.filter(j => j.remote).length;
    const onsiteApplied   = appliedJobs.filter(j => !j.remote).length;
    const remoteCallbacks = appliedJobs.filter(j => j.remote && ['interview', 'offer'].includes(j.status)).length;
    const onsiteCallbacks = appliedJobs.filter(j => !j.remote && ['interview', 'offer'].includes(j.status)).length;

    // Score correlation — average match score for callbacks vs rejections
    const callbackScores  = appliedJobs.filter(j => ['interview', 'offer'].includes(j.status)).map(j => j.matchScore);
    const rejectedScores  = appliedJobs.filter(j => j.status === 'rejected').map(j => j.matchScore);
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Source effectiveness
    const bySource = {};
    for (const j of appliedJobs) {
      if (!bySource[j.source]) bySource[j.source] = { applied: 0, callbacks: 0 };
      bySource[j.source].applied++;
      if (['interview', 'offer'].includes(j.status)) bySource[j.source].callbacks++;
    }
    const sourceStats = Object.entries(bySource)
      .map(([source, s]) => ({
        source,
        applied:      s.applied,
        callbacks:    s.callbacks,
        callbackRate: s.applied > 0 ? Math.round((s.callbacks / s.applied) * 100) : 0,
      }))
      .sort((a, b) => b.callbackRate - a.callbackRate);

    // With HR email vs without
    const withEmail    = allJobs.filter(j => j.recruiterEmail).length;
    const withEmailCb  = appliedJobs.filter(j => j.recruiterEmail && ['interview', 'offer'].includes(j.status)).length;
    const noEmailCb    = appliedJobs.filter(j => !j.recruiterEmail && ['interview', 'offer'].includes(j.status)).length;

    // Recommendations
    const recommendations = [];
    if (callbackRate < 20 && applied >= 5) {
      recommendations.push('Your callback rate is below 20% — try targeting roles with a higher match score (70%+).');
    }
    if (rejectedScores.length >= 3 && avg(rejectedScores) > avg(callbackScores)) {
      recommendations.push('You\'re applying to lower-match roles than the ones getting callbacks — focus on better-matching opportunities.');
    }
    if (remoteApplied > 0 && onsiteApplied > 0) {
      const remoteRate = remoteApplied > 0 ? Math.round((remoteCallbacks / remoteApplied) * 100) : 0;
      const onsiteRate = onsiteApplied > 0 ? Math.round((onsiteCallbacks / onsiteApplied) * 100) : 0;
      if (remoteRate > onsiteRate + 15) recommendations.push(`Remote roles are converting better for you (${remoteRate}% vs ${onsiteRate}%) — prioritize remote filters.`);
      if (onsiteRate > remoteRate + 15) recommendations.push(`On-site roles are converting better (${onsiteRate}% vs ${remoteRate}%) — include on-site options.`);
    }
    if (withEmail > 0 && withEmailCb > noEmailCb) {
      recommendations.push('Jobs where you found HR emails are getting more callbacks — keep using the HR Contact Finder.');
    }

    return success(res, {
      overview: { total, applied, callbacks, callbackRate, byStatus },
      matchScores: {
        callbackAvg: avg(callbackScores),
        rejectedAvg: avg(rejectedScores),
        recommendation: avg(callbackScores) >= 65 ? `Target jobs above ${avg(callbackScores) - 5}% match` : 'Aim for 65%+ match score',
      },
      remote: {
        remoteApplied, onsiteApplied,
        remoteCallbackRate: remoteApplied > 0 ? Math.round((remoteCallbacks / remoteApplied) * 100) : 0,
        onsiteCallbackRate: onsiteApplied > 0 ? Math.round((onsiteCallbacks / onsiteApplied) * 100) : 0,
      },
      hrEmail: {
        withEmail,
        withoutEmail: total - withEmail,
        withEmailCallbacks: withEmailCb,
        withoutEmailCallbacks: noEmailCb,
      },
      sourceStats,
      recommendations,
    });
  } catch (err) { next(err); }
};

// ── Ranking / feedback events (for future LTR + analytics) ───────
exports.logRankingEvent = async (req, res, next) => {
  try {
    const job = await Job.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    }).select('_id searchId contentFingerprint matchScore source').lean();

    if (!job) throw new NotFoundError('Job not found');

    const type = String(req.body?.type || '').trim();
    const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};

    await recordClientEventForJob({
      userId: req.user._id,
      job,
      type,
      meta,
    });

    return success(res, { logged: true }, 'Event recorded');
  } catch (err) {
    next(err);
  }
};
