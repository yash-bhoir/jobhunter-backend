const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
  adminId:     { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  action:      { type: String, required: true },
  targetType:  String,
  targetId:    mongoose.Types.ObjectId,
  targetEmail: String,
  before:      mongoose.Schema.Types.Mixed,
  after:       mongoose.Schema.Types.Mixed,
  ip:          String,
  userAgent:   String,
  reason:      String,
}, { timestamps: true });

adminAuditLogSchema.index({ adminId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1 });
adminAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);