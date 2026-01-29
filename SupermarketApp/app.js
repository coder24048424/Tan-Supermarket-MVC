const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');

const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const OrdersController = require('./controllers/OrdersController');
const RefundController = require('./controllers/RefundController');
const PaymentController = require('./controllers/PaymentController');
const AdminDashboardController = require('./controllers/AdminDashboardController');
const HomeController = require('./controllers/HomeController');
const CartController = require('./controllers/CartController');
const NetsService = require('./services/net');
const OrderService = require('./services/OrderService');
const OrdersModel = require('./models/OrdersModel');
const ProductModel = require('./models/ProductModel');
const UserModel = require('./models/UserModel');
const RefundModel = require('./models/RefundModel');
const UserCartModel = require('./models/UserCartModel');

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
app.use(express.json());

app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Validate that the session user still exists (handles deleted users)
app.use((req, res, next) => {
    const user = req.session.user;
    if (!user) return next();

    UserModel.getStudentById(user.id, (err, freshUser) => {
        if (err) {
            console.error('Failed to validate session user:', err);
            return next();
        }
        if (!freshUser || (freshUser.role && freshUser.role.toLowerCase() === 'deleted')) {
            // wipe session if user no longer exists or is marked deleted
            req.session.user = null;
            req.session.cart = [];
            req.session.lastCartUserId = null;
            req.flash('error', 'Your account is no longer available. Please contact support or register again.');
            return res.redirect('/login');
        }
        // keep session in sync with any updates
        req.session.user = freshUser;
        return next();
    });
});

// Keep cart in sync across sessions/browsers by hydrating from DB for logged-in users
app.use((req, res, next) => {
    const user = req.session.user;
    if (!user) return next();
    UserCartModel.getCartForUser(user.id, (err, cart = []) => {
        if (!err) {
            req.session.cart = cart;
        }
        return next();
    });
});

// Make the logged-in user available in every view
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    const cart = req.session.cart || [];
    res.locals.cartCount = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    res.locals.navCategories = [];
    res.locals.pendingRefundCount = 0;
    if (res.locals.user && res.locals.user.role === 'admin') {
        return RefundModel.getPendingCount((err, count) => {
            if (!err) res.locals.pendingRefundCount = count;
            return next();
        });
    }
    next();
});

// ========================
// Auth Middlewares
// ========================
const checkAuthenticated = (req, res, next) => {
    const sessionUser = req.session.user;
    if (!sessionUser) {
        req.flash('error', 'Please log in to view this page.');
        return res.redirect('/login');
    }

    // Re-validate user exists (handles deleted users)
    UserModel.getStudentById(sessionUser.id, (err, freshUser) => {
        if (err) {
            console.error('Failed to validate user session:', err);
            req.flash('error', 'Please log in again.');
            req.session.user = null;
            req.session.cart = [];
            req.session.lastCartUserId = null;
            return res.redirect('/login');
        }

        if (!freshUser || (freshUser.role && freshUser.role.toLowerCase() === 'deleted')) {
            req.flash('error', 'Your account is no longer available. Please contact support or register again.');
            req.session.user = null;
            req.session.cart = [];
            req.session.lastCartUserId = null;
            return res.redirect('/login');
        }

        req.session.user = freshUser;
        return next();
    });
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    req.flash('error', 'Access denied.');
    res.redirect('/shopping');
};

