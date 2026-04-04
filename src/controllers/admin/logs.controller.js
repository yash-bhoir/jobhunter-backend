const ActivityLog   = require('../../models/ActivityLog');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { success, paginated } = require('../../utils/response.util');

exports.getLogs = async (req, res, next) => {
  try {
    const page     = parseInt(req.query.page)     || 1;
    const limit    = parseInt(req.query.limit)    || 50;
    const skip     = (page - 1) * limit;
    const category = req.query.category || null;
    const userId   = req.query.userId   || null;
    const event    = req.query.event    || null;

    const filter = {};
    if (category) filter.category = category;
    if (userId)   filter.userId   = userId;
    if (event)    filter.event    = { $regex: event, $options: 'i' };

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'email profile.firstName profile.lastName')
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    return paginated(res, logs, { total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

exports.getAuditLog = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      AdminAuditLog.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('adminId', 'email')
        .lean(),
      AdminAuditLog.countDocuments(),
    ]);

    return paginated(res, logs, { total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

exports.exportLogs = async (req, res, next) => {
  try {
    const logs = await ActivityLog.find()
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    const XLSX   = require('xlsx');
    const rows   = logs.map(l => [
      l.createdAt, l.userId, l.event, l.category,
      l.creditsUsed, l.ip, JSON.stringify(l.metadata),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'UserID', 'Event', 'Category', 'Credits Used', 'IP', 'Metadata'],
      ...rows,
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Logs');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=logs.xlsx');
    res.send(buffer);
  } catch (err) { next(err); }
};

exports.getErrors = async (req, res, next) => {
  try {
    const logs = await ActivityLog.find({ event: /error|failed/i })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return success(res, logs);
  } catch (err) { next(err); }
};