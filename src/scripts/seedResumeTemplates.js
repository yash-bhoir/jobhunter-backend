const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const mongoose = require('mongoose');

const TEMPLATES = [
  {
    name: 'Classic',
    description: 'Traditional dark-header layout — safe choice for conservative industries',
    style: 'classic',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Modern',
    description: 'Indigo-accented with clean sections — great for tech & product roles',
    style: 'modern',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Minimal',
    description: 'Pure white, understated typography — lets your content breathe',
    style: 'minimal',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Tech',
    description: 'Dark header with sky-blue accents — tailored for engineering roles',
    style: 'tech',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Executive',
    description: 'Navy blue with structured hierarchy — ideal for senior leadership',
    style: 'executive',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Clean',
    description: 'Light header, charcoal accents — professional & universally readable',
    style: 'clean',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Bold',
    description: 'Black header, high contrast — stands out in design & creative fields',
    style: 'bold',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Sidebar',
    description: 'Indigo sidebar accent — modern feel for marketing & growth roles',
    style: 'sidebar',
    accentColor: '',
    isActive: true,
  },
  {
    name: 'Compact',
    description: 'Dense layout, dark charcoal — fits more experience on one page',
    style: 'compact',
    accentColor: '',
    isActive: true,
  },
];

async function seed() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    const ResumeTemplate = require('../models/ResumeTemplate');

    let created = 0;
    let skipped = 0;

    for (const tpl of TEMPLATES) {
      const existing = await ResumeTemplate.findOne({ style: tpl.style });
      if (existing) {
        console.log(`  Skipped (exists): ${tpl.name}`);
        skipped++;
      } else {
        await ResumeTemplate.create(tpl);
        console.log(`  Created: ${tpl.name}`);
        created++;
      }
    }

    console.log(`\nDone! Created: ${created}, Skipped: ${skipped}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

seed();
