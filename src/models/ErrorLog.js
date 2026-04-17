const mongoose = require('mongoose');

const errorLogSchema = new mongoose.Schema({
  // Who
  userId:    { type: mongoose.Types.ObjectId, ref: 'User', default: null },
  userEmail: { type: String, default: null },

  // What
  type:       { type: String, enum: ['frontend', 'backend'], default: 'backend' },
  severity:   { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  message:    { type: String, required: true },
  code:       { type: String, default: null },  // e.g. 'VALIDATION_ERROR', 'SERVER_ERROR'
  stack:      { type: String, default: null },

  // Where
  endpoint:   { type: String, default: null },  // e.g. '/api/v1/search/run'
  method:     { type: String, default: null },   // GET, POST, etc.
  statusCode: { type: Number, default: null },

  // Context
  ip:        { type: String, default: null },
  userAgent: { type: String, default: null },
  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },

  // Resolution
  resolved:   { type: Boolean, default: false },
  resolvedAt: { type: Date,    default: null },
  resolvedBy: { type: String,  default: null },
  notes:      { type: String,  default: null },

  createdAt: { type: Date, default: Date.now, expires: 7776000 }, // 90-day TTL
}, { timestamps: false });

errorLogSchema.index({ createdAt: -1 });
errorLogSchema.index({ userId: 1, createdAt: -1 });
errorLogSchema.index({ severity: 1, resolved: 1 });
errorLogSchema.index({ statusCode: 1 });

module.exports = mongoose.model('ErrorLog', errorLogSchema);
