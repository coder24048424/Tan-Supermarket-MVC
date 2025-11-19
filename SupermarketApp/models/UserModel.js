const db = require('../db');

function StudentModel() {
  return {
    // Get all users (includes password for login checks)
    getAllStudents(callback) {
      const sql = 'SELECT id, username, email, password, address, contact, role FROM users';
      db.query(sql, (err, results) => {
        if (err) return callback(err);
        callback(null, results);
      });
    },

    // Get single user by id
    getStudentById(id, callback) {
      const sql = 'SELECT id, username, email, password, address, contact, role FROM users WHERE id = ? LIMIT 1';
      db.query(sql, [id], (err, results) => {
        if (err) return callback(err);
        callback(null, results[0] || null);
      });
    },

    // Add a new user; password hashed via SHA1 in SQL
    addStudent(studentData, callback) {
      const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)';
      const params = [
        studentData.username || null,
        studentData.email || null,
        studentData.password || null,
        studentData.address || null,
        studentData.contact || null,
        studentData.role || 'user'
      ];
      db.query(sql, params, (err, result) => {
        if (err) return callback(err);
        callback(null, { insertId: result.insertId, affectedRows: result.affectedRows });
      });
    },

    // Update user (partial). If password provided it's hashed.
    updateStudent(id, studentData, callback) {
      const allowed = ['username', 'email', 'password', 'address', 'contact', 'role'];
      const keys = Object.keys(studentData).filter(k => allowed.includes(k));
      if (keys.length === 0) return callback(new Error('No valid fields provided for update'));

      let setClauses = [];
      let params = [];
      keys.forEach(k => {
        if (k === 'password') {
          setClauses.push('password = SHA1(?)');
          params.push(studentData[k]);
        } else {
          setClauses.push(`${k} = ?`);
          params.push(studentData[k]);
        }
      });
      params.push(id);

      const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`;
      db.query(sql, params, (err, result) => {
        if (err) return callback(err);
        callback(null, { affectedRows: result.affectedRows, changedRows: result.changedRows });
      });
    },

    // Delete user by id
    deleteStudent(id, callback) {
      const sql = 'DELETE FROM users WHERE id = ?';
      db.query(sql, [id], (err, result) => {
        if (err) return callback(err);
        callback(null, { affectedRows: result.affectedRows });
      });
    }
  };
}

module.exports = StudentModel();