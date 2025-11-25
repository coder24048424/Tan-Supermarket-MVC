const UserModel = require('../models/UserModel');
const OrdersModel = require('../models/OrdersModel');
const RefundModel = require('../models/RefundModel');

const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

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

    // ADMIN: list users
    adminListUsers(req, res) {
      const errors = req.flash('error');
      const success = req.flash('success');
      UserModel.getAllStudents((err, users) => {
        if (err) {
          console.error('Error fetching users:', err);
          return res.status(500).render('error', { message: 'Failed to fetch users' });
        }
        return res.render('users', { users, user: req.session.user, errors, success });
      });
    },

    // ADMIN: show edit form
    adminEditForm(req, res) {
      const errors = req.flash('error');
      const success = req.flash('success');
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        req.flash('error', 'Invalid user id');
        return res.redirect('/admin/users');
      }
      UserModel.getStudentById(id, (err, userProfile) => {
        if (err || !userProfile) {
          req.flash('error', 'User not found');
          return res.redirect('/admin/users');
        }
        return res.render('userEdit', { userProfile, user: req.session.user, errors, success });
      });
    },

    // ADMIN: update user (including role/password)
    adminUpdateUser(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        req.flash('error', 'Invalid user id');
        return res.redirect('/admin/users');
      }

      const {
        username = '',
        email = '',
        address = '',
        contact = '',
        role = '',
        password = '',
        confirmPassword = ''
      } = req.body;

      if (!username || !email || !address || !contact || !role) {
        req.flash('error', 'All fields except password are required.');
        return res.redirect(`/admin/users/${id}/edit`);
      }

      const updates = { username: username.trim(), email: email.trim(), address: address.trim(), contact: contact.trim(), role: role.trim() };

      if (password || confirmPassword) {
        if (password !== confirmPassword) {
          req.flash('error', 'Passwords must match.');
          return res.redirect(`/admin/users/${id}/edit`);
        }
        if (!strongPassword.test(password)) {
          req.flash('error', 'Password must be at least 8 chars and include upper, lower, number, and special.');
          return res.redirect(`/admin/users/${id}/edit`);
        }
        updates.password = password;
      }

      UserModel.updateStudent(id, updates, (err) => {
        if (err) {
          console.error(`Error updating user ${id}:`, err);
          req.flash('error', 'Failed to update user');
          return res.redirect(`/admin/users/${id}/edit`);
        }
        req.flash('success', 'User updated');
        return res.redirect('/admin/users');
      });
    },

    // ADMIN: delete (only if not admin role)
    adminDeleteUser(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        req.flash('error', 'Invalid user id');
        return res.redirect('/admin/users');
      }

      UserModel.getStudentById(id, (err, found) => {
        if (err || !found) {
          req.flash('error', 'User not found');
          return res.redirect('/admin/users');
        }

        if (found.role === 'admin') {
          req.flash('error', 'Demote admin to user before deletion.');
          return res.redirect(`/admin/users/${id}/edit`);
        }

        UserModel.deleteStudent(id, (delErr) => {
          if (delErr) {
            console.error(`Error deleting user ${id}:`, delErr);
            req.flash('error', 'Failed to delete user');
            return res.redirect('/admin/users');
          }
          req.flash('success', 'User deleted');
          return res.redirect('/admin/users');
        });
      });
    },

    // ADMIN: view orders for a user
    adminUserOrders(req, res) {
      const userId = parseInt(req.params.id, 10);
      if (Number.isNaN(userId)) {
        req.flash('error', 'Invalid user id');
        return res.redirect('/admin/users');
      }

      const errors = req.flash('error');
      const success = req.flash('success');

      UserModel.getStudentById(userId, (userErr, userProfile) => {
        if (userErr || !userProfile) {
          req.flash('error', 'User not found');
          return res.redirect('/admin/users');
        }

        OrdersModel.getOrdersByUser(userId, (orderErr, orders = []) => {
          if (orderErr) {
            console.error('Failed to load user orders:', orderErr);
            req.flash('error', 'Unable to load orders for this user.');
            return res.redirect('/admin/users');
          }

          const render = () => res.render('adminUserOrders', {
            user: req.session.user,
            userProfile,
            orders,
            errors,
            success
          });

          if (!orders.length) return render();

          let pending = orders.length;
          orders.forEach((order) => {
            RefundModel.getRefundsByOrder(order.id, (rErr, refunds = []) => {
              if (!rErr) {
                order.refunds = refunds;
                const statuses = refunds.map(r => String(r.status || '').toLowerCase());
                if (statuses.some(s => s === 'approved' || s === 'processed')) {
                  order.refundStatus = 'refunded';
                } else if (statuses.some(s => s === 'pending')) {
                  order.refundStatus = 'refund_pending';
                } else {
                  order.refundStatus = 'none';
                }
              }
              pending -= 1;
              if (pending === 0) return render();
              return null;
            });
          });
        });
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
        role: 'user'
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
