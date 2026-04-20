const { google }  = require('googleapis');
const cheerio     = require('cheerio');
const logger      = require('../../config/logger');

// ── Combined Gmail search query (all major Indian job portals) ────
const COMBINED_QUERY = [
  'from:jobalerts-noreply@linkedin.com',
  'from:jobs-listings@linkedin.com',
  'from:mailer.naukri.com',
  'from:alert@indeed.com',
  'from:indeedemail.com',
  'from:foundit.in',
  'from:alerts@foundit.in',
  'from:internshala.com',
  'from:timesjobs.com',
  'from:shine.com',
  'from:instahyre.com',
  'from:hirist.tech',
  '(subject:"job alert" newer_than:7d)',
  '(subject:"jobs for you" newer_than:7d)',
  '(subject:"new jobs" newer_than:7d)',
  '(subject:"job recommendations" newer_than:7d)',
  '(subject:"jobs matching" newer_than:7d)',
].join(' OR ');

// ── Source detection ──────────────────────────────────────────────
function detectSource(from, subject) {
  const f = (from || '').toLowerCase();
  if (f.includes('linkedin.com'))    return 'linkedin';
  if (f.includes('naukri.com'))      return 'naukri';
  if (f.includes('indeed.com') || f.includes('indeedemail')) return 'indeed';
  if (f.includes('foundit.in') || f.includes('monster.com')) return 'foundit';
  if (f.includes('internshala.com')) return 'internshala';
  if (f.includes('timesjobs.com'))   return 'timesjobs';
  if (f.includes('shine.com'))       return 'shine';
  if (f.includes('instahyre.com'))   return 'instahyre';
  if (f.includes('hirist'))          return 'hirist';
  return 'email_alert';
}

// ── LinkedIn ──────────────────────────────────────────────────────
function parseLinkedIn($) {
  const jobs = [];

  $('table[data-job-id], .job-card, [class*="job"]').each((_, el) => {
    const title   = $(el).find('a[href*="linkedin.com/jobs"]').first().text().trim() ||
                    $(el).find('strong, b, h3, h4').first().text().trim();
    const company = $(el).find('[class*="company"], [class*="subtitle"]').first().text().trim();
    const loc     = $(el).find('[class*="location"], [class*="geo"]').first().text().trim();
    const url     = $(el).find('a[href*="linkedin.com/jobs"]').first().attr('href') || '';
    if (title?.length > 3)
      jobs.push({ title, company, location: loc, url, source: 'linkedin', remote: /remote/i.test(loc) });
  });

  if (jobs.length === 0) {
    $('a[href*="linkedin.com/jobs/view"]').each((_, el) => {
      const title = $(el).text().trim();
      const url   = $(el).attr('href') || '';
      if (title?.length > 3)
        jobs.push({ title, company: '', location: '', url, source: 'linkedin', remote: false });
    });
  }
  return jobs;
}

// ── Naukri ────────────────────────────────────────────────────────
function parseNaukri($) {
  const jobs = [];
  $('a[href*="naukri.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (text.length < 3) return;
    const parent  = $(el).closest('td, div, tr');
    const company = parent.find('b, strong').not($(el)).first().text().trim();
    const loc     = parent.find('[class*="loc"], [class*="location"]').first().text().trim();
    jobs.push({ title: text, company, location: loc, url: href, source: 'naukri', remote: /remote|work from home/i.test(loc) });
  });
  return jobs;
}

// ── Indeed ────────────────────────────────────────────────────────
function parseIndeed($) {
  const jobs = [];
  $('a[href*="indeed.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!href.includes('/viewjob') && !href.includes('/rc/clk')) return;
    if (text.length < 3) return;
    const parent  = $(el).closest('td, div, table');
    const company = parent.find('[class*="company"], [class*="employer"]').first().text().trim();
    const loc     = parent.find('[class*="location"], [class*="loc"]').first().text().trim();
    jobs.push({ title: text, company, location: loc, url: href, source: 'indeed', remote: /remote/i.test(loc) });
  });
  return jobs;
}

