const crypto             = require('crypto');
const JobSearch          = require('../models/JobSearch');
const Job                = require('../models/Job');
const UserCredits        = require('../models/UserCredits');
const { runJobSearch }   = require('../services/jobSearch');
const { findHRContacts } = require('../services/emailFinder');
const { emitToUser }     = require('../config/socket');
const { success, paginated } = require('../utils/response.util');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../config/logger');

// ── Cache TTL: 30 days. After this, same search re-calls APIs ────
const SEARCH_CACHE_TTL_DAYS  = 30;
const SEARCH_CACHE_TTL_HOURS = SEARCH_CACHE_TTL_DAYS * 24;

// ── Build a stable hash for a search query ────────────────────────
function buildSearchHash(role, location, workType) {
  const str = [
    (role     || '').toLowerCase().trim(),
    (location || '').toLowerCase().trim(),
    (workType || '').toLowerCase().trim(),
  ].join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

// ── Run search ────────────────────────────────────────────────────
exports.runSearch = async (req, res, next) => {
  try {
    const { role, location, workType, platforms, force = false } = req.body;

    if (!role || !role.trim()) {
      return res.status(400).json({ success: false, message: 'Job role is required' });
    }

    // ── Cache check — skip if force=true ──────────────────────────
    if (!force) {
      const searchHash = buildSearchHash(role, location, workType);
      const cacheFrom  = new Date(Date.now() - SEARCH_CACHE_TTL_HOURS * 60 * 60 * 1000);

      const cached = await JobSearch.findOne({
        userId:     req.user._id,
        searchHash,
        status:     'completed',
        createdAt:  { $gte: cacheFrom },
      }).sort({ createdAt: -1 }).lean();

      if (cached) {
        logger.info(`Cache hit for ${req.user.email} — search "${role}" (${searchHash})`);

        // Refund the credits since we're not calling external APIs
        if (req.creditsDeducted) {
          await UserCredits.findOneAndUpdate(
            { userId: req.user._id },
            { $inc: { usedCredits: -req.creditsDeducted } }
          ).catch(err => logger.warn('Credit refund failed for cache hit:', err.message));
        }

        // Fetch the actual jobs from DB
        const jobs = await Job.find({
          searchId: cached._id,
          userId:   req.user._id,
        }).sort({ matchScore: -1 }).lean();

        emitToUser(req.user._id, 'search:complete', {
          searchId:   cached._id,
          totalFound: cached.totalFound,
          fromCache:  true,
        });

        return success(res, {
          searchId:          cached._id,
          jobs,
          totalFound:        cached.totalFound,
          platformBreakdown: cached.platformBreakdown
            ? Object.fromEntries(cached.platformBreakdown)
            : {},
          emailsFound:       jobs.filter(j => j.recruiterEmail).length,
          fromCache:         true,
          cachedAt:          cached.createdAt,
          cacheExpiresInDays: Math.max(0, Math.ceil(
            (cached.createdAt.getTime() + SEARCH_CACHE_TTL_DAYS * 86400000 - Date.now()) / 86400000
          )),
          creditsUsed:      0,
          creditsRemaining: req.creditsRemaining !== undefined
            ? req.creditsRemaining + (req.creditsDeducted || 0)
            : undefined,
        }, `Showing results from recent search (${SEARCH_CACHE_TTL_HOURS}h cache). Use force:true to refresh.`);
      }
    }

    // ── Fresh search ──────────────────────────────────────────────
    const searchHash = buildSearchHash(role, location, workType);

    const jobSearch = await JobSearch.create({
      userId:     req.user._id,
      query:      { role, location, workType, platforms },
      status:     'running',
      searchHash,
    });

    const startTime = Date.now();
    const plan      = req.user.plan || 'free';

    const onProgress = (data) => {
      emitToUser(req.user._id, 'search:progress', {
        searchId: jobSearch._id, ...data,
      });
    };

    // Run job search (external APIs)
    let result;
    try {
      result = await runJobSearch(
        { role, location, workType, platforms },
        req.user, plan, onProgress
      );
    } catch (searchErr) {
      await JobSearch.findByIdAndUpdate(jobSearch._id, {
        status: 'failed',
        error:  searchErr.message,
      });
      throw searchErr;
    }

    const durationMs = Date.now() - startTime;

    // ── Auto find HR emails ───────────────────────────────────────
    const limit           = plan === 'free' ? 2 : result.jobs.length;
    const uniqueCompanies = [...new Set(result.jobs.map(j => j.company))].slice(0, limit);
    const emailMap        = {};

    emitToUser(req.user._id, 'search:email_finding', {
      status: 'started',
      total:  uniqueCompanies.length,
    });

    for (const company of uniqueCompanies) {
      try {
        const contacts = await findHRContacts(company, plan);
        if (contacts?.emails?.length > 0) {
          emailMap[company] = {
            email:        contacts.emails[0].email,
            name:         contacts.emails[0].name,
            confidence:   contacts.emails[0].confidence,
            source:       contacts.source,
            careerPageUrl: contacts.careerPageUrl,
          };
        }
      } catch (err) {
        logger.warn(`Auto email find failed for ${company}: ${err.message}`);
      }
    }

    emitToUser(req.user._id, 'search:email_finding', {
      status: 'done',
      found:  Object.keys(emailMap).length,
    });

    // ── Save jobs to DB ───────────────────────────────────────────
    if (result.jobs.length > 0) {
      const jobDocs = result.jobs.map(j => {
        const hr = emailMap[j.company] || null;
        return {
          userId:              req.user._id,
          searchId:            jobSearch._id,
          externalId:          j.externalId,
          title:               j.title,
          company:             j.company,
          location:            j.location,
          description:         j.description,
          url:                 j.url,
          salary:              j.salary,
          source:              j.source,
          remote:              j.remote,
          matchScore:          j.matchScore,
          postedAt:            j.postedAt,
          status:              'found',
          recruiterEmail:      hr?.email         || null,
          recruiterName:       hr?.name          || null,
          recruiterConfidence: hr?.confidence    || null,
          recruiterSource:     hr?.source        || null,
          careerPageUrl:       hr?.careerPageUrl || null,
        };
      });

      await Job.insertMany(jobDocs, { ordered: false }).catch(err =>
        logger.warn('Some jobs failed to insert (likely duplicates):', err.message)
      );
    }

    // ── Update search record ──────────────────────────────────────
    await JobSearch.findByIdAndUpdate(jobSearch._id, {
      status:            'completed',
      totalFound:        result.totalFound,
      platformBreakdown: result.platformBreakdown,
      durationMs,
    });

    emitToUser(req.user._id, 'search:complete', {
      searchId:    jobSearch._id,
      totalFound:  result.totalFound,
      emailsFound: Object.keys(emailMap).length,
      fromCache:   false,
    });

    logger.info(
      `Search complete: ${req.user.email} — ${result.totalFound} jobs, ` +
      `${Object.keys(emailMap).length} HR emails in ${durationMs}ms`
    );

    return success(res, {
      searchId:          jobSearch._id,
      jobs:              result.jobs,
      totalFound:        result.totalFound,
      platformBreakdown: result.platformBreakdown,
      emailsFound:       Object.keys(emailMap).length,
      fromCache:         false,
      durationMs,
      creditsUsed:       req.creditsDeducted  || 10,
      creditsRemaining:  req.creditsRemaining,
    }, 'Search complete');

  } catch (err) {
    next(err);
  }
};

// ── Get search history ────────────────────────────────────────────
exports.getHistory = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [searches, total] = await Promise.all([
      JobSearch.find({ userId: req.user._id })
        .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      JobSearch.countDocuments({ userId: req.user._id }),
    ]);

    return paginated(res, searches, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get search by ID ──────────────────────────────────────────────
exports.getSearchById = async (req, res, next) => {
  try {
    const search = await JobSearch.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!search) throw new NotFoundError('Search not found');
    return success(res, search);
  } catch (err) {
    next(err);
  }
};

// ── Get jobs for a search ─────────────────────────────────────────
exports.getSearchJobs = async (req, res, next) => {
  try {
    const jobs = await Job.find({
      searchId: req.params.id,
      userId:   req.user._id,
    }).sort({ matchScore: -1 }).lean();
    return success(res, jobs);
  } catch (err) {
    next(err);
  }
};

// ── Profile-based smart search ────────────────────────────────────
exports.profileSearch = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id);
    const p    = user?.profile || {};

    const role     = p.targetRole || p.currentRole || '';
    const location = p.preferredLocations?.[0] || p.city || 'India';
    const workType = p.workType || 'any';
    const skills   = p.skills   || [];

    if (!role) {
      return res.status(400).json({
        success: false,
        message: 'Add your Target Role in Profile → Career to use Smart Search',
      });
    }

    return success(res, {
      role,
      location,
      workType,
      skills,
      experience:   p.experience  || 0,
      expectedCTC:  p.expectedCTC || '',
      resumeSkills: user.resume?.extractedSkills || [],
    }, 'Profile loaded for smart search');
  } catch (err) {
    next(err);
  }
};

