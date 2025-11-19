const ProductModel = require('../models/ProductModel');

function ProductController() {
  return {
    // List all products
    listProducts(req, res) {
      ProductModel.getAllProducts((err, products) => {
        if (err) {
          console.error('Error fetching products:', err);
          if (req.accepts('html')) return res.status(500).render('error', { message: 'Failed to fetch products' });
          return res.status(500).json({ error: 'Failed to fetch products' });
        }

        // Render inventory for admin route, shopping for public route
        if (req.accepts('html')) {
          if (req.path && req.path.startsWith('/inventory')) {
            return res.render('inventory', { products, user: req.session.user, messages: req.flash('error') });
          }
          return res.render('shopping', { products, user: req.session.user });
        }

        return res.json(products);
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
        if (req.accepts('html')) return res.render('product', { product, user: req.session.user });
        return res.json(product);
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