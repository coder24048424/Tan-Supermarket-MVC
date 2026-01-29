const db = require('../db');

function RefundModel() {
  const ensureTable = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS refunds (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        amount DOUBLE(10,2) NOT NULL,
        reason TEXT,
        destination VARCHAR(32) DEFAULT 'store_credit',
        status VARCHAR(32) DEFAULT 'pending',
        approved_amount DOUBLE(10,2) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `;
    db.query(sql, (createErr) => {
      if (createErr) return callback(createErr);
      const alterSql = 'ALTER TABLE refunds ADD COLUMN approved_amount DOUBLE(10,2) DEFAULT NULL';
      db.query(alterSql, (addErr) => {
        if (addErr && addErr.errno !== 1060) {
          return callback(addErr);
        }
        return callback(null);
      });
    });
  };

  ensureTable(() => {});

  return {
    createRefund(orderId, amount, reason, destination = 'store_credit', callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'INSERT INTO refunds (order_id, amount, reason, destination, status) VALUES (?, ?, ?, ?, ?)';
        db.query(sql, [orderId, amount, reason, destination, 'pending'], callback);
      });
    },

    getAllRefunds(callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = `
          SELECT r.id, r.order_id, r.amount, r.approved_amount, r.reason, r.destination, r.status, r.created_at,
                 o.user_id,
                 u.username,
                 o.total AS order_total,
                 o.payment_method
          FROM refunds r
          LEFT JOIN orders o ON r.order_id = o.id
          LEFT JOIN users u ON o.user_id = u.id
          ORDER BY r.created_at DESC
        `;
        db.query(sql, (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          return callback(null, rows);
        });
      });
    },

    getPendingCount(callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'SELECT COUNT(*) AS pending FROM refunds WHERE status = ?';
        db.query(sql, ['pending'], (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          const count = rows[0] ? Number(rows[0].pending) || 0 : 0;
          return callback(null, count);
        });
      });
    },

    getRefundById(refundId, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'SELECT * FROM refunds WHERE id = ? LIMIT 1';
        db.query(sql, [refundId], (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          return callback(null, rows[0] || null);
        });
      });
    },

    getRefundsByOrder(orderId, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'SELECT id, order_id, amount, approved_amount, reason, destination, status, created_at FROM refunds WHERE order_id = ? ORDER BY created_at DESC';
        db.query(sql, [orderId], (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          callback(null, rows);
        });
      });
    },

    updateRefundStatus(refundId, status, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'UPDATE refunds SET status = ? WHERE id = ?';
        db.query(sql, [status, refundId], callback);
      });
    },

    setApprovedAmount(refundId, amount, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = 'UPDATE refunds SET approved_amount = ? WHERE id = ?';
        db.query(sql, [amount, refundId], callback);
      });
    }
  };
}

module.exports = RefundModel();
