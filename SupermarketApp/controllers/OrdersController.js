const OrdersModel = require('../models/OrdersModel');
const RefundModel = require('../models/RefundModel');
const RefundController = require('./RefundController');
const ProductModel = require('../models/ProductModel');
const UserCartModel = require('../models/UserCartModel');
const WalletModel = require('../models/WalletModel');

function OrdersController() {
  return {

    // ===============================
    // SHOW CHECKOUT PAGE
    // ===============================
    checkoutPage(req, res) {
      const cart = req.session.cart || [];
      const errors = req.flash('error');
      const success = req.flash('success');

      ProductModel.getAllProducts((err, products) => {
        if (err) return res.status(500).render('error', { message: 'Failed to load cart' });

        // Update cart with latest product info
        const enriched = cart.map(item => {
          const p = products.find(x => x.id === item.productId) || {};
          return {
            ...item,
            price: p.price || item.price,
            productName: p.productName || item.productName,
            image: p.image || item.image
          };
        });

        const total = enriched.reduce((sum, it) => sum + ((parseFloat(it.price) || 0) * it.quantity), 0);

        return res.render('checkOut', {
          cart: enriched,
          total,
          user: req.session.user,
          errors,
          success
        });
      });
    },

    // ===============================
    // CONFIRM CHECKOUT (review step)
    // ===============================
    checkoutConfirm(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const cart = req.session.cart || [];
      if (!cart.length) {
        req.flash('error', 'Cart is empty');
        return res.redirect('/shopping');
      }

      const firstName = (req.body.firstName || user.username || '').trim();
      const address = (req.body.address || user.address || '').trim();
      const phone = (req.body.phone || user.contact || '').trim();
      const notesInput = (req.body.notes || '').trim();

      if (!firstName || !address) {
        req.flash('error', 'Please enter your name and address to continue.');
        return res.redirect('/checkout');
      }

      ProductModel.getAllProducts((err, products) => {
        if (err) {
          req.flash('error', 'Unable to verify inventory.');
          return res.redirect('/checkout');
        }

        const catalog = new Map(products.map(p => [p.id, p]));
        const enriched = [];
        let blockedMessage = null;

        cart.forEach(item => {
          const product = catalog.get(item.productId);
          const available = product ? Number(product.quantity) || 0 : 0;
          if (!product || available === 0) {
            blockedMessage = `${item.productName || 'Item'} is no longer available.`;
          } else if (item.quantity > available) {
            blockedMessage = `${product.productName} only has ${available} left.`;
          }
          if (product) {
            enriched.push({
              ...item,
              productName: product.productName,
              price: product.price
            });
          } else {
            enriched.push(item);
          }
        });

        if (blockedMessage) {
          req.flash('error', blockedMessage);
          return res.redirect('/checkout');
        }

        const total = enriched.reduce((sum, it) => sum + ((parseFloat(it.price) || 0) * it.quantity), 0);

        req.session.pendingCheckout = {
          cart: enriched,
          total,
          firstName,
          address,
          phone,
          notes: notesInput
        };

        return res.render('confirmOrder', {
          cart: enriched,
          total,
          user,
          firstName,
          address,
          phone,
          notes: notesInput,
          errors: req.flash('error'),
          success: req.flash('success')
        });
      });
    },

    // ===============================
    // PLACE ORDER
    // ===============================
    placeOrder(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const cart = req.session.cart || [];
      const firstName = (req.body.firstName || user.username || '').trim();
      const address = (req.body.address || user.address || '').trim();
      const phone = (req.body.phone || user.contact || '').trim();
      const notesInput = (req.body.notes || '').trim();

      if (!firstName || !address) {
        req.flash('error', 'Please enter your name and address to place the order.');
        return res.redirect('/checkout');
      }

      const notesParts = [
        `Name: ${firstName}`,
        `Address: ${address}`,
        `Phone: ${phone}`,
        notesInput ? `Notes: ${notesInput}` : ''
      ].filter(Boolean);

      const notes = notesParts.join('\n');
      if (!cart.length) {
        req.flash('error', 'Cart is empty');
        return res.redirect('/shopping');
      }

      const productIds = cart.map(item => item.productId);

      ProductModel.getProductsByIds(productIds, (err, liveProducts) => {
        if (err) {
          console.error('Failed to verify products for checkout:', err);
          req.flash('error', 'Unable to verify the latest inventory. Please try again.');
          return res.redirect('/checkout');
        }

        const catalog = new Map(liveProducts.map(product => [product.id, product]));
        const normalizedItems = [];
        let validationMessage = null;
        let updatedCart = cart;

        for (let i = 0; i < cart.length; i += 1) {
          const cartItem = cart[i];
          const product = catalog.get(cartItem.productId);

          if (!product) {
            validationMessage = 'Some items were removed from the catalog and cannot be purchased.';
            updatedCart = cart.filter(item => catalog.has(item.productId));
            break;
          }

          const available = Number(product.quantity) || 0;
          if (available === 0) {
            validationMessage = `${product.productName} is no longer in stock and was removed from your cart.`;
            updatedCart = cart.filter(item => item.productId !== product.id);
            break;
          }

          if (cartItem.quantity > available) {
            validationMessage = `${product.productName} only has ${available} left. Quantity updated in your cart.`;
            cartItem.quantity = available;
            break;
          }

          normalizedItems.push({
            productId: product.id,
            price: parseFloat(product.price) || 0,
            quantity: cartItem.quantity
          });
        }

        if (validationMessage) {
          req.session.cart = updatedCart;
          req.flash('error', validationMessage);
          return res.redirect('/cart');
        }

        if (!normalizedItems.length) {
          req.flash('error', 'No valid items available to checkout.');
          return res.redirect('/shopping');
        }

        const total = normalizedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

        OrdersModel.createOrder(user.id, normalizedItems, total, notes, 'pending', 'unpaid', (orderErr, data = {}) => {
          if (orderErr) {
            console.error('Order creation failed:', orderErr);
            if (orderErr.code === 'INSUFFICIENT_STOCK') {
              req.flash('error', 'Stock changed during checkout. Please review your cart.');
              return res.redirect('/cart');
            }
            req.flash('error', 'Failed to place order');
            return res.redirect('/checkout');
          }

          req.session.cart = []; // Clear cart
          req.session.pendingCheckout = null;
          UserCartModel.clearCart(user.id, (clearErr) => {
            if (clearErr) console.error('Failed to clear persisted cart:', clearErr);
          });

          req.flash('success', 'Order placed successfully');
          const orderId = data.orderId;
          if (orderId) {
            return res.redirect(`/orders/${orderId}`); // Order summary
          }
          return res.redirect('/orders'); // Purchase history fallback
        });
      });
    },

    // ===============================
    // VIEW PURCHASE HISTORY
    // ===============================
    viewOrders(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');
      const success = req.flash('success');
      const errors = req.flash('error');

      OrdersModel.getOrdersByUser(user.id, (err, orders = []) => {
        if (err)
          return res.status(500).render('error', { message: 'Failed to load orders' });

        const renderOrders = () => res.render('purchaseHistory', {
          orders,
          user,
          success,
          errors
        });

        if (!orders.length) return renderOrders();

        let pending = orders.length;
        orders.forEach((order) => {
          RefundModel.getRefundsByOrder(order.id, (rErr, refunds = []) => {
            if (!rErr) {
              order.refunds = refunds;
              const lower = refunds.map(r => String(r.status || '').toLowerCase());
              if (lower.some(s => s === 'approved' || s === 'processed')) {
                order.refundStatus = 'refunded';
              } else if (lower.some(s => s === 'pending')) {
                order.refundStatus = 'refund_pending';
              } else if (lower.some(s => s === 'rejected')) {
                order.refundStatus = 'refund_rejected';
              } else {
                order.refundStatus = 'none';
              }
            }
            pending -= 1;
            if (pending === 0) return renderOrders();
            return null;
          });
        });
      });
    },

    // ===============================
    // VIEW ORDER DETAILS
    // ===============================
    getOrderById(req, res) {
      const sessionUser = req.session.user;
      const orderId = parseInt(req.params.id, 10);
      const success = req.flash('success');
      const errors = req.flash('error');
      const refundDestination = (req.flash('refundDestination') || [])[0] || '';

      if (Number.isNaN(orderId)) {
        req.flash('error', 'Invalid order');
        return res.redirect('/orders');
      }

      const allowAdmin = sessionUser && sessionUser.role === 'admin';

      const renderOrder = (order, refunds = []) => {
        const ownerDeleted = String(order.owner_role || '').toLowerCase() === 'deleted';
      const respond = (balance = 0) => res.render('orderDetails', {
        order,
        user: sessionUser,
        refunds,
        ownerDeleted,
        success,
        errors,
        storeCreditBalance: Number(balance) || 0
        ,
        refundDestination
      });
        if (!sessionUser) {
          return respond(0);
        }
        return WalletModel.getBalance(sessionUser.id, (balanceErr, balance = 0) => {
          if (balanceErr) {
            console.error('Failed to load wallet balance for order view:', balanceErr);
          }
          return respond(balance);
        });
      };

      const loadRefunds = (order, done) => {
        RefundModel.getRefundsByOrder(order.id, (rErr, refunds = []) => {
          if (rErr) {
            console.error('Failed to load refunds:', rErr);
            return done(order, []);
          }
          return done(order, refunds);
        });
      };

      OrdersModel.getOrderById(orderId, sessionUser.id, (err, order) => {
        if (err)
          return res.status(500).render('error', { message: 'Failed to load order' });

        if (!order && allowAdmin) {
          // Try loading without user constraint for admins
          return OrdersModel.getOrderById(orderId, null, (err2, adminOrder) => {
            if (err2 || !adminOrder) {
              req.flash('error', 'Order not found');
              return res.redirect('/orders');
            }
            return loadRefunds(adminOrder, renderOrder);
          });
        }

        if (!order) {
          req.flash('error', 'Order not found');
          return res.redirect('/orders');
        }

        return loadRefunds(order, renderOrder);
      });
    },

    // ADMIN: view all orders
    adminAllOrders(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }

      const errors = req.flash('error');
      const success = req.flash('success');

      const filters = {
        status: (req.query.status || 'all').toLowerCase(),
        user: (req.query.user || '').toLowerCase().trim(),
        start: req.query.start || '',
        end: req.query.end || ''
      };

      OrdersModel.getAllOrders((err, orders = []) => {
        if (err) {
          console.error('Failed to load all orders:', err);
          req.flash('error', 'Unable to load orders.');
          return res.redirect('/orders');
        }

        let filtered = [...orders];
        if (filters.status !== 'all') {
          filtered = filtered.filter(o => String(o.status || '').toLowerCase() === filters.status);
        }
        if (filters.user) {
          filtered = filtered.filter(o => {
            const u = `${o.username || ''} ${o.email || ''}`.toLowerCase();
            return u.includes(filters.user);
          });
        }
        if (filters.start) {
          const startDate = new Date(filters.start);
          filtered = filtered.filter(o => new Date(o.created_at) >= startDate);
        }
        if (filters.end) {
          const endDate = new Date(filters.end);
          filtered = filtered.filter(o => new Date(o.created_at) <= endDate);
        }

        return res.render('adminOrders', {
          user: sessionUser,
          orders: filtered,
          errors,
          success,
          filters
        });
      });
    },

    // ===============================
    // INVOICE VIEW
    // ===============================
    invoice(req, res) {
      const sessionUser = req.session.user;
      const orderId = parseInt(req.params.id, 10);

      if (!sessionUser || Number.isNaN(orderId)) {
        req.flash('error', 'Invalid order');
        return res.redirect('/orders');
      }

      const allowAdmin = sessionUser.role === 'admin';

      const renderInvoice = (order, refunds = []) => res.render('invoice', {
        order,
        refunds,
        user: sessionUser || null
      });

      const userFilterId = sessionUser ? sessionUser.id : null;

      OrdersModel.getOrderById(orderId, userFilterId, (err, order) => {
        if (err)
          return res.status(500).render('error', { message: 'Failed to load order' });

        const handleOrder = (foundOrder) => {
          return RefundModel.getRefundsByOrder(foundOrder.id, (rErr, refunds = []) => {
            if (rErr) {
              console.error('Failed to load refunds for invoice:', rErr);
              return renderInvoice(foundOrder, []);
            }
            return renderInvoice(foundOrder, refunds);
          });
        };

        if (!order && allowAdmin) {
          return OrdersModel.getOrderById(orderId, null, (err2, adminOrder) => {
            if (err2 || !adminOrder) {
              req.flash('error', 'Order not found');
              return res.redirect('/orders');
            }
            return handleOrder(adminOrder);
          });
        }

        if (!order) {
          req.flash('error', 'Order not found');
          return res.redirect('/orders');
        }

        return handleOrder(order);
      });
    },

    // ADMIN: update status/shipping
    updateStatus(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied');
        return res.redirect('/orders');
      }
      const orderId = parseInt(req.params.id, 10);
      const { status, shipping_status } = req.body;
      if (Number.isNaN(orderId)) {
        req.flash('error', 'Invalid order');
        return res.redirect('/orders');
      }

      OrdersModel.getOrderById(orderId, null, (findErr, order) => {
        if (findErr || !order) {
          req.flash('error', 'Order not found');
          return res.redirect('/orders');
        }

        if (String(order.owner_role || '').toLowerCase() === 'deleted') {
          req.flash('error', 'This order belongs to a deleted account and is read-only.');
          return res.redirect(`/orders/${orderId}`);
        }

        const tasks = [];
        if (status) tasks.push((cb) => OrdersModel.updateOrderStatus(orderId, status, cb));
        if (shipping_status) tasks.push((cb) => OrdersModel.updateShippingStatus(orderId, shipping_status, cb));

        let pending = tasks.length;
        if (!pending) {
          req.flash('error', 'No updates provided.');
          return res.redirect(`/orders/${orderId}`);
        }

        const done = (err) => {
          if (err) {
            console.error('Failed to update order/shipping status:', err);
            req.flash('error', 'Could not update order status.');
            return res.redirect(`/orders/${orderId}`);
          }
          pending -= 1;
          if (pending === 0) {
            req.flash('success', 'Order updated.');
            return res.redirect(`/orders/${orderId}`);
          }
        };

        tasks.forEach(t => t(done));
      });
    },

    // ADMIN: process refund
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
        return res.redirect(`/orders/${orderId}`);
      }

      OrdersModel.getOrderById(orderId, null, (orderErr, order) => {
        if (orderErr || !order) {
          req.flash('error', 'Order not found.');
          return res.redirect('/orders');
        }

        if (String(order.owner_role || '').toLowerCase() === 'deleted') {
          req.flash('error', 'This order belongs to a deleted account and is read-only.');
          return res.redirect(`/orders/${orderId}`);
        }

        RefundModel.createRefund(orderId, amount, reason, 'store_credit', (err, result) => {
          if (err) {
            console.error('Failed to create refund:', err);
            req.flash('error', 'Could not create refund request.');
            return res.redirect(`/orders/${orderId}`);
          }
          const refundId = result && result.insertId ? Number(result.insertId) : null;
          if (!refundId) {
            req.flash('success', 'Refund recorded.');
            return res.redirect(`/orders/${orderId}`);
          }
          req.params.id = String(refundId);
          req.body.status = 'approved';
          req.body.approvedAmount = amount;
          req.body.redirectTo = `/orders/${orderId}`;
          return RefundController.updateStatus(req, res);
        });
      });
    },

    // ===============================
    // ===============================
    // REORDER ALL ITEMS INTO CART
    // ===============================
    reorder(req, res, orderId) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const allowAdmin = user.role === 'admin';
      const userFilter = allowAdmin ? null : user.id;

      OrdersModel.getOrderById(orderId, userFilter, (err, order) => {
        if (err) {
          console.error('Failed to load order for reorder:', err);
          req.flash('error', 'Unable to reorder right now.');
          return res.redirect('/orders');
        }

        if (!order || !order.items || !order.items.length) {
          req.flash('error', 'Order not found or has no items.');
          return res.redirect('/orders');
        }

        const productIds = [...new Set(order.items.map(i => i.product_id))];

        ProductModel.getProductsByIds(productIds, (productErr, products = []) => {
          if (productErr) {
            console.error('Failed to fetch products for reorder:', productErr);
            req.flash('error', 'Unable to reorder these items at the moment.');
            return res.redirect('/orders');
          }

          const catalog = new Map(products.map(p => [p.id, p]));
          const cart = req.session.cart || [];
          let addedCount = 0;
          const skipped = [];

          order.items.forEach(item => {
            const product = catalog.get(item.product_id);
            const available = product ? Number(product.quantity) || 0 : 0;
            if (!product || available === 0) {
              skipped.push(`${item.productName || 'Item'} (no stock)`);
              return;
            }

            const existing = cart.find(c => c.productId === product.id);
            const previousQty = existing ? existing.quantity : 0;
            const desired = Math.min(item.quantity, available);
            const newQty = Math.min(previousQty + desired, available);
            const actuallyAdded = newQty - previousQty;

            if (actuallyAdded <= 0) {
              skipped.push(`${product.productName} (limit reached)`);
              return;
            }

            if (existing) {
              existing.quantity = newQty;
            } else {
              cart.push({
                productId: product.id,
                productName: product.productName,
                price: product.price,
                quantity: actuallyAdded,
                image: product.image
              });
            }

            addedCount += actuallyAdded;

            if (desired > actuallyAdded) {
              skipped.push(`${product.productName} (only ${actuallyAdded} added)`);
            }
          });

          req.session.cart = cart;
          UserCartModel.replaceCart(user.id, cart, (persistErr) => {
            if (persistErr) {
              console.error('Failed to persist reordered cart:', persistErr);
            }
          });

          if (addedCount > 0) {
            req.flash('success', `Added ${addedCount} item(s) from order #${order.id} to your cart.`);
          }
          if (skipped.length) {
            req.flash('error', `Some items could not be added: ${skipped.join(', ')}.`);
          }

          return res.redirect('/cart');
        });
      });
    }

  };
}

module.exports = OrdersController();
