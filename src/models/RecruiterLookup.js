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
  status:     { type: String, enum: ['verified', 'predicted', 'invalid', 'unknown'], default: 'unknown' },

  // All contacts returned
  allEmails: [
    {
      email:      String,
      name:       String,
      confidence: Number,
      linkedin:   String,
      title:      String,
      source:     String,
      status:     { type: String, enum: ['verified', 'predicted', 'invalid', 'unknown'], default: 'unknown' },
    },
  ],

  careerPageUrl:  { type: String },
  linkedinUrl:    { type: String },
  employeeSearch: { type: String },
}, {
  timestamps: true,
});

recruiterLookupSchema.index({ userId: 1, createdAt: -1 });
// FIX: was a plain index — changed to unique to prevent duplicate lookup records
// (and duplicate API credit spend) when findHR is called concurrently on two jobs
// at the same company.
// MIGRATION NOTE: if deploying to an existing collection with duplicate entries, run:
//   db.recruiterlookups.aggregate([
//     {$group:{_id:{userId:"$userId",company:"$company"},count:{$sum:1},ids:{$push:"$_id"}}},
//     {$match:{count:{$gt:1}}}
//   ]).forEach(g => g.ids.slice(1).forEach(id => db.recruiterlookups.deleteOne({_id:id})))
recruiterLookupSchema.index({ userId: 1, company: 1 }, { unique: true });

module.exports = mongoose.model('RecruiterLookup', recruiterLookupSchema);
