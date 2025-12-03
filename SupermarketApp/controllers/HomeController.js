const ProductModel = require('../models/ProductModel');
const OrdersModel = require('../models/OrdersModel');

const buildCategoriesFromProducts = (products = []) => {
  const groups = new Map();
  products.forEach((p) => {
    const key = (p.category || 'Uncategorized').trim() || 'Uncategorized';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  return Array.from(groups.entries()).map(([name, items]) => ({ name, items }));
};

function HomeController() {
  return {
    homePage(req, res) {
      const sessionUser = req.session.user;

      const renderHome = (products = [], hasPurchaseHistory = false) => {
        const bestSeller = products.reduce((top, product) => {
          if (!top) return product;
          return (product.quantity || 0) > (top.quantity || 0) ? product : top;
        }, null);

        const categories = buildCategoriesFromProducts(products);
        const newProducts = [...products]
          .sort((a, b) => (b.id || 0) - (a.id || 0))
          .slice(0, 4);

        res.render('index', {
          user: sessionUser,
          bestSeller,
          categories,
          newProducts,
          hasPurchaseHistory
        });
      };

      ProductModel.getAllProducts((err, products = []) => {
        if (err) {
          console.error('Failed to load products for homepage:', err);
          return renderHome([], false);
        }

        if (sessionUser) {
          return OrdersModel.getOrdersByUser(sessionUser.id, (ordersErr, orders = []) => {
            if (ordersErr) {
              console.error('Failed to load purchase history for home:', ordersErr);
            }
            const hasPurchaseHistory = Array.isArray(orders) && orders.length > 0;
            return renderHome(products, hasPurchaseHistory);
          });
        }

        return renderHome(products, false);
      });
    }
  };
}

module.exports = HomeController();
