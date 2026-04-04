const { google }  = require('googleapis');
const cheerio     = require('cheerio');
const logger      = require('../../config/logger');

// Parse LinkedIn job alert email HTML
const parseLinkedInAlertEmail = (htmlContent) => {
  const $ = cheerio.load(htmlContent);
  const jobs = [];

  // LinkedIn alert email job card selectors
  $('table[data-job-id], .job-card, [class*="job"]').each((_, el) => {
    const title   = $(el).find('a[href*="linkedin.com/jobs"]').first().text().trim() ||
                    $(el).find('strong, b, h3, h4').first().text().trim();
    const company = $(el).find('[class*="company"], [class*="subtitle"]').first().text().trim();
    const loc     = $(el).find('[class*="location"], [class*="geo"]').first().text().trim();
    const link    = $(el).find('a[href*="linkedin.com/jobs"]').first().attr('href');

    if (title && title.length > 3) {
      jobs.push({
        title:   title.replace(/\s+/g, ' ').trim(),
        company: company.replace(/\s+/g, ' ').trim(),
        location: loc.replace(/\s+/g, ' ').trim(),
        url:      link || '',
        source:   'linkedin_email_alert',
        remote:   loc.toLowerCase().includes('remote'),
      });
    }
  });

  // Fallback — try all links to linkedin jobs
  if (jobs.length === 0) {
    $('a[href*="linkedin.com/jobs/view"]').each((_, el) => {
      const text    = $(el).text().trim();
      const href    = $(el).attr('href');
      const parent  = $(el).parent().text().trim();

      if (text && text.length > 3) {
        jobs.push({
          title:   text.replace(/\s+/g, ' ').trim(),
          company: '',
          location: '',
          url:      href || '',
          source:   'linkedin_email_alert',
          remote:   parent.toLowerCase().includes('remote'),
        });
      }
    });
  }

  return jobs;
};

// Fetch LinkedIn alert emails from Gmail API
const fetchLinkedInAlertEmails = async (accessToken, maxResults = 10) => {
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    const gmail   = google.gmail({ version: 'v1', auth });

    // Search for LinkedIn job alert emails
    const response = await gmail.users.messages.list({
      userId:   'me',
      q:        'from:jobalerts-noreply@linkedin.com OR from:jobs-listings@linkedin.com OR subject:"job alert" from:linkedin.com',
      maxResults,
    });

    const messages = response.data.messages || [];
    if (messages.length === 0) {
      logger.info('No LinkedIn alert emails found');
      return [];
    }

    const allJobs = [];

    for (const msg of messages.slice(0, 5)) { // Process max 5 emails
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id:     msg.id,
          format: 'full',
        });

        // Get HTML body
        const parts   = detail.data.payload?.parts || [];
        let htmlBody   = '';

        const findHtml = (parts) => {
          for (const part of parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
              return Buffer.from(part.body.data, 'base64').toString('utf8');
            }
            if (part.parts) {
              const found = findHtml(part.parts);
              if (found) return found;
            }
          }
          // Check main body
          if (detail.data.payload?.body?.data) {
            return Buffer.from(detail.data.payload.body.data, 'base64').toString('utf8');
          }
          return '';
        };

        htmlBody = findHtml(parts);

        if (htmlBody) {
          const jobs = parseLinkedInAlertEmail(htmlBody);
          allJobs.push(...jobs);
          logger.info(`Parsed ${jobs.length} jobs from LinkedIn alert email`);
        }
      } catch (err) {
        logger.warn(`Failed to parse email ${msg.id}: ${err.message}`);
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    return allJobs.filter(j => {
      if (!j.url || seen.has(j.url)) return j.url ? false : true;
      seen.add(j.url);
      return true;
    });

  } catch (err) {
    logger.error(`Gmail API error: ${err.message}`);
    throw err;
  }
};

module.exports = { fetchLinkedInAlertEmails, parseLinkedInAlertEmail };