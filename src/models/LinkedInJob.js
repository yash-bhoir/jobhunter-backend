'use strict';

const mongoose = require('mongoose');

// ── Valid source values ───────────────────────────────────────────
// All email-parsed jobs use the email_* prefix.
// linkedin_alert / linkedin_fetch are for direct LinkedIn pulls.
const SOURCE_ENUM = [
  'email_linkedin',
  'email_naukri',
  'email_indeed',
  'email_foundit',
  'email_internshala',
  'email_timesjobs',
  'email_shine',
  'email_instahyre',
  'email_hirist',
  'email_cutshort',
  'email_wellfound',
  'email_glassdoor',
  'email_iimjobs',
  'email_monster',
  'email_freshersworld',
  'email_other',
  'linkedin_alert',   // legacy — RSS / scraped alert
  'linkedin_fetch',   // manual "Fetch from LinkedIn" button
  'career_page',      // daily ATS scan (Greenhouse / Ashby / Lever) matched to profile
  'dream_company',    // user-watched board — any new listing on that board
];

const linkedInJobSchema = new mongoose.Schema({
  userId:      { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true },

  // FIX: was required:true — email parser often returns empty company,
  // which caused all insertMany docs to fail silently.
  company:     { type: String, default: '' },

  location:    String,
  description: String,
  url:         String,
  salary:      String,
  remote:      { type: Boolean, default: false },
  postedAt:    Date,

  // FIX: was free-form String — enum prevents source value drift.
  source: {
    type:    String,
    enum:    SOURCE_ENUM,
    default: 'linkedin_alert',
  },

  matchScore: { type: Number, default: 0, min: 0, max: 100 },

  status: {
    type:    String,
    enum:    ['new', 'saved', 'applied', 'ignored'],
    default: 'new',
  },

  // FIX: tracking fields missing from original schema — added for parity with Job.js
  statusUpdatedAt: Date,   // set by pre-save hook whenever status changes
  appliedAt:       Date,   // set automatically when status → 'applied'
  notes:           String, // user's personal notes on this job
  followUpDate:    Date,   // user-set follow-up reminder
  followUpCount:   { type: Number, default: 0 },  // number of follow-ups sent

  // ── HR contact — primary (kept for backwards compat) ─────────────
  recruiterEmail:    String,
  recruiterName:     String,
  recruiterLinkedIn: String,
  careerPageUrl:     String,
  linkedinUrl:       String,
  employeeSearch:    String,

  // FIX: was missing — Job.js has allRecruiterContacts[], LinkedInJob did not.
  // findHR() now stores all Apollo contacts here instead of discarding contacts 2-N.
  allRecruiterContacts: [{
    email:      String,
    name:       String,
    title:      String,
    confidence: Number,
    source:     String,
    linkedin:   String,
    status: {
      type:    String,
      enum:    ['verified', 'predicted', 'invalid', 'unknown'],
      default: 'unknown',
    },
  }],

  // Employees from Apollo
  employees: [{
    name:     String,
    title:    String,
    linkedin: String,
    email:    String,
  }],

  // FIX: was mongoose.Schema.Types.Mixed — typed to match Job.js deepEval schema.
  // Mixed field causes runtime errors when AI code accesses .deepEval.score on a null.
  deepEval: {
    score:        Number,   // 0–5
    archetype:    String,   // FDE / SA / PM / LLMOps / Agentic / etc.
    summary:      String,
    cvGaps:       [String],
    topCvChanges: [String],
    salaryRange:  String,
    interviewQs:  [String],
    generatedAt:  Date,
  },

  interviewPrep: {
    questions:   [{ question: String, starHint: String }],
    generatedAt: Date,
  },

}, { timestamps: true });

// ── Pre-save: auto-set statusUpdatedAt and appliedAt ─────────────
linkedInJobSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    this.statusUpdatedAt = new Date();
    if (this.status === 'applied' && !this.appliedAt) {
      this.appliedAt = new Date();
    }
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────

// Primary list query — userId + date sort
linkedInJobSchema.index({ userId: 1, createdAt: -1 });

// FIX: was missing — Email Jobs page filters by status (new/saved/applied/ignored)
linkedInJobSchema.index({ userId: 1, status: 1 });

// FIX: was missing — Email Jobs page filters by source portal (email_linkedin etc.)
linkedInJobSchema.index({ userId: 1, source: 1 });

// FIX: was missing — sorting by match score on email jobs was a full scan
linkedInJobSchema.index({ userId: 1, matchScore: -1 });

// Company index — HR lookup, updateMany by company name
linkedInJobSchema.index({ userId: 1, company: 1 });

// FIX: deduplication — prevents same URL being inserted twice for same user.
// sparse:true allows multiple docs with no URL (email jobs often have no URL).
// NOTE: if deploying to an existing collection with duplicate URLs, run a
// dedup migration first:
//   db.linkedinjobs.aggregate([{$group:{_id:{userId:"$userId",url:"$url"},
//   count:{$sum:1},ids:{$push:"$_id"}}},{$match:{count:{$gt:1}}}])
//   .forEach(g => g.ids.slice(1).forEach(id => db.linkedinjobs.deleteOne({_id:id})))
linkedInJobSchema.index({ userId: 1, url: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('LinkedInJob', linkedInJobSchema);
