const mongoose = require('mongoose');

const platformConfigSchema = new mongoose.Schema({
  key:         { type: String, required: true, unique: true },
  value:       { type: mongoose.Schema.Types.Mixed, required: true },
  description: String,
  category:    {
    type: String,
    enum: ['limits', 'credits', 'features', 'apis', 'billing', 'alerts', 'general'],
  },
  updatedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

platformConfigSchema.statics.get = async function (key, defaultVal = null) {
  const doc = await this.findOne({ key }).lean();
  return doc ? doc.value : defaultVal;
};

platformConfigSchema.statics.set = async function (key, value, updatedBy = null) {
  return this.findOneAndUpdate(
    { key },
    { value, updatedBy },
    { upsert: true, new: true }
  );
};

platformConfigSchema.statics.getAll = async function (category) {
  const q    = category ? { category } : {};
  const docs = await this.find(q).lean();
  return docs.reduce((acc, d) => { acc[d.key] = d.value; return acc; }, {});
};

module.exports = mongoose.model('PlatformConfig', platformConfigSchema);