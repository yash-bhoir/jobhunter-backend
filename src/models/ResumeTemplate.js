const mongoose = require('mongoose');

const STYLES = ['classic', 'modern', 'minimal', 'tech', 'executive', 'clean', 'bold', 'sidebar', 'compact'];

const resumeTemplateSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  description:  { type: String, default: '' },
  // PDFKit style — drives how the optimized PDF is rendered
  style:        { type: String, enum: STYLES, default: 'classic' },
  accentColor:  { type: String, default: '' },   // hex override e.g. "#4f46e5"
  preview:      { type: String, default: '' },   // URL to a preview image shown to users
  isActive:     { type: Boolean, default: true },
  // Legacy: raw LaTeX kept for .tex download only — not used for PDF compilation
  templateCode: { type: String, default: '' },
}, { timestamps: true });

resumeTemplateSchema.index({ isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('ResumeTemplate', resumeTemplateSchema);
