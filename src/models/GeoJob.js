const mongoose = require('mongoose');

const geoJobSchema = new mongoose.Schema(
  {
    title:   { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },

    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
      address:     { type: String, trim: true },
    },

    salary:       { type: Number },
    salaryDisplay:{ type: String },
    description:  { type: String },
    jobType: {
      type:    String,
      enum:    ['full-time', 'part-time', 'contract', 'remote', 'hybrid'],
      default: 'full-time',
    },
    applyUrl:   { type: String },
    tags:       [String],
    postedAt:   { type: Date, default: Date.now },
    externalId: { type: String, index: true },  // dedup key from source API
    source:     { type: String },               // 'Adzuna', 'JSearch', 'Google Jobs', …
    expiresAt:  { type: Date, index: { expireAfterSeconds: 0 } }, // TTL — auto-delete after 24h
  },
  { timestamps: true }
);

// Geospatial index — required for $near / $geoWithin queries
geoJobSchema.index({ location: '2dsphere' });
// Text index for title search
geoJobSchema.index({ title: 'text', company: 'text' });

module.exports = mongoose.model('GeoJob', geoJobSchema);
