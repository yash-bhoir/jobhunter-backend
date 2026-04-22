/**
 * Job listing embeddings for semantic dedupe in GlobalJob ingest.
 * Uses text-embedding-3-small @ 512 dims (configurable) to keep BSON small.
 */
const OpenAI = require('openai');
const crypto = require('crypto');
const logger = require('../../config/logger');

const MODEL     = process.env.JOB_EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMENSION = Math.min(2000, Math.max(256, parseInt(process.env.JOB_EMBEDDING_DIMENSIONS || '512', 10) || 512));

const getClient = () => {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

let _cache = null;
const getCache = () => {
  if (!_cache) {
    try { _cache = require('../../config/redis').cache; } catch { _cache = null; }
  }
  return _cache;
};

function buildEmbedInput(rawJob) {
  const title = String(rawJob.title || '').trim();
  const company = String(rawJob.company || '').trim();
  const loc = String(rawJob.location || '').trim();
  const desc = String(rawJob.description || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return `Title: ${title}\nCompany: ${company}\nLocation: ${loc}\n${desc}`.slice(0, 8000);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * @returns {Promise<number[]|null>}
 */
async function embedJob(rawJob) {
  if (process.env.GLOBAL_JOB_SEM_DEDUP === '0' || process.env.GLOBAL_JOB_SEM_DEDUP === 'false') {
    return null;
  }

  const input = buildEmbedInput(rawJob);
  if (input.length < 12) return null;

  const client = getClient();
  if (!client) return null;

  const keyHash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 40);
  const cacheKey = `jobemb:${keyHash}`;
  try {
    const cached = await getCache()?.get(cacheKey);
    if (cached && Array.isArray(cached)) return cached;
  } catch { /* optional redis */ }

  try {
    const res = await client.embeddings.create({
      model:       MODEL,
      input,
      dimensions:  DIMENSION,
    });
    const vec = res.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.length) return null;
    try {
      await getCache()?.set(cacheKey, vec, 86400 * 7);
    } catch { /* */ }
    return vec;
  } catch (err) {
    logger.warn(`[jobEmbedding] OpenAI embed failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  embedJob,
  cosineSimilarity,
  buildEmbedInput,
  EMBEDDING_MODEL_VERSION: `${MODEL}-${DIMENSION}`,
};
