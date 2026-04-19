/**
 * End-to-End Plan Guard Test
 * Tests that pro-only endpoints are inaccessible to free users and accessible to pro users.
 * Also tests credit deduction behaviour and daily search limits.
 *
 * Usage:
 *   node tests/e2e-plan-guard.test.js
 *
 * Set env vars (or create .env.test):
 *   FREE_EMAIL=<free user email>
 *   FREE_PASS=<free user password>
 *   PRO_EMAIL=<pro user email>
 *   PRO_PASS=<pro user password>
 *   API_BASE=https://jobhunter-backend-7jwh.onrender.com/api/v1
 */

require('dotenv').config({ path: '.env.test' });
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const BASE = process.env.API_BASE || 'https://jobhunter-backend-7jwh.onrender.com/api/v1';

// ─── tiny HTTP client ───────────────────────────────────────────────────────
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const lib  = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const SKIP = '\x1b[33m~\x1b[0m';
let passed = 0, failed = 0, skipped = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${name}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${SKIP} ${name} (skipped: ${reason})`);
  skipped++;
}

async function login(email, password) {
  const r = await request('POST', '/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data?.token || r.body.data?.accessToken;
}

// ─── test groups ─────────────────────────────────────────────────────────────
async function testPlanGuard(label, token, expectBlocked) {
  console.log(`\n  [Plan Guard — ${label}]`);

  const endpoints = [
    // Recruiters — pro only
    { method: 'POST', path: '/recruiters/lookup',       body: { email: 'test@example.com' } },
    { method: 'POST', path: '/recruiters/employees',    body: { company: 'Google' } },
    { method: 'POST', path: '/recruiters/find-all',     body: { company: 'Google' } },
    // Jobs — pro only
    { method: 'POST', path: '/jobs/export/excel',       body: {} },
    { method: 'GET',  path: '/jobs/000000000000000000000001/explain' },
    { method: 'GET',  path: '/jobs/000000000000000000000001/company' },
    { method: 'POST', path: '/jobs/000000000000000000000001/find-employees', body: {} },
    { method: 'POST', path: '/jobs/000000000000000000000001/deep-evaluate',  body: {} },
    // Outreach — pro only
    { method: 'POST', path: '/outreach/optimize-resume',body: {} },
    { method: 'POST', path: '/outreach/auto-outreach',  body: {} },
    // LinkedIn — pro only
    { method: 'POST', path: '/linkedin/jobs/000000000000000000000001/find-hr', body: {} },
    // Profile — pro only
    { method: 'POST', path: '/profile/gap-analysis',    body: {} },
  ];

  for (const ep of endpoints) {
    const r = await request(ep.method, ep.path, ep.body || null, token);
    const name = `${ep.method} ${ep.path}`;
    if (expectBlocked) {
      assert(
        `${name} → 403`,
        r.status === 403,
        `got ${r.status}`
      );
    } else {
      // Pro user: should NOT be 403 (may be 200, 400, 404 — anything but a plan block)
      assert(
        `${name} → not 403`,
        r.status !== 403,
        `got ${r.status}`
      );
    }
  }
}

async function testCreditEndpoints(label, token) {
  console.log(`\n  [Credit Endpoints — ${label}]`);

  const endpoints = [
    { method: 'POST', path: '/outreach/generate', body: { jobTitle: 'SWE', company: 'Test Co', hrName: 'Jane', hrEmail: 'jane@test.com' } },
    { method: 'POST', path: '/outreach/send',     body: { to: 'jane@test.com', subject: 'Hi', body: 'Hello' } },
    { method: 'POST', path: '/jobs/000000000000000000000001/interview-prep', body: {} },
  ];

  for (const ep of endpoints) {
    const r = await request(ep.method, ep.path, ep.body, token);
    const name = `${ep.method} ${ep.path}`;
    // Should never 500 (would indicate credit deduction on error)
    assert(
      `${name} → not 500`,
      r.status !== 500,
      `got ${r.status} — server error (possible credit leak)`
    );
    // Should not be a plan guard 403 for free users on credit-only routes
    if (r.status === 402) {
      console.log(`    ℹ credit shortage (402) — that's fine`);
    }
  }
}

