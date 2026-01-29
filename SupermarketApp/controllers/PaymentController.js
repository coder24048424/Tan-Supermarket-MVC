const OrderService = require('../services/OrderService');
const OrdersModel = require('../models/OrdersModel');
const UserCartModel = require('../models/UserCartModel');
const WalletModel = require('../models/WalletModel');
const NotificationModel = require('../models/NotificationModel');
const TransactionsModel = require('../models/TransactionsModel');
const PayPalService = require('../services/PayPalService');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const StripeService = require('../services/StripeService');
const db = require('../db');
const crypto = require('crypto');

const FRAUD_SCORE_THRESHOLD = 85;

function getWalletBalanceAsync(userId) {
  return new Promise((resolve, reject) => {
    WalletModel.getBalance(userId, (err, balance = 0) => {
      if (err) return reject(err);
      return resolve(balance);
    });
  });
}

function deductWalletFundsAsync(userId, amount) {
  return new Promise((resolve, reject) => {
    WalletModel.deductFunds(userId, amount, (err, balance) => {
      if (err) return reject(err);
      return resolve(balance);
    });
  });
}

function runFraudChecks(pending, user) {
  const score = [];
  let totalScore = 0;
  const reasons = [];
  const userAddr = ((user && user.address) || '').trim().toLowerCase();
  const shippingAddr = ((pending && pending.address) || '').trim().toLowerCase();
  if (userAddr && shippingAddr && userAddr !== shippingAddr) {
    totalScore += 30;
    reasons.push('Shipping address differs from account address');
  }
  const total = Number(pending && pending.total) || 0;
  if (total >= 200) {
    totalScore += 25;
    reasons.push('High order amount');
  }
  if (pending && Array.isArray(pending.cart) && pending.cart.length >= 5) {
    totalScore += 15;
    reasons.push('Multiple items purchased');
  }
  if ((pending && pending.phone || '').replace(/\D/g, '').length < 8) {
    totalScore += 10;
    reasons.push('Suspicious phone number');
  }
  const severity = totalScore >= FRAUD_SCORE_THRESHOLD ? 'high' : (totalScore >= 50 ? 'medium' : 'low');
  return { score: totalScore, severity, reasons };
}

