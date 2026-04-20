const { google }         = require('googleapis');
const LinkedInJob        = require('../models/LinkedInJob');
const { findHRContacts } = require('../services/emailFinder');
const apollo             = require('../services/emailFinder/apollo.service');
const { success, paginated } = require('../utils/response.util');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../config/logger');

// ── Get email-sourced jobs only ───────────────────────────────────
exports.getEmailJobs = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 20;
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;
    const source = req.query.source || null; // e.g. 'email_naukri'

    const filter = {
      userId: req.user._id,
      source: { $regex: 'email', $options: 'i' },
    };
    if (status) filter.status = status;
    if (source) filter.source = source; // narrow to specific portal

    const [jobs, total] = await Promise.all([
      LinkedInJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      LinkedInJob.countDocuments(filter),
    ]);

    return paginated(res, jobs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) { next(err); }
};

// ── Get all LinkedIn jobs ─────────────────────────────────────────
exports.getJobs = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;

    const filter = { userId: req.user._id };
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      LinkedInJob.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LinkedInJob.countDocuments(filter),
    ]);

    return paginated(res, jobs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) { next(err); }
};

// ── Add job from LinkedIn alert ───────────────────────────────────
exports.addJob = async (req, res, next) => {
  try {
    const { title, company, location, url, description, salary, remote, postedAt } = req.body;

    if (!title || !company) throw new ValidationError('Title and company are required');

    const job = await LinkedInJob.create({
      userId: req.user._id,
      title, company, location, url,
      description, salary, remote, postedAt,
    });

    // Auto-find HR email in background
    findHRContacts(company, req.user.plan || 'free')
      .then(async (contacts) => {
        if (contacts?.emails?.length > 0) {
          const top = contacts.emails[0];
          await LinkedInJob.findByIdAndUpdate(job._id, {
            recruiterEmail:    top.email,
            recruiterName:     top.name,
            recruiterLinkedIn: top.linkedin || null,
          });
          logger.info(`Auto-found HR email for LinkedIn job: ${company}`);
        }
      })
      .catch(err => logger.warn(`Auto HR email failed for ${company}: ${err.message}`));

    logger.info(`LinkedIn job added: ${title} at ${company} for ${req.user.email}`);
    return success(res, job, 'Job added from LinkedIn alert');
  } catch (err) { next(err); }
};

// ── Get single job ────────────────────────────────────────────────
exports.getJob = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!job) throw new NotFoundError('Job not found');
    return success(res, job);
  } catch (err) { next(err); }
};

// ── Update status ─────────────────────────────────────────────────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['new', 'saved', 'applied', 'ignored'];
    if (!allowed.includes(status)) throw new ValidationError('Invalid status');

    const job = await LinkedInJob.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { status },
      { new: true }
    );
    if (!job) throw new NotFoundError('Job not found');
    return success(res, job, 'Status updated');
  } catch (err) { next(err); }
};

