/**
 * One-time: nested resumeBuffer → pdfBuffer (avoids Mongoose select collision with top-level resumeBuffer).
 */
const mongoose = require('mongoose');
const logger   = require('../config/logger');

function hasBytes(b) {
  return !!(b && typeof b.length === 'number' && b.length > 0);
}

function asBuffer(b) {
  if (!b) return null;
  if (Buffer.isBuffer(b)) return b;
  try {
    return Buffer.from(b);
  } catch {
    return null;
  }
}

async function migrateResumeItemsPdfBuffer() {
  const col = mongoose.connection.collection('users');
  const cursor = col.find({
    resumeItems: { $elemMatch: { resumeBuffer: { $exists: true, $ne: null } } },
  });

  let n = 0;
  for await (const doc of cursor) {
    const items = (doc.resumeItems || []).map((it) => {
      const { resumeBuffer, pdfBuffer, ...rest } = it;
      if (hasBytes(pdfBuffer)) {
        return { ...rest, pdfBuffer };
      }
      if (hasBytes(resumeBuffer)) {
        const buf = asBuffer(resumeBuffer);
        return buf ? { ...rest, pdfBuffer: buf } : rest;
      }
      return rest;
    });
    await col.updateOne({ _id: doc._id }, { $set: { resumeItems: items } });
    n += 1;
  }
  if (n) logger.info(`[migrate] resumeItems.resumeBuffer → pdfBuffer for ${n} user(s)`);
}

module.exports = { migrateResumeItemsPdfBuffer };
