const crypto             = require('crypto');
const JobSearch          = require('../models/JobSearch');
const Job                = require('../models/Job');
const UserCredits        = require('../models/UserCredits');
const { runJobSearch }   = require('../services/jobSearch');
const {
  getSeenFingerprints,
  filterUnseen,
  mmrSelect,
}                        = require('../services/jobSearch/searchSession.service');
const { computeContentFingerprint } = require('../services/jobSearch/jobFingerprint.util');
const {
  upsertClusterFromFetch,
  materializeClusterForUser,
  findBestClusterForReuse,
} = require('../services/jobSearch/searchCluster.service');
const { findHRContacts } = require('../services/emailFinder');
const { linkRecruitersToJobs } = require('../services/dataLinker.service');
const {
  linkLookupToGlobalStore,
  linkEmployeesToGlobalStore,
  isRecruiterDataFresh,
  getGlobalRecruitersForCompany,
} = require('../services/dataLinker.service');
const {
  findOrCreateCompany,
  ingestJob,
}                        = require('../services/companyStore.service');
const { recordSearchImpressions } = require('../services/ranking/rankingFeedback.service');
const { scheduleGeoEnrichment }   = require('../services/geo/jobGeoEnrichment.service');
const { emitToUser }     = require('../config/socket');
const { success, paginated } = require('../utils/response.util');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../config/logger');

// ── Cache TTL: 30 days. After this, same search re-calls APIs ────
const SEARCH_CACHE_TTL_DAYS  = 30;
const SEARCH_CACHE_TTL_HOURS = SEARCH_CACHE_TTL_DAYS * 24;

/** Quality-first caps: small surface to user, larger ranked pool in DB for “show all”. */
const DISPLAY_CAP = { free: 10, pro: 15, team: 15 };
const PERSIST_CAP = { free: 80, pro: 150, team: 200 };
const RANKING_MODEL_VERSION = 'rank-v2-2026-04';

