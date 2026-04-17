const Subscription   = require('../models/Subscription');
const User           = require('../models/User');
const UserCredits    = require('../models/UserCredits');
const { createOrder, verifyPayment }  = require('../config/razorpay');
const { invalidateUserCache }         = require('../middleware/auth.middleware');
const { success }    = require('../utils/response.util');
const { ValidationError } = require('../utils/errors');
const { PLAN_CREDITS }    = require('../utils/constants');
const logger = require('../config/logger');

// ── Create Razorpay order ─────────────────────────────────────────
exports.createOrder = async (req, res, next) => {
  try {
    const { plan, amount } = req.body;

    if (!['pro', 'team'].includes(plan)) {
      throw new ValidationError('Invalid plan');
    }

    const PRICES = { pro: 499, team: 1999 };
    const price  = PRICES[plan];

    if (!process.env.RAZORPAY_KEY_ID) {
      return success(res, {
        id:       'demo_order_' + Date.now(),
        amount:   price * 100,
        currency: 'INR',
        plan,
        demo:     true,
      }, 'Demo order created — Razorpay not configured yet');
    }

    const order = await createOrder({
      amount:  price,
      receipt: `order_${req.user._id}_${Date.now()}`,
      notes:   { userId: req.user._id.toString(), plan },
    });

    logger.info(`Razorpay order created: ${order.id} for ${req.user.email}`);
    return success(res, { ...order, plan });

  } catch (err) {
    next(err);
  }
};

// ── Verify payment ────────────────────────────────────────────────
exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan,
    } = req.body;

    // Verify signature
    const isValid = verifyPayment(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      throw new ValidationError('Payment verification failed — invalid signature');
    }

    const PRICES = { pro: 499, team: 1999 };

    // Update user plan + bust auth cache so next request sees new plan immediately
    await User.findByIdAndUpdate(req.user._id, { plan });
    invalidateUserCache(req.user._id);

    // Update credits — reset everything cleanly on upgrade
    await UserCredits.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          plan,
          totalCredits: PLAN_CREDITS[plan],
          usedCredits:  0,
          resetDate:    getNextMonthReset(),
          lastResetAt:  new Date(),
          graceGiven:   false,
          graceGivenAt: null,
          // Reset all breakdown counters
          'breakdown.searches':     0,
          'breakdown.emailLookups': 0,
          'breakdown.aiEmails':     0,
          'breakdown.emailsSent':   0,
          'breakdown.resumeParses': 0,
          'breakdown.exports':      0,
        },
      },
      { upsert: true }
    );

    // Create subscription record
    await Subscription.create({
      userId:          req.user._id,
      plan,
      status:          'active',
      razorpayOrderId: razorpay_order_id,
      amount:          PRICES[plan],
      currency:        'INR',
      startDate:       new Date(),
      endDate:         getNextMonthReset(),
    });

    logger.info(`Payment verified: ${req.user.email} upgraded to ${plan}`);

    return success(res, { plan }, `Successfully upgraded to ${plan}!`);

  } catch (err) {
    next(err);
  }
};

// ── Get payment history ───────────────────────────────────────────
exports.getHistory = async (req, res, next) => {
  try {
    const subs = await Subscription.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return success(res, subs);
  } catch (err) {
    next(err);
  }
};

// ── Get plans ─────────────────────────────────────────────────────
exports.getPlans = async (req, res, next) => {
  try {
    const PlatformConfig = require('../models/PlatformConfig');
    const proPrice  = await PlatformConfig.get('proPlanPrice',  499);
    const teamPrice = await PlatformConfig.get('teamPlanPrice', 1999);
    return success(res, { pro: proPrice, team: teamPrice });
  } catch (err) {
    next(err);
  }
};

// ── Cancel subscription ───────────────────────────────────────────
exports.cancelSubscription = async (req, res, next) => {
  try {
    await Subscription.findOneAndUpdate(
      { userId: req.user._id, status: 'active' },
      { status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason }
    );
    logger.info(`Subscription cancelled: ${req.user.email}`);
    return success(res, null, 'Subscription cancelled. You keep access until end of billing period.');
  } catch (err) {
    next(err);
  }
};

// ── Buy top-up ────────────────────────────────────────────────────
exports.buyTopup = async (req, res, next) => {
  try {
    const { credits, amount } = req.body;
    if (!credits || !amount) throw new ValidationError('Credits and amount required');

    if (!process.env.RAZORPAY_KEY_ID) {
      // Demo mode — just add credits
      await UserCredits.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { topupCredits: credits } }
      );
      return success(res, { credits }, `${credits} credits added (demo mode)`);
    }

    const order = await createOrder({
      amount,
      receipt: `topup_${req.user._id}_${Date.now()}`,
      notes:   { userId: req.user._id.toString(), type: 'topup', credits },
    });

    return success(res, { ...order, credits });
  } catch (err) {
    next(err);
  }
};

// ── Helper ────────────────────────────────────────────────────────
function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}