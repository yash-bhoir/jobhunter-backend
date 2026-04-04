const hunter  = require('./hunter.service');
const apollo  = require('./apollo.service');
const pattern = require('./pattern.service');
const logger  = require('../../config/logger');

const findHRContacts = async (company, plan = 'free') => {
  const domain = pattern.extractDomain(company);
  const base   = pattern.generate(domain, company);

  // Free plan — pattern only
  if (plan === 'free') {
    return { ...base, source: 'pattern' };
  }

  // Layer 1 — Hunter.io (Pro+)
  try {
    const hunterResult = await hunter.searchDomain(domain);
    if (hunterResult?.emails?.length > 0) {
      logger.info(`Hunter found ${hunterResult.emails.length} emails for ${domain}`);
      return {
        ...base,
        emails: hunterResult.emails,
        source: 'hunter',
        organization: hunterResult.organization,
      };
    }
  } catch (err) {
    logger.warn(`Hunter failed for ${domain}: ${err.message}`);
  }

  // Layer 2 — Apollo.io (Pro+)
  try {
    const apolloResult = await apollo.searchPeople(company);
    if (apolloResult?.length > 0) {
      logger.info(`Apollo found ${apolloResult.length} contacts for ${company}`);
      return {
        ...base,
        emails:    apolloResult,
        employees: apolloResult,
        source:    'apollo',
      };
    }
  } catch (err) {
    logger.warn(`Apollo failed for ${company}: ${err.message}`);
  }

  // Layer 3 — Pattern fallback (always works)
  logger.info(`Using pattern emails for ${company}`);
  return { ...base, source: 'pattern' };
};

module.exports = { findHRContacts };