async function finalizeOrderFromPending(req, finalMethod, sessionInfo = {}, options = {}) {
  const pending = req.session.pendingCheckout;
  const user = req.session.user;
  if (!pending || !pending.cart || !pending.cart.length) {
    throw new Error('No pending checkout found.');
  }
  if (!user) {
    throw new Error('User not authenticated.');
  }

  const method = finalMethod || pending.paymentMethod || 'unpaid';
  const paymentRecords = Array.isArray(pending.partialPayments) ? [...pending.partialPayments] : [];
  const fraudInfo = pending.fraudInfo || runFraudChecks(pending, user);
  pending.fraudInfo = fraudInfo;

  const orderResult = await OrderService.placeOrderFromPending(user, pending, method);
  OrdersModel.updatePaymentMethod(orderResult.orderId, method, (updateErr) => {
    if (updateErr) console.error('Failed to update payment method:', updateErr);
  });
  const sessionSnapshot = sessionInfo && sessionInfo.id ? {
    id: sessionInfo.id,
    payment_status: sessionInfo.payment_status || sessionInfo.status || null
  } : null;
  OrdersModel.updatePaymentSummary(orderResult.orderId, JSON.stringify({
    records: paymentRecords,
    fraud: fraudInfo,
    session: sessionSnapshot
  }), (summaryErr) => {
    if (summaryErr) {
      console.error('Failed to update payment summary:', summaryErr);
    }
  });

  req.session.cart = [];
  req.session.pendingCheckout = null;
  req.session.stripePayment = { sessionId: (sessionInfo && sessionInfo.id) || null, orderId: orderResult.orderId };
  UserCartModel.clearCart(user.id, (clearErr) => {
    if (clearErr) console.error('Failed to clear persisted cart:', clearErr);
  });

  if (!options.skipFlash) {
    req.flash('success', 'Payment successful. Thank you for your payment!');
  }
  NotificationModel.createNotification({
    userId: user.id,
    title: 'Payment successful',
    message: `Your ${method.toUpperCase()} payment of $${Number(orderResult.total || pending.total || 0).toFixed(2)} was successful.`
  }, () => {});
  const txAmount = Number(orderResult.total || pending.total || 0);
  TransactionsModel.createTransaction({
    orderId: orderResult.orderId,
    payerId: String(user.id || ''),
    payerEmail: String(user.email || (user && user.contact) || ''),
    payerName: user.username || `${(user.firstName || '').trim()} ${(user.lastName || '').trim()}`.trim() || `User ${user.id || ''}`,
    amount: Number.isFinite(txAmount) ? txAmount : 0,
    currency: process.env.DEFAULT_CURRENCY || 'SGD',
    status: 'paid',
    method,
    time: new Date()
  }, (txErr) => {
    if (txErr) {
      console.error('Failed to log transaction:', txErr);
    }
  });

  return orderResult.orderId;
}

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
          // require password confirmation for security

      const total = cart.reduce((sum, item) => sum + ((parseFloat(item.price) || 0) * item.quantity), 0);

      req.session.pendingCheckout = {
        cart,
        total,
        remaining: total,
        firstName,
        address,
        phone,
        notes,
        partialPayments: []
      };

      return res.redirect('/payment');
    },

    paymentPage(req, res) {
      const pending = req.session.pendingCheckout;
      if (!pending || !pending.cart || !pending.cart.length) {
        req.flash('error', 'No pending checkout found.');
        return res.redirect('/checkout');
      }

      const user = req.session.user;
      return WalletModel.getBalance(user.id, (err, balance = 0) => {
        if (err) {
          console.error('Failed to load wallet balance:', err);
        }

        const queryMethod = String(req.query.method || '').toLowerCase();
        const allowedMethods = ['card','paynow','nets','stripe','paypal','grabpay','paypal-card'];
        if (queryMethod && allowedMethods.includes(queryMethod)) {
          pending.paymentMethod = queryMethod;
          req.session.pendingCheckout = pending;
        }

        pending.remaining = Number(pending.remaining || pending.total || 0);
        pending.partialPayments = Array.isArray(pending.partialPayments) ? pending.partialPayments : [];
        return res.render('payment', {
          pending,
          walletBalance: Number(balance) || 0,
          selectedMethod: pending.paymentMethod || '',
          paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
          errors: req.flash('error'),
          success: req.flash('success')
        });
      });
    },

    setPaymentMethod(req, res) {
      const pending = req.session.pendingCheckout;
      if (!pending || !pending.cart || !pending.cart.length) {
        return res.status(400).json({ error: 'No pending checkout found.' });
      }

      const method = String(req.body.method || '').toLowerCase();
      const allowed = ['card', 'paynow', 'nets', 'stripe', 'paypal', 'grabpay', 'paypal-card'];
      if (!allowed.includes(method)) {
        return res.status(400).json({ error: 'Invalid payment method.' });
      }

      pending.paymentMethod = method;
      req.session.pendingCheckout = pending;
      return res.json({ success: true, method });
    },

    async createStripeCheckout(req, res) {
      try {
        if (!stripe) {
          return res.status(500).json({ error: 'Stripe is not configured.' });
        }
        const pending = req.session.pendingCheckout;
        if (!pending || !pending.cart || !pending.cart.length) {
          return res.status(400).json({ error: 'No pending checkout found.' });
        }
        const variant = String((req.body && req.body.variant) || '').toLowerCase();
        const allowedStripeMethods = ['stripe', 'grabpay'];
        if (!allowedStripeMethods.includes(String(pending.paymentMethod || ''))) {
          return res.status(400).json({ error: 'Please select Stripe or GrabPay first.' });
        }

        const amount = Number(pending.remaining || pending.total || 0);
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({ error: 'Invalid order total.' });
        }

        const successBase = process.env.STRIPE_SUCCESS_URL || `${req.protocol}://${req.get('host')}/stripe/success`;
        const cancelBase = process.env.STRIPE_CANCEL_URL || `${req.protocol}://${req.get('host')}/payment`;

        const methodVariant = variant === 'grabpay' ? 'grabpay' : variant === 'paynow' ? 'paynow' : 'stripe';
        pending.paymentMethod = methodVariant;
        req.session.pendingCheckout = pending;

        const stripeOptions = {
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'sgd',
                product_data: { name: 'Supermarket order' },
                unit_amount: Math.round(amount * 100)
              },
              quantity: 1
            }
          ],
          success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: cancelBase,
          metadata: {
            userId: String(req.session.user && req.session.user.id ? req.session.user.id : ''),
            checkoutType: 'order'
          }
        };

        if (methodVariant === 'paynow') {
          stripeOptions.payment_method_types = ['paynow'];
        } else if (methodVariant === 'grabpay') {
          stripeOptions.payment_method_types = ['grabpay'];
          stripeOptions.line_items[0].price_data.product_data.name = 'Supermarket order (GrabPay)';
        }

        const session = await stripe.checkout.sessions.create(stripeOptions);
        pending.stripeSessionId = session.id;
        req.session.pendingCheckout = pending;

        return res.json({ url: session.url });
      } catch (err) {
        console.error('Stripe checkout creation failed:', err);
        return res.status(500).json({ error: 'Unable to create Stripe checkout.' });
      }
    },

      async createPayNowSession(req, res) {
        try {
          if (!stripe) {
            return res.status(500).json({ error: 'Stripe is not configured.' });
          }
          const pending = req.session.pendingCheckout;
          if (!pending || !pending.cart || !pending.cart.length) {
            return res.status(400).json({ error: 'No pending checkout found.' });
          }
          if (String(pending.paymentMethod || '') !== 'paynow') {
            return res.status(400).json({ error: 'Please select PayNow first.' });
          }

          const amount = Number(pending.remaining || pending.total || 0);
          if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid order total.' });
          }

          const host = `${req.protocol}://${req.get('host')}`;
          const successBase = process.env.STRIPE_SUCCESS_URL || `${host}/stripe/success`;
          const cancelBase = process.env.STRIPE_CANCEL_URL || `${host}/payment`;

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['paynow'],
            line_items: [
              {
                price_data: {
                  currency: 'sgd',
                  product_data: { name: 'Supermarket order (PayNow)' },
                  unit_amount: Math.round(amount * 100)
                },
                quantity: 1
              }
            ],
            success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelBase,
            metadata: {
              userId: String(req.session.user && req.session.user.id ? req.session.user.id : ''),
              checkoutType: 'order',
              payment_method: 'paynow'
            }
          });

          return res.json({ url: session.url });
        } catch (err) {
          console.error('PayNow session creation failed:', err);
          return res.status(500).json({ error: 'Unable to create PayNow session.' });
        }
      },

    async createPayPalOrder(req, res) {
      try {
        const pending = req.session.pendingCheckout;
        if (!pending || !pending.cart || !pending.cart.length) {
          return res.status(400).json({ error: 'No pending checkout found.' });
        }
        if (!['paypal','paypal-card'].includes(String(pending.paymentMethod || ''))) {
          return res.status(400).json({ error: 'Please select PayPal first.' });
        }

        const amount = Number(pending.total || 0);
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({ error: 'Invalid order total.' });
        }

        const host = `${req.protocol}://${req.get('host')}`;
        const returnUrl = process.env.PAYPAL_RETURN_URL || `${host}/paypal/return`;
        const cancelUrl = process.env.PAYPAL_CANCEL_URL || `${host}/paypal/cancel`;

        const order = await PayPalService.createOrder(amount.toFixed(2), 'SGD', { returnUrl, cancelUrl });
        const approve = order && order.links && order.links.find(l => l.rel === 'approve');
        if (!approve) {
          throw new Error('Unable to obtain PayPal approval link.');
        }

        return res.json({ url: approve.href });
      } catch (err) {
        console.error('PayPal create order failed:', err);
        return res.status(500).json({ error: err.message || 'Unable to create PayPal order.' });
      }
    },

    async paypalReturn(req, res) {
      try {
        const token = String(req.query.token || '').trim();
        const pending = req.session.pendingCheckout;
        const user = req.session.user;

        if (!token) {
          req.flash('error', 'Missing PayPal token.');
          return res.redirect('/payment');
        }
        if (!pending || !pending.cart || !pending.cart.length) {
          req.flash('error', 'No pending checkout found.');
          return res.redirect('/payment');
        }

        const capture = await PayPalService.captureOrder(token);
        if (!capture) {
          req.flash('error', 'PayPal capture failed.');
          return res.redirect('/payment');
        }

        const captureId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
        pending.partialPayments = Array.isArray(pending.partialPayments) ? pending.partialPayments : [];
        const remaining = Number(pending.remaining || pending.total || 0);
        if (remaining > 0) {
          pending.partialPayments.push({
            method: 'paypal',
            amount: remaining,
            meta: { sessionId: token, captureId }
          });
          pending.remaining = 0;
        }

        const orderId = await finalizeOrderFromPending(req, 'paypal', { id: token });
        req.session.paypalPayment = { orderId };

        return res.redirect(`/orders/${orderId}`);
      } catch (err) {
        console.error('PayPal return handler failed:', err);
        req.flash('error', 'Unable to finalize PayPal payment.');
        return res.redirect('/payment');
      }
    },

    paypalCancel(req, res) {
      req.flash('error', 'PayPal payment was cancelled.');
      return res.redirect('/payment');
    },

    async stripeSuccess(req, res) {
      try {
        if (!stripe) {
          req.flash('error', 'Stripe is not configured.');
          return res.redirect('/payment');
        }
        const sessionId = String(req.query.session_id || '').trim();
        const pending = req.session.pendingCheckout;
        const user = req.session.user;
        const existing = req.session.stripePayment || {};

        if (existing.orderId && (!sessionId || existing.sessionId === sessionId)) {
          return res.redirect(`/orders/${existing.orderId}`);
        }

        if (!pending || !pending.cart || !pending.cart.length) {
          req.flash('error', 'No pending checkout found.');
          return res.redirect('/payment');
        }

        if (!sessionId) {
          req.flash('error', 'Missing Stripe session.');
          return res.redirect('/payment');
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (!session || session.payment_status !== 'paid') {
          req.flash('error', 'Payment not completed.');
          return res.redirect('/payment');
        }

        const recordedMethod = pending.paymentMethod === 'grabpay'
          ? 'grabpay'
          : (pending.paymentMethod === 'paynow' ? 'paynow' : 'stripe');
        const remaining = Number(pending.remaining || pending.total || 0);
        pending.partialPayments = Array.isArray(pending.partialPayments) ? pending.partialPayments : [];
        if (remaining > 0) {
          pending.partialPayments.push({
            method: recordedMethod,
            amount: remaining,
            meta: {
              sessionId,
              paymentIntent: session.payment_intent || null
            }
          });
          pending.remaining = 0;
        }

        const orderId = await finalizeOrderFromPending(req, recordedMethod, session);
        return res.redirect(`/orders/${orderId}`);
      } catch (err) {
        console.error('Stripe success handler failed:', err);
        req.flash('error', 'Unable to finalize Stripe payment.');
        return res.redirect('/payment');
      }
    },

    async pollPaymentStatus(req, res) {
      const pending = req.session.pendingCheckout;
      if (!pending || !pending.cart || !pending.cart.length) {
        return res.json({ status: 'no_pending' });
      }
      const method = String(pending.paymentMethod || '').toLowerCase();
      if (!['stripe', 'grabpay', 'paynow'].includes(method)) {
        return res.json({ status: 'not_applicable' });
      }
      if (!stripe) {
        return res.status(500).json({ status: 'error', error: 'Stripe is not configured.' });
      }
      const sessionId = pending.stripeSessionId;
      if (!sessionId) {
        return res.json({ status: 'awaiting_session' });
      }
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (!session) {
          return res.json({ status: 'missing_session' });
        }
        if (session.payment_status === 'paid') {
          const recordedMethod = pending.paymentMethod === 'grabpay'
            ? 'grabpay'
            : (pending.paymentMethod === 'paynow' ? 'paynow' : 'stripe');
          const remaining = Number(pending.remaining || pending.total || 0);
          pending.partialPayments = Array.isArray(pending.partialPayments) ? pending.partialPayments : [];
          if (remaining > 0) {
          pending.partialPayments.push({
            method: recordedMethod,
            amount: remaining,
            meta: {
              sessionId,
              paymentIntent: session.payment_intent || null
            }
          });
            pending.remaining = 0;
          }

          const orderId = await finalizeOrderFromPending(req, recordedMethod, session, { skipFlash: true });
          return res.json({ status: 'completed', orderId });
        }
        return res.json({ status: session.payment_status || 'pending' });
      } catch (err) {
        console.error('Stripe polling failed:', err);
        return res.status(500).json({ status: 'error', error: err.message || 'Unable to check payment status.' });
      }
    },

    async payWithStoreCredit(req, res) {
      try {
        const pending = req.session.pendingCheckout;
        const user = req.session.user;
        if (!pending || !pending.cart || !pending.cart.length) {
          return res.status(400).json({ error: 'No pending checkout found.' });
        }

        if (!user) {
          return res.status(401).json({ error: 'Please log in to continue.' });
        }

        const passwordInput = String(req.body.password || '').trim();
        if (!passwordInput) {
          return res.status(400).json({ error: 'Password is required to use store credit.' });
        }

        const hashedPassword = crypto.createHash('sha1').update(passwordInput).digest('hex');
        if (!user.password || String(user.password) !== hashedPassword) {
          return res.status(401).json({ error: 'Incorrect password.' });
        }

        pending.paymentMethod = 'store_credit';
        pending.partialPayments = Array.isArray(pending.partialPayments) ? pending.partialPayments : [];
        pending.remaining = Number(pending.remaining || pending.total || 0);
        const remaining = pending.remaining;
        if (remaining <= 0) {
          return res.status(400).json({ error: 'No outstanding amount to cover.' });
        }

        const walletBalance = await getWalletBalanceAsync(user.id);
        const requestedAmount = Math.max(Number(req.body.amount || 0), 0);
        const maxDeduct = Math.min(walletBalance, remaining);
        if (maxDeduct <= 0) {
          return res.status(400).json({ error: 'Insufficient store credit balance.' });
        }

        let amountToUse = requestedAmount > 0 ? Math.min(requestedAmount, maxDeduct) : maxDeduct;
        if (amountToUse <= 0) {
          amountToUse = maxDeduct;
        }

        const balanceAfter = await deductWalletFundsAsync(user.id, amountToUse);
        pending.partialPayments.push({
          method: 'store_credit',
          amount: amountToUse,
          meta: {
            balanceBefore: walletBalance,
            timestamp: Date.now()
          }
        });

        pending.remaining = Number((remaining - amountToUse).toFixed(2));
        req.session.pendingCheckout = pending;

        if (pending.remaining <= 0) {
          const orderId = await finalizeOrderFromPending(req, 'store_credit', {}, {});
          return res.json({ success: true, orderId, completed: true, balance: balanceAfter });
        }

        return res.json({
          success: true,
          remaining: pending.remaining,
          partial: true,
          balance: balanceAfter
        });
      } catch (err) {
        console.error('Store credit payment failed:', err);
        if (err && err.code === 'INSUFFICIENT_FUNDS') {
          return res.status(400).json({ error: 'Insufficient store credit.' });
        }
        return res.status(500).json({ error: err.message || 'Unable to complete store credit payment.' });
      }
    }
  };
}

module.exports = PaymentController();
