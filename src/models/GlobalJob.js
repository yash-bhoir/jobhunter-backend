/**
 * GlobalJob.js — Deduplicated, shared job store.
 *
 * Design principles:
 *  - One record per unique real-world job posting (deduped by externalId + source OR url)
 *  - Links to Company (companyId) — NOT to a user
 *  - UserJob (in Job.js) is the user-specific record that refs GlobalJob
 *  - Allows N users to see the same job without N API calls
 *  - lastSeenAt tracks freshness; expired flag for TTL cleanup
 */

const mongoose = require('mongoose');

const globalJobSchema = new mongoose.Schema({
  // ── Company link ─────────────────────────────────────────────────
  companyId:  { type: mongoose.Types.ObjectId, ref: 'Company', required: true, index: true },

  // ── Dedup keys ───────────────────────────────────────────────────
  externalId: { type: String, default: null },   // source platform's job ID
  url:        { type: String, default: null },    // canonical apply URL (secondary dedup key)

  // ── Job data ─────────────────────────────────────────────────────
  title:      { type: String, required: true },
  location:   { type: String, default: '' },
  description:{ type: String, default: '' },
  salary:     { type: String, default: 'Not specified' },
  salaryMin:  { type: Number, default: null },
  salaryMax:  { type: Number, default: null },
  remote:     { type: Boolean, default: false },
  postedAt:   { type: Date,   default: null },

  // ── Source tracking ──────────────────────────────────────────────
  // Multiple sources may list the same job — we track all of them
  primarySource: { type: String, required: true }, // first source that found it
  sources: [{
    name:       String,   // e.g. 'adzuna', 'greenhouse', 'jsearch'
    externalId: String,
    url:        String,
    seenAt:     { type: Date, default: Date.now },
  }],

  // ── Freshness ────────────────────────────────────────────────────
  lastSeenAt: { type: Date, default: Date.now },
  expired:    { type: Boolean, default: false },
  expiredAt:  { type: Date,   default: null },

  // ── Geo ──────────────────────────────────────────────────────────
  geoLocation: { lat: Number, lng: Number },

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────
globalJobSchema.index({ companyId: 1, externalId: 1 }, { sparse: true });
globalJobSchema.index({ companyId: 1, title: 1 });
globalJobSchema.index({ url: 1 }, { sparse: true });
globalJobSchema.index({ expired: 1, lastSeenAt: 1 });
globalJobSchema.index({ remote: 1, createdAt: -1 });

module.exports = mongoose.model('GlobalJob', globalJobSchema);
