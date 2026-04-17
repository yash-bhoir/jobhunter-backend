/**
 * GlobalEmployee.js — Shared employee pool, linked to Company.
 *
 * Design principles:
 *  - Employees found via Apollo, LinkedIn scraping, or manual input
 *  - Linked to Company (companyId) — shared across ALL users
 *  - Used to surface "people who work here" alongside job listings
 *  - Deduped by (companyId + linkedin) or (companyId + email)
 *  - Extensible: ready for AI-based "warm intro" path scoring
 */

const mongoose = require('mongoose');

const globalEmployeeSchema = new mongoose.Schema({
  // ── Company link ─────────────────────────────────────────────────
  companyId:  { type: mongoose.Types.ObjectId, ref: 'Company', required: true, index: true },

  // ── Identity (dedup keys) ────────────────────────────────────────
  linkedin:   { type: String, default: null },
  email:      { type: String, default: null },

  // ── Profile ──────────────────────────────────────────────────────
  name:       { type: String, default: '' },
  title:      { type: String, default: '' },
  department: { type: String, default: null },
  location:   { type: String, default: null },
  seniority:  { type: String, default: null },  // 'junior', 'mid', 'senior', 'lead', 'vp', 'c-level'

  // ── Source tracking ──────────────────────────────────────────────
  source:     { type: String, enum: ['apollo', 'linkedin', 'manual', 'hunter'], default: 'apollo' },

  // ── Freshness ────────────────────────────────────────────────────
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────
globalEmployeeSchema.index({ companyId: 1, linkedin: 1 }, { sparse: true });
globalEmployeeSchema.index({ companyId: 1, email: 1 },    { sparse: true });
globalEmployeeSchema.index({ companyId: 1, department: 1 });

module.exports = mongoose.model('GlobalEmployee', globalEmployeeSchema);