const checkCustomer = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        req.flash('error', 'Admins cannot add items or checkout. Switch to a user account to shop.');
        return res.redirect('/inventory');
    }
    return next();
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

    const phoneDigits = String(contact || '').replace(/\D/g, '');
    if (phoneDigits.length < 8) {
        req.flash('error', 'Contact number must have at least 8 digits.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    next();
};

// ========================
// ROUTES
// ========================

// Home
app.get('/', HomeController.homePage);

// Admin dashboard
app.get('/admin/dashboard', checkAuthenticated, checkAdmin, (req, res) =>
    AdminDashboardController.dashboard(req, res)
);

// ========================
// AUTH
// ========================
app.get('/register', (req, res) => {
    res.render('register', {
        messages: req.flash('error'),
        successMessages: req.flash('success'),
        formData: req.flash('formData')[0]
    });
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

        if (String(match.role || '').toLowerCase() === 'deleted') {
            req.flash('error', 'This account has been deactivated.');
            return res.redirect('/login');
        }

        req.flash('success', 'Login successful!');

        const guestCart = Array.isArray(req.session.cart) ? [...req.session.cart] : [];

        return UserCartModel.getCartForUser(match.id, (cartErr, persistedCart = []) => {
            let mergedCart = persistedCart;
            if (!cartErr && guestCart.length) {
                const map = new Map();
                persistedCart.forEach(item => {
                    map.set(item.productId, { ...item });
                });
                guestCart.forEach(item => {
                    const existing = map.get(item.productId);
                    if (existing) {
                        existing.quantity += item.quantity;
                    } else {
                        map.set(item.productId, { ...item });
                    }
                });
                mergedCart = Array.from(map.values());

                const ids = mergedCart.map(i => i.productId);
                ProductModel.getProductsByIds(ids, (prodErr, products = []) => {
                    if (prodErr) {
                        console.error('Failed to cap merged cart by stock:', prodErr);
                        return finalizeMerge(mergedCart);
                    }

                    const catalog = new Map(products.map(p => [p.id, p]));
                    let adjusted = false;
                    mergedCart = mergedCart.map(item => {
                        const product = catalog.get(item.productId);
                        const available = product ? Number(product.quantity) || 0 : 0;
                        if (available <= 0) {
                            adjusted = true;
                            return null;
                        }
                        const cappedQty = Math.min(item.quantity, available);
                        if (cappedQty !== item.quantity) adjusted = true;
                        return { ...item, quantity: cappedQty };
                    }).filter(Boolean);

                    UserCartModel.replaceCart(match.id, mergedCart, (persistErr) => {
                        if (persistErr) {
                            console.error('Failed to merge guest cart:', persistErr);
                        }
                        if (adjusted) {
                            req.flash('error', 'Cart quantities were adjusted to match current stock.');
                        }
                        return finalizeMerge(mergedCart);
                    });
                });
            } else {
                return finalizeMerge(mergedCart);
            }

            function finalizeMerge(cartData) {
                req.session.user = match;
                req.session.cart = cartData;
                req.session.lastCartUserId = match.id;

                if (match.role === 'admin') return res.redirect('/inventory');
                return res.redirect('/shopping');
            }
        });
    });
});

// Logout
app.get('/logout', (req, res) => {
    if (req.session) {
        req.session.cart = [];
        req.session.user = null;
        req.session.lastCartUserId = null;
    }
    res.redirect('/');
});

// ========================
// SHOPPING
// ========================
app.get('/shopping', (req, res) =>
    ProductController.listProducts(req, res)
);

// ========================
// CART SYSTEM
// ========================

// Add to cart (guests allowed; admins blocked)
app.post('/add-to-cart/:id', (req, res, next) => checkCustomer(req, res, next), (req, res) =>
    CartController.addToCart(req, res)
);

// Cart page
app.get('/cart', (req, res) =>
    CartController.cartPage(req, res)
);

// Remove from cart
app.get('/remove-from-cart/:id', (req, res) =>
    CartController.removeFromCart(req, res)
);

// Clear entire cart
app.post('/cart/clear', (req, res) =>
    CartController.clearCart(req, res)
);

// Update quantity in cart
app.post('/cart/update/:id', (req, res) =>
    CartController.updateQuantity(req, res)
);

// ========================
// ADMIN PRODUCT MGMT
// ========================
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) =>
    ProductController.listProducts(req, res)
);

app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    ProductModel.getCategories((err, categories = []) => {
        res.render('addProduct', { user: req.session.user, categories });
    });
});

app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) =>
    ProductController.createProduct(req, res)
);

app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) =>
    ProductController.editProductView(req, res)
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
app.post('/admin/users/:id/activate', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminActivateUser(req, res)
);
app.get('/admin/users/:id/orders', checkAuthenticated, checkAdmin, (req, res) =>
    UserController.adminUserOrders(req, res)
);

// Product detail (public)
app.get('/product/:id', (req, res) =>
    ProductController.getProductById(req, res)
);

// ========================
// CHECKOUT & ORDERS
// ========================

// Show checkout page
app.get('/checkout', checkAuthenticated, checkCustomer, (req, res) =>
    OrdersController.checkoutPage(req, res)
);

