const OrdersModel = require('../models/OrdersModel');
const ProductModel = require('../models/ProductModel');

function placeOrderFromPending(user, pending, paymentMethodOverride) {
  return new Promise((resolve, reject) => {
    if (!user) {
      return reject({ code: 'NOT_AUTHENTICATED', message: 'Please log in to continue.' });
    }
    if (!pending || !Array.isArray(pending.cart) || pending.cart.length === 0) {
      return reject({ code: 'NO_PENDING', message: 'No items available to checkout.' });
    }

    const cart = pending.cart;
    const firstName = (pending.firstName || user.username || '').trim();
    const address = (pending.address || user.address || '').trim();
    const phone = (pending.phone || user.contact || '').trim();
    const notesInput = (pending.notes || '').trim();

    if (!firstName || !address) {
      return reject({ code: 'MISSING_DETAILS', message: 'Missing delivery details.' });
    }

    const productIds = cart.map(item => item.productId);

    ProductModel.getProductsByIds(productIds, (err, liveProducts = []) => {
      if (err) {
        return reject({ code: 'VERIFY_FAILED', message: 'Unable to verify inventory.' });
      }

      const catalog = new Map(liveProducts.map(product => [product.id, product]));
      const normalizedItems = [];

      for (let i = 0; i < cart.length; i += 1) {
        const cartItem = cart[i];
        const product = catalog.get(cartItem.productId);

        if (!product) {
          return reject({ code: 'ITEM_REMOVED', message: 'Some items were removed from the catalog.' });
        }

        const available = Number(product.quantity) || 0;
        if (available === 0) {
          return reject({ code: 'OUT_OF_STOCK', message: `${product.productName} is out of stock.` });
        }

        if (cartItem.quantity > available) {
          return reject({
            code: 'INSUFFICIENT_STOCK',
            message: `${product.productName} only has ${available} left.`
          });
        }

        normalizedItems.push({
          productId: product.id,
          price: parseFloat(product.price) || 0,
          quantity: cartItem.quantity
        });
      }

      const total = normalizedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const notesParts = [
        `Name: ${firstName}`,
        `Address: ${address}`,
        `Phone: ${phone}`,
        notesInput ? `Notes: ${notesInput}` : ''
      ].filter(Boolean);
      const notes = notesParts.join('\n');

      const paymentMethod = paymentMethodOverride || pending.paymentMethod || 'unpaid';
      OrdersModel.createOrder(user.id, normalizedItems, total, notes, 'pending', paymentMethod, (orderErr, data = {}) => {
        if (orderErr) {
          return reject({ code: orderErr.code || 'ORDER_FAILED', message: 'Failed to place order.' });
        }
        return resolve({ orderId: data.orderId, total });
      });
    });
  });
}

module.exports = { placeOrderFromPending };