// ── Find HR contacts + employees ──────────────────────────────────
exports.findHR = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!job) throw new NotFoundError('Job not found');

    const contacts = await findHRContacts(job.company, req.user.plan || 'free');

    let employees = [];
    try {
      employees = await apollo.searchPeople(
        job.company,
        ['HR Manager', 'Recruiter', 'Talent Acquisition', 'Engineering Manager']
      );
    } catch (err) {
      logger.warn(`Apollo search failed for ${job.company}: ${err.message}`);
    }

    const update = {
      // Always persist links — available for all plans
      ...(contacts?.careerPageUrl  && { careerPageUrl:  contacts.careerPageUrl  }),
      ...(contacts?.linkedinUrl    && { linkedinUrl:    contacts.linkedinUrl    }),
      ...(contacts?.employeeSearch && { employeeSearch: contacts.employeeSearch }),
      // Emails — only set if found
      ...(contacts?.emails?.[0]?.email && {
        recruiterEmail:    contacts.emails[0].email,
        recruiterName:     contacts.emails[0].name     || '',
        recruiterLinkedIn: contacts.emails[0].linkedin || '',
      }),
      // Employees
      ...(employees.length > 0 && {
        employees: employees.map(e => ({
          name:     e.name     || '',
          title:    e.title    || '',
          linkedin: e.linkedin || null,
          email:    e.email    || null,
        })),
      }),
    };

    await LinkedInJob.findByIdAndUpdate(job._id, update);

    logger.info(
      `HR found for ${job.company}: ` +
      `${contacts?.emails?.length || 0} emails, ${employees.length} employees, ` +
      `careerPage: ${!!contacts?.careerPageUrl}`
    );

    return success(res, {
      emails:        contacts?.emails       || [],
      employees,
      source:        contacts?.source       || 'pattern',
      careerPageUrl: contacts?.careerPageUrl || null,
      linkedinUrl:   contacts?.linkedinUrl   || null,
      employeeSearch: contacts?.employeeSearch || null,
    }, 'HR contacts found');
  } catch (err) { next(err); }
};

// ── Delete job ────────────────────────────────────────────────────
exports.deleteJob = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!job) throw new NotFoundError('Job not found');
    return success(res, null, 'Job deleted');
  } catch (err) { next(err); }
};

// ── Get connect info ──────────────────────────────────────────────
exports.getConnectInfo = async (req, res, next) => {
  try {
    return success(res, {
      instructions: [
        'Set up LinkedIn job alerts for your target role',
        'Connect Gmail to auto-import jobs from LinkedIn alert emails',
        'Or click Fetch from LinkedIn to pull jobs directly',
        'We auto-find HR emails and employee LinkedIn profiles',
        'Send AI outreach directly from this page',
      ],
      webhookEmail: `linkedin+${req.user._id}@jobhunter.in`,
      status:       'active',
    });
  } catch (err) { next(err); }
};

// ── Manual fetch from LinkedIn ────────────────────────────────────
exports.fetchAlerts = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id);
    const p    = user.profile || {};

    const role     = req.body.role     || p.targetRole || p.currentRole || '';
    const location = req.body.location || p.preferredLocations?.[0] || p.city || 'India';
    const workType = req.body.workType || p.workType || 'any';

    if (!role) {
      return res.status(400).json({
        success: false,
        message: 'Add your target role in Profile → Career first',
      });
    }

    const { fetchLinkedInRSS, scrapeLinkedInJobs } = require('../services/linkedin/rss.service');
    const { score } = require('../services/jobSearch/scorer');

    let jobs = await fetchLinkedInRSS({ role, location });
    if (jobs.length === 0) {
      jobs = await scrapeLinkedInJobs({ role, location, workType });
    }

    if (jobs.length === 0) {
      return success(res, {
        fetched: 0,
        saved:   0,
        message: 'LinkedIn returned no results. Try a different role or location.',
      }, 'No jobs found');
    }

    // Filter duplicates
    const existing    = await LinkedInJob.find({ userId: req.user._id }).select('url').lean();
    const existingSet = new Set(existing.map(j => j.url).filter(Boolean));
    const newJobs     = jobs.filter(j => !j.url || !existingSet.has(j.url));

    if (newJobs.length === 0) {
      return success(res, {
        fetched: jobs.length,
        saved:   0,
      }, 'All jobs already saved — no new ones');
    }

    const scored = score(newJobs, user);

    const jobDocs = scored.map(j => ({
      userId:     req.user._id,
      title:      j.title,
      company:    j.company,
      location:   j.location,
      url:        j.url,
      postedAt:   j.postedAt,
      remote:     j.remote,
      source:     'linkedin_fetch',
      matchScore: j.matchScore || 0,
      status:     'new',
    }));

    await LinkedInJob.insertMany(jobDocs, { ordered: false }).catch(() => {});

    const limit     = req.user.plan === 'free' ? 2 : jobDocs.length;
    const companies = [...new Set(scored.slice(0, limit).map(j => j.company))];

    let emailsFound = 0;
    for (const company of companies) {
      try {
        const contacts = await findHRContacts(company, req.user.plan);
        if (contacts?.emails?.length > 0) {
          await LinkedInJob.updateMany(
            { userId: req.user._id, company, recruiterEmail: null },
            {
              $set: {
                recruiterEmail: contacts.emails[0].email,
                recruiterName:  contacts.emails[0].name,
              },
            }
          );
          emailsFound++;
        }
      } catch {}
    }

    logger.info(
      `Manual LinkedIn fetch: ${req.user.email} — ` +
      `${jobDocs.length} jobs, ${emailsFound} HR emails`
    );

    return success(res, {
      fetched:     jobs.length,
      saved:       jobDocs.length,
      emailsFound,
      role,
      location,
    }, `Fetched ${jobDocs.length} new LinkedIn jobs!`);

  } catch (err) { next(err); }
};

