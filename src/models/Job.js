const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  userId:     { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  searchId:   { type: mongoose.Types.ObjectId, ref: 'JobSearch' },
  externalId: String,
  title:      { type: String, required: true },
  company:    { type: String, required: true },
  location:   String,
  description: String,
  url:        String,
  salary:     String,
  salaryMin:  Number,
  salaryMax:  Number,
  source:     String,
  remote:     { type: Boolean, default: false },
  matchScore: { type: Number, default: 0, min: 0, max: 100 },
  status:     {
    type:    String,
    enum:    ['found', 'saved', 'applied', 'interview', 'offer', 'rejected'],
    default: 'found',
  },
  statusUpdatedAt: Date,
  notes:           String,
  appliedAt:       Date,
  recruiterName:       String,
  recruiterEmail:      String,
  recruiterConfidence: Number,
  recruiterSource:     String,
  recruiterLinkedIn:   String,
  careerPageUrl:       String,
  postedAt: Date,
  expired:   { type: Boolean, default: false },
  expiredAt: Date,
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
// TTL-friendly: mark expired jobs in maintenance
jobSchema.index({ expired: 1, createdAt: 1 });

module.exports = mongoose.model('Job', jobSchema);