async function testSearchLimits(freeToken) {
  console.log('\n  [Daily Search Limit — free user]');

  // Check credits first
  const credR = await request('GET', '/user/credits', null, freeToken);
  if (credR.status === 200) {
    const c = credR.body.data;
    console.log(`    Credits: ${c?.totalCredits} total, ${c?.usedCredits} used, reset: ${c?.resetDate}`);
    assert('resetDate exists', !!c?.resetDate, 'missing resetDate — billing cron fix needed');
  }

  // Run first search
  const s1 = await request('POST', '/search/run', { query: 'software engineer', location: 'remote' }, freeToken);
  assert('Search #1 accepted (not 429/402)', ![429, 402].includes(s1.status), `got ${s1.status}`);

  if ([200, 201].includes(s1.status)) {
    const jobs = s1.body.data?.jobs || [];
    assert(`Search #1 returned ≤10 jobs for free plan`, jobs.length <= 10, `got ${jobs.length}`);
  }
}

async function testCreditsBalance(token, label) {
  console.log(`\n  [Credits Balance — ${label}]`);
  const r = await request('GET', '/user/credits', null, token);
  assert('GET /user/credits → 200', r.status === 200, `got ${r.status}`);
  if (r.status === 200) {
    const d = r.body.data;
    assert('has totalCredits', typeof d?.totalCredits === 'number');
    assert('has usedCredits',  typeof d?.usedCredits  === 'number');
    assert('has resetDate',    !!d?.resetDate, 'resetDate missing');
    assert('remaining >= 0',   (d?.totalCredits + (d?.topupCredits||0)) - d?.usedCredits >= 0);
    console.log(`    Plan: ${d?.plan}, Total: ${d?.totalCredits}, TopUp: ${d?.topupCredits||0}, Used: ${d?.usedCredits}, Reset: ${d?.resetDate}`);
  }
}

async function testPublicRoutes(freeToken) {
  console.log('\n  [Public / Any-Plan Routes]');
  const routes = [
    { method: 'GET',  path: '/user/me' },
    { method: 'GET',  path: '/user/activity?limit=5' },
    { method: 'GET',  path: '/user/credits' },
    { method: 'GET',  path: '/billing/history' },
    { method: 'GET',  path: '/billing/plans' },
  ];
  for (const ep of routes) {
    const r = await request(ep.method, ep.path, null, freeToken);
    assert(`${ep.method} ${ep.path} → 200`, r.status === 200, `got ${r.status}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       JobHunter — E2E Plan Guard Test            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`API: ${BASE}\n`);

  const freeEmail = process.env.FREE_EMAIL;
  const freePass  = process.env.FREE_PASS;
  const proEmail  = process.env.PRO_EMAIL;
  const proPass   = process.env.PRO_PASS;

  if (!freeEmail || !freePass) {
    console.log('⚠  FREE_EMAIL / FREE_PASS not set. Set them in .env.test or environment.');
    process.exit(1);
  }

  let freeToken, proToken;

  // Login
  console.log('─── Authentication ───────────────────────────────');
  try {
    freeToken = await login(freeEmail, freePass);
    console.log(`  ${PASS} Free user logged in`);
  } catch (e) {
    console.log(`  ${FAIL} Free user login — ${e.message}`);
    process.exit(1);
  }

  if (proEmail && proPass) {
    try {
      proToken = await login(proEmail, proPass);
      console.log(`  ${PASS} Pro user logged in`);
    } catch (e) {
      console.log(`  ${FAIL} Pro user login — ${e.message}`);
    }
  } else {
    console.log(`  ${SKIP} Pro user — PRO_EMAIL / PRO_PASS not set`);
  }

  // Tests
  console.log('\n─── Suites ───────────────────────────────────────');

  await testPublicRoutes(freeToken);
  await testCreditsBalance(freeToken, 'free user');

  if (proToken) {
    await testCreditsBalance(proToken, 'pro user');
  }

  await testPlanGuard('free user — expect 403', freeToken, true);

  if (proToken) {
    await testPlanGuard('pro user — expect access', proToken, false);
  } else {
    skip('Plan guard — pro user access', 'no pro credentials');
  }

  await testCreditEndpoints('free user', freeToken);
  await testSearchLimits(freeToken);

  // Summary
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${SKIP} ${skipped} skipped`);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
})();
