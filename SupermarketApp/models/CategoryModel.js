const db = require('../db');

function CategoryModel() {
  const ensureTable = (callback) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      )
    `;
    db.query(sql, callback);
  };

  return {
    getAll(callback) {
      ensureTable((err) => {
        if (err) return callback(err);
        db.query('SELECT id, name FROM categories ORDER BY name ASC', (qErr, rows = []) => {
          if (qErr) return callback(qErr);
          callback(null, rows);
        });
      });
    },

    findOrCreate(name, callback) {
      if (!name) return callback(null, null);
      const trimmed = name.trim();
      if (!trimmed) return callback(null, null);
      ensureTable((err) => {
        if (err) return callback(err);
        db.query('SELECT id, name FROM categories WHERE name = ? LIMIT 1', [trimmed], (findErr, rows = []) => {
          if (findErr) return callback(findErr);
          if (rows.length) return callback(null, rows[0]);
          db.query('INSERT INTO categories (name) VALUES (?)', [trimmed], (insErr, result) => {
            if (insErr) return callback(insErr);
            return callback(null, { id: result.insertId, name: trimmed });
          });
        });
      });
    }
  };
}

module.exports = CategoryModel();
