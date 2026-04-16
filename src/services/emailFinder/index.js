const hunter  = require('./hunter.service');
const apollo  = require('./apollo.service');
const pattern = require('./pattern.service');
const logger  = require('../../config/logger');

const findHRContacts = async (company, plan = 'free') => {
  const domain = pattern.extractDomain(company);
  const base   = pattern.generate(domain, company);

  // Pattern emails are guesses — strip them, keep only career links
  const linksOnly = {
    emails:         [],          // no pattern emails
    careerPageUrl:  base.careerPageUrl,
    linkedinUrl:    base.linkedinUrl,
    employeeSearch: base.employeeSearch,
    domain,
  };

  // Free plan — return career links only, no guessed emails
  if (plan === 'free') {
    return { ...linksOnly, source: 'pattern' };
  }

  // Layer 1 — Hunter.io (Pro+)
  try {
    const hunterResult = await hunter.searchDomain(domain);
    if (hunterResult?.emails?.length > 0) {
      logger.info(`Hunter found ${hunterResult.emails.length} emails for ${domain}`);
      return {
        ...linksOnly,
        emails:       hunterResult.emails,
        source:       'hunter',
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
        ...linksOnly,
        emails:    apolloResult,
        employees: apolloResult,
        source:    'apollo',
      };
    }
  } catch (err) {
    logger.warn(`Apollo failed for ${company}: ${err.message}`);
  }

  // No real emails found — return career links only
  logger.info(`No verified emails found for ${company} — returning career links only`);
  return { ...linksOnly, source: 'pattern' };
};

module.exports = { findHRContacts };