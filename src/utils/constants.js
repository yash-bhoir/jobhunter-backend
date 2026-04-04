module.exports = {
  PLANS:        { FREE: 'free', PRO: 'pro', TEAM: 'team' },
  PLAN_CREDITS: { free: 100, pro: 1000, team: 5000 },

  CREDIT_COSTS: {
    JOB_SEARCH:          10,
    HUNTER_LOOKUP:       15,
    APOLLO_SEARCH:       10,
    AI_EMAIL:             5,
    RESUME_PARSE:        20,
    RESUME_KEYWORD_OPT:   3,   // Pro: keyword-optimize resume for a specific job
    AI_ANALYSIS:          3,   // Pro: AI-powered job/company analysis (explain match, company research, gap analysis)
    EMAIL_SEND:           2,
    EXCEL_EXPORT:         5,
    PROXYCURL:           30,
  },

  // Maps credit action → breakdown field for usage tracking
  CREDIT_BREAKDOWN_MAP: {
    JOB_SEARCH:         'searches',
    HUNTER_LOOKUP:      'emailLookups',
    APOLLO_SEARCH:      'emailLookups',
    AI_EMAIL:           'aiEmails',
    RESUME_PARSE:       'resumeParses',
    RESUME_KEYWORD_OPT: 'resumeParses',
    AI_ANALYSIS:        'resumeParses',
    EMAIL_SEND:         'emailsSent',
    EXCEL_EXPORT:       'exports',
  },

  PLAN_LIMITS: {
    free: { searchesPerDay: 2,   jobsPerSearch: 10, emailsPerMonth: 10,   hrLookupsPerMonth: 0,   historyDays: 7   },
    pro:  { searchesPerDay: 999, jobsPerSearch: 30, emailsPerMonth: 999,  hrLookupsPerMonth: 50,  historyDays: 90  },
    team: { searchesPerDay: 999, jobsPerSearch: 50, emailsPerMonth: 9999, hrLookupsPerMonth: 200, historyDays: 365 },
  },

  ROLES:      { USER: 'user', ADMIN: 'admin', SUPER_ADMIN: 'super_admin' },
  JOB_STATUS: { FOUND: 'found', SAVED: 'saved', APPLIED: 'applied', INTERVIEW: 'interview', OFFER: 'offer', REJECTED: 'rejected' },
  PLATFORMS:  ['jsearch', 'adzuna', 'remoteok', 'remotive', 'arbeitnow', 'jobicy', 'himalayas', 'themuse', 'careerjet'],
};