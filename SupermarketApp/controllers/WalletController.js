const WalletModel = require('../models/WalletModel');
const NetsService = require('../services/net');
const StripeService = require('../services/StripeService');
const PayPalService = require('../services/PayPalService');
const NotificationModel = require('../models/NotificationModel');

function WalletController() {
  return {
    walletPage(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      return WalletModel.getBalance(user.id, (err, balance = 0) => {
        if (err) {
          console.error('Failed to load wallet balance:', err);
          req.flash('error', 'Unable to load wallet balance.');
        }

        return res.render('wallet', {
          balance: Number(balance) || 0,
          errors: req.flash('error'),
          success: req.flash('success')
        });
      });
    },

    walletHistory(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      return WalletModel.getTransactionsByUser(user.id, (err, transactions = []) => {
        if (err) {
          console.error('Failed to load wallet transactions:', err);
          req.flash('error', 'Unable to load wallet history.');
        }

        return res.render('walletHistory', {
          transactions,
          errors: req.flash('error'),
          success: req.flash('success')
        });
      });
    },

    walletInvoice(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const txId = parseInt(req.params.id, 10);
      if (Number.isNaN(txId)) {
        req.flash('error', 'Invalid transaction.');
        return res.redirect('/wallet/history');
      }

      return WalletModel.getTransactionById(txId, user.id, (err, tx) => {
        if (err || !tx) {
          req.flash('error', 'Transaction not found.');
          return res.redirect('/wallet/history');
        }

        return res.render('walletInvoice', {
          tx
        });
      });
    },

    adminWallets(req, res) {
      const user = req.session.user;
      if (!user || user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/shopping');
      }

      return WalletModel.getAllBalances((err, rows = []) => {
        if (err) {
          console.error('Failed to load wallet balances:', err);
          req.flash('error', 'Unable to load wallet balances.');
        }

        const totalBalance = rows.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
        return res.render('adminWallets', {
          users: rows,
          totalBalance,
          errors: req.flash('error'),
          success: req.flash('success')
        });
      });
    },

    topUp(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const amount = Number(req.body.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        req.flash('error', 'Please enter a valid top-up amount.');
        return res.redirect('/wallet');
      }

      req.session.pendingTopup = {
        amount
      };
      return res.redirect('/wallet/payment');
    },


    walletPaymentPage(req, res) {
      const pending = req.session.pendingTopup;
      if (!pending || !Number(pending.amount)) {
        req.flash('error', 'No pending top-up found.');
        return res.redirect('/wallet');
      }

      return res.render('walletPayment', {
        amount: pending.amount,
        selectedMethod: pending.paymentMethod || '',
        errors: req.flash('error'),
        success: req.flash('success')
      });
    },

    setPaymentMethod(req, res) {
      const pending = req.session.pendingTopup;
      if (!pending || !Number(pending.amount)) {
        return res.status(400).json({ error: 'No pending top-up found.' });
      }

      const method = String(req.body.method || '').toLowerCase();
      const allowed = ['nets', 'stripe', 'paypal', 'paynow', 'grabpay'];
      if (!allowed.includes(method)) {
        return res.status(400).json({ error: 'Invalid payment method.' });
      }

      pending.paymentMethod = method;
      req.session.pendingTopup = pending;
      return res.json({ success: true, method });
    },

    async requestNetsQr(req, res) {
      try {
        const pending = req.session.pendingTopup;
        if (!pending || !Number(pending.amount)) {
          return res.status(400).json({ success: false, error: 'No pending top-up found.' });
        }

        // Ensure NETS API configuration exists
        if (!process.env.API_KEY || !process.env.PROJECT_ID) {
          console.error('NETS configuration missing: API_KEY or PROJECT_ID not set.');
          return res.status(500).json({ success: false, error: 'NETS not configured on server. Please contact administrator.' });
        }

        pending.paymentMethod = 'nets';
        req.session.pendingTopup = pending;

        const amount = Number(pending.amount || 0).toFixed(2);
        const payload = await NetsService.generateQrData(amount).catch((err) => {
          console.error('NetsService.generateQrData failed:', err && err.message ? err.message : err);
          return { success: false, error: 'Unable to generate NETS QR (service error).' };
        });

        if (!payload || !payload.success) {
          console.error('NETS QR generation failed:', payload);
          return res.status(400).json(payload || { success: false, error: 'Unable to generate NETS QR.' });
        }

        pending.netsTxnRetrievalRef = payload.txnRetrievalRef;
        req.session.pendingTopup = pending;

        return res.json(payload);
      } catch (err) {
        console.error('NETS top-up request failed:', err);
        return res.status(500).json({ success: false, error: 'Unable to generate NETS QR.' });
      }
    },

    async createStripeSession(req, res) {
      try {
      const pending = req.session.pendingTopup;
      if (!pending || !Number(pending.amount)) return res.status(400).json({ error: 'No pending top-up found.' });
      // allow variant (e.g. paynow, grabpay)
      const variant = String((req.body && (req.body.variant || req.body.method)) || '').toLowerCase();

      const methodVariant = variant === 'paynow' ? 'paynow' : variant === 'grabpay' ? 'grabpay' : 'stripe';
      pending.paymentMethod = methodVariant;
      req.session.pendingTopup = pending;

        const host = `${req.protocol}://${req.get('host')}`;
        const stripeOptions = {
          host,
          successUrl: process.env.STRIPE_SUCCESS_URL || `${host}/wallet/stripe/success`,
          cancelUrl: process.env.STRIPE_CANCEL_URL || `${host}/wallet/payment`,
          productName: 'Wallet top-up',
          metadata: {
            userId: String(req.session.user && req.session.user.id ? req.session.user.id : ''),
            payment_method: methodVariant
          }
        };

        if (variant === 'paynow') {
          stripeOptions.payment_method_types = ['paynow'];
        }

        if (methodVariant === 'paynow') {
          stripeOptions.payment_method_types = ['paynow'];
          stripeOptions.productName = 'Wallet top-up (PayNow)';
        } else if (methodVariant === 'grabpay') {
          stripeOptions.payment_method_types = ['grabpay'];
          stripeOptions.productName = 'Wallet top-up (GrabPay)';
        }

        const session = await StripeService.createCheckoutSession(Number(pending.amount), 'sgd', stripeOptions);

        return res.json({ url: session.url, id: session.id });
      } catch (err) {
        console.error('Stripe session creation failed:', err);
        return res.status(500).json({ error: err.message || 'Unable to create Stripe session.' });
      }
    },

    async stripeSuccess(req, res) {
      try {
        if (!StripeService) {
          req.flash('error', 'Stripe is not configured.');
          return res.redirect('/wallet/payment');
        }
        const sessionId = String(req.query.session_id || '').trim();
        const pending = req.session.pendingTopup;
        const user = req.session.user;
        const existing = req.session.walletStripe || {};

        if (existing.orderId && (!sessionId || existing.sessionId === sessionId)) {
          req.flash('success', 'Store credit added successfully.');
          return res.redirect('/wallet');
        }

        if (!pending || !Number(pending.amount)) {
          req.flash('error', 'No pending top-up found.');
          return res.redirect('/wallet');
        }

        if (!sessionId) {
          req.flash('error', 'Missing Stripe session.');
          return res.redirect('/wallet/payment');
        }

        // retrieve session using stripe package directly
        const stripePkg = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
        if (!stripePkg) {
          req.flash('error', 'Stripe is not configured.');
          return res.redirect('/wallet/payment');
        }

        const session = await stripePkg.checkout.sessions.retrieve(sessionId);
        if (!session || session.payment_status !== 'paid') {
          req.flash('error', 'Payment not completed.');
          return res.redirect('/wallet/payment');
        }

        const amount = Number(pending.amount || 0);
        const recordedMethod = pending && pending.paymentMethod ? pending.paymentMethod : 'stripe';
        return WalletModel.addFunds(user.id, amount, (err, balance) => {
          if (err) {
            console.error('Failed to credit wallet:', err);
            req.flash('error', 'Unable to add wallet credit.');
            return res.redirect('/wallet/payment');
          }

          WalletModel.createTransaction({
            userId: user.id,
            amount,
            method: recordedMethod,
            status: 'completed',
            providerRef: sessionId || null
          }, (txErr) => {
            if (txErr) console.error('Failed to record wallet transaction:', txErr);
          });

          req.session.pendingTopup = null;
          req.session.walletStripe = { sessionId, orderId: sessionId };
          req.flash('success', `Store credit added. New balance: $${Number(balance).toFixed(2)}.`);
          NotificationModel.createNotification({
            userId: user.id,
            title: 'Wallet top-up successful',
            message: `Your Stripe top-up of $${Number(amount || 0).toFixed(2)} was added to STORE CREDIT.`
          }, () => {});
          return res.redirect('/wallet');
        });
      } catch (err) {
        console.error('Stripe success handler failed:', err);
        req.flash('error', 'Unable to finalize Stripe payment.');
        return res.redirect('/wallet/payment');
      }
    },

    async createPayPalOrder(req, res) {
      try {
        const pending = req.session.pendingTopup;
        if (!pending || !Number(pending.amount)) return res.status(400).json({ error: 'No pending top-up found.' });

        pending.paymentMethod = 'paypal';
        req.session.pendingTopup = pending;

        const amount = Number(pending.amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid top-up amount.' });

        const host = `${req.protocol}://${req.get('host')}`;
        const returnUrl = process.env.PAYPAL_WALLET_RETURN_URL || `${host}/wallet/paypal/return`;
        const cancelUrl = process.env.PAYPAL_WALLET_CANCEL_URL || `${host}/wallet/payment`;

        const order = await PayPalService.createOrder(amount.toFixed(2), 'SGD', { returnUrl, cancelUrl });
        const approve = order && order.links && order.links.find(l => l.rel === 'approve');
        if (!approve) throw new Error('Unable to obtain PayPal approval link.');

        return res.json({ url: approve.href });
      } catch (err) {
        console.error('PayPal create order failed (wallet):', err);
        return res.status(500).json({ error: err.message || 'Unable to create PayPal order.' });
      }
    },

    async paypalReturn(req, res) {
      try {
        const token = String(req.query.token || '').trim();
        const pending = req.session.pendingTopup;
        const user = req.session.user;
        const existing = req.session.walletTopup || {};

        if (!token) {
          req.flash('error', 'Missing PayPal token.');
          return res.redirect('/wallet/payment');
        }
        if (existing.orderId && existing.orderId === token) {
          req.flash('success', 'Store credit added successfully.');
          return res.redirect('/wallet');
        }
        if (!pending || !Number(pending.amount)) {
          req.flash('error', 'No pending top-up found.');
          return res.redirect('/wallet');
        }

        const capture = await PayPalService.captureOrder(token);
        if (!capture) {
          req.flash('error', 'PayPal capture failed.');
          return res.redirect('/wallet/payment');
        }

        const amount = Number(pending.amount || 0);
        return WalletModel.addFunds(user.id, amount, (err, balance) => {
          if (err) {
            console.error('Failed to credit wallet:', err);
            req.flash('error', 'Unable to add wallet credit.');
            return res.redirect('/wallet/payment');
          }

          WalletModel.createTransaction({
            userId: user.id,
            amount,
            method: 'paypal',
            status: 'completed',
            providerRef: token
          }, (txErr) => {
            if (txErr) console.error('Failed to record wallet transaction:', txErr);
          });

          req.session.pendingTopup = null;
          req.session.walletTopup = { orderId: token };
          req.flash('success', `Store credit added. New balance: $${Number(balance).toFixed(2)}.`);
          NotificationModel.createNotification({
            userId: user.id,
            title: 'Wallet top-up successful',
            message: `Your PayPal top-up of $${Number(amount || 0).toFixed(2)} was added to STORE CREDIT.`
          }, () => {});

          return res.redirect('/wallet');
        });
      } catch (err) {
        console.error('PayPal wallet return failed:', err);
        req.flash('error', 'Unable to finalize PayPal payment.');
        return res.redirect('/wallet/payment');
      }
    },

    async paypalCapture(req, res) {
      try {
        const token = String(req.body.token || '').trim();
        const pending = req.session.pendingTopup;
        const user = req.session.user;

        if (!token) return res.status(400).json({ error: 'Missing PayPal token.' });
        if (!pending || !Number(pending.amount)) return res.status(400).json({ error: 'No pending top-up found.' });

        const capture = await PayPalService.captureOrder(token);
        if (!capture) return res.status(500).json({ error: 'PayPal capture failed.' });

        const amount = Number(pending.amount || 0);
        return WalletModel.addFunds(user.id, amount, (err, balance) => {
          if (err) {
            console.error('Failed to credit wallet:', err);
            return res.status(500).json({ error: 'Unable to add wallet credit.' });
          }

          WalletModel.createTransaction({
            userId: user.id,
            amount,
            method: 'paypal',
            status: 'completed',
            providerRef: token
          }, (txErr) => {
            if (txErr) console.error('Failed to record wallet transaction:', txErr);
          });

          req.session.pendingTopup = null;
          req.session.walletTopup = { orderId: token };
          NotificationModel.createNotification({
            userId: user.id,
            title: 'Wallet top-up successful',
            message: `Your PayPal top-up of $${Number(amount || 0).toFixed(2)} was added to STORE CREDIT.`
          }, () => {});

          return res.json({ success: true, orderId: token, balance });
        });
      } catch (err) {
        console.error('PayPal capture failed (wallet):', err);
        return res.status(500).json({ error: err.message || 'Unable to capture PayPal order.' });
      }
    },

    netsSuccess(req, res) {
      const user = req.session.user;
      const pending = req.session.pendingTopup;
      const txnRetrievalRef = String(req.query.txn_retrieval_ref || '').trim();
      const existing = req.session.walletTopup || {};

      if (existing.txnRetrievalRef && (!txnRetrievalRef || existing.txnRetrievalRef === txnRetrievalRef)) {
        req.flash('success', 'Store credit added successfully.');
        return res.redirect('/wallet');
      }

      if (!pending || !Number(pending.amount)) {
        req.flash('error', 'No pending top-up found.');
        return res.redirect('/wallet');
      }

      if (txnRetrievalRef && pending.netsTxnRetrievalRef && pending.netsTxnRetrievalRef !== txnRetrievalRef) {
        req.flash('error', 'NETS transaction does not match this top-up.');
        return res.redirect('/wallet/payment');
      }

      const amount = Number(pending.amount || 0);
        return WalletModel.addFunds(user.id, amount, (err, balance) => {
          if (err) {
            console.error('Failed to credit wallet:', err);
            req.flash('error', 'Unable to add wallet credit.');
            return res.redirect('/wallet/payment');
          }

        WalletModel.createTransaction({
          userId: user.id,
          amount,
          method: 'nets',
          status: 'completed',
          providerRef: txnRetrievalRef || pending.netsTxnRetrievalRef || null
        }, (txErr) => {
          if (txErr) {
            console.error('Failed to record wallet transaction:', txErr);
          }
        });

        req.session.pendingTopup = null;
        req.session.walletTopup = { txnRetrievalRef: txnRetrievalRef || pending.netsTxnRetrievalRef || '' };
        req.flash('success', `Store credit added. New balance: $${Number(balance).toFixed(2)}.`);
        NotificationModel.createNotification({
          userId: user.id,
          title: 'Wallet top-up successful',
          message: `Your NETS top-up of $${Number(amount || 0).toFixed(2)} was added to STORE CREDIT.`
        }, () => {});
        return res.redirect('/wallet');
      });
    }
  };
}

module.exports = WalletController();
