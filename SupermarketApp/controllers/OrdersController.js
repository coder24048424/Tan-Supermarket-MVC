const OrdersModel = require('../models/OrdersModel');
const ProductModel = require('../models/ProductModel');

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
    // PLACE ORDER
    // ===============================
    placeOrder(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const cart = req.session.cart || [];
      if (!cart.length) {
        req.flash('error', 'Cart is empty');
        return res.redirect('/shopping');
      }

      const productIds = cart.map(item => item.productId);
      const notes = (req.body.notes || '').trim();

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

        OrdersModel.createOrder(user.id, normalizedItems, total, notes, (orderErr) => {
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
          req.flash('success', 'Order placed successfully');
          return res.redirect('/orders'); // Purchase history
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

      OrdersModel.getOrdersByUser(user.id, (err, orders) => {
        if (err)
          return res.status(500).render('error', { message: 'Failed to load orders' });

        return res.render('purchaseHistory', {
          orders,
          user,
          success,
          errors
        });
      });
    },

    // ===============================
    // VIEW ORDER DETAILS
    // ===============================
    getOrderById(req, res) {
      const user = req.session.user;
      const orderId = parseInt(req.params.id, 10);

      if (!user || Number.isNaN(orderId)) {
        req.flash('error', 'Invalid order');
        return res.redirect('/orders');
      }

      OrdersModel.getOrderById(orderId, user.id, (err, order) => {
        if (err)
          return res.status(500).render('error', { message: 'Failed to load order' });

        if (!order) {
          req.flash('error', 'Order not found');
          return res.redirect('/orders');
        }

        return res.render('orderDetails', {
          order,
          user
        });
      });
    }

  };
}

module.exports = OrdersController();
