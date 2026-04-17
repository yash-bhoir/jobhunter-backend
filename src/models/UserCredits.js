const mongoose = require('mongoose');

const userCreditsSchema = new mongoose.Schema({
  userId:       { type: mongoose.Types.ObjectId, ref: 'User', required: true, unique: true },
  plan:         { type: String, enum: ['free', 'pro', 'team'], default: 'free' },
  totalCredits: { type: Number, default: 100 },
  usedCredits:  { type: Number, default: 0, min: 0 },
  topupCredits: { type: Number, default: 0, min: 0 },
  breakdown: {
    searches:     { type: Number, default: 0 },
    emailLookups: { type: Number, default: 0 },
    aiEmails:     { type: Number, default: 0 },
    emailsSent:   { type: Number, default: 0 },
    resumeParses: { type: Number, default: 0 },
    exports:      { type: Number, default: 0 },
  },
  resetDate:    Date,
  lastResetAt:  Date,
  graceGiven:   { type: Boolean, default: false },
  graceGivenAt: Date,
}, { timestamps: true });

userCreditsSchema.virtual('remaining').get(function () {
  return Math.max(0, this.totalCredits + this.topupCredits - this.usedCredits);
});

userCreditsSchema.virtual('usagePct').get(function () {
  const total = this.totalCredits + this.topupCredits;
  return total > 0 ? Math.round((this.usedCredits / total) * 100) : 0;
});

module.exports = mongoose.model('UserCredits', userCreditsSchema);