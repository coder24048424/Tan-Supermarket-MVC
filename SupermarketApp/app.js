const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');

const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const OrdersController = require('./controllers/OrdersController');
const ProductModel = require('./models/ProductModel');
const UserModel = require('./models/UserModel');
const OrdersModel = require('./models/OrdersModel');
const { buildCategories, CATEGORY_NAMES } = require('./utils/catalog');

const app = express();

// ========================
// Multer Setup
// ========================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

// ========================
// App Middlewares
// ========================
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));

app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Make the logged-in user available in every view
app.use((req, res, next) => {
    const rawUser = req.session.user || null;
    const isAdmin = rawUser && rawUser.role === 'admin';
    const viewAsUser = Boolean(isAdmin && req.session.viewAsUser);
    res.locals.viewMode = isAdmin ? (viewAsUser ? 'user' : 'admin') : null;
    res.locals.user = viewAsUser ? { ...rawUser, role: 'user' } : rawUser;
    const cart = req.session.cart || [];
    res.locals.cartCount = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    res.locals.navCategories = CATEGORY_NAMES;
    next();
});

// ========================
// Auth Middlewares
// ========================
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    req.flash('error', 'Please log in to view this page.');
    res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    req.flash('error', 'Access denied.');
    res.redirect('/shopping');
};

const validateRegistration = (req, res, next) => {
    const { username, email, password, confirmPassword, address, contact } = req.body;

    if (!username || !email || !password || !confirmPassword || !address || !contact) {
        req.flash('error', 'All fields are required.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    if (password !== confirmPassword) {
        req.flash('error', 'Passwords must match.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
    if (!strongPassword.test(password)) {
        req.flash('error', 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    next();
};

// ========================
// ROUTES
// ========================

// Home
app.get('/', (req, res) => {
    const isAdmin = req.session.user && req.session.user.role === 'admin' && res.locals.viewMode !== 'user';

    ProductModel.getAllProducts((err, products = []) => {
        if (err) {
            console.error('Failed to load products for homepage:', err);
            return res.render('index', {
                user: req.session.user,
                bestSeller: null,
                categories: [],
                newProducts: [],
                adminStats: null
            });
        }

        const bestSeller = products.reduce((top, product) => {
            if (!top) return product;
            return (product.quantity || 0) > (top.quantity || 0) ? product : top;
        }, null);

        const categories = buildCategories(products);
        const newProducts = [...products]
            .sort((a, b) => (b.id || 0) - (a.id || 0))
            .slice(0, 4);
        const lowStockItems = products
            .filter(p => (Number(p.quantity) || 0) <= 10)
            .sort((a, b) => (Number(a.quantity) || 0) - (Number(b.quantity) || 0))
            .slice(0, 5);

        const renderPage = (adminStats = null) => res.render('index', {
            user: req.session.user,
            bestSeller,
            categories,
            newProducts,
            adminStats
        });

        if (isAdmin) {
            OrdersModel.getOrderStats((statsErr, adminStats) => {
                if (statsErr) {
                    console.error('Failed to load admin order stats:', statsErr);
                    return renderPage(null);
                }
                return renderPage({
                    ...adminStats,
                    lowStockItems,
                    lowStockCount: lowStockItems.length
                });
            });
        } else {
            renderPage(null);
        }
    });
});

// ========================
// AUTH
// ========================
app.get('/register', (req, res) => {
    res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});

app.post('/register', validateRegistration, (req, res) =>
    UserController.createUser(req, res)
);

app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        req.flash('error', 'All fields required.');
        return res.redirect('/login');
    }

    const hashed = crypto.createHash('sha1').update(password).digest('hex');

    UserModel.getAllStudents((err, users) => {
        if (err) return res.redirect('/login');

        const match = users.find(u => u.email === email && u.password === hashed);

        if (!match) {
            req.flash('error', 'Invalid email or password.');
            return res.redirect('/login');
        }

        req.session.user = match;
        // Keep cart for the same user across logins; clear it if a different user logs in
        const previousOwnerId = req.session.lastCartUserId;
        if (previousOwnerId && previousOwnerId !== match.id) {
            req.session.cart = [];
        }
        req.session.lastCartUserId = match.id;
        req.flash('success', 'Login successful!');

        if (match.role === 'admin') return res.redirect('/inventory');
        return res.redirect('/shopping');
    });
});

// Logout
app.get('/logout', (req, res) => {
    if (req.session) {
        req.session.lastCartUserId = req.session.user ? req.session.user.id : req.session.lastCartUserId;
        // Keep the cart in session so it can be restored on the next login by the same user
        req.session.user = null;
    }
    res.redirect('/');
});

// ========================
// SHOPPING
// ========================
app.get('/shopping', checkAuthenticated, (req, res) =>
    ProductController.listProducts(req, res)
);

// ========================
// CART SYSTEM
// ========================

// Add to cart
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10) || 1;

    ProductModel.getProductById(productId, (err, product) => {
        if (err || !product) {
            req.flash('error', 'Unable to add this product right now.');
            return res.redirect('/shopping');
        }

        if (!req.session.cart) req.session.cart = [];

        const existing = req.session.cart.find(i => i.productId === productId);
        const available = Number(product.quantity) || 0;

        if (available === 0) {
            req.flash('error', `${product.productName} is currently out of stock.`);
            return res.redirect('/shopping');
        }

        const existingQty = existing ? existing.quantity : 0;
        const desiredQty = existingQty + quantity;

        if (desiredQty > available) {
            req.flash('error', `${product.productName} only has ${available} left. Adjust the quantity in your cart.`);
            return res.redirect('/shopping');
        }

        if (existing) {
            existing.quantity = desiredQty;
        } else {
            req.session.cart.push({
                productId: product.id,
                productName: product.productName,
                price: product.price,
                quantity,
                image: product.image
            });
        }

        req.flash('success', `${product.productName} added to your cart.`);
        res.redirect('/cart');
    });
});

