const ProductModel = require('../models/ProductModel');
const { matchesCategory, CATEGORY_NAMES } = require('../utils/catalog');

const LOW_STOCK_THRESHOLD = 10;
const STOCK_OPTIONS = [
  { value: 'all', label: 'All stock' },
  { value: 'in', label: 'In stock' },
  { value: 'low', label: `Low stock (≤${LOW_STOCK_THRESHOLD})` },
  { value: 'out', label: 'Out of stock' }
];
const SORT_OPTIONS = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'stock-asc', label: 'Stock: Low to High' },
  { value: 'stock-desc', label: 'Stock: High to Low' }
];
const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  ...CATEGORY_NAMES.map((name) => ({ value: name, label: name }))
];

const parseFilters = (query = {}) => {
  const stockValues = new Set(STOCK_OPTIONS.map(opt => opt.value));
  const sortValues = new Set(SORT_OPTIONS.map(opt => opt.value));
  const categoryValues = new Set(CATEGORY_NAMES);
  const searchTerm = (query.q ?? query.search ?? '').toString().trim();
  const stock = stockValues.has(query.stock) ? query.stock : 'all';
  const sort = sortValues.has(query.sort) ? query.sort : 'featured';
  const categoryInput = (query.category ?? '').toString().trim();
  const category = categoryValues.has(categoryInput) ? categoryInput : null;
  return {
    search: searchTerm,
    stock,
    sort,
    category,
    hasActive: Boolean(searchTerm) || stock !== 'all' || sort !== 'featured' || Boolean(category)
  };
};

const applyFilters = (products = [], filters) => {
  let filtered = [...products];
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    filtered = filtered.filter(p => (p.productName || '').toLowerCase().includes(searchLower));
  }

  if (filters.stock === 'in') {
    filtered = filtered.filter(p => (p.quantity || 0) > 0);
  } else if (filters.stock === 'low') {
    filtered = filtered.filter(p => (p.quantity || 0) > 0 && (p.quantity || 0) <= LOW_STOCK_THRESHOLD);
  } else if (filters.stock === 'out') {
    filtered = filtered.filter(p => (p.quantity || 0) === 0);
  }

  if (filters.category) {
    filtered = filtered.filter(p => matchesCategory(p, filters.category));
  }

  if (filters.sort === 'price-asc') {
    filtered.sort((a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0));
  } else if (filters.sort === 'price-desc') {
    filtered.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0));
  } else if (filters.sort === 'stock-asc') {
    filtered.sort((a, b) => (a.quantity || 0) - (b.quantity || 0));
  } else if (filters.sort === 'stock-desc') {
    filtered.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
  }

  return filtered;
};

const buildStats = (products = [], filtered = []) => {
  const lowStockCount = products.filter(p => (p.quantity || 0) > 0 && (p.quantity || 0) <= LOW_STOCK_THRESHOLD).length;
  const outOfStockCount = products.filter(p => (p.quantity || 0) === 0).length;
  const inventoryValue = products.reduce((sum, p) => {
    return sum + ((parseFloat(p.price) || 0) * (p.quantity || 0));
  }, 0);
  return {
    totalProducts: products.length,
    filteredCount: filtered.length,
    lowStockCount,
    outOfStockCount,
    inventoryValue
  };
};

