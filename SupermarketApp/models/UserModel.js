const db = require('../db');

function StudentModel() {
  return {
    getAllStudents(callback) {
      const sql = 'SELECT id, username, email, password, address, contact, role FROM users';
      db.query(sql, (err, results) => {
        if (err) return callback(err);
        callback(null, results);
      });
    },

    getStudentById(id, callback) {
      const sql = 'SELECT id, username, email, password, address, contact, role FROM users WHERE id = ? LIMIT 1';
      db.query(sql, [id], (err, results) => {
        if (err) return callback(err);
        callback(null, results[0] || null);
      });
    },

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

    updateStudent(id, studentData, callback) {
      const allowed = ['username', 'email', 'password', 'address', 'contact', 'role'];
      const keys = Object.keys(studentData).filter(k => allowed.includes(k));
      if (keys.length === 0) return callback(new Error('No valid fields provided for update'));

      const setClauses = [];
      const params = [];
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

    deleteStudent(id, callback) {
      const sql = 'DELETE FROM users WHERE id = ?';
      db.query(sql, [id], (err, result) => {
        if (err) return callback(err);
        callback(null, { affectedRows: result.affectedRows });
      });
    },

    findByFields(username, email, contact, callback) {
      const sql = `
        SELECT id, username, email, contact
        FROM users
        WHERE username = ? OR email = ? OR contact = ?
        LIMIT 1
      `;
      db.query(sql, [username, email, contact], (err, rows = []) => {
        if (err) return callback(err);
        callback(null, rows);
      });
    }
  };
}

module.exports = StudentModel();
