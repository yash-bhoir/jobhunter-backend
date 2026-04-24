/**
 * Smoke-test each job-search provider (direct service calls, no Mongo).
 * Run from backend root: node src/scripts/testJobSearchApis.js
 *
 * Exits 0 if every configured provider returns without throw;
 * exits 1 if any configured provider throws or returns a hard HTTP-style failure.
 * Providers skipped due to missing env keys still count as OK (reported as skipped).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path = require('path');

const PLATFORMS = [
  { name: 'jsearch',        file: 'jsearch.service',        skipUnless: ['RAPIDAPI_KEY'] },
  { name: 'adzuna',         file: 'adzuna.service',         skipUnless: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'] },
  { name: 'remoteok',       file: 'remoteok.service',     skipUnless: [] },
  { name: 'remotive',       file: 'remotive.service',     skipUnless: [] },
  { name: 'arbeitnow',      file: 'arbeitnow.service',    skipUnless: [] },
  { name: 'jobicy',         file: 'jobicy.service',       skipUnless: [] },
  { name: 'himalayas',      file: 'himalayas.service',    skipUnless: [] },
  { name: 'themuse',        file: 'themuse.service',      skipUnless: [] },
  { name: 'careerjet',      file: 'careerjet.service',    skipUnless: [] },
  { name: 'linkedin-rss',   file: 'linkedin-rss.service', skipUnless: [] },
  { name: 'indeed-rss',     file: 'indeed-rss.service',   skipUnless: [] },
  { name: 'naukri',         file: 'naukri.service',       skipUnless: [] },
  { name: 'wellfound',      file: 'wellfound.service',    skipUnless: [] },
  { name: 'jooble',         file: 'jooble.service',       skipUnless: ['JOOBLE_API_KEY'] },
  { name: 'findwork',       file: 'findwork.service',     skipUnless: ['FINDWORK_API_KEY'] },
  { name: 'greenhouse',     file: 'greenhouse.service',   skipUnless: [] },
  { name: 'lever',          file: 'lever.service',        skipUnless: [] },
  { name: 'ashby',          file: 'ashby.service',        skipUnless: [] },
  { name: 'recruitee',      file: 'recruitee.service',    skipUnless: [] },
  { name: 'serpapi',        file: 'serpapi.service',      skipUnless: ['SERPAPI_KEY'] },
  { name: 'reed',           file: 'reed.service',         skipUnless: ['REED_API_KEY'] },
];

const TEST_PARAMS = {
  role:       'software engineer',
  location:   'United States',
  workType:   'remote',
  skills:     ['javascript', 'react'],
  experience: 2,
};

/** Apify + some ATS fetches can exceed 60s; keep bounded for CI. */
const PER_PLATFORM_MS = Number(process.env.JOB_API_TEST_TIMEOUT_MS) || 200000;

function missingEnv(keys) {
  return keys.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
}

function runOne(platform) {
  const svcPath = path.join(__dirname, '../services/jobSearch', platform.file);
  const mod = require(svcPath);
  if (typeof mod.search !== 'function') {
    return Promise.reject(new Error('module has no search()'));
  }

  const missing = missingEnv(platform.skipUnless);
  if (platform.skipUnless.length && missing.length > 0) {
    return Promise.resolve({
      status: 'skipped',
      reason: `missing env: ${missing.join(', ')}`,
      count:  0,
      ms:     0,
    });
  }

  const started = Date.now();
  return Promise.race([
    mod.search(TEST_PARAMS),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${PER_PLATFORM_MS}ms`)), PER_PLATFORM_MS)
    ),
  ])
    .then((jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [];
      return {
        status: 'ok',
        count:  arr.length,
        ms:     Date.now() - started,
      };
    })
    .catch((err) => ({
      status: 'error',
      reason: err.message || String(err),
      count:  0,
      ms:     Date.now() - started,
    }));
}

async function main() {
  console.log('Job search API smoke test');
  console.log('Params:', { ...TEST_PARAMS });
  console.log('---');

  const rows = [];
  let failed = false;

  for (const p of PLATFORMS) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const result = await runOne(p);
    rows.push({ name: p.name, ...result });
    const line = `[${p.name}] ${result.status}` +
      (result.count !== undefined ? ` jobs=${result.count}` : '') +
      (result.ms != null ? ` ${result.ms}ms` : '') +
      (result.reason ? ` — ${result.reason}` : '');
    console.log(line);
    if (result.status === 'error') failed = true;
  }

  console.log('---');
  const ok = rows.filter((r) => r.status === 'ok').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  console.log(`Summary: ok=${ok} skipped=${skipped} error=${errors}`);

  if (failed) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
