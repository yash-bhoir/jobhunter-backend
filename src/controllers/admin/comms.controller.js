const User           = require('../../models/User');
const PlatformConfig = require('../../models/PlatformConfig');
const { sendEmail }  = require('../../config/mailer');
const { success }    = require('../../utils/response.util');
const { ValidationError } = require('../../utils/errors');
const logger = require('../../config/logger');

exports.broadcast = async (req, res, next) => {
  try {
    const { subject, html, targetPlan } = req.body;
    if (!subject || !html) throw new ValidationError('Subject and html are required');

    const filter = { status: 'active', emailVerified: true };
    if (targetPlan) filter.plan = targetPlan;

    const users = await User.find(filter).select('email profile.firstName').lean();

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        const personalizedHtml = html.replace(/{name}/g, user.profile?.firstName || 'User');
        await sendEmail({ to: user.email, subject, html: personalizedHtml });
        sent++;
        await new Promise(r => setTimeout(r, 200));
      } catch { failed++; }
    }

    logger.info(`Broadcast sent: ${sent} success, ${failed} failed`);
    return success(res, { sent, failed, total: users.length }, 'Broadcast complete');
  } catch (err) { next(err); }
};

exports.setBanner = async (req, res, next) => {
  try {
    const { message, type, expiresAt } = req.body;
    if (!message) throw new ValidationError('Message is required');

    await PlatformConfig.set('banner', { message, type: type || 'info', expiresAt, active: true }, req.user._id);
    return success(res, null, 'Banner set');
  } catch (err) { next(err); }
};

exports.removeBanner = async (req, res, next) => {
  try {
    await PlatformConfig.set('banner', { active: false }, req.user._id);
    return success(res, null, 'Banner removed');
  } catch (err) { next(err); }
};

exports.setMaintenance = async (req, res, next) => {
  try {
    const { enabled, message } = req.body;
    await PlatformConfig.set('maintenanceMode', { enabled: !!enabled, message }, req.user._id);
    logger.warn(`Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${req.user.email}`);
    return success(res, { enabled }, `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) { next(err); }
};