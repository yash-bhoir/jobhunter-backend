/**
 * Minimal Apify REST helper — run-sync-get-dataset-items (no apify-client dependency).
 * @see https://docs.apify.com/api/v2#/Actors/ActorsActorRunSyncGetDatasetItemsPost
 */
const axios = require('axios');

function getApifyToken() {
  return (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '').trim();
}

/**
 * @param {string} actorPath e.g. automation-lab~naukri-scraper
 * @param {object} input    Actor-specific JSON body
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object[]>} Dataset items (empty array if none)
 */
async function apifyRunSyncGetDatasetItems(actorPath, input, opts = {}) {
  const token = getApifyToken();
  if (!token) throw new Error('APIFY_TOKEN missing');

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 180000, 5000), 300000);
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorPath)}/run-sync-get-dataset-items`;

  const { data, status } = await axios.post(url, input, {
    params:  { token },
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });

  if (status >= 400) {
    const body = typeof data === 'string' ? data : JSON.stringify(data || {}).slice(0, 600);
    throw new Error(`Apify HTTP ${status}: ${body}`);
  }
  return Array.isArray(data) ? data : [];
}

module.exports = { getApifyToken, apifyRunSyncGetDatasetItems };
