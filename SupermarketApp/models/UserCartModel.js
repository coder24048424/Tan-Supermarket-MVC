const db = require('../db');

function UserCartModel() {
  const ensureTable = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS user_cart_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_product (user_id, product_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `;
    db.query(sql, callback);
  };

  ensureTable(() => {});

  return {
    getCartForUser(userId, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = `
          SELECT uci.product_id, uci.quantity, p.productName, p.price, p.image
          FROM user_cart_items uci
          JOIN products p ON uci.product_id = p.id
          WHERE uci.user_id = ?
        `;
        db.query(sql, [userId], (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          const cart = rows.map((r) => ({
            productId: r.product_id,
            productName: r.productName,
            price: Number(r.price) || 0,
            quantity: Number(r.quantity) || 0,
            image: r.image
          }));
          return callback(null, cart);
        });
      });
    },

    setItemQuantity(userId, productId, quantity, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        if (quantity <= 0) {
          const delSql = 'DELETE FROM user_cart_items WHERE user_id = ? AND product_id = ?';
          return db.query(delSql, [userId, productId], callback);
        }
        const sql = `
          INSERT INTO user_cart_items (user_id, product_id, quantity)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)
        `;
        db.query(sql, [userId, productId, quantity], callback);
      });
    },

    removeItem(userId, productId, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'DELETE FROM user_cart_items WHERE user_id = ? AND product_id = ?';
        db.query(sql, [userId, productId], callback);
      });
    },

    replaceCart(userId, items = [], callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        db.beginTransaction((txnErr) => {
          if (txnErr) return callback(txnErr);

          const clearSql = 'DELETE FROM user_cart_items WHERE user_id = ?';
          db.query(clearSql, [userId], (clearErr) => {
            if (clearErr) return db.rollback(() => callback(clearErr));

            if (!items.length) {
              return db.commit((commitErr) => {
                if (commitErr) return db.rollback(() => callback(commitErr));
                return callback(null);
              });
            }

            const values = items.map((i) => [userId, i.productId, i.quantity]);
            const insertSql = 'INSERT INTO user_cart_items (user_id, product_id, quantity) VALUES ?';
            db.query(insertSql, [values], (insertErr) => {
              if (insertErr) return db.rollback(() => callback(insertErr));
              return db.commit((commitErr) => {
                if (commitErr) return db.rollback(() => callback(commitErr));
                return callback(null);
              });
            });
          });
        });
      });
    },

    clearCart(userId, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'DELETE FROM user_cart_items WHERE user_id = ?';
        db.query(sql, [userId], callback);
      });
    }
  };
}

module.exports = UserCartModel();
