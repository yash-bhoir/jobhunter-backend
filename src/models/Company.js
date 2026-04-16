/**
 * Company.js — Central entity. Shared across ALL users.
 *
 * Design principles:
 *  - One Company record per real-world company (deduplicated by normalizedName + domain)
 *  - All jobs, recruiters, and employees link here via companyId
 *  - Refresh timestamps prevent redundant API calls (global cache)
 *  - nameVariants lets us match "Google LLC", "Google Inc", "Alphabet/Google" → same record
 */

const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  // ── Identity ────────────────────────────────────────────────────
  name:           { type: String, required: true },          // display name (first seen)
  normalizedName: { type: String, required: true },          // for dedup matching
  nameVariants:   { type: [String], default: [] },           // all seen variants

  domain:         { type: String, default: null },           // e.g. "stripe.com"
  linkedinUrl:    { type: String, default: null },
  careerPageUrl:  { type: String, default: null },

  // ── Company metadata ─────────────────────────────────────────────
  industry:       { type: String, default: null },
  size:           { type: String, default: null },           // e.g. "1001-5000"
  logoUrl:        { type: String, default: null },
  headquarters:   { type: String, default: null },

  // ── Data quality ─────────────────────────────────────────────────
  dataQuality: {
    score:          { type: Number, default: 0, min: 0, max: 100 },
    hasRecruiters:  { type: Boolean, default: false },
    hasEmployees:   { type: Boolean, default: false },
    recruiterCount: { type: Number, default: 0 },
    employeeCount:  { type: Number, default: 0 },
    jobCount:       { type: Number, default: 0 },
  },

  // ── Refresh control (prevents redundant API calls) ───────────────
  recruitersRefreshedAt: { type: Date, default: null }, // last time we called Hunter/Apollo
  employeesRefreshedAt:  { type: Date, default: null }, // last time we called Apollo employees
  jobsRefreshedAt:       { type: Date, default: null }, // last time we scraped their job board

  // TTL flags — stale after N days (set by maintenance cron)
  recruitersStale: { type: Boolean, default: true },
  employeesStale:  { type: Boolean, default: true },

  // ── Sources that have contributed data ───────────────────────────
  sources: { type: [String], default: [] },  // e.g. ['adzuna', 'greenhouse', 'lever']

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────
companySchema.index({ normalizedName: 1 }, { unique: true });
companySchema.index({ domain: 1 }, { sparse: true });
companySchema.index({ 'dataQuality.score': -1 });
companySchema.index({ recruitersStale: 1, recruitersRefreshedAt: 1 });

module.exports = mongoose.model('Company', companySchema);
