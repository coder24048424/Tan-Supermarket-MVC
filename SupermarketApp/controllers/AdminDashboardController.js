const ProductModel = require('../models/ProductModel');
const OrdersModel = require('../models/OrdersModel');
const UserModel = require('../models/UserModel');
const RefundModel = require('../models/RefundModel');

const LOW_STOCK_THRESHOLD = 10;

function AdminDashboardController() {
  const toPromise = (fn, ...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (err, data) => (err ? reject(err) : resolve(data || [])));
    });

  return {
    async dashboard(req, res) {
      const success = req.flash('success');
      const errors = req.flash('error');

      try {
        const [products, orders, users, pendingRefunds] = await Promise.all([
          toPromise(ProductModel.getAllProducts),
          toPromise(OrdersModel.getAllOrders),
          toPromise(UserModel.getAllStudents),
          new Promise((resolve) => {
            RefundModel.getPendingCount((err, count = 0) => resolve(err ? 0 : count));
          })
        ]);

        const totalProducts = products.length;
        const lowStock = products.filter(p => (p.quantity || 0) > 0 && (p.quantity || 0) <= LOW_STOCK_THRESHOLD).length;
        const outOfStock = products.filter(p => (p.quantity || 0) === 0).length;
        const inventoryValue = products.reduce((sum, p) => sum + ((parseFloat(p.price) || 0) * (p.quantity || 0)), 0);

        const totalOrders = orders.length;
        const pendingOrders = orders.filter(o => String(o.status || '').toLowerCase() === 'pending').length;
        const deliveredOrders = orders.filter(o => String(o.status || '').toLowerCase() === 'delivered').length;
        const totalRevenue = orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);

        const activeUsers = users.filter(u => String(u.role || '').toLowerCase() !== 'deleted').length;
        const adminUsers = users.filter(u => String(u.role || '').toLowerCase() === 'admin').length;
        const deletedUsers = users.filter(u => String(u.role || '').toLowerCase() === 'deleted').length;

        const recentOrders = [...orders]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 6)
          .map(o => ({
            id: o.id,
            user: o.username || 'User',
            total: Number(o.total) || 0,
            status: o.status || 'pending',
            created_at: o.created_at,
            items: o.items ? o.items.length : 0
          }));

        const overview = {
          products: { total: totalProducts, lowStock, outOfStock, inventoryValue },
          orders: { total: totalOrders, pending: pendingOrders, delivered: deliveredOrders, revenue: totalRevenue },
          users: { total: users.length, active: activeUsers, admins: adminUsers, deleted: deletedUsers },
          refunds: { pending: pendingRefunds }
        };

        return res.render('adminDashboard', {
          user: req.session.user,
          overview,
          recentOrders,
          success,
          errors
        });
      } catch (err) {
        console.error('Failed to load admin dashboard:', err);
        return res.status(500).render('error', { message: 'Failed to load dashboard' });
      }
    }
  };
}

module.exports = AdminDashboardController();
