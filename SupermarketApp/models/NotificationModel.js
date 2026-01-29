const db = require('../db');

function NotificationModel() {
  const ensureSchema = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS notifications (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        title VARCHAR(120) NOT NULL,
        message VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'unread',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_notifications_user (user_id),
        CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `;
    db.query(sql, callback);
  };

  return {
    createNotification({ userId, title, message }, callback) {
      ensureSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          INSERT INTO notifications (user_id, title, message)
          VALUES (?, ?, ?)
        `;
        db.query(sql, [userId, title, message], callback);
      });
    },

    listByUser(userId, limit = 5, callback) {
      ensureSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          SELECT id, title, message, status, created_at
          FROM notifications
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `;
        db.query(sql, [userId, Number(limit)], (err, rows = []) => {
          if (err) return callback(err);
          return callback(null, rows);
        });
      });
    },

    countUnread(userId, callback) {
      ensureSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = 'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND status = ?';
        db.query(sql, [userId, 'unread'], (err, rows = []) => {
          if (err) return callback(err);
          const total = rows.length ? Number(rows[0].total) : 0;
          return callback(null, total);
        });
      });
    },

    markAllRead(userId, callback) {
      ensureSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = 'UPDATE notifications SET status = ? WHERE user_id = ? AND status = ?';
        db.query(sql, ['read', userId, 'unread'], callback);
      });
    },

    listAllByUser(userId, callback) {
      ensureSchema((schemaErr) => {
        if (schemaErr) return callback(schemaErr);
        const sql = `
          SELECT id, title, message, status, created_at
          FROM notifications
          WHERE user_id = ?
          ORDER BY created_at DESC
        `;
        db.query(sql, [userId], (err, rows = []) => {
          if (err) return callback(err);
          return callback(null, rows);
        });
      });
    }
  };
}

module.exports = NotificationModel();
