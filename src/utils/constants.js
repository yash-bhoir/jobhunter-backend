module.exports = {
  PLANS:        { FREE: 'free', PRO: 'pro', TEAM: 'team' },

  // Monthly credit allocation per plan (hardcoded fallbacks — DB values take precedence)
  PLAN_CREDITS: { free: 100, pro: 1000, team: 5000 },

  // Credit cost per action (hardcoded fallbacks — DB values via getCreditCosts() take precedence)
  CREDIT_COSTS: {
    JOB_SEARCH:          10,   // Per search run across platforms
    HUNTER_LOOKUP:       15,   // Verified HR email via Hunter.io
    APOLLO_SEARCH:       10,   // Apollo employee search
    AI_EMAIL:             5,   // AI-generated outreach email
    RESUME_PARSE:        20,   // Full resume AI parse + ATS optimise
    RESUME_KEYWORD_OPT:   3,   // Quick keyword optimise for a specific job
    AI_ANALYSIS:          3,   // AI match analysis, company research, gap analysis
    DEEP_EVALUATE:        8,   // Deep job evaluation with A-F scoring
    EMAIL_SEND:           2,   // Send outreach email via SMTP
    EXCEL_EXPORT:         5,   // Export job list to Excel
    INTERVIEW_PREP:       3,   // Interview question generator
    PROXYCURL:           30,   // LinkedIn profile enrichment
  },

  // Maps credit action key → UserCredits.breakdown field for usage tracking
  CREDIT_BREAKDOWN_MAP: {
    JOB_SEARCH:         'searches',
    HUNTER_LOOKUP:      'emailLookups',
    APOLLO_SEARCH:      'emailLookups',
    PROXYCURL:          'emailLookups',
    AI_EMAIL:           'aiEmails',
    RESUME_PARSE:       'resumeParses',
    RESUME_KEYWORD_OPT: 'resumeParses',
    AI_ANALYSIS:        'resumeParses',
    DEEP_EVALUATE:      'resumeParses',
    INTERVIEW_PREP:     'resumeParses',
    EMAIL_SEND:         'emailsSent',
    EXCEL_EXPORT:       'exports',
  },

  // Per-plan feature limits (hardcoded fallbacks — DB values take precedence)
  PLAN_LIMITS: {
    free: {
      searchesPerDay:      2,
      jobsPerSearch:       10,
      emailsPerMonth:      10,
      hrLookupsPerMonth:   0,
      linkedinLookups:     0,
      historyDays:         7,
      graceCredits:        0,
    },
    pro: {
      searchesPerDay:      999,
      jobsPerSearch:       30,
      emailsPerMonth:      999,
      hrLookupsPerMonth:   50,
      linkedinLookups:     0,
      historyDays:         90,
      graceCredits:        50,
    },
    team: {
      searchesPerDay:      999,
      jobsPerSearch:       50,
      emailsPerMonth:      9999,
      hrLookupsPerMonth:   200,
      linkedinLookups:     100,
      historyDays:         365,
      graceCredits:        100,
    },
  },

  // Plan pricing (INR) — DB values take precedence via getAppConfig()
  PLAN_PRICING: {
    pro:  { monthly: 499,  annual: 3999  },
    team: { monthly: 1999, annual: 15999 },
  },

  // Credit top-up packs (one-time, never expire)
  TOPUP_PACKS: [
    { name: 'Starter',    credits: 50,   price: 99   },
    { name: 'Power',      credits: 200,  price: 299  },
    { name: 'Mega',       credits: 600,  price: 699  },
    { name: 'Enterprise', credits: 2000, price: 1999 },
  ],

  ROLES:      { USER: 'user', ADMIN: 'admin', SUPER_ADMIN: 'super_admin' },
  JOB_STATUS: { FOUND: 'found', SAVED: 'saved', APPLIED: 'applied', INTERVIEW: 'interview', OFFER: 'offer', REJECTED: 'rejected' },
  PLATFORMS:  ['jsearch', 'adzuna', 'remoteok', 'remotive', 'arbeitnow', 'jobicy', 'himalayas', 'themuse', 'careerjet'],
};