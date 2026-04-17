const hunter  = require('./hunter.service');
const apollo  = require('./apollo.service');
const snov    = require('./snov.service');
const pattern = require('./pattern.service');
const logger  = require('../../config/logger');

// ── Email finder cascade ─────────────────────────────────────────
//
// Layer 0 — Snov.io       (free 50 credits/mo, SNOV_CLIENT_ID + SNOV_CLIENT_SECRET)
// Layer 1 — Hunter.io     (free 50 searches/mo, HUNTER_API_KEY)
// Layer 2 — Apollo people (paid plan only — skipped on free, no crash)
// Layer 3 — Apollo org    (free plan — no emails but returns LinkedIn company URL)
// Layer 4 — Pattern       (always works — guessed emails + career/LinkedIn links)
//
// Free plan users only get career page + LinkedIn links (no guessed emails).
// Pro users go through all layers.

const findHRContacts = async (company, plan = 'free') => {
  const domain   = pattern.extractDomain(company);
  const baseLinks = pattern.generate(domain, company);

  // Always-available links — never empty-handed
  const linksOnly = {
    emails:         [],
    domain,
    careerPageUrl:  baseLinks.careerPageUrl,
    linkedinUrl:    baseLinks.linkedinUrl,
    employeeSearch: baseLinks.employeeSearch,
  };

  // Enrich with real LinkedIn company URL from Apollo (free) in background
  // This runs for all plan types — no credits used
  apollo.searchOrganization(company).then(org => {
    if (org?.linkedin) linksOnly.linkedinUrl = org.linkedin;
    if (org?.website)  linksOnly.domain      = org.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }).catch(() => {});

  // Free plan — return career links only, no emails
  if (plan === 'free') {
    return { ...linksOnly, source: 'pattern' };
  }

  // ── Layer 0: Snov.io ────────────────────────────────────────────
  if (process.env.SNOV_CLIENT_ID && process.env.SNOV_CLIENT_SECRET) {
    try {
      const snovResult = await snov.searchDomain(domain);
      if (snovResult?.emails?.length > 0) {
        logger.info(`[EmailFinder] Snov found ${snovResult.emails.length} emails for ${domain}`);
        return {
          ...linksOnly,
          emails:       snovResult.emails,
          source:       'snov',
          organization: snovResult.organization,
        };
      }
    } catch (err) {
      logger.warn(`[EmailFinder] Snov failed for ${domain}: ${err.message}`);
    }
  }

  // ── Layer 1: Hunter.io ──────────────────────────────────────────
  if (process.env.HUNTER_API_KEY) {
    try {
      const hunterResult = await hunter.searchDomain(domain);
      if (hunterResult?.emails?.length > 0) {
        logger.info(`[EmailFinder] Hunter found ${hunterResult.emails.length} emails for ${domain}`);
        return {
          ...linksOnly,
          emails:       hunterResult.emails,
          source:       'hunter',
          organization: hunterResult.organization,
        };
      }
    } catch (err) {
      // 429 = quota exhausted — log clearly so it's obvious
      if (err.response?.status === 429) {
        logger.warn(`[EmailFinder] Hunter quota exhausted for this billing period`);
      } else {
        logger.warn(`[EmailFinder] Hunter failed for ${domain}: ${err.message}`);
      }
    }
  }

  // ── Layer 2: Apollo people search (paid plan only) ──────────────
  if (process.env.APOLLO_API_KEY) {
    try {
      const apolloResult = await apollo.searchPeople(company);
      if (apolloResult?.length > 0) {
        logger.info(`[EmailFinder] Apollo found ${apolloResult.length} contacts for ${company}`);
        return {
          ...linksOnly,
          emails:    apolloResult,
          employees: apolloResult,
          source:    'apollo',
        };
      }
    } catch (err) {
      logger.warn(`[EmailFinder] Apollo failed for ${company}: ${err.message}`);
    }
  }

  // All layers exhausted — return career links so the UI is never empty
  logger.info(`[EmailFinder] No verified emails for ${company} — returning career links`);
  return { ...linksOnly, source: 'pattern' };
};

module.exports = { findHRContacts };
