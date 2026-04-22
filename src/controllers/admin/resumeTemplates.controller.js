const ResumeTemplate = require('../../models/ResumeTemplate');
const { success } = require('../../utils/response.util');
const { ValidationError, NotFoundError } = require('../../utils/errors');

exports.list = async (req, res, next) => {
  try {
    const rows = await ResumeTemplate.find().sort({ updatedAt: -1 }).lean();
    return success(res, rows);
  } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try {
    const { name, templateCode, description, isActive } = req.body;
    if (!name?.trim() || !templateCode?.trim()) {
      throw new ValidationError('name and templateCode are required');
    }
    if (isActive) {
      await ResumeTemplate.updateMany({}, { $set: { isActive: false } });
    }
    const doc = await ResumeTemplate.create({
      name: name.trim(),
      templateCode,
      description: description || '',
      isActive: !!isActive,
    });
    return success(res, doc, 'Template created');
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    const { name, templateCode, description, isActive } = req.body;
    const doc = await ResumeTemplate.findById(req.params.id);
    if (!doc) throw new NotFoundError('Template not found');
    if (name !== undefined) doc.name = String(name).trim();
    if (templateCode !== undefined) doc.templateCode = templateCode;
    if (description !== undefined) doc.description = description;
    if (isActive === true) {
      await ResumeTemplate.updateMany({ _id: { $ne: doc._id } }, { $set: { isActive: false } });
      doc.isActive = true;
    } else if (isActive === false) {
      doc.isActive = false;
    }
    await doc.save();
    return success(res, doc, 'Template updated');
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    const doc = await ResumeTemplate.findByIdAndDelete(req.params.id);
    if (!doc) throw new NotFoundError('Template not found');
    return success(res, null, 'Template deleted');
  } catch (e) { next(e); }
};
