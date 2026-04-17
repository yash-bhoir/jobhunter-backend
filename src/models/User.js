const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, select: false, minlength: 8 },
  googleId: { type: String, sparse: true },
  role:     { type: String, enum: ['user', 'admin', 'super_admin'], default: 'user' },
  status:   { type: String, enum: ['active', 'pending', 'banned', 'deleted'], default: 'pending' },
  plan:     { type: String, enum: ['free', 'pro', 'team'], default: 'free' },

  profile: {
    firstName:   String,
    lastName:    String,
    phone:       String,
    avatarUrl:   String,
    city:        String,
    country:     { type: String, default: 'India' },
    linkedinUrl:  String,
    portfolioUrl: String,
    currentRole:  String,
    experience:   Number,
    currentCTC:   String,
    expectedCTC:  String,
    noticePeriod: String,
    targetRole:         String,
    targetIndustries:   [String],
    workType:           { type: String, enum: ['remote', 'hybrid', 'onsite', 'any'] },
    companySize:        [String],
    companyType:        [String],
    preferredLocations: [String],
    openToRelocation:   Boolean,
    skills:          [String],
    secondarySkills: [String],
    languages:       [String],
    certifications:  [String],
    education: {
      degree:  String,
      college: String,
      year:    Number,
    },
    completionPct: { type: Number, default: 0, min: 0, max: 100 },
  },

  resume: {
    url:                String,
    publicId:           String,
    originalName:       String,
    uploadedAt:         Date,
    parsedAt:           Date,
    isParsed:           { type: Boolean, default: false },
    extractedSkills:    [String],
    extractedCompanies: [String],
    summary:            String,
    totalExperience:    String,
  },

  // Raw PDF buffer stored in DB so optimization/attachment never depends on Cloudinary CDN
  resumeBuffer:     { type: Buffer, select: false },
  // Original DOCX buffer — enables pixel-perfect keyword patching (XML find/replace)
  resumeDocxBuffer: { type: Buffer, select: false },

  planOverrides: {
    active:            { type: Boolean, default: false },
    searchesPerDay:    Number,
    creditsPerMonth:   Number,
    hrLookupsPerMonth: Number,
    emailsPerMonth:    Number,
    reason:            String,
    appliedBy:         mongoose.Types.ObjectId,
    appliedAt:         Date,
  },

  emailVerified:        { type: Boolean, default: false },
  emailVerifyToken:     { type: String,  select: false },
  emailVerifyExpires:   { type: Date,    select: false },
  passwordResetToken:   { type: String,  select: false },
  passwordResetExpires: { type: Date,    select: false },
  loginAttempts:        { type: Number,  default: 0 },
  lockUntil:            Date,

  lastLoginAt:  Date,
  lastActiveAt: Date,
  banReason:    String,
  bannedAt:     Date,
  bannedBy:     mongoose.Types.ObjectId,
  deletedAt:    Date,

  // ── SMTP — multiple email accounts ──────────────────────────────
  smtpAccounts: {
    type: [{
      email:        { type: String, required: true },
      pass:         { type: String, required: true },
      label:        { type: String, default: 'Gmail' },
      isDefault:    { type: Boolean, default: false },
      configuredAt: { type: Date,    default: Date.now },
    }],
    select:  false,
    default: [],
  },

// Gmail OAuth for email alert parsing
gmailAccessToken:  { type: String, select: false },
gmailRefreshToken: { type: String, select: false },
gmailConnectedAt:  Date,
gmailEmail:        String,

  // LinkedIn job alert preferences
  linkedinAlerts: {
    enabled:    { type: Boolean, default: true },
    frequency:  { type: String, enum: ['hourly', 'daily', 'weekly'], default: 'daily' },
    lastSentAt: Date,
  },

}, { timestamps: true });

// ── Hash password before save ─────────────────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(
    this.password,
    parseInt(process.env.BCRYPT_ROUNDS) || 12
  );
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerifyToken;
  delete obj.emailVerifyExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.smtpAccounts;
  return obj;
};

userSchema.virtual('fullName').get(function () {
  return `${this.profile?.firstName || ''} ${this.profile?.lastName || ''}`.trim();
});

module.exports = mongoose.model('User', userSchema);