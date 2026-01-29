const db = require('../db');

function TransactionsModel() {
  const ensureTable = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        orderId VARCHAR(64) NOT NULL,
        payerId VARCHAR(64) NOT NULL,
        payerEmail VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        status VARCHAR(32) NOT NULL,
        time DATETIME NOT NULL
      )
    `;
    db.query(sql, callback);
  };

  ensureTable(() => {});

  return {
    createTransaction(payload, callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        const sql = `
          INSERT INTO transactions (orderId, payerId, payerEmail, amount, currency, status, time)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
          payload.orderId,
          payload.payerId,
          payload.payerEmail,
          payload.amount,
          payload.currency,
          payload.status,
          payload.time
        ];
        db.query(sql, values, callback);
      });
    }
  };
}

module.exports = TransactionsModel();
