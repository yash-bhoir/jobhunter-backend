const axios  = require('axios');
const logger = require('../../config/logger');

// Snov.io — free tier: 50 email credits/month
// Docs: https://snov.io/api
// Register at snov.io → Settings → API Keys → copy Client ID + Secret

const BASE = 'https://api.snov.io';

// Snov.io uses OAuth2 client_credentials — get token first, then call API
const getToken = async () => {
  const { data } = await axios.post(`${BASE}/v1/oauth/access_token`, {
    grant_type:    'client_credentials',
    client_id:     process.env.SNOV_CLIENT_ID,
    client_secret: process.env.SNOV_CLIENT_SECRET,
  }, { timeout: 8000 });
  return data.access_token;
};

// Domain search — find all emails at a company domain (uses 1 credit per result)
const searchDomain = async (domain) => {
  if (!process.env.SNOV_CLIENT_ID || !process.env.SNOV_CLIENT_SECRET) return null;

  try {
    const token = await getToken();

    const { data } = await axios.get(`${BASE}/v2/domain-emails-with-info`, {
      params: {
        domain,
        type:  'personal',
        limit: 10,
        lastId: 0,
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    if (!data?.emails?.length) return null;

    const emails = data.emails.map(e => ({
      email:      e.email,
      name:       `${e.firstName || ''} ${e.lastName || ''}`.trim() || 'Unknown',
      title:      e.position || 'HR',
      confidence: e.confidence || 50,
      source:     'snov',
      status:     e.emailStatus === 'valid' ? 'verified' : 'predicted',
      linkedin:   null,
    }));

    logger.info(`[Snov] found ${emails.length} emails for ${domain}`);
    return { domain, emails, organization: data.companyName || null };
  } catch (err) {
    logger.warn(`[Snov] searchDomain failed for ${domain}: ${err.message}`);
    return null;
  }
};

// Find email for a specific person by name + domain (uses 1 credit)
const findEmail = async (domain, firstName, lastName) => {
  if (!process.env.SNOV_CLIENT_ID || !process.env.SNOV_CLIENT_SECRET) return null;

  try {
    const token = await getToken();

    const { data } = await axios.post(`${BASE}/v1/get-emails-from-names`, {
      firstName,
      lastName,
      domain,
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    if (!data?.data?.emails?.[0]) return null;

    const e = data.data.emails[0];
    return {
      email:      e.email,
      confidence: e.confidence || 50,
      source:     'snov',
      status:     e.emailStatus === 'valid' ? 'verified' : 'predicted',
    };
  } catch (err) {
    logger.warn(`[Snov] findEmail failed: ${err.message}`);
    return null;
  }
};

module.exports = { searchDomain, findEmail };
