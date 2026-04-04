const { success } = require('../../utils/response.util');
const AdminAuditLog = require('../../models/AdminAuditLog');

const API_KEYS = [
  // ── Existing search platforms ────────────────────────────────────
  { key: 'RAPIDAPI_KEY',            label: 'RapidAPI (JSearch)',                 category: 'search', paid: true  },
  { key: 'ADZUNA_APP_ID',           label: 'Adzuna App ID',                      category: 'search', paid: true  },
  { key: 'ADZUNA_APP_KEY',          label: 'Adzuna App Key',                     category: 'search', paid: true  },
  // ── New paid platforms (admin must add key + enable in Platform Config) ──
  { key: 'SERPAPI_KEY',             label: 'SerpAPI (Google Jobs)',              category: 'search', paid: true,
    note: 'Enable platform "serpapi" in Platform Config after adding key. ~$50/mo for 5000 searches.' },
  { key: 'REED_API_KEY',            label: 'Reed.co.uk',                         category: 'search', paid: true,
    note: 'Enable platform "reed" in Platform Config after adding key. Free tier: 100 calls/day.' },
  // ── Email finders ────────────────────────────────────────────────
  { key: 'HUNTER_API_KEY',          label: 'Hunter.io',                          category: 'email',  paid: true  },
  { key: 'APOLLO_API_KEY',          label: 'Apollo.io',                          category: 'email',  paid: true  },
  // ── AI ───────────────────────────────────────────────────────────
  { key: 'OPENAI_API_KEY',          label: 'OpenAI',                             category: 'ai',     paid: true  },
  // ── Storage ──────────────────────────────────────────────────────
  { key: 'CLOUDINARY_CLOUD_NAME',   label: 'Cloudinary Name',                    category: 'storage', paid: false },
  { key: 'CLOUDINARY_API_KEY',      label: 'Cloudinary Key',                     category: 'storage', paid: true  },
  // ── Billing ──────────────────────────────────────────────────────
  { key: 'RAZORPAY_KEY_ID',         label: 'Razorpay Key ID',                    category: 'billing', paid: true  },
];

exports.getAll = async (req, res, next) => {
  try {
    const keys = API_KEYS.map(k => ({
      key:        k.key,
      label:      k.label,
      category:   k.category,
      paid:       k.paid ?? true,
      note:       k.note || null,
      configured: !!process.env[k.key],
      maskedValue: process.env[k.key]
        ? `${'*'.repeat(Math.max(0, process.env[k.key].length - 4))}${process.env[k.key].slice(-4)}`
        : null,
    }));
    return success(res, keys);
  } catch (err) { next(err); }
};

// ── List all job platforms + their enabled/disabled state ─────────
exports.getPlatforms = async (req, res, next) => {
  try {
    const { getPlatformList } = require('../../services/jobSearch');
    const PlatformConfig      = require('../../models/PlatformConfig');
    const platforms           = getPlatformList();

    // Load DB overrides
    const keys    = platforms.map(p => `platform.${p.name}.enabled`);
    const configs = await PlatformConfig.find({ key: { $in: keys } }).lean();
    const dbMap   = Object.fromEntries(configs.map(c => [c.key, c.value]));

    const result = platforms.map(p => {
      const dbKey    = `platform.${p.name}.enabled`;
      const dbValue  = dbMap[dbKey];
      const enabled  = dbValue !== undefined ? dbValue : p.defaultEnabled;
      return {
        name:           p.name,
        type:           p.type,
        defaultEnabled: p.defaultEnabled,
        enabled,
        adminOverride:  dbValue !== undefined,
      };
    });

    return success(res, result);
  } catch (err) { next(err); }
};

// ── Toggle a platform on or off ───────────────────────────────────
exports.togglePlatform = async (req, res, next) => {
  try {
    const { name }    = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled must be boolean' });
    }

    const PlatformConfig = require('../../models/PlatformConfig');
    await PlatformConfig.set(`platform.${name}.enabled`, enabled, req.user._id);

    await AdminAuditLog.create({
      adminId:    req.user._id,
      action:     'platform.toggled',
      targetType: 'Platform',
      after:      { name, enabled },
      ip:         req.ip,
    });

    return success(res, { name, enabled }, `Platform "${name}" ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { value } = req.body;
    const keyConfig = API_KEYS.find(k => k.key === req.params.key);
    if (!keyConfig) {
      return res.status(400).json({ success: false, message: 'Unknown API key' });
    }

    // Update in process.env (runtime only — persists until restart)
    process.env[req.params.key] = value;

    await AdminAuditLog.create({
      adminId:    req.user._id,
      action:     'apikey.updated',
      targetType: 'ApiKey',
      after:      { key: req.params.key },
      ip:         req.ip,
    });

    return success(res, null, `${keyConfig.label} updated`);
  } catch (err) { next(err); }
};

exports.testKey = async (req, res, next) => {
  try {
    const keyName = req.params.key;
    const value   = process.env[keyName];

    if (!value) {
      return success(res, { working: false, message: 'Key not configured' });
    }

    // Test Hunter.io
    if (keyName === 'HUNTER_API_KEY') {
      const axios = require('axios');
      const { data } = await axios.get('https://api.hunter.io/v2/account', {
        params: { api_key: value }, timeout: 5000,
      });
      return success(res, { working: true, plan: data?.data?.plan_name, requests: data?.data?.requests });
    }

    // Test OpenAI
    if (keyName === 'OPENAI_API_KEY') {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: value });
      const models = await client.models.list();
      return success(res, { working: true, models: models.data.length });
    }

    return success(res, { working: true, message: 'Key is set' });
  } catch (err) {
    return success(res, { working: false, error: err.message });
  }
};