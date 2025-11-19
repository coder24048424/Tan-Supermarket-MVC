const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');

const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const ProductModel = require('./models/ProductModel');
const UserModel = require('./models/UserModel');

const app = express();

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); }
});
const upload = multer({ storage: storage });

// Set up view engine & middleware
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

// Auth middlewares
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    req.flash('error', 'Access denied');
    res.redirect('/shopping');
};

// Validation middleware
const validateRegistration = (req, res, next) => {
    const { username, email, password, address, contact, role } = req.body;
    if (!username || !email || !password || !address || !contact || !role) {
        return res.status(400).send('All fields are required.');
    }
    if (password.length < 6) {
        req.flash('error', 'Password should be at least 6 or more characters long');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    next();
};

// Routes wired to controllers (controllers handle rendering/redirects or JSON responses)

// Home
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user });
});

// Inventory - handled by ProductController
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => ProductController.listProducts(req, res));

// Register pages and create user via UserController
app.get('/register', (req, res) => {
    res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});
app.post('/register', validateRegistration, (req, res) => UserController.createUser(req, res));

// Login (uses UserModel to avoid direct SQL in app.js)
app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    // Hash password to compare with DB-stored SHA1
    const hashed = crypto.createHash('sha1').update(password).digest('hex');

    UserModel.getAllStudents((err, users) => {
        if (err) {
            console.error('Login error:', err);
            req.flash('error', 'Login failed');
            return res.redirect('/login');
        }
        const match = users.find(u => u.email === email && u.password === hashed);
        if (match) {
            req.session.user = match;
            req.flash('success', 'Login successful!');
            if (req.session.user.role === 'user') return res.redirect('/shopping');
            return res.redirect('/inventory');
        } else {
            req.flash('error', 'Invalid email or password.');
            return res.redirect('/login');
        }
    });
});

// Shopping - use ProductController (controller should render shopping view)
app.get('/shopping', checkAuthenticated, (req, res) => ProductController.listProducts(req, res));

// Add to cart: use ProductModel to fetch product (no direct SQL)
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10) || 1;
    if (Number.isNaN(productId)) return res.status(400).send('Invalid product id');

    ProductModel.getProductById(productId, (err, product) => {
        if (err) {
            console.error('Error fetching product for cart:', err);
            return res.status(500).send('Server error');
        }
        if (!product) return res.status(404).send('Product not found');

        if (!req.session.cart) req.session.cart = [];

        const existing = req.session.cart.find(item => item.productId === productId);
        if (existing) {
            existing.quantity += quantity;
        } else {
            req.session.cart.push({
                productId: product.id,
                productName: product.productName,
                price: product.price,
                quantity: quantity,
                image: product.image
            });
        }
        res.redirect('/cart');
    });
});

// Cart, logout
app.get('/cart', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', { cart, user: req.session.user });
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Product detail using controller
app.get('/product/:id', checkAuthenticated, (req, res) => ProductController.getProductById(req, res));

// Add / Update / Delete product routes (use ProductController; handle file upload)
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', { user: req.session.user });
});
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => ProductController.createProduct(req, res));

app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => ProductController.getProductById(req, res));
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => ProductController.updateProduct(req, res));

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => ProductController.deleteProduct(req, res));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