// Confirm checkout (review)
app.post('/checkout/confirm', checkAuthenticated, checkCustomer, (req, res) =>
    OrdersController.checkoutConfirm(req, res)
);

// Prepare payment
app.post('/checkout/payment', checkAuthenticated, checkCustomer, (req, res) =>
    PaymentController.preparePayment(req, res)
);

// Payment page
app.get('/payment', checkAuthenticated, checkCustomer, (req, res) =>
    PaymentController.paymentPage(req, res)
);

// Payment method selection
app.post('/payment/method', checkAuthenticated, checkCustomer, (req, res) =>
    PaymentController.setPaymentMethod(req, res)
);

// NETS QR payment
app.post('/nets-qr', checkAuthenticated, checkCustomer, (req, res) => {
    const pending = req.session.pendingCheckout;
    if (!pending || !pending.cart || !pending.cart.length) {
        req.flash('error', 'No pending checkout found.');
        return res.redirect('/checkout');
    }

    pending.paymentMethod = 'nets';
    req.session.pendingCheckout = pending;

    return res.redirect('/payment?autoNets=1');
});

app.post('/nets-qr/request', checkAuthenticated, checkCustomer, async (req, res) => {
    try {
        const pending = req.session.pendingCheckout;
        if (!pending || !pending.cart || !pending.cart.length) {
            return res.status(400).json({ success: false, error: 'No pending checkout found.' });
        }

        pending.paymentMethod = 'nets';
        req.session.pendingCheckout = pending;

        const cartTotal = Number(pending.total || 0).toFixed(2);
        const payload = await NetsService.generateQrData(cartTotal);
        if (!payload || !payload.success) {
            return res.status(400).json(payload || { success: false, error: 'Unable to generate NETS QR.' });
        }

        pending.netsTxnRetrievalRef = payload.txnRetrievalRef;
        req.session.pendingCheckout = pending;

        return res.json(payload);
    } catch (err) {
        console.error('NETS QR request failed:', err);
        return res.status(500).json({ success: false, error: 'Unable to generate NETS QR.' });
    }
});

