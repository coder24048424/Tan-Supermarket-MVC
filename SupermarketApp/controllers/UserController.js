const UserModel = require('../models/UserModel');

function UserController() {
  return {
    // List all users
    listUsers(req, res) {
      UserModel.getAllStudents((err, users) => {
        if (err) {
          console.error('Error fetching users:', err);
          if (req.accepts('html')) return res.status(500).render('error', { message: 'Failed to fetch users' });
          return res.status(500).json({ error: 'Failed to fetch users' });
        }
        if (req.accepts('html')) return res.render('users', { users, user: req.session.user });
        return res.json(users);
      });
    },

    // Get a user by ID
    getUserById(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

      UserModel.getStudentById(id, (err, user) => {
        if (err) {
          console.error(`Error fetching user ${id}:`, err);
          if (req.accepts('html')) return res.status(500).render('error', { message: 'Failed to fetch user' });
          return res.status(500).json({ error: 'Failed to fetch user' });
        }
        if (!user) {
          if (req.accepts('html')) return res.status(404).render('error', { message: 'User not found' });
          return res.status(404).json({ error: 'User not found' });
        }
        if (req.accepts('html')) return res.render('profile', { userProfile: user, user: req.session.user });
        return res.json(user);
      });
    },

    // Create a new user
    createUser(req, res) {
      const userData = {
        username: req.body.username,
        email: req.body.email,
        password: req.body.password,
        address: req.body.address,
        contact: req.body.contact,
        role: req.body.role || 'user'
      };

      if (!userData.username || !userData.email || !userData.password) {
        req.flash('error', 'username, email and password are required');
        req.flash('formData', req.body);
        return res.redirect('/register');
      }

      UserModel.addStudent(userData, (err) => {
        if (err) {
          console.error('Error creating user:', err);
          req.flash('error', 'Failed to create user');
          req.flash('formData', req.body);
          return res.redirect('/register');
        }
        req.flash('success', 'Registration successful. Please log in.');
        return res.redirect('/login');
      });
    },

    // Update an existing user (partial updates allowed)
    updateUser(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

      const userData = {};
      ['username', 'email', 'password', 'address', 'contact', 'role'].forEach((f) => {
        if (typeof req.body[f] !== 'undefined') userData[f] = req.body[f];
      });

      if (Object.keys(userData).length === 0) {
        req.flash('error', 'No valid fields provided for update');
        return res.redirect(`/updateUser/${id}`);
      }

      UserModel.updateStudent(id, userData, (err) => {
        if (err) {
          console.error(`Error updating user ${id}:`, err);
          req.flash('error', 'Failed to update user');
          return res.redirect(`/updateUser/${id}`);
        }
        req.flash('success', 'User updated');
        return res.redirect('/inventory');
      });
    },

    // Delete a user by ID
    deleteUser(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

      UserModel.deleteStudent(id, (err, result) => {
        if (err) {
          console.error(`Error deleting user ${id}:`, err);
          req.flash('error', 'Failed to delete user');
          return res.redirect('/inventory');
        }
        if (result.affectedRows === 0) req.flash('error', 'User not found');
        else req.flash('success', 'User deleted');
        return res.redirect('/inventory');
      });
    }
  };
}

module.exports = UserController();