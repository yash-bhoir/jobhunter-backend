/**
 * Standalone seed script — run with:
 *   node src/scripts/seedGeoJobs.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const GeoJob   = require('../models/GeoJob');

const SEED_JOBS = [
  { title: 'Senior React Developer', company: 'Monzo', location: { type: 'Point', coordinates: [-0.0756, 51.5248], address: 'Shoreditch, London' }, salary: 95000, salaryDisplay: '£95K/yr', jobType: 'hybrid', tags: ['React', 'TypeScript', 'GraphQL'], description: 'Build next-gen banking features for millions of users.', applyUrl: '#' },
  { title: 'Data Engineer', company: 'HSBC', location: { type: 'Point', coordinates: [0.0195, 51.5054], address: 'Canary Wharf, London' }, salary: 85000, salaryDisplay: '£85K/yr', jobType: 'full-time', tags: ['Python', 'Apache Spark', 'AWS'], description: 'Design large-scale data pipelines for global banking analytics.', applyUrl: '#' },
  { title: 'Backend Engineer', company: 'Revolut', location: { type: 'Point', coordinates: [-0.0924, 51.5126], address: 'City of London' }, salary: 110000, salaryDisplay: '£110K/yr', jobType: 'remote', tags: ['Kotlin', 'Microservices', 'Kafka'], description: 'Scale payment infrastructure to handle billions of transactions.', applyUrl: '#' },
  { title: 'UX Designer', company: 'DeepMind', location: { type: 'Point', coordinates: [-0.1337, 51.5136], address: 'Soho, London' }, salary: 90000, salaryDisplay: '£90K/yr', jobType: 'hybrid', tags: ['Figma', 'Design Systems', 'User Research'], description: 'Shape the human side of cutting-edge AI research tools.', applyUrl: '#' },
  { title: 'Product Manager', company: 'Deliveroo', location: { type: 'Point', coordinates: [-0.1430, 51.5390], address: 'Camden, London' }, salary: 105000, salaryDisplay: '£105K/yr', jobType: 'full-time', tags: ['Agile', 'B2C', 'Growth'], description: 'Own the rider experience product from ideation through to launch.', applyUrl: '#' },
  { title: 'Machine Learning Engineer', company: 'DeepMind', location: { type: 'Point', coordinates: [-0.1921, 51.5000], address: 'Kensington, London' }, salary: 130000, salaryDisplay: '£130K/yr', jobType: 'full-time', tags: ['Python', 'PyTorch', 'TensorFlow'], description: 'Develop state-of-the-art ML models for real-world impact.', applyUrl: '#' },
  { title: 'DevOps Engineer', company: 'Wise', location: { type: 'Point', coordinates: [-0.0873, 51.5047], address: 'London Bridge' }, salary: 88000, salaryDisplay: '£88K/yr', jobType: 'hybrid', tags: ['Kubernetes', 'Terraform', 'GCP'], description: 'Build infrastructure powering global money transfers at scale.', applyUrl: '#' },
  { title: 'Frontend Engineer', company: 'Bulb Energy', location: { type: 'Point', coordinates: [-0.0550, 51.5438], address: 'Hackney, London' }, salary: 80000, salaryDisplay: '£80K/yr', jobType: 'remote', tags: ['Vue.js', 'TypeScript', 'Tailwind CSS'], description: 'Build clean energy management tools for consumers.', applyUrl: '#' },
  { title: 'Cloud Architect', company: 'BT Group', location: { type: 'Point', coordinates: [0.0028, 51.5422], address: 'Stratford, London' }, salary: 125000, salaryDisplay: '£125K/yr', jobType: 'full-time', tags: ['AWS', 'Azure', 'Cloud Architecture'], description: 'Lead cloud migration strategy for enterprise infrastructure.', applyUrl: '#' },
  { title: 'iOS Developer', company: 'Farfetch', location: { type: 'Point', coordinates: [-0.2051, 51.5130], address: 'Notting Hill, London' }, salary: 92000, salaryDisplay: '£92K/yr', jobType: 'hybrid', tags: ['Swift', 'SwiftUI', 'UIKit'], description: 'Craft luxury fashion discovery experiences for iOS users.', applyUrl: '#' },
  { title: 'Data Scientist', company: 'GoCardless', location: { type: 'Point', coordinates: [0.0090, 51.4834], address: 'Greenwich, London' }, salary: 87000, salaryDisplay: '£87K/yr', jobType: 'hybrid', tags: ['Python', 'SQL', 'Statistics'], description: 'Model payment failure and fraud detection patterns.', applyUrl: '#' },
  { title: 'Android Developer', company: 'Bumble', location: { type: 'Point', coordinates: [-0.3010, 51.4613], address: 'Richmond, London' }, salary: 88000, salaryDisplay: '£88K/yr', jobType: 'remote', tags: ['Kotlin', 'Jetpack Compose', 'MVVM'], description: 'Build features helping people make meaningful connections.', applyUrl: '#' },
  { title: 'Full Stack Engineer', company: 'OakNorth', location: { type: 'Point', coordinates: [-0.1133, 51.4613], address: 'Brixton, London' }, salary: 95000, salaryDisplay: '£95K/yr', jobType: 'full-time', tags: ['Node.js', 'React', 'PostgreSQL'], description: 'Build banking tools for entrepreneurs.', applyUrl: '#' },
  { title: 'Security Engineer', company: 'Palantir', location: { type: 'Point', coordinates: [-0.2240, 51.4934], address: 'Hammersmith, London' }, salary: 120000, salaryDisplay: '£120K/yr', jobType: 'full-time', tags: ['AppSec', 'Zero Trust', 'SIEM'], description: 'Secure mission-critical data analytics platforms.', applyUrl: '#' },
  { title: 'QA Automation Engineer', company: 'Sky', location: { type: 'Point', coordinates: [-0.2979, 51.5560], address: 'Wembley, London' }, salary: 65000, salaryDisplay: '£65K/yr', jobType: 'hybrid', tags: ['Cypress', 'Playwright', 'Automation'], description: 'Ensure quality across broadcast streaming platforms.', applyUrl: '#' },
  { title: 'Engineering Manager', company: 'Experian', location: { type: 'Point', coordinates: [-0.1420, 51.5154], address: 'Oxford Circus, London' }, salary: 140000, salaryDisplay: '£140K/yr', jobType: 'full-time', tags: ['Leadership', 'Fintech', 'Agile'], description: 'Lead 8 engineers building credit decisioning tools.', applyUrl: '#' },
  { title: 'Blockchain Developer', company: 'ConsenSys', location: { type: 'Point', coordinates: [-0.1425, 51.4963], address: 'Victoria, London' }, salary: 115000, salaryDisplay: '£115K/yr', jobType: 'remote', tags: ['Solidity', 'Ethereum', 'Web3.js'], description: 'Build decentralised applications on Ethereum.', applyUrl: '#' },
  { title: 'Site Reliability Engineer', company: 'Funding Circle', location: { type: 'Point', coordinates: [-0.1010, 51.4958], address: 'Elephant & Castle, London' }, salary: 100000, salaryDisplay: '£100K/yr', jobType: 'hybrid', tags: ['SRE', 'Prometheus', 'Go'], description: 'Improve reliability and observability of the lending platform.', applyUrl: '#' },
  { title: 'Senior Product Designer', company: 'Airtable', location: { type: 'Point', coordinates: [-0.1246, 51.4855], address: 'Vauxhall, London' }, salary: 98000, salaryDisplay: '£98K/yr', jobType: 'hybrid', tags: ['Figma', 'Product Design', 'B2B SaaS'], description: 'Redesign collaboration experiences for enterprise teams.', applyUrl: '#' },
  { title: 'Marketing Data Analyst', company: 'Zalando', location: { type: 'Point', coordinates: [-0.0921, 51.5016], address: 'Borough, London' }, salary: 72000, salaryDisplay: '£72K/yr', jobType: 'full-time', tags: ['SQL', 'Tableau', 'A/B Testing'], description: 'Optimise digital marketing spend across European markets.', applyUrl: '#' },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅  MongoDB connected');

    const existing = await GeoJob.countDocuments();
    if (existing > 0) {
      console.log(`ℹ️   Already have ${existing} geo jobs — skipping seed`);
      return;
    }

    const docs = await GeoJob.insertMany(SEED_JOBS);
    console.log(`✅  Seeded ${docs.length} geo jobs`);
  } catch (err) {
    console.error('❌  Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('✅  Disconnected');
  }
}

seed();
