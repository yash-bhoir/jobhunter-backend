/**
 * Indeed Jobs — tries public RSS first; when blocked (Cloudflare), falls back to
 * SerpAPI Google Jobs and keeps only rows Google attributes to Indeed (`via`).
 *
 * Requires SERPAPI_KEY for the fallback. If both `indeed-rss` and `serpapi` are
 * selected, SerpAPI may be called twice for the same query (same billable units).
 */
const axios  = require('axios');
const Parser = require('rss-parser');
const logger = require('../../config/logger');
const { fetchGoogleJobsRows } = require('./serpapi.service');

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

function viaIsIndeed(via) {
  return /\bindeed\b/i.test(String(via || ''));
}

const search = async (params) => {
  const { role, location, workType } = params;

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

    if (raw.status === 200) {
      const body = typeof raw.data === 'string' ? raw.data : '';
      if (!body.trimStart().startsWith('<!DOCTYPE') && !body.trimStart().startsWith('<html')) {
        const feed = await parser.parseString(body);
        const fromRss = (feed.items || []).map((item, idx) => {
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
        if (fromRss.length) return fromRss;
      } else {
        logger.warn('[indeed-rss] blocked — HTML challenge page instead of RSS');
      }
    } else {
      logger.warn(
        `[indeed-rss] HTTP ${raw.status} — Indeed RSS often blocked for server IPs; trying SerpAPI Indeed-only fallback if key is set`
      );
    }
  } catch (err) {
    logger.warn(`[indeed-rss] RSS failed: ${err.message}`);
  }

  // ── Fallback: Google Jobs via SerpAPI, rows Google labels as Indeed ─────────
  if (!(process.env.SERPAPI_KEY || '').trim()) {
    return [];
  }

  try {
    const rows = await fetchGoogleJobsRows(params); // keeps _gjCache for single SerpAPI call with serpapi
    const indeedRows = rows.filter(j => viaIsIndeed(j.via));
    if (!indeedRows.length) {
      logger.info(
        `[indeed-rss] SerpAPI fallback: ${rows.length} Google Jobs rows, 0 with via≈Indeed — nothing to show under Indeed`
      );
      return [];
    }
    logger.info(`[indeed-rss] SerpAPI Indeed-only fallback: ${indeedRows.length} jobs`);

    return indeedRows.map((j) => ({
      externalId:  `indeed-gj-${j.job_id || Buffer.from((j.title || '') + (j.company_name || '')).toString('base64').slice(0, 16)}`,
      title:       j.title        || '',
      company:     j.company_name || '',
      location:    j.location     || location || '',
      description: (j.description || '').slice(0, 600),
      url:         j.share_link   || j.related_links?.[0]?.link || '',
      salary:      j.detected_extensions?.salary || 'Not specified',
      source:      'Indeed (via Google Jobs)',
      remote:      j.detected_extensions?.work_from_home || workType === 'remote' || false,
      postedAt:    j.detected_extensions?.posted_at || null,
    }));
  } catch (err) {
    logger.warn(`[indeed-rss] SerpAPI fallback failed: ${err.message}`);
    return [];
  }
};

module.exports = { search };