// ── Foundit / Monster ─────────────────────────────────────────────
function parseFoundit($, html) {
  const domain = html.includes('foundit.in') ? 'foundit.in' : 'monster.com';
  const jobs   = [];
  $(`a[href*="${domain}"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (text.length < 3) return;
    const parent  = $(el).closest('td, div, tr');
    const company = parent.find('b, strong').not($(el)).first().text().trim();
    const loc     = parent.find('[class*="loc"], [class*="location"]').first().text().trim();
    jobs.push({ title: text, company, location: loc, url: href, source: 'foundit', remote: /remote|work from home/i.test(loc) });
  });
  return jobs;
}

// ── Internshala ───────────────────────────────────────────────────
function parseInternshala($) {
  const jobs = [];
  $('a[href*="internshala.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!href.includes('/jobs') && !href.includes('/internship')) return;
    if (text.length < 3) return;
    const parent  = $(el).closest('td, div, tr');
    const company = parent.find('[class*="company"]').first().text().trim();
    const loc     = parent.find('[class*="location"]').first().text().trim();
    jobs.push({ title: text, company, location: loc || 'India', url: href, source: 'internshala', remote: /remote|work.from.home/i.test(loc + href) });
  });
  return jobs;
}

// ── Generic fallback (TimesJobs, Shine, Hirist, etc.) ────────────
const JOB_KEYWORDS = /engineer|developer|manager|analyst|designer|scientist|consultant|lead|architect|intern|executive|officer|specialist|recruiter|\bhr\b|head of/i;
const CITY_PATTERN = /mumbai|delhi|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|remote|india|noida|gurugram|gurgaon|ahmedabad|jaipur/i;

function parseGeneric($, sourceName) {
  const jobs = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!JOB_KEYWORDS.test(text) || text.length < 5 || text.length > 120) return;

    const parent   = $(el).closest('td, div, tr, li');
    const siblings = parent.find('*').not($(el)).map((_, e) => $(e).text().trim()).get().filter(Boolean);
    const company  = siblings.find(s => s.length > 2 && s.length < 60 && !JOB_KEYWORDS.test(s)) || '';
    const loc      = siblings.find(s => CITY_PATTERN.test(s)) || '';

    jobs.push({ title: text, company, location: loc, url: href, source: sourceName, remote: /remote|work from home/i.test(loc) });
  });
  return jobs;
}

// ── Parse one email's HTML body into job objects ──────────────────
function parseEmailToJobs(htmlContent, from, subject) {
  const $      = cheerio.load(htmlContent);
  const source = detectSource(from, subject);

  let jobs = [];
  switch (source) {
    case 'linkedin':    jobs = parseLinkedIn($);               break;
    case 'naukri':      jobs = parseNaukri($);                 break;
    case 'indeed':      jobs = parseIndeed($);                 break;
    case 'foundit':     jobs = parseFoundit($, htmlContent);   break;
    case 'internshala': jobs = parseInternshala($);            break;
    default:            jobs = parseGeneric($, source);        break;
  }

  // Normalize text
  return jobs
    .filter(j => j.title?.length > 2)
    .map(j => ({
      title:    j.title.replace(/\s+/g, ' ').trim(),
      company:  (j.company  || '').replace(/\s+/g, ' ').trim(),
      location: (j.location || '').replace(/\s+/g, ' ').trim(),
      url:      j.url || '',
      source:   j.source || source,
      remote:   !!j.remote,
    }));
}

// ── Decode Gmail payload body ─────────────────────────────────────
function decodeBody(payload) {
  const findHtml = (parts) => {
    for (const part of (parts || [])) {
      if (part.mimeType === 'text/html' && part.body?.data)
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.parts) { const f = findHtml(part.parts); if (f) return f; }
    }
    if (payload?.body?.data)
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    return '';
  };
  return findHtml(payload?.parts || []);
}

// ── Main: fetch all job alert emails from Gmail ───────────────────
const fetchJobAlertEmails = async (accessToken, maxResults = 20) => {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.messages.list({
    userId:     'me',
    q:          COMBINED_QUERY,
    maxResults,
  });

  const messages = response.data.messages || [];
  if (messages.length === 0) { logger.info('No job alert emails found'); return []; }

  logger.info(`Found ${messages.length} job alert emails, parsing...`);

  const allJobs = [];

  for (const msg of messages.slice(0, 15)) {
    try {
      const detail  = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = detail.data.payload?.headers || [];
      const from    = headers.find(h => h.name === 'From')?.value    || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const html    = decodeBody(detail.data.payload);

      if (html) {
        const jobs = parseEmailToJobs(html, from, subject);
        allJobs.push(...jobs);
        logger.info(`Parsed ${jobs.length} jobs from ${from}`);
      }
    } catch (err) {
      logger.warn(`Email parse failed ${msg.id}: ${err.message}`);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return allJobs.filter(j => {
    if (!j.url) return true;
    if (seen.has(j.url)) return false;
    seen.add(j.url); return true;
  });
};

// Backward compat alias
const fetchLinkedInAlertEmails = fetchJobAlertEmails;

module.exports = { fetchJobAlertEmails, fetchLinkedInAlertEmails, parseEmailToJobs };
