const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId:             { type: mongoose.Types.ObjectId, ref: 'User', required: true },
  plan:               { type: String, enum: ['free', 'pro', 'team'], required: true },
  status:             { type: String, enum: ['active', 'cancelled', 'expired', 'pending'], default: 'pending' },
  razorpayOrderId:    { type: String, sparse: true },
  razorpayPaymentId:  String,
  razorpaySignature:  String,
  amount:             { type: Number, default: 0 },
  currency:           { type: String, default: 'INR' },
  startDate:          Date,
  endDate:            Date,
  cancelledAt:        Date,
  cancelReason:       String,
  isTopup:            { type: Boolean, default: false },
  topupCredits:       Number,
  topupAmount:        Number,
}, { timestamps: true });

subscriptionSchema.index({ userId: 1, createdAt: -1 });
subscriptionSchema.index({ razorpayOrderId: 1 }, { sparse: true });
subscriptionSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