function ProductController() {
  return {
    // List all products
    listProducts(req, res) {
      const errors = req.flash('error');
      const success = req.flash('success');
      const filters = parseFilters(req.query);

      ProductModel.getAllProducts((err, products) => {
        if (err) {
          console.error('Error fetching products:', err);
          if (req.accepts('html')) return res.status(500).render('error', { message: 'Failed to fetch products' });
          return res.status(500).json({ error: 'Failed to fetch products' });
        }

        const filteredProducts = applyFilters(products, filters);
        const stats = buildStats(products, filteredProducts);
        const basePayload = {
          products: filteredProducts,
          user: req.session.user,
          filters,
          stats,
          filterOptions: { stock: STOCK_OPTIONS, sort: SORT_OPTIONS, category: CATEGORY_OPTIONS },
          errors,
          success
        };

        // Render inventory for admin route, shopping for public route
        if (req.accepts('html')) {
          if (req.path && req.path.startsWith('/inventory')) {
            return res.render('inventory', basePayload);
          }
          return res.render('shopping', basePayload);
        }

        return res.json({
          data: filteredProducts,
          filters,
          stats
        });
      });
    },

    // Get a single product by ID
    getProductById(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('Invalid product id');

      ProductModel.getProductById(id, (err, product) => {
        if (err) {
          console.error(`Error fetching product ${id}:`, err);
          if (req.accepts('html')) return res.status(500).render('error', { message: 'Failed to fetch product' });
          return res.status(500).json({ error: 'Failed to fetch product' });
        }
        if (!product) {
          if (req.accepts('html')) return res.status(404).render('error', { message: 'Product not found' });
          return res.status(404).json({ error: 'Product not found' });
        }

        const sendResponse = (relatedProducts = []) => {
          if (req.accepts('html')) return res.render('product', { product, user: req.session.user, relatedProducts });
          return res.json({ product, relatedProducts });
        };

        ProductModel.getAllProducts((allErr, allProducts = []) => {
          if (allErr) {
            console.error('Error fetching products for related list:', allErr);
            return sendResponse([]);
          }

          const others = allProducts.filter(p => p.id !== product.id);
          const categoryValue = product.category || null;
          const related = others
            .filter(p => {
              const sameCategory = categoryValue ? matchesCategory(p, categoryValue) : false;
              const sameOrigin = p.origin && product.origin && p.origin === product.origin;
              return sameCategory || sameOrigin;
            })
            .slice(0, 4);

          const fallback = related.length ? related : others.slice(0, 4);

          return sendResponse(fallback);
        });
      });
    },

    // Add a new product
    createProduct(req, res) {
      const productData = {
        productName: req.body.productName,
        quantity: req.body.quantity,
        price: req.body.price,
        image: req.file ? req.file.filename : req.body.image
      };

      if (!productData.productName) {
        req.flash('error', 'productName is required');
        return res.redirect('/addProduct');
      }

      ProductModel.addProduct(productData, (err) => {
        if (err) {
          console.error('Error adding product:', err);
          req.flash('error', 'Failed to add product');
          return res.redirect('/addProduct');
        }
        req.flash('success', 'Product added');
        return res.redirect('/inventory');
      });
    },

    // Render edit form
    editProductView(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        req.flash('error', 'Invalid product id');
        return res.redirect('/inventory');
      }

      ProductModel.getProductById(id, (err, product) => {
        if (err || !product) {
          req.flash('error', 'Product not found');
          return res.redirect('/inventory');
        }
        return res.render('updateProduct', { product, user: req.session.user, errors: req.flash('error'), success: req.flash('success') });
      });
    },

    // Update an existing product by ID (partial updates allowed)
    updateProduct(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('Invalid product id');

      const productData = {};
      ['productName', 'quantity', 'price'].forEach((f) => {
        if (typeof req.body[f] !== 'undefined') productData[f] = req.body[f];
      });
      if (req.file) productData.image = req.file.filename;

      if (Object.keys(productData).length === 0) {
        req.flash('error', 'No valid fields provided for update');
        return res.redirect(`/updateProduct/${id}`);
      }

      ProductModel.updateProduct(id, productData, (err) => {
        if (err) {
          console.error(`Error updating product ${id}:`, err);
          req.flash('error', 'Failed to update product');
          return res.redirect(`/updateProduct/${id}`);
        }
        req.flash('success', 'Product updated');
        return res.redirect('/inventory');
      });
    },

    // Delete a product by ID
    deleteProduct(req, res) {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('Invalid product id');

      ProductModel.deleteProduct(id, (err, result) => {
        if (err) {
          console.error(`Error deleting product ${id}:`, err);
          req.flash('error', 'Failed to delete product');
          return res.redirect('/inventory');
        }
        if (result.affectedRows === 0) req.flash('error', 'Product not found');
        else req.flash('success', 'Product deleted');
        return res.redirect('/inventory');
      });
    }
  };
}

module.exports = ProductController();
