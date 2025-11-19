const db = require('../db');

function OrdersModel() {
  return {

    createOrder(userId, items, total, callback) {
      const orderSql = `
        INSERT INTO orders (user_id, total, created_at)
        VALUES (?, ?, NOW())
      `;

      db.query(orderSql, [userId, total], (err, result) => {
        if (err) return callback(err);

        const orderId = result.insertId;

        const values = items.map(i => [
          orderId,
          i.productId,
          i.price,
          i.quantity
        ]);

        const itemsSql = `
          INSERT INTO order_items (order_id, product_id, price, quantity)
          VALUES ?
        `;

        db.query(itemsSql, [values], (err2) => {
          if (err2) return callback(err2);
          callback(null, { orderId });
        });
      });
    },

    getOrdersByUser(userId, callback) {
      const sql = `
        SELECT o.id, o.total, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
      `;

      db.query(sql, [userId], (err, rows) => {
        if (err) return callback(err);

        const orders = {};

        rows.forEach(r => {
          if (!orders[r.id]) {
            orders[r.id] = {
              id: r.id,
              total: Number(r.total),   // ← FIXED
              created_at: r.created_at,
              items: []
            };
          }

          orders[r.id].items.push({
            product_id: r.product_id,
            productName: r.productName,
            price: r.price,
            quantity: r.quantity
          });
        });

        callback(null, Object.values(orders));
      });
    },

    getOrderById(orderId, userId, callback) {
      const sql = `
        SELECT o.id, o.total, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.id = ? AND o.user_id = ?
      `;

      db.query(sql, [orderId, userId], (err, rows) => {
        if (err) return callback(err);
        if (!rows.length) return callback(null, null);

        const order = {
          id: rows[0].id,
          total: Number(rows[0].total),  // ← FIXED
          created_at: rows[0].created_at,
          items: []
        };

        rows.forEach(r => {
          order.items.push({
            product_id: r.product_id,
            productName: r.productName,
            price: r.price,
            quantity: r.quantity
          });
        });

        callback(null, order);
      });
    }

  };
}

module.exports = OrdersModel();