// ── Build a stable hash for a search query ────────────────────────
function buildSearchHash(role, location, workType) {
  const str = [
    (role     || '').toLowerCase().trim(),
    (location || '').toLowerCase().trim(),
    (workType || '').toLowerCase().trim(),
  ].join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

/** Client IP for third-party APIs that require it (e.g. CareerJet v4). */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  const raw = req.ip || req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '') || '127.0.0.1';
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
          platformBreakdown: cached.platformBreakdown instanceof Map
            ? Object.fromEntries(cached.platformBreakdown)
            : (cached.platformBreakdown || {}),
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

    // ── Shared cluster reuse (cross-user) — exact hash or sibling role-family snapshot ──
    let clusterReuse = false;
    let clusterReuseMatch = '';
    let result;
    if (!force) {
      try {
        const hit = await findBestClusterForReuse({
          clusterHash: searchHash,
          role,
          location,
          workType,
        });
        if (hit.cluster) {
          const mat = materializeClusterForUser(hit.cluster, req.user, { role, location, workType });
          if (mat?.rankedAll?.length) {
            clusterReuse = true;
            clusterReuseMatch = hit.reuseMatch || '';
            result = { ...mat, fromCluster: true };
            const refundAmt = req.creditsDeducted || 0;
            if (refundAmt) {
              await UserCredits.findOneAndUpdate(
                { userId: req.user._id },
                { $inc: { usedCredits: -refundAmt } },
              ).catch((e) => logger.warn(`Cluster reuse credit refund failed: ${e.message}`));
              req.creditsDeducted = 0;
              if (req.creditsRemaining !== undefined) {
                req.creditsRemaining += refundAmt;
              }
            }
            emitToUser(req.user._id, 'search:progress', {
              searchId: jobSearch._id,
              platform: 'cluster',
              found:    mat.rankedAll.length,
              status:   hit.reuseMatch === 'sibling' ? 'reused_sibling_snapshot' : 'reused_snapshot',
            });
          }
        }
      } catch (err) {
        logger.warn(`[search] cluster reuse skipped: ${err.message}`);
      }
    }

    // Run job search (external APIs) — skipped when cluster snapshot hit
    if (!result) {
      try {
        result = await runJobSearch(
          {
            role,
            location,
            workType,
            platforms,
            clientIp:         getClientIp(req),
            clientUserAgent:  req.get('user-agent') || 'JobHunter/1.0',
          },
          req.user, plan, onProgress
        );
        if (result.rankedAll?.length) {
          await upsertClusterFromFetch(searchHash, result, { role, location, workType }).catch((e) =>
            logger.warn(`[search] SearchCluster upsert failed: ${e.message}`)
          );
        }
      } catch (searchErr) {
        await JobSearch.findByIdAndUpdate(jobSearch._id, {
          status: 'failed',
          error:  searchErr.message,
        });
        throw searchErr;
      }
    }

    const ranked = result.rankedAll || result.jobs || [];
    const seenFp = await getSeenFingerprints(req.user._id, searchHash);
    const unseen   = filterUnseen(ranked, seenFp);
    const pool     = unseen.length ? unseen : ranked;

    const displayCap = DISPLAY_CAP[plan] || 12;
    const persistCap = PERSIST_CAP[plan] || 100;

    const poolSorted = [...pool].sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    const persistJobs = poolSorted.slice(0, persistCap);

    const mmrInput = poolSorted.slice(0, Math.min(80, poolSorted.length));
    const displayJobs = mmrSelect(
      mmrInput,
      Math.min(displayCap, Math.max(1, mmrInput.length)),
    );

    const exhaustedNewMatches = ranked.length > 0 && unseen.length === 0;

    // Refund if search returned 0 jobs — APIs were reachable but no results
    if (!persistJobs.length && req.creditsDeducted) {
      await UserCredits.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { usedCredits: -req.creditsDeducted } }
      ).catch(e => logger.warn(`Zero-result credit refund failed: ${e.message}`));
      req.creditsDeducted = 0;
    }

    const durationMs = Date.now() - startTime;

    const uniqueCompanyNames = [...new Set(persistJobs.map(j => j.company).filter(Boolean))];

    // ── Step 1 & 2: Global store ingest — fully non-blocking ─────
    // Runs in background after response is sent — never delays the user.
    const companyIdMap   = {};
    const globalJobIdMap = {};

    setImmediate(async () => {
      try {
        await Promise.all(
          uniqueCompanyNames.map(async (name) => {
            const company = await findOrCreateCompany(name, {
              source: persistJobs.find(j => j.company === name)?.source,
            });
            if (!company) return;
            companyIdMap[name] = company._id;
            // Ingest jobs for this company
            const companyJobs = persistJobs.filter(j => j.company === name);
            await Promise.all(companyJobs.map(async (j) => {
              const { globalJob } = await ingestJob(j, company._id);
              if (globalJob) {
                const key = j.url || j.externalId || `${j.company}|${j.title}`;
                globalJobIdMap[key] = globalJob._id;
              }
            }));
          })
        );
      } catch (err) {
        logger.warn(`[globalStore] background ingest error: ${err.message}`);
      }
    });

    // ── Step 3: Auto find HR emails ───────────────────────────────
    // Cap at 5 companies max — prevents 30-second Hunter loops
    const HR_LOOKUP_LIMIT  = plan === 'free' ? 2 : 5;
    const uniqueCompanies  = uniqueCompanyNames.slice(0, HR_LOOKUP_LIMIT);
    const emailMap         = {};

    emitToUser(req.user._id, 'search:email_finding', {
      status: 'started',
      total:  uniqueCompanies.length,
    });

    for (const company of uniqueCompanies) {
      try {
        // ── API cost gate: reuse global store if data is fresh ────
        const fresh = await isRecruiterDataFresh(company);
        if (fresh) {
          const cached = await getGlobalRecruitersForCompany(company);
          if (cached.length > 0) {
            const top = cached[0];
            emailMap[company] = {
              email:    top.email,
              name:     top.name,
              confidence: top.confidence,
              status:   top.status,
              source:   top.source,
              contacts: cached.map(r => ({
                email: r.email, name: r.name, title: r.title,
                confidence: r.confidence, status: r.status, linkedin: r.linkedin,
              })),
            };
            logger.info(`[search] reused ${cached.length} cached recruiters for "${company}" (saved API call)`);
            continue;
          }
        }

        // ── Fresh API call ────────────────────────────────────────
        const contacts = await findHRContacts(company, plan);
        if (contacts?.emails?.length > 0) {
          const top = contacts.emails[0];
          emailMap[company] = {
            email:          top.email,
            name:           top.name,
            confidence:     top.confidence,
            status:         top.status || 'unknown',
            source:         contacts.source,
            contacts:       contacts.emails,
            careerPageUrl:  contacts.careerPageUrl,
            linkedinUrl:    contacts.linkedinUrl,
            employeeSearch: contacts.employeeSearch,
          };

          // ── Ingest into global store (saves future API calls) ──
          const cid = companyIdMap[company];
          if (cid) {
            linkLookupToGlobalStore(req.user._id, company, {
              ...contacts,
              allEmails: contacts.emails,
            }, contacts.source).catch(() => {});
          }

          // ── Ingest employees into GlobalEmployee ──────────────
          if (contacts.employees?.length) {
            linkEmployeesToGlobalStore(company, contacts.employees, contacts.source)
              .catch(() => {});
          }
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
    let savedJobIds = [];
    if (persistJobs.length > 0) {
      const jobDocs = persistJobs.map(j => {
        const hr         = emailMap[j.company] || null;
        const topContact = hr?.contacts?.[0]   || null;
        const globalKey  = j.url || j.externalId || `${j.company}|${j.title}`;
        return {
          userId:               req.user._id,
          searchId:             jobSearch._id,
          externalId:           j.externalId,
          title:                j.title,
          company:              j.company,
          location:             j.location,
          description:          j.description,
          url:                  j.url,
          salary:               j.salary,
          source:               j.source,
          remote:               j.remote,
          matchScore:           j.matchScore,
          postedAt:             j.postedAt,
          status:               'found',
          contentFingerprint:   j.contentFingerprint || computeContentFingerprint(j),
          // ── Global store refs ─────────────────────────────────
          companyId:            companyIdMap[j.company]  || null,
          globalJobId:          globalJobIdMap[globalKey] || null,
          // ── HR contact data ───────────────────────────────────
          // Pattern emails are guesses — never save them on job records
          recruiterEmail:       hr?.source !== 'pattern' ? (topContact?.email      || hr?.email)      : null,
          recruiterName:        hr?.source !== 'pattern' ? (topContact?.name       || hr?.name)       : null,
          recruiterConfidence:  hr?.source !== 'pattern' ? (topContact?.confidence || hr?.confidence) : null,
          recruiterSource:      hr?.source !== 'pattern' ? hr?.source              : null,
          recruiterEmailStatus: hr?.source !== 'pattern' ? (topContact?.status     || hr?.status || 'unknown') : 'unknown',
          allRecruiterContacts: hr?.source !== 'pattern' ? (hr?.contacts || [])   : [],
          careerPageUrl:        hr?.careerPageUrl       || null,
          linkedinUrl:          hr?.linkedinUrl         || null,
          employeeSearch:       hr?.employeeSearch      || null,
        };
      });

      const inserted = await Job.insertMany(jobDocs, { ordered: false, rawResult: true }).catch(err => {
        logger.warn('Some jobs failed to insert (likely duplicates):', err.message);
        return null;
      });

      // Collect inserted IDs for data linking
      savedJobIds = inserted?.insertedIds ? Object.values(inserted.insertedIds) : [];
    }

    if (displayJobs.length) {
      await recordSearchImpressions({
        userId:      req.user._id,
        searchId:    jobSearch._id,
        clusterHash: searchHash,
        displayJobs,
      }).catch((e) => logger.warn(`[search] impressions: ${e.message}`));
    }

    // ── Auto-link existing recruiter lookups to newly saved jobs ──
    // Runs async — doesn't block the response
    if (savedJobIds.length > 0) {
      linkRecruitersToJobs(req.user._id, savedJobIds).catch(err =>
        logger.warn('dataLinker async failed:', err.message)
      );
      scheduleGeoEnrichment(savedJobIds);
    }

    // ── Update search record ──────────────────────────────────────
    await JobSearch.findByIdAndUpdate(jobSearch._id, {
      status:            'completed',
      totalFound:        result.totalFound,
      storedJobCount:    persistJobs.length,
      rankingModel:      RANKING_MODEL_VERSION,
      platformBreakdown: result.platformBreakdown,
      durationMs,
      fromClusterReuse:  clusterReuse,
      clusterReuseMatch: clusterReuse ? clusterReuseMatch : '',
    });

    emitToUser(req.user._id, 'search:complete', {
      searchId:    jobSearch._id,
      totalFound:  result.totalFound,
      emailsFound: Object.keys(emailMap).length,
      fromCache:   false,
    });

    logger.info(
      `Search complete: ${req.user.email} — ${result.totalFound} ranked, ${persistJobs.length} stored, ` +
      `${displayJobs.length} shown, ${Object.keys(emailMap).length} HR emails in ${durationMs}ms`
    );

    return success(res, {
      searchId:          jobSearch._id,
      jobs:              displayJobs,
      totalFound:        result.totalFound,
      storedJobCount:    persistJobs.length,
      displayedCount:    displayJobs.length,
      exhaustedNewMatches,
      rankingModel:      RANKING_MODEL_VERSION,
      platformBreakdown: result.platformBreakdown,
      emailsFound:       Object.keys(emailMap).length,
      fromCache:         false,
      fromCluster:       clusterReuse,
      clusterReuseMatch: clusterReuse ? clusterReuseMatch : '',
      durationMs,
      creditsUsed:       typeof req.creditsDeducted === 'number' ? req.creditsDeducted : 0,
      creditsRemaining:  req.creditsRemaining,
    }, clusterReuse ? 'Search complete (reused shared job pool)' : 'Search complete');

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
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip  = (page - 1) * limit;

    const filter = { searchId: req.params.id, userId: req.user._id };
    const status = req.query.status || null;
    const source = req.query.source || null;
    const remote = req.query.remote;
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (remote === 'true' || remote === 'false') filter.remote = remote === 'true';

    const sortKey = String(req.query.sort || 'matchScore').trim();
    const sortObj = sortKey === 'date'
      ? { createdAt: -1 }
      : { matchScore: -1 };

    const [jobs, total, platformAgg] = await Promise.all([
      Job.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      Job.countDocuments(filter),
      page === 1
        ? Job.aggregate([
            { $match: filter },
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]).catch(() => null)
        : Promise.resolve(null),
    ]);

    const platformBreakdown = platformAgg
      ? Object.fromEntries(platformAgg.map((p) => [p._id || 'Unknown', p.count]))
      : undefined;

    return paginated(res, jobs, {
      total,
      page,
      limit,
      pages:   Math.ceil(total / limit) || 1,
      hasNext: page * limit < total,
      hasPrev: page > 1,
      ...(platformBreakdown ? { platformBreakdown } : {}),
    });
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
