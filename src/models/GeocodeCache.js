const mongoose = require('mongoose');

/**
 * Durable cache for forward-geocode results (dedupe across jobs & users).
 */
const geocodeCacheSchema = new mongoose.Schema(
  {
    key:         { type: String, required: true, unique: true, index: true },
    queryNorm:   { type: String, required: true },
    lat:         { type: Number, required: true },
    lng:         { type: Number, required: true },
    confidence:  { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    provider:    { type: String, default: 'nominatim' },
    displayName: { type: String, default: '' },
    hitCount:    { type: Number, default: 0 },
  },
  { timestamps: true }
);

geocodeCacheSchema.index({ updatedAt: 1 });

module.exports = mongoose.model('GeocodeCache', geocodeCacheSchema);
