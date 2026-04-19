const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/billing.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.post('/create-order',   ctrl.createOrder);
router.post('/verify-payment', ctrl.verifyPayment);
router.get ('/history',        ctrl.getHistory);
router.get ('/plans',          ctrl.getPlans);
router.post('/cancel',         ctrl.cancelSubscription);
router.post('/topup',          ctrl.buyTopup);
router.post('/verify-topup',   ctrl.verifyTopup);

module.exports = router;