// ── Gmail connect ─────────────────────────────────────────────────
exports.gmailConnect = async (req, res, next) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${process.env.API_URL}/api/v1/linkedin/gmail/callback`
    );

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state:  req.user._id.toString(),
      prompt: 'consent',
    });

    return success(res, { url });
  } catch (err) { next(err); }
};

// ── Gmail OAuth callback ──────────────────────────────────────────
exports.gmailCallback = async (req, res, next) => {
  try {
    const { code, state: userId } = req.query;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${process.env.API_URL}/api/v1/linkedin/gmail/callback`
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Save tokens
    const User = require('../models/User');
    await User.findByIdAndUpdate(userId, {
      gmailAccessToken:  tokens.access_token,
      gmailRefreshToken: tokens.refresh_token,
      gmailConnectedAt:  new Date(),
      gmailEmail:        profile.email,
    });

    logger.info(`Gmail connected for user ${userId}: ${profile.email}`);
    res.redirect(`${process.env.CLIENT_URL}/linkedin?gmail=connected`);
  } catch (err) {
    logger.error(`Gmail callback error: ${err.message}`);
    res.redirect(`${process.env.CLIENT_URL}/linkedin?gmail=error`);
  }
};

// ── Gmail status ──────────────────────────────────────────────────
exports.gmailStatus = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id)
      .select('+gmailAccessToken +gmailEmail +gmailConnectedAt');

    return success(res, {
      connected:   !!user?.gmailAccessToken,
      email:       user?.gmailEmail       || null,
      connectedAt: user?.gmailConnectedAt || null,
    });
  } catch (err) { next(err); }
};

