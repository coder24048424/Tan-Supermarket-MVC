const db = require('../db');
const RefundModel = require('../models/RefundModel');
const OrdersModel = require('../models/OrdersModel');
const WalletModel = require('../models/WalletModel');
const NotificationModel = require('../models/NotificationModel');
const TransactionsModel = require('../models/TransactionsModel');
const PayPalService = require('../services/PayPalService');
const stripeLib = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

function RefundController() {
  function logRefundTransaction(order, refund, destinationLabel, amount) {
    const payerName = order.owner_username || `User ${order.user_id || ''}`;
    const payerEmail = order.owner_email || '';
    const txAmount = -Math.abs(Number(amount || refund.approved_amount || refund.amount || 0));
    TransactionsModel.createTransaction({
      orderId: order.id,
      payerId: String(order.user_id || ''),
      payerEmail,
      payerName,
      amount: txAmount,
      currency: process.env.DEFAULT_CURRENCY || 'SGD',
      status: 'refunded',
      method: `refund (${destinationLabel.toLowerCase()})`,
      time: new Date()
    }, (txErr) => {
      if (txErr) {
        console.error('Failed to log refund transaction:', txErr);
      }
    });
  }

  return {
    // User: request a refund for their own order
    requestRefund(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser) {
        req.flash('error', 'Please log in to request a refund.');
        return res.redirect('/login');
      }

      const orderId = parseInt(req.params.id, 10);
      const reasonChoice = (req.body.reason || '').trim();
      const otherReason = (req.body.reasonOther || '').trim();
      const reason = reasonChoice === 'other' ? otherReason : reasonChoice;
      const destinationChoice = (req.body.refundDestination || '').trim().toLowerCase();

      if (Number.isNaN(orderId)) {
        req.flash('refundDestination', destinationChoice || 'store_credit');
        req.flash('error', 'Invalid refund details.');
        return res.redirect(`/orders/${orderId || ''}`.replace(/\/$/, ''));
      }

      if (!reason) {
        req.flash('refundDestination', destinationChoice || 'store_credit');
        req.flash('error', 'Please select a refund reason.');
        return res.redirect(`/orders/${orderId}`);
      }

      // Validate the order belongs to the user
      OrdersModel.getOrderById(orderId, sessionUser.id, (orderErr, order) => {
        if (orderErr || !order) {
          req.flash('refundDestination', destinationChoice || 'store_credit');
          req.flash('error', 'Order not found.');
          return res.redirect('/orders');
        }

          const amount = Number(order.total) || 0;
          if (amount <= 0) {
            req.flash('refundDestination', destinationChoice || 'store_credit');
            req.flash('error', 'Invalid refund amount for this order.');
            return res.redirect(`/orders/${orderId}`);
          }

          const allowedOriginals = ['paypal','paypal-card','paynow','grabpay'];
          let destination = 'store_credit';
          if (allowedOriginals.includes((order.payment_method || '').toLowerCase()) && destinationChoice === 'original') {
            destination = 'original';
          }

          return RefundModel.getRefundsByOrder(orderId, (rErr, existing = []) => {
          if (rErr) {
            console.error('Failed to load refunds for request:', rErr);
            req.flash('error', 'Unable to submit refund right now.');
            return res.redirect(`/orders/${orderId}`);
          }

          const hasPending = existing.some(r => (r.status || '').toLowerCase() === 'pending');
          if (hasPending) {
            req.flash('error', 'A refund is already pending for this order.');
            return res.redirect(`/orders/${orderId}`);
          }

          return RefundModel.createRefund(orderId, amount, reason, destination, (err) => {
            if (err) {
              console.error('Failed to create refund request:', err);
              req.flash('error', 'Could not create refund request.');
              return res.redirect(`/orders/${orderId}`);
            }
            req.flash('success', 'Refund request submitted. An admin has been notified.');
            return res.redirect(`/orders/${orderId}`);
          });
        });
      });
    },

    // Admin: create a refund for an order
    createRefund(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }

      const orderId = parseInt(req.params.id, 10);
      const amount = parseFloat(req.body.amount);
      const reasonChoice = (req.body.reason || '').trim();
      const reasonOther = (req.body.reasonOther || '').trim();
      const destinationChoice = (req.body.destination || 'store_credit').trim().toLowerCase();

      if (Number.isNaN(orderId) || Number.isNaN(amount) || amount <= 0) {
        req.flash('error', 'Invalid refund details.');
        return res.redirect(`/orders/${orderId || ''}`.replace(/\/$/, ''));
      }

      // Ensure the order exists before creating a refund
      OrdersModel.getOrderById(orderId, null, (orderErr, order) => {
        if (orderErr || !order) {
          req.flash('error', 'Order not found.');
          return res.redirect('/orders');
        }

        if (String(order.owner_role || '').toLowerCase() === 'deleted') {
          req.flash('error', 'This order belongs to a deleted account and is read-only.');
          return res.redirect(`/orders/${orderId}`);
        }

        const adminReason = reasonChoice === 'other' ? reasonOther : reasonChoice;
        const reason = adminReason || 'No reason provided';
        const paymentKey = (order.payment_method || '').toLowerCase();
        const supportsOriginal = ['paypal','paypal-card','paynow','grabpay','stripe'].includes(paymentKey);
        const allowedDestinations = ['store_credit'];
        if (supportsOriginal) allowedDestinations.push('original');
        const destination = allowedDestinations.includes(destinationChoice) ? destinationChoice : 'store_credit';
        if (amount > Number(order.total || 0)) {
          req.flash('error', 'Refund amount cannot exceed total order amount.');
          return res.redirect(`/orders/${orderId}`);
        }

        RefundModel.createRefund(orderId, amount, reason, destination, (err) => {
          if (err) {
            console.error('Failed to create refund:', err);
            req.flash('error', 'Could not create refund request.');
            return res.redirect(`/orders/${orderId}`);
          }
          req.flash('success', 'Refund recorded.');
          return res.redirect(`/orders/${orderId}`);
        });
      });
    },

    // Admin: list all refunds with order/user info
    listAll(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }

      const success = req.flash('success');
      const errors = req.flash('error');

      RefundModel.getAllRefunds((err, refunds = []) => {
        if (err) {
          console.error('Failed to load refunds:', err);
          return res.status(500).render('error', { message: 'Failed to load refunds' });
        }
        return res.render('adminRefunds', {
          refunds,
          user: sessionUser,
          success,
          errors
        });
      });
    },

    // Fetch refunds for a specific order (for admin dashboards or AJAX calls)
    listByOrder(req, res) {
      const orderId = parseInt(req.params.id, 10);
      if (Number.isNaN(orderId)) {
        return res.status(400).json({ error: 'Invalid order id' });
      }

      RefundModel.getRefundsByOrder(orderId, (err, refunds = []) => {
        if (err) {
          console.error('Failed to load refunds:', err);
          return res.status(500).json({ error: 'Failed to load refunds' });
        }
        return res.json({ refunds });
      });
    },

    // Admin: update the status of a refund request
    updateStatus(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }

      const rawRedirect = req.body && req.body.redirectTo;
      const redirectTarget = (typeof rawRedirect === 'string' && rawRedirect.startsWith('/'))
        ? rawRedirect
        : '/admin/refunds';

      const refundId = parseInt(req.params.id, 10);
      const { status } = req.body;

      if (Number.isNaN(refundId) || !status) {
        req.flash('error', 'Invalid refund update.');
        return res.redirect(redirectTarget);
      }

      const normalizedStatus = String(status).toLowerCase();
      const isApproval = ['approved', 'processed'].includes(normalizedStatus);
      const overrideAmount = parseFloat(req.body.approvedAmount);

      RefundModel.getRefundById(refundId, (findErr, refund) => {
        if (findErr || !refund) {
          req.flash('error', 'Refund not found.');
          return res.redirect(redirectTarget);
        }

        OrdersModel.getOrderById(refund.order_id, null, (orderErr, order) => {
          if (orderErr || !order) {
            req.flash('error', 'Order not found for this refund.');
            return res.redirect(redirectTarget);
          }

          if (String(order.owner_role || '').toLowerCase() === 'deleted') {
            req.flash('error', 'This order belongs to a deleted account and is read-only.');
            return res.redirect(redirectTarget);
          }

        const alreadyApproved = ['approved', 'processed'].includes(String(refund.status).toLowerCase());
        const destination = (refund.destination || 'store_credit').toLowerCase();
        const destinationLabel = destination === 'store_credit' ? 'STORE CREDIT wallet' : 'original payment method';
        const requestedAmount = Number(refund.amount || 0);
        const orderTotal = Math.max(Number(order.total || 0), requestedAmount);
        let finalAmount = Number(refund.approved_amount || requestedAmount);
        if (isApproval) {
          const candidate = (!Number.isNaN(overrideAmount) && overrideAmount > 0)
            ? Math.min(overrideAmount, orderTotal)
            : Math.min(requestedAmount, orderTotal);
          if (candidate <= 0) {
            req.flash('error', 'Refund amount must be greater than zero.');
            return res.redirect(redirectTarget);
          }
          finalAmount = candidate;
        }
        let captureId = null;
        let paymentIntentId = null;
        const paymentMethods = {};
        const orderMethod = String(order.payment_method || '').toLowerCase();
        let originalMethod = null;
        try {
          const summary = order.payment_summary
            ? (typeof order.payment_summary === 'string' ? JSON.parse(order.payment_summary) : order.payment_summary)
            : {};
          const records = Array.isArray(summary.records) ? summary.records : [];
          records.forEach((record) => {
            const method = String(record && record.method || '').toLowerCase();
            const amt = Number(record && record.amount || 0);
            if (!method || !Number.isFinite(amt) || amt <= 0) return;
            paymentMethods[method] = (paymentMethods[method] || 0) + amt;
          });
          const paypalRecord = records.find(r => {
            const method = (r.method || '').toLowerCase();
            return method === 'paypal' || method === 'paypal-card';
          });
          captureId = paypalRecord && paypalRecord.meta ? paypalRecord.meta.captureId : null;
          const stripeRecord = records.find(r => {
            const method = (r.method || '').toLowerCase();
            return ['stripe','grabpay','paynow'].includes(method);
          });
          paymentIntentId = stripeRecord && stripeRecord.meta ? stripeRecord.meta.paymentIntent : null;
        } catch (parseErr) {
          console.error('Failed to parse payment summary for refund:', parseErr);
        }
        if (['paypal', 'paypal-card'].includes(orderMethod)) {
          originalMethod = 'paypal';
        } else if (['stripe', 'paynow', 'grabpay'].includes(orderMethod)) {
          originalMethod = 'stripe';
        }
        const maxOriginalAmount = (() => {
          if (originalMethod === 'paypal') {
            return (paymentMethods['paypal'] || 0) + (paymentMethods['paypal-card'] || 0);
          }
          if (originalMethod === 'stripe') {
            return (paymentMethods['stripe'] || 0) + (paymentMethods['paynow'] || 0) + (paymentMethods['grabpay'] || 0);
          }
          return 0;
        })();
        if (isApproval && destination === 'original') {
          if (maxOriginalAmount <= 0) {
            req.flash('error', 'Original payment details missing or unavailable for this refund.');
            return res.redirect(redirectTarget);
          }
          finalAmount = Math.min(finalAmount, maxOriginalAmount);
        }
        const finalizeRefund = () => {
          const amountToUse = Number(refund.approved_amount || refund.amount || 0);
          if (destination !== 'store_credit') {
            req.flash('success', `Refund approved. $${amountToUse.toFixed(2)} will be returned to the ${destinationLabel}.`);
            NotificationModel.createNotification({
              userId: order.user_id,
              title: 'Refund approved',
              message: `Your refund of $${amountToUse.toFixed(2)} will be returned to the ${destinationLabel}.`
            }, () => {});
            logRefundTransaction(order, refund, destinationLabel, amountToUse);
            return res.redirect(redirectTarget);
          }
            return WalletModel.addFunds(order.user_id, amountToUse, (walletErr, balance) => {
              if (walletErr) {
                console.error('Failed to credit wallet for refund:', walletErr);
                req.flash('error', 'Refund approved, but wallet credit failed.');
                return res.redirect(redirectTarget);
              }

              WalletModel.createTransaction({
                userId: order.user_id,
                amount: amountToUse,
                method: 'store_credit',
                status: 'refunded',
                providerRef: `refund_${refund.id}`
              }, (txErr) => {
                if (txErr) {
                  console.error('Failed to log wallet refund transaction:', txErr);
                }
              });

              req.flash('success', `Refund approved. $${amountToUse.toFixed(2)} credited to your STORE CREDIT wallet.`);
              NotificationModel.createNotification({
                userId: order.user_id,
                title: 'Refund approved',
                message: `Your refund of $${amountToUse.toFixed(2)} was credited to STORE CREDIT.`
              }, () => {});
              logRefundTransaction(order, refund, destinationLabel, amountToUse);
              return res.redirect(redirectTarget);
            });
          };

        const restockAndFinalize = () => {
          const restockNeeded = isApproval && !alreadyApproved;
          if (!restockNeeded) {
            req.flash('success', 'Refund status updated.');
            return res.redirect(redirectTarget);
          }

          const items = order.items || [];
          if (!items.length) {
            return finalizeRefund();
          }

          let pendingCount = items.length;
          let failed = false;
          items.forEach((item) => {
            const sql = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
            db.query(sql, [item.quantity, item.product_id], (qErr) => {
              if (qErr && !failed) {
                failed = true;
                console.error('Failed to restock item', item.product_id, qErr);
              }
              pendingCount -= 1;
              if (pendingCount === 0) {
                if (failed) {
                  req.flash('error', 'Refund approved, but some items failed to restock.');
                  return res.redirect(redirectTarget);
                }

                return finalizeRefund();
              }
            });
          });
        };

        const performOriginalRefund = () => {
          if (destination !== 'original') {
            return Promise.resolve();
          }
          const refundAmount = Number(refund.approved_amount || refund.amount || 0);
          if (originalMethod === 'stripe') {
            if (paymentIntentId && stripeLib) {
              return stripeLib.refunds.create({
                payment_intent: paymentIntentId,
                amount: Math.round(refundAmount * 100)
              });
            }
            return Promise.reject(new Error('Stripe payment details missing for refund.'));
          }
          if (originalMethod === 'paypal') {
            if (captureId) {
              return PayPalService.refundCapture(captureId, refundAmount);
            }
            return Promise.reject(new Error('PayPal capture details missing for refund.'));
          }
          if (paymentIntentId && stripeLib) {
            return stripeLib.refunds.create({
              payment_intent: paymentIntentId,
              amount: Math.round(refundAmount * 100)
            });
          }
          if (captureId) {
            return PayPalService.refundCapture(captureId, refundAmount);
          }
          return Promise.reject(new Error('Original payment refund information is missing.'));
        };
        const processStatusChange = () => {
          refund.approved_amount = finalAmount;
          performOriginalRefund().catch((refundErr) => {
            const code = refundErr && (refundErr.code || (refundErr.raw && refundErr.raw.code));
            const alreadyRefunded = code === 'charge_already_refunded' || code === 'refund_already_processed';
            if (alreadyRefunded) {
              return;
            }
            return Promise.reject(refundErr);
          }).then(() => {
            RefundModel.updateRefundStatus(refundId, status, (err) => {
              if (err) {
                console.error('Failed to update refund status:', err);
                req.flash('error', 'Could not update refund status.');
                return res.redirect(redirectTarget);
              }
              restockAndFinalize();
            });
          }).catch(refundErr => {
            console.error('Failed to process original refund:', refundErr);
            req.flash('error', `Unable to process original refund: ${refundErr.message || refundErr}`);
            return res.redirect(redirectTarget);
          });
        };

        if (isApproval) {
          RefundModel.setApprovedAmount(refundId, finalAmount, (setErr) => {
          if (setErr) {
            console.error('Failed to set approved refund amount:', setErr);
            req.flash('error', 'Unable to update refund amount.');
            return res.redirect(redirectTarget);
          }
          processStatusChange();
        });
        } else {
          processStatusChange();
        }
        });
      });
    }
  };
}

module.exports = RefundController();