// ── Resume-based smart search suggestions (no credits charged) ───
// Reads resume + profile to generate multiple targeted search queries.
// User then picks one and runs it (that run charges credits normally).
exports.resumeSuggest = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id).lean();
    const p    = user?.profile || {};
    const r    = user?.resume  || {};

    // Merge profile skills + resume extracted skills (deduplicated)
    const profileSkills = (p.skills || []).map(s => s.trim()).filter(Boolean);
    const resumeSkills  = (r.extractedSkills || []).map(s => s.trim()).filter(Boolean);
    const allSkills     = [...new Set([...profileSkills, ...resumeSkills])];

    const targetRole = p.targetRole || p.currentRole || '';
    const location   = p.preferredLocations?.[0] || p.city || 'India';
    const workType   = p.workType || 'any';
    const experience = p.experience || 0;

    // ── Build tech-stack clusters from skills ──────────────────────
    const TECH_CLUSTERS = {
      'Full Stack':     ['react', 'node', 'nodejs', 'next', 'express', 'mongodb', 'postgresql', 'vue', 'angular'],
      'Frontend':       ['react', 'vue', 'angular', 'nextjs', 'typescript', 'css', 'html', 'tailwind'],
      'Backend':        ['node', 'nodejs', 'express', 'python', 'java', 'spring', 'django', 'fastapi', 'go', 'golang', 'rust'],
      'Data Science':   ['python', 'pandas', 'numpy', 'tensorflow', 'pytorch', 'sklearn', 'machine learning', 'ml', 'ai'],
      'DevOps':         ['docker', 'kubernetes', 'aws', 'gcp', 'azure', 'ci/cd', 'jenkins', 'terraform', 'ansible'],
      'Mobile':         ['react native', 'flutter', 'android', 'ios', 'swift', 'kotlin'],
      'Java':           ['java', 'spring', 'springboot', 'spring boot', 'hibernate', 'maven'],
      'Python':         ['python', 'django', 'fastapi', 'flask'],
      'Cloud':          ['aws', 'gcp', 'azure', 'cloud', 'serverless', 'lambda'],
    };

    const lowerSkills = allSkills.map(s => s.toLowerCase());
    const detectedStacks = Object.entries(TECH_CLUSTERS)
      .filter(([, keywords]) => keywords.some(kw => lowerSkills.some(s => s.includes(kw))))
      .map(([stack]) => stack)
      .slice(0, 3);

    // ── Generate search queries ────────────────────────────────────
    const queries = [];

    // 1. Exact target role from profile
    if (targetRole) {
      queries.push({
        label:       `${targetRole}`,
        description: 'Your target role from profile',
        role:        targetRole,
        location,
        workType,
        priority:    'high',
      });
    }

    // 2. Stack-based queries
    for (const stack of detectedStacks) {
      const roleLabel = experience >= 5
        ? `Senior ${stack} Developer`
        : experience >= 2
          ? `${stack} Developer`
          : `Junior ${stack} Developer`;

      if (roleLabel !== targetRole) {
        queries.push({
          label:       roleLabel,
          description: `Based on your ${stack} skills`,
          role:        roleLabel,
          location,
          workType,
          priority:    'medium',
        });
      }
    }

    // 3. Remote variant of top query
    if (workType !== 'remote' && queries.length > 0) {
      queries.push({
        label:       `${queries[0].role} (Remote)`,
        description: 'Same role, remote only',
        role:        queries[0].role,
        location:    '',
        workType:    'remote',
        priority:    'low',
      });
    }

    // 4. Skill-keyword search as fallback
    if (allSkills.length > 0 && queries.length < 3) {
      const topSkills = allSkills.slice(0, 3).join(' ');
      queries.push({
        label:       `${topSkills} roles`,
        description: 'Based on your top skills',
        role:        topSkills,
        location,
        workType,
        priority:    'low',
      });
    }

    return success(res, {
      suggestions:   queries.slice(0, 5),
      detectedStacks,
      topSkills:     allSkills.slice(0, 10),
      profile: {
        targetRole,
        location,
        workType,
        experience,
        skillCount: allSkills.length,
      },
    }, 'Search suggestions generated from your resume');
  } catch (err) {
    next(err);
  }
};

