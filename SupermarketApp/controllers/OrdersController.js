const OrdersModel = require('../models/OrdersModel');
const ProductModel = require('../models/ProductModel');

function OrdersController() {
  return {
    // Display checkout page
    checkoutPage(req, res) {
      const cart = req.session.cart || [];

      ProductModel.getAllProducts((err, products) => {
        if (err) return res.status(500).render('error', { message: 'Failed to load cart' });

        const enriched = cart.map(item => {
          const p = products.find(x => x.id === item.productId) || {};
          return {
            ...item,
            price: p.price || item.price,
            productName: p.productName || item.productName,
            image: p.image || item.image
          };
        });

        const total = enriched.reduce((s, it) => s + (parseFloat(it.price) * it.quantity), 0);

        return res.render('checkOut', { cart: enriched, total, user: req.session.user });
      });
    },

    // Create order
    placeOrder(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      const cart = req.session.cart || [];
      if (!cart.length) {
        req.flash('error', 'Cart is empty');
        return res.redirect('/shopping');
      }

      const items = cart.map(i => ({
        productId: i.productId,
        price: i.price,
        quantity: i.quantity
      }));

      const total = items.reduce((s, it) => s + (parseFloat(it.price) * it.quantity), 0);

      OrdersModel.createOrder(user.id, items, total, (err, result) => {
        if (err) {
          console.error('Order creation failed:', err);
          req.flash('error', 'Failed to place order');
          return res.redirect('/checkout');
        }

        req.session.cart = [];
        req.flash('success', 'Order placed successfully');
        return res.redirect('/orders');
      });
    },

    // Show list of orders
    viewOrders(req, res) {
      const user = req.session.user;
      if (!user) return res.redirect('/login');

      OrdersModel.getOrdersByUser(user.id, (err, orders) => {
        if (err) return res.status(500).render('error', { message: 'Failed to load orders' });

        return res.render('orders', { orders, user });
      });
    },

    // View specific order
    getOrderById(req, res) {
      const user = req.session.user;
      const orderId = parseInt(req.params.id, 10);

      if (!user || Number.isNaN(orderId)) return res.redirect('/orders');

      OrdersModel.getOrderById(orderId, user.id, (err, order) => {
        if (err) return res.status(500).render('error', { message: 'Failed to load order' });

        if (!order) {
          req.flash('error', 'Order not found');
          return res.redirect('/orders');
        }

        return res.render('orderDetails', { order, user });
      });
    }
  };
}

module.exports = OrdersController();