// ── Fetch jobs from Gmail LinkedIn alerts ─────────────────────────
exports.fetchFromGmail = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id)
      .select('+gmailAccessToken +gmailRefreshToken');

    if (!user?.gmailAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Gmail not connected. Click "Connect Gmail" first.',
        code:    'GMAIL_NOT_CONNECTED',
      });
    }

    const { fetchJobAlertEmails } = require('../services/linkedin/emailParser.service');
    const { score }               = require('../services/jobSearch/scorer');

    // Setup OAuth client with stored tokens
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      access_token:  user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken,
    });

    // Get fresh access token (refresh if expired)
    const { token } = await oauth2Client.getAccessToken();
    const accessToken = token || user.gmailAccessToken;

    if (token && token !== user.gmailAccessToken) {
      await User.findByIdAndUpdate(req.user._id, { gmailAccessToken: token });
    }

    // Fetch from ALL job portals (LinkedIn, Naukri, Indeed, Foundit, etc.)
    const maxResults = parseInt(req.body.maxResults) || 20;
    const rawJobs = await fetchJobAlertEmails(accessToken, maxResults);

    if (rawJobs.length === 0) {
      return success(res, {
        fetched: 0,
        saved:   0,
      }, 'No LinkedIn alert emails found in your Gmail');
    }

    // Filter duplicates
    const existing    = await LinkedInJob.find({ userId: req.user._id }).select('url').lean();
    const existingSet = new Set(existing.map(j => j.url).filter(Boolean));
    const newJobs     = rawJobs.filter(j => !j.url || !existingSet.has(j.url));

    if (newJobs.length === 0) {
      return success(res, {
        fetched: rawJobs.length,
        saved:   0,
      }, 'All jobs from email alerts already saved');
    }

    // Score + save
    const fullUser = await User.findById(req.user._id).lean();
    const scored   = score(newJobs, fullUser);

    const jobDocs = scored.map(j => ({
      userId:      req.user._id,
      title:       j.title,
      company:     j.company || '',
      location:    j.location || '',
      url:         j.url || '',
      description: j.description || '',
      remote:      j.remote,
      source:      `email_${j.source || 'alert'}`,
      matchScore:  j.matchScore || 0,
      status:      'new',
    }));

    let insertedCount = 0;
    try {
      const result = await LinkedInJob.insertMany(jobDocs, { ordered: false });
      insertedCount = result.length;
    } catch (err) {
      // Partial success — some docs inserted, some failed (e.g. duplicates)
      insertedCount = err.insertedDocs?.length || 0;
      logger.warn(`Gmail insertMany partial: ${insertedCount}/${jobDocs.length} inserted — ${err.message}`);
    }

    // Auto-find HR emails + employees
    const isPro     = req.user.plan === 'pro' || req.user.plan === 'team';
    const limit     = isPro ? jobDocs.length : 2;
    const companies = [...new Set(scored.slice(0, limit).map(j => j.company).filter(Boolean))];

    let emailsFound    = 0;
    let employeesFound = 0;

    for (const company of companies) {
      try {
        const contacts = await findHRContacts(company, req.user.plan);
        if (contacts?.emails?.length > 0) {
          const top = contacts.emails[0];
          await LinkedInJob.updateMany(
            { userId: req.user._id, company, recruiterEmail: null },
            {
              $set: {
                recruiterEmail:    top.email,
                recruiterName:     top.name,
                recruiterLinkedIn: top.linkedin || null,
              },
            }
          );
          emailsFound++;
        }

        if (isPro) {
          try {
            const employees = await apollo.searchPeople(
              company,
              ['HR Manager', 'Recruiter', 'Talent Acquisition', 'Engineering Manager']
            );
            if (employees.length > 0) {
              await LinkedInJob.updateMany(
                { userId: req.user._id, company },
                {
                  $set: {
                    employees: employees.map(e => ({
                      name:     e.name     || '',
                      title:    e.title    || '',
                      linkedin: e.linkedin || null,
                      email:    e.email    || null,
                    })),
                  },
                }
              );
              employeesFound += employees.length;
            }
          } catch {}
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.warn(`HR/employee search failed for ${company}: ${err.message}`);
      }
    }

    logger.info(
      `Gmail alert fetch: ${req.user.email} — ` +
      `${insertedCount}/${jobDocs.length} jobs inserted, ${emailsFound} HR emails, ${employeesFound} employees`
    );

    return success(res, {
      fetched:        rawJobs.length,
      saved:          insertedCount,
      emailsFound,
      employeesFound,
    }, `Fetched ${insertedCount} jobs from your email alerts!`);

  } catch (err) { next(err); }
};

// ── Get alert settings ────────────────────────────────────────────
exports.getAlertSettings = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id).select('linkedinAlerts').lean();
    return success(res, {
      enabled:    user?.linkedinAlerts?.enabled    ?? true,
      frequency:  user?.linkedinAlerts?.frequency  ?? 'daily',
      lastSentAt: user?.linkedinAlerts?.lastSentAt ?? null,
    });
  } catch (err) { next(err); }
};

