const db = require('../db');

function WalletModel() {
  const ensureWalletSchema = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS wallets (
        user_id INT NOT NULL,
        balance DECIMAL(10,2) NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id),
        CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `;

    db.query(sql, callback);
  };

  const ensureWalletTransactionSchema = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'completed',
        provider_ref VARCHAR(128),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_wallet_tx_user (user_id),
        CONSTRAINT fk_wallet_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `;

    db.query(sql, callback);
  };

  const ensureWalletRow = (userId, callback) => {
    const sql = `
      INSERT INTO wallets (user_id, balance)
      VALUES (?, 0)
      ON DUPLICATE KEY UPDATE balance = balance
    `;
    db.query(sql, [userId], callback);
  };

  return {
    getBalance(userId, callback) {
      ensureWalletSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        ensureWalletRow(userId, (ensureErr) => {
          if (ensureErr) return callback(ensureErr);
          db.query('SELECT balance FROM wallets WHERE user_id = ?', [userId], (err, rows = []) => {
            if (err) return callback(err);
            const balance = rows.length ? Number(rows[0].balance) : 0;
            return callback(null, balance);
          });
        });
      });
    },

    createTransaction({ userId, amount, method, status = 'completed', providerRef = null }, callback) {
      ensureWalletTransactionSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          INSERT INTO wallet_transactions (user_id, amount, method, status, provider_ref)
          VALUES (?, ?, ?, ?, ?)
        `;
        db.query(sql, [userId, amount, method, status, providerRef], (err, result) => {
          if (err) return callback(err);
          return callback(null, { id: result.insertId });
        });
      });
    },

    getTransactionsByUser(userId, callback) {
      ensureWalletTransactionSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          SELECT id, user_id, amount, method, status, provider_ref, created_at
          FROM wallet_transactions
          WHERE user_id = ?
          ORDER BY created_at DESC
        `;
        db.query(sql, [userId], (err, rows = []) => {
          if (err) return callback(err);
          return callback(null, rows);
        });
      });
    },

    getTransactionById(id, userId, callback) {
      ensureWalletTransactionSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          SELECT id, user_id, amount, method, status, provider_ref, created_at
          FROM wallet_transactions
          WHERE id = ? AND user_id = ?
        `;
        db.query(sql, [id, userId], (err, rows = []) => {
          if (err) return callback(err);
          return callback(null, rows.length ? rows[0] : null);
        });
      });
    },

    getAllBalances(callback) {
      ensureWalletSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          SELECT u.id, u.username, u.email, u.role, u.contact,
                 COALESCE(w.balance, 0) AS balance,
                 w.updated_at
          FROM users u
          LEFT JOIN wallets w ON u.id = w.user_id
          ORDER BY u.id ASC
        `;
        db.query(sql, [], (err, rows = []) => {
          if (err) return callback(err);
          return callback(null, rows);
        });
      });
    },

    addFunds(userId, amount, callback) {
      ensureWalletSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        db.beginTransaction((txnErr) => {
          if (txnErr) return callback(txnErr);
          const sql = `
            INSERT INTO wallets (user_id, balance)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)
          `;
          db.query(sql, [userId, amount], (insertErr) => {
            if (insertErr) {
              return db.rollback(() => callback(insertErr));
            }
            db.query('SELECT balance FROM wallets WHERE user_id = ?', [userId], (balErr, rows = []) => {
              if (balErr) {
                return db.rollback(() => callback(balErr));
              }
              return db.commit((commitErr) => {
                if (commitErr) {
                  return db.rollback(() => callback(commitErr));
                }
                const balance = rows.length ? Number(rows[0].balance) : 0;
                return callback(null, balance);
              });
            });
          });
        });
      });
    },

    deductFunds(userId, amount, callback) {
      ensureWalletSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        db.beginTransaction((txnErr) => {
          if (txnErr) return callback(txnErr);
          ensureWalletRow(userId, (ensureErr) => {
            if (ensureErr) {
              return db.rollback(() => callback(ensureErr));
            }
            const sql = 'UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?';
            db.query(sql, [amount, userId, amount], (updateErr, result) => {
              if (updateErr) {
                return db.rollback(() => callback(updateErr));
              }
              if (!result || result.affectedRows === 0) {
                const insufficient = new Error('INSUFFICIENT_FUNDS');
                insufficient.code = 'INSUFFICIENT_FUNDS';
                return db.rollback(() => callback(insufficient));
              }
              db.query('SELECT balance FROM wallets WHERE user_id = ?', [userId], (balErr, rows = []) => {
                if (balErr) {
                  return db.rollback(() => callback(balErr));
                }
                return db.commit((commitErr) => {
                  if (commitErr) {
                    return db.rollback(() => callback(commitErr));
                  }
                  const balance = rows.length ? Number(rows[0].balance) : 0;
                  return callback(null, balance);
                });
              });
            });
          });
        });
      });
    }
  };
}

module.exports = WalletModel();
