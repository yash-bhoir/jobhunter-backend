/**
 * Indeed Jobs — public RSS (no API key).
 * Indeed serves RSS behind Cloudflare; server-side requests often get HTTP 403.
 * We fail open (empty list) and log once per search.
 */
const axios  = require('axios');
const Parser = require('rss-parser');
const logger = require('../../config/logger');

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept':          'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://www.indeed.com/',
  },
  customFields: { item: ['description', 'pubDate', 'link', 'title'] },
});

const search = async ({ role, location, workType }) => {
  try {
    const q = workType === 'remote' ? `${role} remote` : role;
    const l = location || '';

    const url = `https://www.indeed.com/rss?q=${encodeURIComponent(q)}&l=${encodeURIComponent(l)}&radius=25&limit=25&sort=date`;

    const raw = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept':          'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.indeed.com/',
      },
      responseType:   'text',
      validateStatus: () => true,
    });

    if (raw.status !== 200) {
      logger.warn(
        `[indeed-rss] HTTP ${raw.status} — Indeed RSS is often blocked (Cloudflare) for server IPs; use JSearch, SerpAPI, or Reed for broader coverage`
      );
      return [];
    }

    const body = typeof raw.data === 'string' ? raw.data : '';

    if (body.trimStart().startsWith('<!DOCTYPE') || body.trimStart().startsWith('<html')) {
      logger.warn('[indeed-rss] blocked — HTML challenge page instead of RSS');
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