// ── Update alert settings ─────────────────────────────────────────
exports.updateAlertSettings = async (req, res, next) => {
  try {
    const { enabled, frequency } = req.body;
    const allowed = ['hourly', 'daily', 'weekly'];

    const update = {};
    if (typeof enabled === 'boolean')                   update['linkedinAlerts.enabled']   = enabled;
    if (frequency && allowed.includes(frequency))       update['linkedinAlerts.frequency'] = frequency;

    const User = require('../models/User');
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: update },
      { new: true, select: 'linkedinAlerts' }
    );

    return success(res, {
      enabled:   user.linkedinAlerts.enabled,
      frequency: user.linkedinAlerts.frequency,
    }, 'Alert settings saved');
  } catch (err) { next(err); }
};

// ── Unread count (badge) ──────────────────────────────────────────
exports.getUnreadCount = async (req, res, next) => {
  try {
    const count = await LinkedInJob.countDocuments({
      userId: req.user._id,
      status: 'new',
    });
    return success(res, { count });
  } catch (err) { next(err); }
};

// ── Deep evaluate a LinkedIn job (A-F scoring) ───────────────────
exports.deepEvaluate = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    if (job.deepEval?.generatedAt) {
      const age = Date.now() - new Date(job.deepEval.generatedAt).getTime();
      if (age < 7 * 24 * 60 * 60 * 1000) return success(res, job.deepEval, 'Using cached evaluation');
    }

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { deepEvaluateJob } = require('../services/ai/jobAnalyzer.service');
    const evalResult = await deepEvaluateJob({ job, user });

    await LinkedInJob.updateOne(
      { _id: req.params.id },
      { $set: { deepEval: { ...evalResult, generatedAt: new Date() } } }
    );

    return success(res, evalResult);
  } catch (err) { next(err); }
};

// ── Generate interview prep for a LinkedIn job ────────────────────
exports.generateInterviewPrep = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    if (job.interviewPrep?.generatedAt) {
      const age = Date.now() - new Date(job.interviewPrep.generatedAt).getTime();
      if (age < 14 * 24 * 60 * 60 * 1000) return success(res, job.interviewPrep, 'Using cached prep');
    }

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { generateInterviewPrep } = require('../services/ai/jobAnalyzer.service');
    const prep = await generateInterviewPrep({ job, user });

    await LinkedInJob.updateOne(
      { _id: req.params.id },
      { $set: { interviewPrep: { ...prep, generatedAt: new Date() } } }
    );

    return success(res, prep);
  } catch (err) { next(err); }
};

// ── Explain match score for a LinkedIn job ────────────────────────
exports.explainMatch = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();

    const { explainMatch } = require('../services/ai/jobAnalyzer.service');
    const explanation = await explainMatch({ job, user });
    return success(res, explanation);
  } catch (err) { next(err); }
};

// ── Company research for a LinkedIn job ──────────────────────────
exports.getCompanyResearch = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!job) throw new NotFoundError('Job not found');

    const { researchCompany } = require('../services/ai/jobAnalyzer.service');
    const { extractDomain }   = require('../services/emailFinder/pattern.service');
    const domain = extractDomain(job.company);
    const research = await researchCompany({ company: job.company, domain });
    return success(res, research);
  } catch (err) { next(err); }
};

