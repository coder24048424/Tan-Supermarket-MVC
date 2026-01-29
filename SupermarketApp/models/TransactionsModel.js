const db = require('../db');

function TransactionsModel() {
  const ensureTable = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        orderId VARCHAR(64) NOT NULL,
        payerId VARCHAR(64) NOT NULL,
        payerEmail VARCHAR(255) NOT NULL,
        payerName VARCHAR(128),
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        status VARCHAR(32) NOT NULL,
        method VARCHAR(32) NOT NULL,
        time DATETIME NOT NULL
      )
    `;
    db.query(sql, callback);
  };

  const ensureColumn = (columnSql) => {
    const sql = `ALTER TABLE transactions ADD COLUMN ${columnSql}`;
    db.query(sql, (err) => {
      if (err && err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_DUP_KEYNAME') {
        console.error('Failed to ensure transactions column:', err);
      }
    });
  };

  ensureTable(() => {
    ensureColumn('payerName VARCHAR(128)');
    ensureColumn('method VARCHAR(32) NOT NULL DEFAULT \'UNKNOWN\'');
  });

  return {
    createTransaction(payload, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = `
          INSERT INTO transactions (orderId, payerId, payerEmail, payerName, amount, currency, status, method, time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
          payload.orderId,
          payload.payerId,
          payload.payerEmail,
          payload.payerName || null,
          payload.amount,
          payload.currency,
          payload.status,
          payload.method,
          payload.time
        ];
        db.query(sql, values, callback);
      });
    },
    listTransactions(filters, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const clauses = [];
        const values = [];
        if (filters) {
          if (filters.orderId) {
            clauses.push('orderId = ?');
            values.push(filters.orderId);
          }
          if (filters.method) {
            clauses.push('method = ?');
            values.push(filters.method);
          }
          if (filters.status) {
            clauses.push('status = ?');
            values.push(filters.status);
          }
          if (filters.payer) {
            clauses.push('(payerName LIKE ? OR payerEmail LIKE ? OR payerId LIKE ?)');
            const like = `%${filters.payer}%`;
            values.push(like, like, like);
          }
          if (filters.from) {
            clauses.push('time >= ?');
            values.push(filters.from);
          }
          if (filters.to) {
            clauses.push('time <= ?');
            values.push(filters.to);
          }
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const sql = `
          SELECT id, orderId, payerId, payerEmail, payerName, amount, currency, status, method, time
          FROM transactions
          ${where}
          ORDER BY time DESC, id DESC
        `;
        db.query(sql, values, callback);
      });
    }
  };
}

module.exports = TransactionsModel();
