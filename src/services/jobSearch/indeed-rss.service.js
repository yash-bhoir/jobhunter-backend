/**
 * Indeed Jobs — public RSS feed (no auth required)
 * Free, no API key needed.
 */
const Parser = require('rss-parser');
const logger = require('../../config/logger');

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; JobHunter/1.0)',
  },
  customFields: {
    item: ['description', 'pubDate', 'link', 'title'],
  },
});

const search = async ({ role, location, workType }) => {
  try {
    const q = workType === 'remote'
      ? `${role} remote`
      : role;

    const l = location || '';

    const url = `https://www.indeed.com/rss?q=${encodeURIComponent(q)}&l=${encodeURIComponent(l)}&radius=25&limit=25&sort=date`;

    const feed = await parser.parseURL(url);

    return (feed.items || []).map((item, idx) => {
      // Indeed RSS: title = "Job Title - Company - Location"
      const parts   = (item.title || '').split(' - ');
      const title   = parts[0]?.trim() || item.title || '';
      const company = parts[1]?.trim() || 'Unknown';
      const loc     = parts[2]?.trim() || location || '';

      // Strip HTML from description
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