// Cart page
app.get('/cart', checkAuthenticated, (req, res) => {
    res.render('cart', {
        cart: req.session.cart || [],
        user: req.session.user,
        errors: req.flash('error'),
        success: req.flash('success')
    });
});

// Remove from cart
app.get('/remove-from-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);

    if (!req.session.cart) req.session.cart = [];

    req.session.cart = req.session.cart.filter(item => item.productId !== productId);

    req.flash('success', 'Item removed.');
    res.redirect('/cart');
});

// ========================
// ADMIN PRODUCT MGMT
// ========================
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) =>
    ProductController.listProducts(req, res)
);

app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', { user: req.session.user });
});

app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) =>
    ProductController.createProduct(req, res)
);

app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) =>
    ProductController.getProductById(req, res)
);

app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) =>
    ProductController.updateProduct(req, res)
);

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) =>
    ProductController.deleteProduct(req, res)
);

// Admin user management
app.get('/admin/users', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminListUsers(req, res)
);
app.get('/admin/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminEditForm(req, res)
);
app.post('/admin/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminUpdateUser(req, res)
);
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminDeleteUser(req, res)
);
app.get('/admin/users/:id/orders', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminUserOrders(req, res)
);

// Product detail
app.get('/product/:id', checkAuthenticated, (req, res) =>
    ProductController.getProductById(req, res)
);

// ========================
// CHECKOUT & ORDERS
// ========================

// Show checkout page
app.get('/checkout', checkAuthenticated, (req, res) =>
    OrdersController.checkoutPage(req, res)
);

// Place order
app.post('/checkout', checkAuthenticated, (req, res) =>
    OrdersController.placeOrder(req, res)
);

// Purchase history
app.get('/orders', checkAuthenticated, (req, res) =>
    OrdersController.viewOrders(req, res)
);

// Order details
app.get('/orders/:id', checkAuthenticated, (req, res) =>
    OrdersController.getOrderById(req, res)
);

app.post('/orders/:id/status', checkAuthenticated, checkAdmin, (req, res) =>
    OrdersController.updateStatus(req, res)
);

// Admin orders list
app.get('/admin/orders', checkAuthenticated, checkAdmin, (req, res) =>
    OrdersController.adminList(req, res)
);

// Reorder all items from a past order into the cart
app.post('/orders/:id/reorder', checkAuthenticated, (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId)) {
        req.flash('error', 'Invalid order.');
        return res.redirect('/orders');
    }

    OrdersController.reorder(req, res, orderId);
});

// ========================
// START SERVER
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
