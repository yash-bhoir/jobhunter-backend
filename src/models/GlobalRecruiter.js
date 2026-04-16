/**
 * GlobalRecruiter.js — Shared recruiter pool, linked to Company.
 *
 * Design principles:
 *  - One record per unique person at a company (deduped by email OR linkedin)
 *  - Linked to Company (companyId) — shared across ALL users
 *  - confidence + verifiedAt enable ranking (highest confidence shown first)
 *  - seenCount tracks how many times this recruiter was found (boosts trust)
 *  - No userId — this is global data, not user-specific
 *
 * Ranking logic (for search results):
 *  1. status = 'verified'   → highest rank
 *  2. confidence score      → secondary rank
 *  3. seenCount             → tertiary (seen more = more trustworthy)
 *  4. title relevance       → "HR Manager" > "Software Engineer"
 */

const mongoose = require('mongoose');

const globalRecruiterSchema = new mongoose.Schema({
  // ── Company link ─────────────────────────────────────────────────
  companyId:  { type: mongoose.Types.ObjectId, ref: 'Company', required: true, index: true },

  // ── Identity (dedup keys) ────────────────────────────────────────
  email:      { type: String, default: null },
  linkedin:   { type: String, default: null },

  // ── Profile ──────────────────────────────────────────────────────
  name:       { type: String, default: '' },
  title:      { type: String, default: '' },   // "Talent Acquisition Manager", "HR Lead", etc.
  department: { type: String, default: null },  // "Engineering", "HR", "Recruiting"

  // ── Data quality ─────────────────────────────────────────────────
  confidence: { type: Number, default: 0, min: 0, max: 100 },
  status:     { type: String, enum: ['verified', 'predicted', 'invalid', 'unknown'], default: 'unknown' },
  source:     { type: String, enum: ['hunter', 'apollo', 'pattern', 'linkedin', 'manual'], default: 'pattern' },

  // ── Ranking signals ──────────────────────────────────────────────
  seenCount:    { type: Number, default: 1 },   // incremented each time re-discovered
  isHR:         { type: Boolean, default: false }, // true if title suggests recruiter/HR
  rankScore:    { type: Number, default: 0 },   // pre-computed: confidence * isHR * seenCount

  // ── Freshness ────────────────────────────────────────────────────
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },
  verifiedAt:  { type: Date, default: null },

}, { timestamps: true });

// ── Pre-save: compute isHR and rankScore ─────────────────────────
const HR_TITLES = /recruit|talent|hr|human resource|people ops|hiring|staffing|headhunt/i;

globalRecruiterSchema.pre('save', function (next) {
  this.isHR      = HR_TITLES.test(this.title || '');
  this.rankScore = Math.round(
    (this.confidence || 0) * (this.isHR ? 1.5 : 1.0) * Math.min(this.seenCount, 5)
  );
  next();
});

// ── Indexes ───────────────────────────────────────────────────────
globalRecruiterSchema.index({ companyId: 1, rankScore: -1 });
globalRecruiterSchema.index({ email: 1 }, { sparse: true });
globalRecruiterSchema.index({ linkedin: 1 }, { sparse: true });
// Compound dedup: same email at same company = same recruiter
globalRecruiterSchema.index({ companyId: 1, email: 1 }, { sparse: true });

module.exports = mongoose.model('GlobalRecruiter', globalRecruiterSchema);
