const mongoose = require('mongoose');

const linkedInJobSchema = new mongoose.Schema({
  userId:      { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true },
  company:     { type: String, required: true },
  location:    String,
  description: String,
  url:         String,
  salary:      String,
  remote:      { type: Boolean, default: false },
  postedAt:    Date,
  source:      { type: String, default: 'linkedin_alert' },
  matchScore:  { type: Number, default: 0 },
  status:      {
    type:    String,
    enum:    ['new', 'saved', 'applied', 'ignored'],
    default: 'new',
  },

  // HR contact
  recruiterEmail:    String,
  recruiterName:     String,
  recruiterLinkedIn: String,

  // Employees from Apollo
  employees: [{
    name:     String,
    title:    String,
    linkedin: String,
    email:    String,
  }],

}, { timestamps: true });

linkedInJobSchema.index({ userId: 1, createdAt: -1 });
linkedInJobSchema.index({ userId: 1, company:   1 });

module.exports = mongoose.model('LinkedInJob', linkedInJobSchema);