// ── Check if a cached search exists (no credits charged) ─────────
exports.checkCache = async (req, res, next) => {
  try {
    const { role, location, workType } = req.query;
    if (!role) {
      return res.status(400).json({ success: false, message: 'role is required' });
    }

    const searchHash = buildSearchHash(role, location, workType);
    const cacheFrom  = new Date(Date.now() - SEARCH_CACHE_TTL_HOURS * 60 * 60 * 1000);

    const cached = await JobSearch.findOne({
      userId:     req.user._id,
      searchHash,
      status:     'completed',
      createdAt:  { $gte: cacheFrom },
    }).sort({ createdAt: -1 }).lean();

    if (!cached) {
      return success(res, { hasCache: false });
    }

    const jobCount  = await Job.countDocuments({ searchId: cached._id, userId: req.user._id });
    const expiresAt = cached.createdAt.getTime() + SEARCH_CACHE_TTL_DAYS * 86400000;
    const msLeft    = expiresAt - Date.now();
    const daysLeft  = Math.max(0, Math.ceil(msLeft / 86400000));
    const ageMs     = Date.now() - cached.createdAt.getTime();
    const ageDays   = Math.floor(ageMs / 86400000);

    return success(res, {
      hasCache:   true,
      searchId:   cached._id,
      cachedAt:   cached.createdAt,
      totalFound: cached.totalFound,
      jobCount,
      daysLeft,
      ageDays,
      expiresAt:  new Date(expiresAt),
    });
  } catch (err) {
    next(err);
  }
};
