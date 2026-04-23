/**
 * Company name suggestions: indexed job boards + optional Clearbit directory names.
 */

const axios = require('axios');
const { GREENHOUSE, ASHBY, LEVER } = require('./portals');

function allPortalCompanies() {
  return [
    ...GREENHOUSE.map((c) => ({ ...c, platform: 'greenhouse' })),
    ...ASHBY.map((c) => ({ ...c, platform: 'ashby' })),
    ...LEVER.map((c) => ({ ...c, platform: 'lever' })),
  ];
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co\.?|plc|group|hq)\b\.?/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function portalKey(c) {
  return `${c.platform}:${c.slug}`;
}

/** Fuzzy ranked matches from our indexed boards only. */
function suggestPortals(query, excludeKeys, limit = 14) {
  const nq = norm(query);
  if (nq.length < 1) return [];
  const exclude = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys || []);
  const list    = allPortalCompanies().filter((c) => !exclude.has(portalKey(c)));

  const scored = list
    .map((c) => {
      const name = c.name.toLowerCase();
      const slug = c.slug.toLowerCase();
      const nqSp = nq.split(' ').filter((w) => w.length > 1);
      let score = 0;
      if (name.startsWith(nq) || slug.startsWith(nq)) score += 120;
      else if (name.includes(nq) || slug.includes(nq)) score += 70;
      for (const w of nqSp) {
        if (w.length < 2) continue;
        if (name.includes(w)) score += 28;
        if (slug.includes(w)) score += 22;
      }
      if (norm(c.name) === nq || slug === nq.replace(/\s/g, '')) score += 40;
      if (score === 0) return null;
      return { c, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => ({
      kind:     'tracked',
      platform: x.c.platform,
      slug:     x.c.slug,
      name:     x.c.name,
    }));

  return scored;
}

function wordOverlapScore(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 1));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

/** Map a directory-style company name to our closest indexed board (if any). */
function resolveNameToPortal(companyName, flat = allPortalCompanies()) {
  const nn = norm(companyName);
  if (!nn) return null;
  let best = null;
  let bestScore = 0;
  for (const c of flat) {
    const pn = norm(c.name);
    let score = 0;
    if (pn === nn) score = 200;
    else if (pn.includes(nn) || nn.includes(pn)) score = 95;
    else {
      score = wordOverlapScore(companyName, c.name) * 80;
      const slug = c.slug.toLowerCase();
      if (nn.split(' ').some((w) => w.length > 2 && slug.includes(w))) score += 25;
    }
    if (score > bestScore) {
      bestScore = score;
      best      = c;
    }
  }
  if (bestScore >= 52) {
    return { platform: best.platform, slug: best.slug, name: best.name };
  }
  return null;
}

async function fetchClearbitCompanies(query) {
  const q = String(query || '').trim().slice(0, 64);
  if (q.length < 2) return [];
  try {
    const { data } = await axios.get('https://autocomplete.clearbit.com/v1/companies/suggest', {
      params: { query: q },
      timeout:            4000,
      validateStatus:     (s) => s < 500,
      headers:            { Accept: 'application/json' },
    });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} query
 * @param {Set<string>|string[]} excludeBoardKeys  `platform:slug` already watched
 */
async function getCompanySuggestions(query, excludeBoardKeys) {
  const q = String(query || '').trim();
  const exclude = excludeBoardKeys instanceof Set ? excludeBoardKeys : new Set(excludeBoardKeys || []);
  const flat      = allPortalCompanies();

  if (q.length < 2) {
    const alpha = flat
      .filter((c) => !exclude.has(portalKey(c)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 18)
      .map((c) => ({ kind: 'tracked', platform: c.platform, slug: c.slug, name: c.name }));
    return alpha;
  }

  const out       = [];
  const seenNames = new Set();

  const portalHits = suggestPortals(q, exclude, 14);
  for (const p of portalHits) {
    const nk = norm(p.name);
    if (seenNames.has(nk)) continue;
    seenNames.add(nk);
    out.push(p);
  }

  const external = await fetchClearbitCompanies(q);
  for (const row of external.slice(0, 14)) {
    if (!row?.name) continue;
    const nk = norm(row.name);
    if (seenNames.has(nk)) continue;
    seenNames.add(nk);

    const resolved = resolveNameToPortal(row.name, flat);
    out.push({
      kind:           'directory',
      name:           row.name,
      domain:         row.domain || null,
      logo:           row.logo || null,
      resolvedPortal: resolved,
    });
  }

  return out.slice(0, 28);
}

module.exports = { getCompanySuggestions, suggestPortals, resolveNameToPortal, allPortalCompanies };
