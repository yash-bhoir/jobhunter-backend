exports.success   = (res, data, msg = 'Success', code = 200) =>
  res.status(code).json({ success: true, message: msg, data });

exports.created   = (res, data, msg = 'Created') =>
  res.status(201).json({ success: true, message: msg, data });

exports.paginated = (res, data, pagination, msg = 'Success') =>
  res.status(200).json({ success: true, message: msg, data, pagination });

exports.noContent = (res) => res.status(204).send();