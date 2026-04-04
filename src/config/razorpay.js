const Razorpay = require('razorpay');
const crypto   = require('crypto');

const createOrder = ({ amount, currency = 'INR', receipt, notes = {} }) => {
  const rp = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return rp.orders.create({ amount: amount * 100, currency, receipt, notes });
};

const verifyPayment = (orderId, paymentId, signature) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
};

module.exports = { createOrder, verifyPayment };