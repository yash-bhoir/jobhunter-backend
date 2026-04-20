const { google }  = require('googleapis');
const cheerio     = require('cheerio');
const logger      = require('../../config/logger');

// ── Build Gmail search query ──────────────────────────────────────
// Casts a wide net: known senders + broad subject keywords
// daysBack=0 means no time limit
const buildQuery = (daysBack = 30) => {
  const time = daysBack > 0 ? ` newer_than:${daysBack}d` : '';

  const knownSenders = [
    'from:jobalerts-noreply@linkedin.com',
    'from:jobs-listings@linkedin.com',
    'from:mailer.naukri.com',
    'from:alert@indeed.com',
    'from:noreply@indeed.com',
    'from:indeedemail.com',
    'from:alerts@in.indeed.com',
    'from:jobalert@indeed.com',
    'from:foundit.in',
    'from:alerts@foundit.in',
    'from:internshala.com',
    'from:timesjobs.com',
    'from:shine.com',
    'from:instahyre.com',
    'from:hirist.tech',
    'from:noreply@instahyre.com',
    'from:alerts@cutshort.io',
    'from:noreply@wellfound.com',
    'from:noreply@angellist.com',
    'from:jobs@glassdoor.com',
    'from:noreply@glassdoor.com',
    'from:alerts@iimjobs.com',
    'from:noreply@freshersworld.com',
    'from:jobs@monsterindia.com',
  ].join(' OR ');

  // Broad subject keywords — catches any job portal alert
  const subjects = [
    'subject:"job alert"',
    'subject:"jobs for you"',
    'subject:"new jobs"',
    'subject:"job recommendations"',
    'subject:"jobs matching"',
    'subject:"recommended jobs"',
    'subject:"jobs you might like"',
    'subject:"new job"',
    'subject:"job opening"',
    'subject:"job openings"',
    'subject:"hiring"',
    'subject:"we found jobs"',
    'subject:"jobs near you"',
    'subject:"apply now"',
    'subject:"career opportunity"',
    'subject:"career opportunities"',
    'subject:"job opportunity"',
    'subject:"job opportunities"',
    'subject:"vacancy"',
    'subject:"vacancies"',
    'subject:"positions matching"',
    'subject:"roles matching"',
    'subject:"fresh jobs"',
  ].map(s => `(${s}${time})`).join(' OR ');

  return `(${knownSenders}) OR (${subjects})`;
};

const CITY_RE    = /mumbai|delhi|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|remote|india|noida|gurugram|gurgaon|ahmedabad|jaipur|navi mumbai|thane|bhopal|nagpur|surat|kochi|chandigarh|nationwide/i;
const JOB_KW_RE  = /engineer|developer|manager|analyst|designer|scientist|consultant|lead|architect|intern|executive|officer|specialist|recruiter|\bhr\b|head of|director|associate|coordinator/i;
const NOISE_RE   = /^\d+$|^(view|apply|see|click|here|job|jobs|more|less|new|easy apply|promoted|actively recruiting|linkedin|naukri|indeed|foundit|internshala|shine|hirist|instahyre|timesjobs)$/i;

// ── Source detection ──────────────────────────────────────────────
function detectSource(from, subject) {
  const f = (from || '').toLowerCase();
  if (f.includes('linkedin.com'))    return 'linkedin';
  if (f.includes('naukri.com'))      return 'naukri';
  if (f.includes('indeed.com') || f.includes('indeedemail') || f.includes('in.indeed')) return 'indeed';
  if (f.includes('foundit.in') || f.includes('monster.com')) return 'foundit';
  if (f.includes('internshala.com')) return 'internshala';
  if (f.includes('timesjobs.com'))   return 'timesjobs';
  if (f.includes('shine.com'))       return 'shine';
  if (f.includes('instahyre.com'))   return 'instahyre';
  if (f.includes('hirist'))          return 'hirist';
  return 'email_alert';
}

// ── Extract clean text nodes from a cheerio element ──────────────
// Returns array of non-empty text strings from all child nodes
function extractTexts($, el) {
  const texts = [];
  $(el).find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') {
      const t = (node.data || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length > 1 && !NOISE_RE.test(t)) texts.push(t);
    }
  });
  // Deduplicate adjacent identical values
  return texts.filter((t, i) => t !== texts[i - 1]);
}

