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

const app = express();

// ========================
// Multer file upload setup
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
// App config
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

// ========================
// Middlewares
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
    const { username, email, password, address, contact, role } = req.body;

    if (!username || !email || !password || !address || !contact || !role) {
        req.flash('error', 'All fields are required.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    if (password.length < 6) {
        req.flash('error', 'Password must be at least 6 characters.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    next();
};

// ========================
// Routes
// ========================

// Home
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

// Register
app.get('/register', (req, res) => {
    res.render('register', {
        messages: req.flash('error'),
        formData: req.flash('formData')[0]
    });
});
app.post('/register', validateRegistration, (req, res) =>
    UserController.createUser(req, res)
);

// Login
app.get('/login', (req, res) => {
    res.render('login', {
        messages: req.flash('success'),
        errors: req.flash('error')
    });
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
        req.flash('success', 'Login successful!');

        if (match.role === 'admin') return res.redirect('/inventory');
        return res.redirect('/shopping');
    });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Shopping
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
        if (err || !product) return res.redirect('/shopping');

        if (!req.session.cart) req.session.cart = [];

        const existing = req.session.cart.find(i => i.productId === productId);

        if (existing) {
            existing.quantity += quantity;
        } else {
            req.session.cart.push({
                productId: product.id,
                productName: product.productName,
                price: product.price,
                quantity,
                image: product.image
            });
        }

        res.redirect('/cart');
    });
});

// View cart
app.get('/cart', checkAuthenticated, (req, res) => {
    res.render('cart', {
        cart: req.session.cart || [],
        user: req.session.user
    });
});

// Remove from cart
app.get('/remove-from-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);

    if (!req.session.cart) req.session.cart = [];

    req.session.cart = req.session.cart.filter(
        item => item.productId !== productId
    );

    req.flash('success', 'Item removed.');
    res.redirect('/cart');
});

// ========================
// PRODUCT MANAGEMENT (Admin)
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

// Orders list
app.get('/orders', checkAuthenticated, (req, res) =>
    OrdersController.viewOrders(req, res)
);

// Order details
app.get('/orders/:id', checkAuthenticated, (req, res) =>
    OrdersController.getOrderById(req, res)
);

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
