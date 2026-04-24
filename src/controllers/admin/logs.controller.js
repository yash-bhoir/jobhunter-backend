const ActivityLog   = require('../../models/ActivityLog');
const AdminAuditLog = require('../../models/AdminAuditLog');
const ErrorLog      = require('../../models/ErrorLog');
const { success, paginated } = require('../../utils/response.util');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    if (event)    filter.event    = { $regex: escapeRegex(event), $options: 'i' };

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

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Logs', { views: [{ state: 'frozen', ySplit: 1 }] });

    ws.addRow(['Date', 'UserID', 'Event', 'Category', 'Credits Used', 'IP', 'Metadata']);
    ws.getRow(1).font = { bold: true };

    for (const l of logs) {
      ws.addRow([
        l.createdAt,
        l.userId,
        l.event,
        l.category,
        l.creditsUsed,
        l.ip,
        JSON.stringify(l.metadata),
      ]);
    }

    ws.columns = [
      { width: 24 }, { width: 26 }, { width: 28 }, { width: 16 },
      { width: 14 }, { width: 16 }, { width: 60 },
    ];

    const buffer = await wb.xlsx.writeBuffer();

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

// ── Error Logs (dedicated ErrorLog collection) ────────────────────
exports.getErrorLogs = async (req, res, next) => {
  try {
    const page     = parseInt(req.query.page)     || 1;
    const limit    = parseInt(req.query.limit)    || 50;
    const skip     = (page - 1) * limit;
    const severity = req.query.severity || null;
    const type     = req.query.type     || null;
    const resolved = req.query.resolved;
    const userId   = req.query.userId   || null;
    const search   = req.query.search   || null;

    const filter = {};
    if (severity)              filter.severity   = severity;
    if (type)                  filter.type       = type;
    if (resolved !== undefined) filter.resolved  = resolved === 'true';
    if (userId)                filter.userId     = userId;
    if (search)                filter.message    = { $regex: escapeRegex(search), $options: 'i' };

    const [logs, total] = await Promise.all([
      ErrorLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'email profile.firstName profile.lastName')
        .lean(),
      ErrorLog.countDocuments(filter),
    ]);

    // Stats for dashboard header
    const [critical, unresolved, last24h] = await Promise.all([
      ErrorLog.countDocuments({ severity: 'critical', resolved: false }),
      ErrorLog.countDocuments({ resolved: false }),
      ErrorLog.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    ]);

    return paginated(res, logs, {
      total, page, limit,
      pages:   Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
      stats: { critical, unresolved, last24h },
    });
  } catch (err) { next(err); }
};

exports.resolveError = async (req, res, next) => {
  try {
    const { notes } = req.body;
    await ErrorLog.findByIdAndUpdate(req.params.id, {
      resolved:   true,
      resolvedAt: new Date(),
      resolvedBy: req.user?.email || 'admin',
      ...(notes && { notes }),
    });
    return success(res, null, 'Error marked as resolved');
  } catch (err) { next(err); }
};

exports.bulkResolve = async (req, res, next) => {
  try {
    const { ids, severity } = req.body;
    const filter = severity ? { severity, resolved: false } : { _id: { $in: ids } };
    const result = await ErrorLog.updateMany(filter, {
      resolved:   true,
      resolvedAt: new Date(),
      resolvedBy: req.user?.email || 'admin',
    });
    return success(res, { updated: result.modifiedCount }, `Resolved ${result.modifiedCount} errors`);
  } catch (err) { next(err); }
};

exports.deleteErrorLog = async (req, res, next) => {
  try {
    await ErrorLog.findByIdAndDelete(req.params.id);
    return success(res, null, 'Error log deleted');
  } catch (err) { next(err); }
};

// ── Frontend error report endpoint (called by axios interceptor) ──
exports.reportFrontendError = async (req, res, next) => {
  try {
    const { message, stack, endpoint, statusCode, code, metadata } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message required' });

    await ErrorLog.create({
      userId:     req.user?._id   || null,
      userEmail:  req.user?.email || null,
      type:       'frontend',
      severity:   statusCode >= 500 ? 'critical' : statusCode === 429 ? 'medium' : 'low',
      message,
      code:       code || null,
      stack:      stack || null,
      endpoint:   endpoint || null,
      method:     null,
      statusCode: statusCode || null,
      ip:         req.ip,
      userAgent:  req.headers?.['user-agent'],
      metadata:   metadata || {},
    });

    return res.status(204).send();
  } catch (err) { next(err); }
};