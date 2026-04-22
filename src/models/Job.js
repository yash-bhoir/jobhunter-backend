const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  userId:     { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  searchId:   { type: mongoose.Types.ObjectId, ref: 'JobSearch' },
  externalId: String,
  title:      { type: String, required: true },
  // FIX: was required:true — caused silent insertMany failures when search APIs
  // return jobs with an empty company field. Changed to default:'' for safe insertion.
  company:    { type: String, default: '' },
  location:   String,
  description: String,
  url:        String,
  salary:     String,
  salaryMin:  Number,
  salaryMax:  Number,
  source:     String,
  remote:     { type: Boolean, default: false },
  matchScore: { type: Number, default: 0, min: 0, max: 100 },
  /** Stable hash for dedupe + “next page” of same search across sessions */
  contentFingerprint: { type: String, default: null, index: true },
  status:     {
    type:    String,
    enum:    ['found', 'saved', 'applied', 'interview', 'offer', 'rejected'],
    default: 'found',
  },
  statusUpdatedAt: Date,
  notes:           String,
  appliedAt:       Date,
  recruiterName:        String,
  recruiterEmail:       String,
  recruiterConfidence:  Number,
  recruiterSource:      String,
  recruiterLinkedIn:    String,
  recruiterEmailStatus: { type: String, enum: ['verified', 'predicted', 'invalid', 'unknown'], default: 'unknown' },

  // All HR contacts (multi-email support)
  allRecruiterContacts: [{
    email:      String,
    name:       String,
    title:      String,
    confidence: Number,
    source:     String,
    status:     { type: String, enum: ['verified', 'predicted', 'invalid', 'unknown'], default: 'unknown' },
    linkedin:   String,
  }],

  // Employees found via Apollo
  employees: [{
    name:     String,
    title:    String,
    email:    String,
    linkedin: String,
    source:   { type: String, default: 'apollo' },
    foundAt:  { type: Date, default: Date.now },
  }],

  careerPageUrl:  String,
  linkedinUrl:    String,
  employeeSearch: String,

  // ── Global store refs (populated after ingest) ────────────────
  companyId:   { type: mongoose.Types.ObjectId, ref: 'Company',   default: null },
  globalJobId: { type: mongoose.Types.ObjectId, ref: 'GlobalJob', default: null },

  // Geo data for radius-based search
  geoLocation: { lat: Number, lng: Number },
  distanceKm:  { type: Number, default: null },

  postedAt: Date,
  expired:   { type: Boolean, default: false },
  expiredAt: Date,

  // ── Liveness detection (career-ops inspired) ──────────────────────
  liveness:          { type: String, enum: ['active', 'expired', 'uncertain'], default: null },
  livenessCheckedAt: Date,

  // ── Follow-up reminder system ─────────────────────────────────────
  followUpDate:  Date,    // next follow-up due date
  followUpCount: { type: Number, default: 0 }, // how many follow-ups sent
  followUpNotes: String,

  // ── Deep evaluation report (A-F scoring) ─────────────────────────
  deepEval: {
    score:         Number,   // 0–5
    archetype:     String,   // FDE / SA / PM / LLMOps / Agentic / Transformation
    summary:       String,
    cvGaps:        [String],
    topCvChanges:  [String],
    salaryRange:   String,
    interviewQs:   [String],
    generatedAt:   Date,
  },

  // ── Interview prep / story bank ───────────────────────────────────
  interviewPrep: {
    questions:   [{ question: String, starHint: String }],
    generatedAt: Date,
  },
}, { timestamps: true });

jobSchema.index({ userId: 1, createdAt:   -1 });
jobSchema.index({ userId: 1, status:       1 });
jobSchema.index({ userId: 1, matchScore:  -1 });
// Added for GET /jobs?searchId=xxx (view jobs from a specific past search)
jobSchema.index({ userId: 1, searchId:     1 });
// Added for outreach manager — finding jobs with HR emails by search
jobSchema.index({ searchId: 1, recruiterEmail: 1 });
// Added for recruiter history — jobs with emails
jobSchema.index({ userId: 1, recruiterEmail: 1, createdAt: -1 });
jobSchema.index({ userId: 1, company: 1 });
jobSchema.index({ userId: 1, contentFingerprint: 1 });
// TTL-friendly: mark expired jobs in maintenance
jobSchema.index({ expired: 1, createdAt: 1 });

module.exports = mongoose.model('Job', jobSchema);