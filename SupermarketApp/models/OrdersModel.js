const db = require('../db');

function OrdersModel() {
  return {

    createOrder(userId, items, total, notes, status = 'pending', callback) {
      if (!Array.isArray(items) || items.length === 0) {
        return callback(new Error('No items provided for order'));
      }

      const orderSqlWithNotes = `
        INSERT INTO orders (user_id, total, notes, status, created_at)
        VALUES (?, ?, ?, ?, NOW())
      `;

      const orderSqlLegacy = `
        INSERT INTO orders (user_id, total, created_at)
        VALUES (?, ?, NOW())
      `;

      db.beginTransaction((txnErr) => {
        if (txnErr) return callback(txnErr);

        const insertOrder = (useNotes) => {
          const sql = useNotes ? orderSqlWithNotes : orderSqlLegacy;
          const params = useNotes ? [userId, total, notes, status] : [userId, total];

          db.query(sql, params, (err, result) => {
            if (err) {
              if (useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
                return insertOrder(false);
              }
              return db.rollback(() => callback(err));
            }

            const orderId = result.insertId;
            const values = items.map((i) => [
              orderId,
              i.productId,
              i.price,
              i.quantity
            ]);

            const itemsSql = `
              INSERT INTO order_items (order_id, product_id, price, quantity)
              VALUES ?
            `;

            db.query(itemsSql, [values], (itemErr) => {
              if (itemErr) {
                return db.rollback(() => callback(itemErr));
              }

              const updateStock = (index = 0) => {
                if (index >= items.length) {
                  return db.commit((commitErr) => {
                    if (commitErr) {
                      return db.rollback(() => callback(commitErr));
                    }
                    return callback(null, { orderId });
                  });
                }

                const line = items[index];
                const stockSql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
                db.query(stockSql, [line.quantity, line.productId, line.quantity], (stockErr, updateResult) => {
                  if (stockErr) {
                    return db.rollback(() => callback(stockErr));
                  }

                  if (updateResult.affectedRows === 0) {
                    const insufficient = new Error('INSUFFICIENT_STOCK');
                    insufficient.code = 'INSUFFICIENT_STOCK';
                    return db.rollback(() => callback(insufficient));
                  }

                  return updateStock(index + 1);
                });
              };

              return updateStock();
            });
          });
        };

        insertOrder(true);
      });
    },

    getOrdersByUser(userId, callback) {
      const sqlWithNotes = `
        SELECT o.id, o.total, o.notes, o.status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
      `;

      const sqlLegacy = `
        SELECT o.id, o.total, o.status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
      `;

      const runQuery = (useNotes) => {
        const sql = useNotes ? sqlWithNotes : sqlLegacy;
        db.query(sql, [userId], (err, rows = []) => {
          if (err) {
            if (useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
              return runQuery(false);
            }
            return callback(err);
          }

          const orders = {};

          rows.forEach((r) => {
            if (!orders[r.id]) {
              orders[r.id] = {
                id: r.id,
                total: Number(r.total),
                notes: useNotes ? (r.notes || '') : '',
                status: r.status || 'delivered',
                created_at: r.created_at,
                items: []
              };
            }

            orders[r.id].items.push({
              product_id: r.product_id,
              productName: r.productName,
              price: Number(r.price) || 0,
              quantity: r.quantity
            });
          });

          callback(null, Object.values(orders));
        });
      };

      runQuery(true);
    },

    getOrderById(orderId, userId, callback) {
      const filterClause = userId ? 'AND o.user_id = ?' : '';
      const params = userId ? [orderId, userId] : [orderId];

      const sqlWithNotes = `
        SELECT o.id, o.total, o.notes, o.status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.id = ? ${filterClause}
      `;

      const sqlLegacy = `
        SELECT o.id, o.total, o.status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.id = ? ${filterClause}
      `;

      const runQuery = (useNotes) => {
        const sql = useNotes ? sqlWithNotes : sqlLegacy;
        db.query(sql, params, (err, rows = []) => {
          if (err) {
            if (useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
              return runQuery(false);
            }
            return callback(err);
          }
          if (!rows.length) return callback(null, null);

          const order = {
            id: rows[0].id,
            total: Number(rows[0].total),
            notes: useNotes ? (rows[0].notes || '') : '',
            status: rows[0].status || 'delivered',
            created_at: rows[0].created_at,
            items: []
          };

          rows.forEach((r) => {
            order.items.push({
              product_id: r.product_id,
              productName: r.productName,
              price: Number(r.price) || 0,
              quantity: r.quantity
            });
          });

          callback(null, order);
        });
      };

      runQuery(true);
    },

    updateOrderStatus(orderId, status, callback) {
      const sql = 'UPDATE orders SET status = ? WHERE id = ?';
      db.query(sql, [status, orderId], (err, result) => {
        if (err) return callback(err);
        callback(null, { affectedRows: result.affectedRows });
      });
    },

    getOrderStats(callback) {
      const sql = `
        SELECT
          (SELECT COUNT(*) FROM orders) AS totalOrders,
          (SELECT COALESCE(SUM(quantity), 0) FROM order_items) AS totalItems
      `;
      db.query(sql, (err, rows = []) => {
        if (err) return callback(err);
        const row = rows[0] || {};
        callback(null, {
          totalOrders: Number(row.totalOrders) || 0,
          totalItems: Number(row.totalItems) || 0
        });
      });
    },

    getAllOrders(callback) {
      const sqlWithStatus = `
        SELECT
          o.id,
          o.user_id,
          u.username,
          u.email,
          o.total,
          o.status,
          o.created_at,
          COUNT(oi.order_id) AS itemCount
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id
        ORDER BY o.created_at DESC
      `;

      const sqlLegacy = `
        SELECT
          o.id,
          o.user_id,
          u.username,
          u.email,
          o.total,
          o.created_at,
          COUNT(oi.order_id) AS itemCount
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id
        ORDER BY o.created_at DESC
      `;

      const runQuery = (useStatus) => {
        const sql = useStatus ? sqlWithStatus : sqlLegacy;
        db.query(sql, (err, rows = []) => {
          if (err) {
            if (useStatus && err.code === 'ER_BAD_FIELD_ERROR') {
              return runQuery(false);
            }
            return callback(err);
          }

          const orders = rows.map(r => ({
            id: r.id,
            user_id: r.user_id,
            username: r.username || 'Unknown',
            email: r.email || '',
            total: Number(r.total) || 0,
            status: useStatus ? (r.status || 'delivered') : 'delivered',
            created_at: r.created_at,
            itemCount: Number(r.itemCount) || 0
          }));

          callback(null, orders);
        });
      };

      runQuery(true);
    }

  };
}

module.exports = OrdersModel();
