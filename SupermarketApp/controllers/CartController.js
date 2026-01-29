const ProductModel = require('../models/ProductModel');
const UserCartModel = require('../models/UserCartModel');
const WalletModel = require('../models/WalletModel');

function CartController() {
  return {
    addToCart(req, res) {
      const productId = parseInt(req.params.id, 10);
      const quantity = parseInt((req.body && req.body.quantity) || '1', 10) || 1;

      const sessionUser = req.session.user;
      const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');

      const respond = (type, message) => {
        const cartCount = (req.session.cart || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        if (wantsJson) {
          return res.json({ success: type === 'success', message, cartCount });
        }
        if (type === 'error') {
          req.flash('error', message);
        } else {
          req.flash('success', message);
        }
        const destination = req.get('Referer') || '/shopping';
        return res.redirect(destination);
      };

      const ensureSessionCart = (cb) => {
        if (sessionUser && sessionUser.role !== 'admin') {
          return UserCartModel.getCartForUser(sessionUser.id, (cartErr, persistedCart = []) => {
            if (!cartErr) req.session.cart = persistedCart;
            return cb();
          });
        }
        return cb();
      };

      ensureSessionCart(() => {
        if (!req.session.cart) req.session.cart = [];

        ProductModel.getProductById(productId, (err, product) => {
          if (err || !product) {
            return respond('error', 'Unable to add this product right now.');
          }

          const existing = req.session.cart.find(i => i.productId === productId);
          const available = Number(product.quantity) || 0;

          if (available === 0) {
            return respond('error', `${product.productName} is currently out of stock.`);
          }

          const existingQty = existing ? existing.quantity : 0;
          const desiredQty = existingQty + quantity;

          let nextQuantity = desiredQty;
          let capped = false;
          if (desiredQty > available) {
            nextQuantity = available;
            capped = true;
          }

          if (existing) {
            existing.quantity = nextQuantity;
          } else {
            req.session.cart.push({
              productId: product.id,
              productName: product.productName,
              price: product.price,
              quantity: nextQuantity,
              image: product.image
            });
          }

          if (!sessionUser || sessionUser.role === 'admin') {
            if (capped) {
              return respond('error', `${product.productName} only has ${available} in stock. Cart quantity set to the maximum.`);
            }
            return respond('success', `${product.productName} added to your cart.`);
          }

          return UserCartModel.setItemQuantity(sessionUser.id, product.id, nextQuantity, (persistErr) => {
            if (persistErr) {
              console.error('Failed to persist cart item:', persistErr);
              return respond('error', 'Unable to update your cart right now.');
            }
            if (capped) {
              return respond('error', `${product.productName} only has ${available} in stock. Cart quantity set to the maximum.`);
            }
            return respond('success', `${product.productName} added to your cart.`);
          });
        });
      });
    },

    cartPage(req, res) {
      const render = (balance = 0) => res.render('cart', {
        cart: req.session.cart || [],
        user: req.session.user,
        errors: req.flash('error'),
        success: req.flash('success'),
        walletBalance: Number(balance) || 0
      });

      const user = req.session.user;
      if (!user || user.role === 'admin') {
        return render(0);
      }

      WalletModel.getBalance(user.id, (err, balance = 0) => {
        if (err) {
          console.error('Failed to load wallet balance for cart page:', err);
        }
        return render(balance);
      });
    },

    removeFromCart(req, res) {
      const productId = parseInt(req.params.id, 10);

      if (!req.session.cart) req.session.cart = [];

      req.session.cart = req.session.cart.filter(item => item.productId !== productId);
      const user = req.session.user;
      if (user && user.role !== 'admin') {
        UserCartModel.removeItem(user.id, productId, (err) => {
          if (err) {
            console.error('Failed to remove cart item:', err);
            req.flash('error', 'Unable to remove item right now.');
            return res.redirect('/cart');
          }
          req.flash('success', 'Item removed.');
          return res.redirect('/cart');
        });
      } else {
        req.flash('success', 'Item removed.');
        return res.redirect('/cart');
      }
    },

    clearCart(req, res) {
      if (!req.session.cart) req.session.cart = [];
      req.session.cart = [];
      const user = req.session.user;
      if (user && user.role !== 'admin') {
        UserCartModel.clearCart(user.id, (err) => {
          if (err) {
            console.error('Failed to clear cart:', err);
            req.flash('error', 'Unable to clear cart right now.');
            return res.redirect('/cart');
          }
          req.flash('success', 'Cart cleared.');
          return res.redirect('/cart');
        });
      } else {
        req.flash('success', 'Cart cleared.');
        return res.redirect('/cart');
      }
    },

    updateQuantity(req, res) {
      const productId = parseInt(req.params.id, 10);
      const quantity = parseInt(req.body.quantity, 10);
      const delta = parseInt(req.body.delta, 10);

      if (Number.isNaN(productId)) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/cart');
      }

      if (!req.session.cart) req.session.cart = [];

      ProductModel.getProductById(productId, (err, product) => {
        if (err || !product) {
          req.flash('error', 'Unable to update this item right now.');
          return res.redirect('/cart');
        }

        const existing = req.session.cart.find(i => i.productId === productId);
        if (!existing) {
          req.flash('error', 'Item not found in cart.');
          return res.redirect('/cart');
        }

        const available = Number(product.quantity) || 0;
        const currentQty = existing.quantity || 0;
        let desiredQty;
        if (!Number.isNaN(delta)) {
          desiredQty = currentQty + delta;
        } else {
          desiredQty = Number.isNaN(quantity) ? currentQty : quantity;
        }

        const sanitizedQty = Math.max(0, desiredQty);
        const nextQuantity = Math.min(sanitizedQty, available);

        const applyUpdate = (cb) => {
          if (nextQuantity === 0) {
            req.session.cart = req.session.cart.filter(i => i.productId !== productId);
            if (req.session.user && req.session.user.role !== 'admin') {
              return UserCartModel.removeItem(req.session.user.id, productId, cb);
            }
            return cb();
          }
          existing.quantity = nextQuantity;
          if (req.session.user && req.session.user.role !== 'admin') {
            return UserCartModel.setItemQuantity(req.session.user.id, productId, nextQuantity, cb);
          }
          return cb();
        };

        applyUpdate((persistErr) => {
          if (persistErr) {
            console.error('Failed to update cart quantity:', persistErr);
            req.flash('error', 'Unable to update cart right now.');
            return res.redirect('/cart');
          }
          if (nextQuantity === 0) {
            req.flash('success', 'Item removed.');
          } else if (sanitizedQty > available) {
            req.flash('error', `${product.productName} only has ${available} in stock. Quantity adjusted.`);
          } else {
            req.flash('success', 'Quantity updated.');
          }
          return res.redirect('/cart');
        });
      });
    }
  };
}

module.exports = CartController();
