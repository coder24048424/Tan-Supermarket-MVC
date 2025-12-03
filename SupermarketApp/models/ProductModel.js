const db = require('../db');

function ProductModel() {
  return {
    ensureCategoryColumn(callback) {
      const checkSql = "SHOW COLUMNS FROM products LIKE 'category'";
      db.query(checkSql, (err, rows = []) => {
        if (err) return callback(err);
        if (rows.length) return callback(null);
        const alterSql = "ALTER TABLE products ADD COLUMN category VARCHAR(100) NULL";
        db.query(alterSql, callback);
      });
    },

    // Get all products
    getAllProducts(callback) {
      const sql = 'SELECT id, productName, quantity, price, image, category FROM products';
      this.ensureCategoryColumn((colErr) => {
        if (colErr) return callback(colErr);
        db.query(sql, (err, results) => {
          if (err) return callback(err);
          callback(null, results);
        });
      });
    },

    // Get a product by ID
    getProductById(id, callback) {
      const sql = 'SELECT id, productName, quantity, price, image, category FROM products WHERE id = ? LIMIT 1';
      this.ensureCategoryColumn((colErr) => {
        if (colErr) return callback(colErr);
        db.query(sql, [id], (err, results) => {
          if (err) return callback(err);
          callback(null, results[0] || null);
        });
      });
    },

    getProductsByIds(ids = [], callback) {
      if (!Array.isArray(ids) || ids.length === 0) return callback(null, []);
      const placeholders = ids.map(() => '?').join(', ');
      const sql = `SELECT id, productName, quantity, price, image, category FROM products WHERE id IN (${placeholders})`;
      this.ensureCategoryColumn((colErr) => {
        if (colErr) return callback(colErr);
        db.query(sql, ids, (err, results) => {
          if (err) return callback(err);
          callback(null, results);
        });
      });
    },

    // Add a new product
    // productData: { productName, quantity, price, image, category }
    addProduct(productData, callback) {
      const sql = 'INSERT INTO products (productName, quantity, price, image, category) VALUES (?, ?, ?, ?, ?)';
      const params = [
        productData.productName || null,
        typeof productData.quantity !== 'undefined' ? productData.quantity : null,
        typeof productData.price !== 'undefined' ? productData.price : null,
        productData.image || null,
        productData.category || null
      ];
      this.ensureCategoryColumn((colErr) => {
        if (colErr) return callback(colErr);
        db.query(sql, params, (err, result) => {
          if (err) return callback(err);
          callback(null, { insertId: result.insertId, affectedRows: result.affectedRows });
        });
      });
    },

    // Update product by ID (partial updates allowed)
    // productData may include any of: productName, quantity, price, image, category
    updateProduct(id, productData, callback) {
      const allowed = ['productName', 'quantity', 'price', 'image', 'category'];
      const keys = Object.keys(productData).filter(k => allowed.includes(k));
      if (keys.length === 0) return callback(new Error('No valid fields provided for update'));

      const setClauses = keys.map(k => `${k} = ?`).join(', ');
      const params = keys.map(k => productData[k]);
      params.push(id);

      const sql = `UPDATE products SET ${setClauses} WHERE id = ?`;
      this.ensureCategoryColumn((colErr) => {
        if (colErr) return callback(colErr);
        db.query(sql, params, (err, result) => {
          if (err) return callback(err);
          callback(null, { affectedRows: result.affectedRows, changedRows: result.changedRows });
        });
      });
    },

    // Delete product by ID
    deleteProduct(id, callback) {
      const sql = 'DELETE FROM products WHERE id = ?';
      db.query(sql, [id], (err, result) => {
        if (err) return callback(err);
        callback(null, { affectedRows: result.affectedRows });
      });
    }
  };
}

module.exports = ProductModel();
