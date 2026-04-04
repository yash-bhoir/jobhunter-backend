const PlatformConfig = require('../../models/PlatformConfig');
const AdminAuditLog  = require('../../models/AdminAuditLog');
const { success }    = require('../../utils/response.util');
const { NotFoundError, ValidationError } = require('../../utils/errors');

exports.getAll = async (req, res, next) => {
  try {
    const category = req.query.category || null;
    const configs  = await PlatformConfig.find(category ? { category } : {}).lean();
    return success(res, configs);
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const config = await PlatformConfig.findOne({ key: req.params.key });
    if (!config) throw new NotFoundError('Config key not found');
    return success(res, config);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { value, description, category } = req.body;
    if (value === undefined) throw new ValidationError('Value is required');

    const config = await PlatformConfig.findOneAndUpdate(
      { key: req.params.key },
      { value, description, category, updatedBy: req.user._id },
      { upsert: true, new: true }
    );

    await AdminAuditLog.create({
      adminId:    req.user._id,
      action:     'config.updated',
      targetType: 'Config',
      targetId:   config._id,
      after:      { key: req.params.key, value },
      ip:         req.ip,
    });

    return success(res, config, 'Config updated');
  } catch (err) { next(err); }
};

exports.bulkUpdate = async (req, res, next) => {
  try {
    const { configs } = req.body;
    if (!configs?.length) throw new ValidationError('No configs provided');

    const results = [];
    for (const { key, value, description, category } of configs) {
      const config = await PlatformConfig.findOneAndUpdate(
        { key },
        { value, description, category, updatedBy: req.user._id },
        { upsert: true, new: true }
      );
      results.push(config);
    }

    return success(res, results, `${results.length} configs updated`);
  } catch (err) { next(err); }
};