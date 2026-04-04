const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const mongoose = require('mongoose');

console.log('Starting seed...');
console.log('MongoDB URI:', process.env.MONGODB_URI ? 'Found' : 'NOT FOUND');

async function seed() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    const User           = require('../backend/src/models/User');
    const UserCredits    = require('../backend/src/models/UserCredits');
    const PlatformConfig = require('../backend/src/models/PlatformConfig');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@jobhunter.in';
    const adminPass  = process.env.ADMIN_PASSWORD || 'Admin@123456';

    console.log('Looking for admin:', adminEmail);
    let admin = await User.findOne({ email: adminEmail });

    if (!admin) {
      console.log('Creating admin user...');
      admin = await User.create({
        email:         adminEmail,
        password:      adminPass,
        role:          'super_admin',
        status:        'active',
        emailVerified: true,
        profile: {
          firstName:     'Admin',
          lastName:      'User',
          completionPct: 100,
        },
      });
      await UserCredits.create({
        userId:       admin._id,
        plan:         'team',
        totalCredits: 999999,
      });
      console.log('Admin created:', adminEmail);
    } else {
      console.log('Admin already exists:', adminEmail);
    }

    console.log('Seeding platform config...');
    const defaults = [
      { key: 'maintenanceMode',      value: { enabled: false }, category: 'features' },
      { key: 'registrationsEnabled', value: true,               category: 'features' },
      { key: 'enabledPlatforms',     value: ['jsearch','adzuna','remoteok','remotive','arbeitnow','jobicy','himalayas','themuse'], category: 'apis' },
      { key: 'freePlanLimits',       value: { searchesPerDay: 2,   jobsPerSearch: 10, emailsPerMonth: 10  }, category: 'limits' },
      { key: 'proPlanLimits',        value: { searchesPerDay: 999, jobsPerSearch: 30, emailsPerMonth: 999, hrLookupsPerMonth: 50  }, category: 'limits' },
      { key: 'teamPlanLimits',       value: { searchesPerDay: 999, jobsPerSearch: 50, emailsPerMonth: 9999, hrLookupsPerMonth: 200 }, category: 'limits' },
      { key: 'creditCosts',          value: { JOB_SEARCH: 10, HUNTER_LOOKUP: 15, APOLLO_SEARCH: 10, AI_EMAIL: 5, RESUME_PARSE: 20, EMAIL_SEND: 2, EXCEL_EXPORT: 5 }, category: 'credits' },
      { key: 'proPlanPrice',         value: 499,  category: 'billing' },
      { key: 'teamPlanPrice',        value: 1999, category: 'billing' },
      { key: 'aiEmailEnabled',       value: true, category: 'features' },
      { key: 'resumeParseEnabled',   value: true, category: 'features' },
      { key: 'hunterEnabled',        value: true, category: 'features' },
      { key: 'banner',               value: { active: false }, category: 'general' },
    ];

    for (const d of defaults) {
      await PlatformConfig.findOneAndUpdate({ key: d.key }, d, { upsert: true });
      console.log('  Seeded:', d.key);
    }

    console.log('\nAll done!');
    console.log('Admin email   :', adminEmail);
    console.log('Admin password:', adminPass);
    console.log('Admin role    : super_admin');

    await mongoose.disconnect();
    process.exit(0);

  } catch (err) {
    console.error('Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

seed();