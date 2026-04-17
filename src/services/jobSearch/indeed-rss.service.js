/**
 * Indeed Jobs — public RSS feed (no auth required)
 * Falls back gracefully if Indeed blocks the RSS (returns HTML).
 */
const axios  = require('axios');
const Parser = require('rss-parser');
const logger = require('../../config/logger');

const parser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHunter/1.0)' },
  customFields: { item: ['description', 'pubDate', 'link', 'title'] },
});

const search = async ({ role, location, workType }) => {
  try {
    const q = workType === 'remote' ? `${role} remote` : role;
    const l = location || '';

    const url = `https://www.indeed.com/rss?q=${encodeURIComponent(q)}&l=${encodeURIComponent(l)}&radius=25&limit=25&sort=date`;

    // Fetch raw first so we can detect HTML responses (Indeed blocks RSS in some regions)
    const raw = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHunter/1.0)' },
      responseType: 'text',
    });

    const body = typeof raw.data === 'string' ? raw.data : '';

    // If Indeed returned an HTML page instead of XML, bail out gracefully
    if (body.trimStart().startsWith('<!DOCTYPE') || body.trimStart().startsWith('<html')) {
      logger.warn('[indeed-rss] blocked — received HTML instead of RSS feed');
      return [];
    }

    const feed = await parser.parseString(body);

    return (feed.items || []).map((item, idx) => {
      const parts   = (item.title || '').split(' - ');
      const title   = parts[0]?.trim() || item.title || '';
      const company = parts[1]?.trim() || 'Unknown';
      const loc     = parts[2]?.trim() || location || '';

      const desc = (item.contentSnippet || item.description || '')
        .replace(/<[^>]*>/g, '')
        .slice(0, 600);

      return {
        externalId:  `indeed-${idx}-${Buffer.from(item.link || '').toString('base64').slice(0, 12)}`,
        title,
        company,
        location:    loc,
        description: desc,
        url:         item.link || '',
        salary:      'Not specified',
        source:      'Indeed',
        remote:      workType === 'remote' || loc.toLowerCase().includes('remote'),
        postedAt:    item.pubDate ? new Date(item.pubDate).toISOString() : null,
      };
    });
  } catch (err) {
    logger.warn(`[indeed-rss] failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
