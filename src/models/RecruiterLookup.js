const mongoose = require('mongoose');

const recruiterLookupSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  company: { type: String, required: true },
  domain:  { type: String },
  source:  { type: String, enum: ['hunter', 'apollo', 'pattern', 'none'], default: 'none' },

  // Top contact (for quick display)
  email:      { type: String },
  name:       { type: String },
  confidence: { type: Number },
  linkedin:   { type: String },
  title:      { type: String },

  // All contacts returned
  allEmails: [
    {
      email:      String,
      name:       String,
      confidence: Number,
      linkedin:   String,
      title:      String,
    },
  ],

  careerPageUrl:  { type: String },
  linkedinUrl:    { type: String },
  employeeSearch: { type: String },
}, {
  timestamps: true,
});

recruiterLookupSchema.index({ userId: 1, createdAt: -1 });
recruiterLookupSchema.index({ userId: 1, company:   1 });

module.exports = mongoose.model('RecruiterLookup', recruiterLookupSchema);
