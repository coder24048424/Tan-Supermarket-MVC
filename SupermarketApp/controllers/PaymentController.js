const OrderService = require('../services/OrderService');
const OrdersModel = require('../models/OrdersModel');
const PayPalService = require('../services/PayPalService');
const TransactionsModel = require('../models/TransactionsModel');
const UserCartModel = require('../models/UserCartModel');

function PaymentController() {
  return {
    preparePayment(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const existing = req.session.pendingCheckout;
      if (existing && existing.cart && existing.cart.length) {
        return res.redirect('/payment');
      }

      const cart = req.session.cart || [];
      if (!cart.length) {
        req.flash('error', 'Cart is empty.');
        return res.redirect('/shopping');
      }

      const firstName = (req.body.firstName || '').trim();
      const address = (req.body.address || '').trim();
      const phone = (req.body.phone || '').trim();
      const notes = (req.body.notes || '').trim();

      const total = cart.reduce((sum, item) => sum + ((parseFloat(item.price) || 0) * item.quantity), 0);

      req.session.pendingCheckout = {
        cart,
        total,
        firstName,
        address,
        phone,
        notes
      };

      return res.redirect('/payment');
    },

    paymentPage(req, res) {
      const pending = req.session.pendingCheckout;
      if (!pending || !pending.cart || !pending.cart.length) {
        req.flash('error', 'No pending checkout found.');
        return res.redirect('/checkout');
      }

      return res.render('payment', {
        pending,
        selectedMethod: pending.paymentMethod || '',
        paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
        errors: req.flash('error'),
        success: req.flash('success')
      });
    },

    setPaymentMethod(req, res) {
      const pending = req.session.pendingCheckout;
      if (!pending || !pending.cart || !pending.cart.length) {
        return res.status(400).json({ error: 'No pending checkout found.' });
      }

      const method = String(req.body.method || '').toLowerCase();
      const allowed = ['paypal', 'card', 'paynow', 'nets'];
      if (!allowed.includes(method)) {
        return res.status(400).json({ error: 'Invalid payment method.' });
      }

      pending.paymentMethod = method;
      req.session.pendingCheckout = pending;
      return res.json({ success: true, method });
    },

    async createPayPalOrder(req, res) {
      try {
        const pending = req.session.pendingCheckout;
        if (!pending || !pending.cart || !pending.cart.length) {
          return res.status(400).json({ error: 'No pending checkout found.' });
        }
        if (String(pending.paymentMethod || '') !== 'paypal') {
          return res.status(400).json({ error: 'Please select PayPal first.' });
        }

        const amount = Number(pending.total || 0).toFixed(2);
        const order = await PayPalService.createOrder(amount, 'SGD');
        return res.json(order);
      } catch (err) {
        console.error('PayPal create order failed:', err);
        return res.status(500).json({ error: 'Unable to create PayPal order.' });
      }
    },

    async capturePayPalOrder(req, res) {
      try {
        const pending = req.session.pendingCheckout;
        const user = req.session.user;
        if (!pending || !pending.cart || !pending.cart.length) {
          return res.status(400).json({ error: 'No pending checkout found.' });
        }
        if (String(pending.paymentMethod || '') !== 'paypal') {
          return res.status(400).json({ error: 'Please select PayPal first.' });
        }

        const orderId = req.body.orderId;
        if (!orderId) {
          return res.status(400).json({ error: 'Missing PayPal order id.' });
        }

        pending.paymentMethod = 'paypal';
        req.session.pendingCheckout = pending;

        const capture = await PayPalService.captureOrder(orderId);
        if (String(capture.status || '').toUpperCase() !== 'COMPLETED') {
          return res.status(400).json({ error: 'Payment not completed.' });
        }

        const orderResult = await OrderService.placeOrderFromPending(user, pending, 'paypal');

        OrdersModel.updatePaymentMethod(orderResult.orderId, 'paypal', (updateErr) => {
          if (updateErr) {
            console.error('Failed to update payment method:', updateErr);
          }
        });

        const payer = capture.payer || {};
        const payerId = payer.payer_id || 'unknown';
        const payerEmail = payer.email_address || 'unknown';
        const amount = pending.total;
        const currency = 'SGD';
        const status = capture.status || 'COMPLETED';

        TransactionsModel.createTransaction({
          orderId,
          payerId,
          payerEmail,
          amount,
          currency,
          status,
          time: new Date()
        }, (tErr) => {
          if (tErr) {
            console.error('Failed to store transaction:', tErr);
          }
        });

        req.session.cart = [];
        req.session.pendingCheckout = null;
        UserCartModel.clearCart(user.id, (clearErr) => {
          if (clearErr) console.error('Failed to clear persisted cart:', clearErr);
        });

        req.flash('success', 'Payment successful. Thank you for your payment!');
        return res.json({ success: true, orderId: orderResult.orderId });
      } catch (err) {
        console.error('PayPal capture failed:', err);
        return res.status(500).json({ error: 'Unable to capture PayPal payment.' });
      }
    }
  };
}

module.exports = PaymentController();
