const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId:        { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  event:         { type: String, required: true },
  category:      { type: String, enum: ['auth', 'search', 'email', 'billing', 'profile', 'admin'], required: true },
  creditsUsed:   { type: Number, default: 0 },
  creditsBefore: Number,
  creditsAfter:  Number,
  metadata:      { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:            String,
  userAgent:     String,
  sessionId:     String,
  createdAt:     { type: Date, default: Date.now, expires: 7776000 }, // 90 days TTL
});

activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ event: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);