const db = require('../db');
const RefundModel = require('../models/RefundModel');
const OrdersModel = require('../models/OrdersModel');

function RefundController() {
  return {
    // User: request a refund for their own order
    requestRefund(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser) {
        req.flash('error', 'Please log in to request a refund.');
        return res.redirect('/login');
      }

      const orderId = parseInt(req.params.id, 10);
      const reason = (req.body.reason || '').trim();

      if (Number.isNaN(orderId)) {
        req.flash('error', 'Invalid refund details.');
        return res.redirect(`/orders/${orderId || ''}`.replace(/\/$/, ''));
      }

      if (!reason) {
        req.flash('error', 'Please provide a reason for your refund request.');
        return res.redirect(`/orders/${orderId}`);
      }

      // Validate the order belongs to the user
      OrdersModel.getOrderById(orderId, sessionUser.id, (orderErr, order) => {
        if (orderErr || !order) {
          req.flash('error', 'Order not found.');
          return res.redirect('/orders');
        }

        const amount = Number(order.total) || 0;
        if (amount <= 0) {
          req.flash('error', 'Invalid refund amount for this order.');
          return res.redirect(`/orders/${orderId}`);
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

          return RefundModel.createRefund(orderId, amount, reason, (err) => {
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
      const reason = (req.body.reason || '').trim();

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

        RefundModel.createRefund(orderId, amount, reason, (err) => {
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

      const refundId = parseInt(req.params.id, 10);
      const { status } = req.body;

      if (Number.isNaN(refundId) || !status) {
        req.flash('error', 'Invalid refund update.');
        return res.redirect('/admin/refunds');
      }

      const normalizedStatus = String(status).toLowerCase();
      const isApproval = ['approved', 'processed'].includes(normalizedStatus);

      RefundModel.getRefundById(refundId, (findErr, refund) => {
        if (findErr || !refund) {
          req.flash('error', 'Refund not found.');
          return res.redirect('/admin/refunds');
        }

        const alreadyApproved = ['approved', 'processed'].includes(String(refund.status).toLowerCase());

        RefundModel.updateRefundStatus(refundId, status, (err) => {
          if (err) {
            console.error('Failed to update refund status:', err);
            req.flash('error', 'Could not update refund status.');
            return res.redirect('/admin/refunds');
          }

          const restockNeeded = isApproval && !alreadyApproved;
          if (!restockNeeded) {
            req.flash('success', 'Refund status updated.');
            return res.redirect('/admin/refunds');
          }

          // Restock items for the refunded order
          OrdersModel.getOrderById(refund.order_id, null, (orderErr, order) => {
            if (orderErr || !order) {
              console.error('Refund approved but order not found for restock:', orderErr);
              req.flash('error', 'Refund approved but could not restock items.');
              return res.redirect('/admin/refunds');
            }

            const items = order.items || [];
            if (!items.length) {
              req.flash('success', 'Refund approved. No items to restock.');
              return res.redirect('/admin/refunds');
            }

            let pending = items.length;
            let failed = false;
            items.forEach((item) => {
              const sql = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
              db.query(sql, [item.quantity, item.product_id], (qErr) => {
                if (qErr && !failed) {
                  failed = true;
                  console.error('Failed to restock item', item.product_id, qErr);
                }
                pending -= 1;
                if (pending === 0) {
                  if (failed) {
                    req.flash('error', 'Refund approved, but some items failed to restock.');
                  } else {
                    req.flash('success', 'Refund approved and stock restored.');
                  }
                  return res.redirect('/admin/refunds');
                }
              });
            });
          });
        });
      });
    }
  };
}

module.exports = RefundController();
