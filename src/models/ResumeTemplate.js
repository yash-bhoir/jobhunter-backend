const mongoose = require('mongoose');

const resumeTemplateSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  templateCode: { type: String, required: true },
  isActive:     { type: Boolean, default: true },
  description:  { type: String, default: '' },
}, { timestamps: true });

resumeTemplateSchema.index({ isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('ResumeTemplate', resumeTemplateSchema);
