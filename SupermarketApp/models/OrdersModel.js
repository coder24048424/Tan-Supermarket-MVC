const db = require('../db');

function OrdersModel() {
  const ensureOrderSchema = (callback) => {
    const ensureColumn = (col, ddl, next) => {
      const checkSql = 'SHOW COLUMNS FROM orders LIKE ?';
      db.query(checkSql, [col], (err, rows = []) => {
        if (err) return next(err);
        if (rows.length) return next(null);
        db.query(ddl, (alterErr) => next(alterErr || null));
      });
    };

    ensureColumn('status', "ALTER TABLE orders ADD COLUMN status VARCHAR(32) DEFAULT 'pending'", (err) => {
      if (err) return callback(err);
      ensureColumn('shipping_status', "ALTER TABLE orders ADD COLUMN shipping_status VARCHAR(32) DEFAULT 'processing'", callback);
    });
  };

  const ensureStatusColumns = (callback) => ensureOrderSchema(callback);

  return {

    createOrder(userId, items, total, notes, status = 'pending', callback) {
      if (!Array.isArray(items) || items.length === 0) {
        return callback(new Error('No items provided for order'));
      }

      const orderSqlWithNotes = `
        INSERT INTO orders (user_id, total, notes, status, shipping_status, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
      `;

      const orderSqlLegacy = `
        INSERT INTO orders (user_id, total, created_at)
        VALUES (?, ?, NOW())
      `;

      const startInsert = () => {
        db.beginTransaction((txnErr) => {
          if (txnErr) return callback(txnErr);

          const insertOrder = (useNotes) => {
            const sql = useNotes ? orderSqlWithNotes : orderSqlLegacy;
            const params = useNotes ? [userId, total, notes, status, 'processing'] : [userId, total];

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
      };

      ensureOrderSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        startInsert();
      });
    },

    getOrdersByUser(userId, callback) {
      const sqlWithNotes = `
        SELECT o.id, o.total, o.notes, o.status, o.shipping_status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
      `;

      const sqlLegacy = `
        SELECT o.id, o.total, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
      `;

      const sqlNoNotesNoStatus = `
        SELECT o.id, o.total, o.created_at,
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
            if (!useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
              return db.query(sqlNoNotesNoStatus, [userId], (err2, rows2 = []) => {
                if (err2) return callback(err2);
                const ordersFallback = {};
                rows2.forEach((r) => {
                  if (!ordersFallback[r.id]) {
                    ordersFallback[r.id] = {
                      id: r.id,
                      total: Number(r.total),
                      notes: '',
                      status: 'delivered',
                      created_at: r.created_at,
                      items: []
                    };
                  }
                  ordersFallback[r.id].items.push({
                    product_id: r.product_id,
                    productName: r.productName,
                    price: Number(r.price) || 0,
                    quantity: r.quantity
                  });
                });
                return callback(null, Object.values(ordersFallback));
              });
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
                  status: r.status || 'pending',
                  shipping_status: r.shipping_status || 'processing',
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

    getAllOrders(callback) {
      const sqlWithNotes = `
        SELECT o.id, o.user_id, o.total, o.status, o.shipping_status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName,
               u.username, u.email
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
      `;

      db.query(sqlWithNotes, [], (err, rows = []) => {
        if (err) return callback(err);

        const orders = {};
        rows.forEach((r) => {
          if (!orders[r.id]) {
            orders[r.id] = {
              id: r.id,
              user_id: r.user_id,
              username: r.username || 'Deleted user',
              email: r.email || '',
              total: Number(r.total),
              notes: r.notes || '',
              status: r.status || 'pending',
              shipping_status: r.shipping_status || 'processing',
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

        const sorted = Object.values(orders).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return callback(null, sorted);
      });
    },

    getOrderById(orderId, userId, callback) {
      const filterClause = userId ? 'AND o.user_id = ?' : '';
      const params = userId ? [orderId, userId] : [orderId];

      const sqlWithNotes = `
        SELECT o.id, o.user_id, o.total, o.notes, o.status, o.shipping_status, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName,
               u.role AS owner_role,
               u.username AS owner_username
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.id = ? ${filterClause}
      `;

      const sqlLegacy = `
        SELECT o.id, o.user_id, o.total, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName,
               u.role AS owner_role,
               u.username AS owner_username
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.id = ? ${filterClause}
      `;

      const sqlNoNotesNoStatus = `
        SELECT o.id, o.user_id, o.total, o.created_at,
               oi.product_id, oi.price, oi.quantity,
               p.productName,
               u.role AS owner_role,
               u.username AS owner_username
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.id = ? ${filterClause}
      `;

      const runQuery = (useNotes) => {
        const sql = useNotes ? sqlWithNotes : sqlLegacy;
        db.query(sql, params, (err, rows = []) => {
          if (err) {
            if (useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
              return runQuery(false);
            }
            if (!useNotes && err.code === 'ER_BAD_FIELD_ERROR') {
              return db.query(sqlNoNotesNoStatus, params, (err2, rows2 = []) => {
                if (err2 || !rows2.length) return callback(err2 || null, rows2.length ? rows2 : null);
                const order = {
                  id: rows2[0].id,
                  user_id: rows2[0].user_id,
                  owner_role: rows2[0].owner_role || null,
                  owner_username: rows2[0].owner_username || null,
                  total: Number(rows2[0].total),
                  notes: '',
                  status: 'pending',
                  created_at: rows2[0].created_at,
                  items: []
                };
                rows2.forEach((r) => {
                  order.items.push({
                    product_id: r.product_id,
                    productName: r.productName,
                    price: Number(r.price) || 0,
                    quantity: r.quantity
                  });
                });
                return callback(null, order);
              });
            }
            return callback(err);
          }
          if (!rows.length) return callback(null, null);

          const order = {
            id: rows[0].id,
            user_id: rows[0].user_id,
            owner_role: rows[0].owner_role || null,
            owner_username: rows[0].owner_username || null,
            total: Number(rows[0].total),
            notes: useNotes ? (rows[0].notes || '') : '',
            status: rows[0].status || 'pending',
            shipping_status: rows[0].shipping_status || 'processing',
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
      ensureStatusColumns((err) => {
        if (err) return callback(err);
        const sql = 'UPDATE orders SET status = ? WHERE id = ?';
        db.query(sql, [status, orderId], (qErr, result) => {
          if (qErr) return callback(qErr);
          callback(null, { affectedRows: result.affectedRows });
        });
      });
    },

    updateShippingStatus(orderId, shippingStatus, callback) {
      ensureStatusColumns((err) => {
        if (err) return callback(err);
        const sql = 'UPDATE orders SET shipping_status = ? WHERE id = ?';
        db.query(sql, [shippingStatus, orderId], (qErr, result) => {
          if (qErr) return callback(qErr);
          callback(null, { affectedRows: result.affectedRows });
        });
      });
    }

  };
}

module.exports = OrdersModel();
