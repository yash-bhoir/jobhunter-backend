const mongoose = require('mongoose');

const outreachEmailSchema = new mongoose.Schema({
  userId:        { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  jobId:         { type: mongoose.Types.ObjectId, ref: 'Job' },
  to:            { type: String, default: '' },
  subject:       String,
  body:          String,
  company:       String,
  recruiterName: String,
  status:        { type: String, enum: ['pending', 'sent', 'bounced', 'replied'], default: 'pending' },
  sentAt:        Date,
  bouncedAt:     Date,
  repliedAt:     Date,
  senderEmail:   String,
  aiGenerated:    { type: Boolean, default: false },
  tokensUsed:     Number,
  resumeAttached:  { type: Boolean, default: false },
  latexTemplate:   { type: String, default: null },   // LaTeX source saved at send time
  resumeSnapshot:  { type: String, default: null },   // base64 PDF snapshot at send time
}, { timestamps: true });

outreachEmailSchema.index({ userId: 1, createdAt: -1 });
outreachEmailSchema.index({ userId: 1, status:    1 });
outreachEmailSchema.index({ userId: 1, company:   1 });

module.exports = mongoose.model('OutreachEmail', outreachEmailSchema);