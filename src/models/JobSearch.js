const mongoose = require('mongoose');

const jobSearchSchema = new mongoose.Schema({
  userId: { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  query: {
    role:      String,
    location:  String,
    workType:  String,
    salaryMin: Number,
    keywords:  [String],
    platforms: [String],
  },
  status:            { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  totalFound:        { type: Number, default: 0 },
  platformBreakdown: { type: Map, of: Number },
  durationMs:        Number,
  error:             String,
  searchHash:        { type: String, index: true }, // for dedup/cache lookups
}, { timestamps: true });

jobSearchSchema.index({ userId: 1, createdAt: -1 });
jobSearchSchema.index({ userId: 1, searchHash: 1, createdAt: -1 }); // cache lookup

module.exports = mongoose.model('JobSearch', jobSearchSchema);