// NETS QR payment status (SSE)
app.get('/sse/payment-status/:txnRetrievalRef', checkAuthenticated, checkCustomer, async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const txnRetrievalRef = req.params.txnRetrievalRef;
    let pollCount = 0;
    const maxPolls = 60;
    let frontendTimeoutStatus = 0;

    const interval = setInterval(async () => {
        pollCount += 1;

        try {
            const response = await NetsService.queryNetsQrStatus(txnRetrievalRef, frontendTimeoutStatus);
            res.write(`data: ${JSON.stringify(response.data)}\n\n`);

            const resData = response.data && response.data.result && response.data.result.data;

            if (resData && resData.response_code === '00' && resData.txn_status === 1) {
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                res.end();
            } else if (
                frontendTimeoutStatus === 1 &&
                resData &&
                (resData.response_code !== '00' || resData.txn_status === 2)
            ) {
                res.write(`data: ${JSON.stringify({ fail: true, ...resData })}\n\n`);
                clearInterval(interval);
                res.end();
            }
        } catch (err) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }

        if (pollCount >= maxPolls) {
            clearInterval(interval);
            frontendTimeoutStatus = 1;
            res.write(`data: ${JSON.stringify({ fail: true, error: 'Timeout' })}\n\n`);
            res.end();
        }
    }, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// NETS QR success handler
app.get('/nets-qr/success', checkAuthenticated, checkCustomer, async (req, res) => {
    const user = req.session.user;
    const pending = req.session.pendingCheckout;
    const txnRetrievalRef = String(req.query.txn_retrieval_ref || '').trim();
    const existing = req.session.netsPayment || {};

    if (existing.orderId && (!txnRetrievalRef || existing.txnRetrievalRef === txnRetrievalRef)) {
        OrdersModel.updatePaymentMethod(existing.orderId, 'nets', (updateErr) => {
            if (updateErr) {
                console.error('Failed to update payment method:', updateErr);
            }
        });
        req.flash('success', 'Payment successful. Thank you for your payment!');
        return res.redirect(`/orders/${existing.orderId}`);
    }

    if (!pending || !pending.cart || !pending.cart.length) {
        req.flash('error', 'No pending checkout found.');
        return res.redirect('/payment');
    }

    if (txnRetrievalRef && pending.netsTxnRetrievalRef && pending.netsTxnRetrievalRef !== txnRetrievalRef) {
        req.flash('error', 'NETS transaction does not match this checkout.');
        return res.redirect('/payment');
    }

    try {
        const orderResult = await OrderService.placeOrderFromPending(user, pending, 'nets');
        req.session.cart = [];
        req.session.pendingCheckout = null;
        req.session.netsPayment = { txnRetrievalRef: txnRetrievalRef || pending.netsTxnRetrievalRef || '', orderId: orderResult.orderId };

        UserCartModel.clearCart(user.id, (clearErr) => {
            if (clearErr) console.error('Failed to clear persisted cart:', clearErr);
        });

        OrdersModel.updatePaymentMethod(orderResult.orderId, 'nets', (updateErr) => {
            if (updateErr) {
                console.error('Failed to update payment method:', updateErr);
            }
        });
        req.flash('success', 'Payment successful. Thank you for your payment!');
        return res.redirect(`/orders/${orderResult.orderId}`);
    } catch (err) {
        console.error('Failed to finalize NETS payment:', err);
        req.flash('error', err.message || 'Unable to finalize NETS payment.');
        return res.redirect('/payment');
    }
});

app.get('/nets-qr/fail', checkAuthenticated, checkCustomer, (req, res) =>
    res.render('netsQrFail', {
        title: 'Error',
        responseCode: 'N.A.',
        instructions: '',
        errorMsg: 'Unable to generate NETS QR code.'
    })
);

app.get('/nets-qr/cancel', checkAuthenticated, checkCustomer, (req, res) =>
    res.render('netsQrCancel', (() => {
        const pending = req.session.pendingCheckout || {};
        const method = String(pending.paymentMethod || '').toLowerCase();
        const methodLabel = method === 'paypal'
            ? 'PayPal'
            : method === 'card'
                ? 'Card'
                : method === 'paynow'
                    ? 'PayNow'
                    : method === 'nets'
                        ? 'NETS QR'
                        : 'Unknown';

        return {
            title: 'Payment Cancelled',
            cancelledMethod: methodLabel,
            cancelledMethodKey: method,
            total: Number(pending.total || 0).toFixed(2)
        };
    })())
);

// PayPal checkout
app.post('/paypal/create-order', checkAuthenticated, checkCustomer, (req, res) =>
    PaymentController.createPayPalOrder(req, res)
);
app.post('/paypal/capture-order', checkAuthenticated, checkCustomer, (req, res) =>
    PaymentController.capturePayPalOrder(req, res)
);

// Place order
app.post('/checkout', checkAuthenticated, checkCustomer, (req, res) =>
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
// Admin all orders
app.get('/admin/orders', checkAuthenticated, checkAdmin, (req, res) =>
    OrdersController.adminAllOrders(req, res)
);
// Order invoice (HTML)
app.get('/orders/:id/invoice', checkAuthenticated, (req, res) =>
    OrdersController.invoice(req, res)
);

// Admin order management
app.post('/orders/:id/status', checkAuthenticated, checkAdmin, (req, res) =>
    OrdersController.updateStatus(req, res)
);
app.post('/orders/:id/refund', checkAuthenticated, checkAdmin, (req, res) =>
    RefundController.createRefund(req, res)
);
app.post('/orders/:id/refund-request', checkAuthenticated, (req, res) =>
    RefundController.requestRefund(req, res)
);
app.get('/orders/:id/refunds', checkAuthenticated, checkAdmin, (req, res) =>
    RefundController.listByOrder(req, res)
);
app.post('/refunds/:id/status', checkAuthenticated, checkAdmin, (req, res) =>
    RefundController.updateStatus(req, res)
);
app.get('/admin/refunds', checkAuthenticated, checkAdmin, (req, res) =>
    RefundController.listAll(req, res)
);
app.post('/admin/refunds/:id/status', checkAuthenticated, checkAdmin, (req, res) =>
    RefundController.updateStatus(req, res)
);

// Profile
app.get('/profile', checkAuthenticated, (req, res) =>
    UserController.profilePage(req, res)
);
app.post('/profile', checkAuthenticated, (req, res) =>
    UserController.profileUpdate(req, res)
);

// Reorder all items from a past order into the cart
app.post('/orders/:id/reorder', checkAuthenticated, checkCustomer, (req, res) => {
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
