const mongoose = require('mongoose');

/**
 * Ranking / UX signals for future LTR models and analytics.
 * - impression: server-logged when search results are shown
 * - click, save, hide, apply: client or server follow-ups
 */
const jobRankingEventSchema = new mongoose.Schema({
  userId:   { type: mongoose.Types.ObjectId, ref: 'User', required: true, index: true },
  searchId: { type: mongoose.Types.ObjectId, ref: 'JobSearch', default: null, index: true },
  /** Same as JobSearch.searchHash when known */
  clusterHash: { type: String, default: null, index: true },
  jobId:       { type: mongoose.Types.ObjectId, ref: 'Job', default: null, index: true },
  /** In-app LinkedIn / email-ingested listing (when jobId is null). */
  linkedinJobId: { type: mongoose.Types.ObjectId, ref: 'LinkedInJob', default: null, index: true },
  contentFingerprint: { type: String, default: null, index: true },

  eventType: {
    type: String,
    enum: [
      'impression',
      'click',
      'save',
      'unsave',
      'hide',
      'apply',
      'open_detail',
      'email_click',
    ],
    required: true,
    index: true,
  },

  /** 0-based rank in the result set (impressions only) */
  position:   { type: Number, default: null },
  matchScore: { type: Number, default: null },
  jobSource:  { type: String, default: '' },

  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

jobRankingEventSchema.index({ userId: 1, createdAt: -1 });
jobRankingEventSchema.index({ jobId: 1, eventType: 1, createdAt: -1 });

module.exports = mongoose.model('JobRankingEvent', jobRankingEventSchema);