// ── Walk up DOM to find job container ────────────────────────────
// For a given anchor, find the enclosing block (td/div/li/article)
function findContainer($, anchor) {
  let el = $(anchor).parent();
  for (let i = 0; i < 6; i++) {
    const tag = el.get(0)?.tagName?.toLowerCase();
    if (!tag || tag === 'body' || tag === 'html') break;
    if (['td', 'div', 'li', 'article', 'section'].includes(tag)) return el;
    el = el.parent();
  }
  return $(anchor).parent();
}

// ── LinkedIn ──────────────────────────────────────────────────────
function parseLinkedIn($) {
  const jobs = [];
  const seen = new Set();

  // LinkedIn sends both /jobs/view and /comm/jobs/view URLs
  $('a[href*="linkedin.com/jobs"], a[href*="linkedin.com/comm/jobs"]').each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();

    if (title.length < 3 || !JOB_KW_RE.test(title)) return;

    const key = url || title;
    if (seen.has(key)) return;
    seen.add(key);

    // Find the immediate parent td or div that wraps this job's info
    const container = findContainer($, anchor);

    // Extract all non-noise text from the container
    const texts = extractTexts($, container).filter(t => t !== title);

    // Company = first non-city, non-noise text
    const company = texts.find(t =>
      !CITY_RE.test(t) &&
      !t.match(/^\d+/) &&
      t.length > 1 && t.length < 80
    ) || '';

    // Location = first text matching city pattern
    const location = texts.find(t => CITY_RE.test(t)) || '';

    const cleanLocation = location.replace(/\s*·\s*.+$/, '').trim();
    const usedTexts     = new Set([title, company, cleanLocation]);
    const description   = texts
      .filter(t => !usedTexts.has(t) && t.length > 20 && !NOISE_RE.test(t) && !CITY_RE.test(t))
      .slice(0, 3).join(' · ');

    jobs.push({
      title, company,
      location: cleanLocation,
      url, description,
      source: 'linkedin',
      remote: /remote/i.test(location),
    });
  });

  return jobs;
}

// ── Naukri ────────────────────────────────────────────────────────
function parseNaukri($) {
  const jobs = [];
  const seen = new Set();

  $('a[href*="naukri.com"]').each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (title.length < 3 || !JOB_KW_RE.test(title)) return;
    if (seen.has(url || title)) return;
    seen.add(url || title);

    const container = findContainer($, anchor);
    const texts     = extractTexts($, container).filter(t => t !== title);

    const company  = texts.find(t => !CITY_RE.test(t) && t.length > 1 && t.length < 80) || '';
    const location = texts.find(t => CITY_RE.test(t)) || '';

    jobs.push({
      title, company,
      location: location.replace(/\s*[\|·]\s*.+$/, '').trim(),
      url, source: 'naukri',
      remote: /remote|work from home|wfh/i.test(location),
    });
  });

  return jobs;
}

// ── Indeed ────────────────────────────────────────────────────────
function parseIndeed($) {
  const jobs = [];
  const seen = new Set();

  $('a[href*="indeed.com"], a[href*="indeedemail.com"], a[href*="in.indeed.com"]').each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    // Accept any Indeed job link — /viewjob, /rc/clk, /jobs, /pagead/clk
    if (!url.match(/indeed\.com\/(viewjob|rc\/clk|jobs|pagead|clk)/)) return;
    if (title.length < 3) return;
    if (seen.has(url || title)) return;
    seen.add(url || title);

    const container = findContainer($, anchor);
    const texts     = extractTexts($, container).filter(t => t !== title);

    const company  = texts.find(t => !CITY_RE.test(t) && t.length > 1 && t.length < 80) || '';
    const location = texts.find(t => CITY_RE.test(t)) || '';

    jobs.push({
      title, company,
      location: location.replace(/\s*[\|·]\s*.+$/, '').trim(),
      url, source: 'indeed',
      remote: /remote/i.test(location),
    });
  });

  return jobs;
}

// ── Foundit / Monster ─────────────────────────────────────────────
function parseFoundit($, html) {
  const domain = html.includes('foundit.in') ? 'foundit.in' : 'monster.com';
  const jobs   = [];
  const seen   = new Set();

  $(`a[href*="${domain}"]`).each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (title.length < 3 || !JOB_KW_RE.test(title)) return;
    if (seen.has(url || title)) return;
    seen.add(url || title);

    const container = findContainer($, anchor);
    const texts     = extractTexts($, container).filter(t => t !== title);

    const company  = texts.find(t => !CITY_RE.test(t) && t.length > 1 && t.length < 80) || '';
    const location = texts.find(t => CITY_RE.test(t)) || '';

    jobs.push({
      title, company,
      location: location.replace(/\s*[\|·]\s*.+$/, '').trim(),
      url, source: 'foundit',
      remote: /remote|work from home/i.test(location),
    });
  });

  return jobs;
}