// ── Fetch & cache job description by scraping LinkedIn URL ────────
exports.fetchDescription = async (req, res, next) => {
  try {
    const job = await LinkedInJob.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) throw new NotFoundError('Job not found');

    // Return cached description if already stored
    if (job.description) return success(res, { description: job.description });

    if (!job.url) return success(res, { description: null }, 'No URL to fetch description from');

    const axios   = require('axios');
    const cheerio = require('cheerio');

    // Extract LinkedIn job ID from any URL format:
    // /jobs/view/1234567, /comm/jobs/view/1234567, etc.
    const jobIdMatch = job.url.match(/\/jobs\/view\/(\d+)/);
    const linkedinJobId = jobIdMatch?.[1];

    let description = '';

    // 1. LinkedIn guest API — works without login, returns full HTML description
    if (linkedinJobId) {
      try {
        const { data: guestHtml } = await axios.get(
          `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedinJobId}`,
          {
            headers: {
              'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept':          'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 12000,
          }
        );
        const $g = cheerio.load(guestHtml);
        description =
          $g('.show-more-less-html__markup').html()?.trim() ||
          $g('.description__text').html()?.trim()           ||
          $g('[class*="description"]').first().html()?.trim() || '';

        // Enrich company/location if missing, then trigger HR search in background
        let enrichedCompany = job.company;
        if (!job.company) {
          const company = $g('.topcard__org-name-link, .topcard__flavor--black-link').first().text().trim();
          if (company) {
            enrichedCompany = company;
            await LinkedInJob.findByIdAndUpdate(req.params.id, { company });
          }
        }
        if (!job.location) {
          const location = $g('.topcard__flavor--bullet').first().text().trim();
          if (location) await LinkedInJob.findByIdAndUpdate(req.params.id, { location });
        }

        // Background HR search now that we have a company name
        if (enrichedCompany && !job.careerPageUrl) {
          findHRContacts(enrichedCompany, req.user?.plan || 'free')
            .then(async (contacts) => {
              const update = {
                ...(contacts?.careerPageUrl  && { careerPageUrl:  contacts.careerPageUrl  }),
                ...(contacts?.linkedinUrl    && { linkedinUrl:    contacts.linkedinUrl    }),
                ...(contacts?.employeeSearch && { employeeSearch: contacts.employeeSearch }),
                ...(contacts?.emails?.[0]?.email && {
                  recruiterEmail: contacts.emails[0].email,
                  recruiterName:  contacts.emails[0].name || '',
                }),
              };
              if (Object.keys(update).length) {
                await LinkedInJob.findByIdAndUpdate(req.params.id, update);
                logger.info(`Background HR enriched for ${enrichedCompany}`);
              }
            })
            .catch(() => {});
        }
      } catch (err) {
        logger.warn(`LinkedIn guest API failed for job ${linkedinJobId}: ${err.message}`);
      }
    }

    // 2. Fallback: JSON-LD on the public job page
    if (!description && linkedinJobId) {
      try {
        const { data: html } = await axios.get(
          `https://www.linkedin.com/jobs/view/${linkedinJobId}`,
          {
            headers: {
              'User-Agent': 'LinkedInBot/1.0 (compatible; LinkedInBot/1.0; +http://www.linkedin.com)',
              'Accept': 'text/html',
            },
            timeout: 12000,
            maxRedirects: 3,
          }
        );
        const $p = cheerio.load(html);
        $p('script[type="application/ld+json"]').each((_, el) => {
          if (description) return;
          try {
            const json = JSON.parse($p(el).html());
            if (json.description) description = json.description;
          } catch {}
        });
      } catch {}
    }

    // Strip HTML tags and clean up
    description = (description || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    if (description.length > 50) {
      await LinkedInJob.findByIdAndUpdate(req.params.id, { description });
    }

    return success(res, { description: description || null });
  } catch (err) {
    logger.warn(`LinkedIn description fetch failed for ${req.params.id}: ${err.message}`);
    return success(res, { description: null }, 'Could not fetch description');
  }
};

// ── Disconnect Gmail ──────────────────────────────────────────────
exports.gmailDisconnect = async (req, res, next) => {
  try {
    const User = require('../models/User');
    await User.findByIdAndUpdate(req.user._id, {
      $unset: {
        gmailAccessToken:  '',
        gmailRefreshToken: '',
        gmailConnectedAt:  '',
        gmailEmail:        '',
      },
    });
    return success(res, null, 'Gmail disconnected');
  } catch (err) { next(err); }
};