// ── Internshala ───────────────────────────────────────────────────
function parseInternshala($) {
  const jobs = [];
  const seen = new Set();

  $('a[href*="internshala.com"]').each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (!url.includes('/jobs') && !url.includes('/internship')) return;
    if (title.length < 3) return;
    if (seen.has(url || title)) return;
    seen.add(url || title);

    const container = findContainer($, anchor);
    const texts     = extractTexts($, container).filter(t => t !== title);

    const company  = texts.find(t => !CITY_RE.test(t) && t.length > 1 && t.length < 80) || '';
    const location = texts.find(t => CITY_RE.test(t)) || 'India';

    jobs.push({
      title, company,
      location: location.replace(/\s*[\|·]\s*.+$/, '').trim(),
      url, source: 'internshala',
      remote: /remote|work.from.home/i.test(location + url),
    });
  });

  return jobs;
}

// ── Generic fallback (TimesJobs, Shine, Hirist, etc.) ────────────
function parseGeneric($, sourceName) {
  const jobs = [];
  const seen = new Set();

  $('a').each((_, anchor) => {
    const url   = $(anchor).attr('href') || '';
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (!JOB_KW_RE.test(title) || title.length < 5 || title.length > 120) return;
    if (seen.has(url || title)) return;
    seen.add(url || title);

    const container = findContainer($, anchor);
    const texts     = extractTexts($, container).filter(t => t !== title);

    const company  = texts.find(t => !CITY_RE.test(t) && t.length > 1 && t.length < 80) || '';
    const location = texts.find(t => CITY_RE.test(t)) || '';

    jobs.push({
      title, company,
      location: location.replace(/\s*[\|·]\s*.+$/, '').trim(),
      url, source: sourceName,
      remote: /remote|work from home/i.test(location),
    });
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
const fetchJobAlertEmails = async (accessToken, maxResults = 20, daysBack = 30) => {
  // Validate params
  maxResults = Math.min(Math.max(parseInt(maxResults) || 20, 1), 200);
  daysBack   = Math.min(Math.max(parseInt(daysBack)   || 30, 0), 365);

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });

  const query = buildQuery(daysBack);
  logger.info(`Gmail query (daysBack=${daysBack}, max=${maxResults}): ${query.slice(0, 120)}...`);

  // Pass maxResults directly to Gmail API — don't over-fetch then slice
  const response = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults: maxResults,
  });

  const messages = response.data.messages || [];
  if (messages.length === 0) { logger.info('No job alert emails found'); return []; }

  logger.info(`Found ${messages.length} job alert emails, parsing...`);

  const allJobs = [];

  for (const msg of messages) {
    try {
      const detail  = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full',
      });
      const headers = detail.data.payload?.headers || [];
      const from    = headers.find(h => h.name === 'From')?.value    || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const html    = decodeBody(detail.data.payload);

      if (html) {
        const jobs = parseEmailToJobs(html, from, subject);
        allJobs.push(...jobs);
        logger.info(`Parsed ${jobs.length} jobs from: ${from} | Subject: ${subject}`);
      } else {
        logger.warn(`No HTML body in email from: ${from}`);
      }
    } catch (err) {
      logger.warn(`Email parse failed ${msg.id}: ${err.message}`);
    }
  }

  // Deduplicate by URL, then by title+company
  const seenUrls   = new Set();
  const seenTitles = new Set();

  return allJobs.filter(j => {
    if (j.url) {
      if (seenUrls.has(j.url)) return false;
      seenUrls.add(j.url);
    }
    const titleKey = `${j.title}__${j.company}`.toLowerCase();
    if (seenTitles.has(titleKey)) return false;
    seenTitles.add(titleKey);
    return true;
  });
};

// Backward compat alias
const fetchLinkedInAlertEmails = fetchJobAlertEmails;

module.exports = { fetchJobAlertEmails, fetchLinkedInAlertEmails, parseEmailToJobs };
