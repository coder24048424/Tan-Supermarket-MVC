const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');

const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const OrdersController = require('./controllers/OrdersController');
const RefundController = require('./controllers/RefundController');
const ProductModel = require('./models/ProductModel');
const UserModel = require('./models/UserModel');
const RefundModel = require('./models/RefundModel');
const UserCartModel = require('./models/UserCartModel');
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
    res.locals.navCategories = CATEGORY_NAMES;
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
    if (req.session.user) return next();
    req.flash('error', 'Please log in to view this page.');
    res.redirect('/login');
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
app.get('/', (req, res) => {
    ProductModel.getAllProducts((err, products = []) => {
        if (err) {
            console.error('Failed to load products for homepage:', err);
            return res.render('index', {
                user: req.session.user,
                bestSeller: null,
                categories: [],
                newProducts: []
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

        res.render('index', {
            user: req.session.user,
            bestSeller,
            categories,
            newProducts
        });
    });
});

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
app.post('/add-to-cart/:id', (req, res, next) => checkCustomer(req, res, next), (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10) || 1;

    const sessionUser = req.session.user;

    const ensureSessionCart = (cb) => {
        if (sessionUser && sessionUser.role !== 'admin') {
            return UserCartModel.getCartForUser(sessionUser.id, (cartErr, persistedCart = []) => {
                if (!cartErr) req.session.cart = persistedCart;
                return cb();
            });
        }
        return cb();
    };

    ensureSessionCart(() => {
        const wasEmpty = !req.session.cart || req.session.cart.length === 0;

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

            let nextQuantity = desiredQty;
            let capped = false;
            if (desiredQty > available) {
                nextQuantity = available;
                capped = true;
            }

            if (existing) {
                existing.quantity = nextQuantity;
            } else {
                req.session.cart.push({
                    productId: product.id,
                    productName: product.productName,
                    price: product.price,
                    quantity: nextQuantity,
                    image: product.image
                });
            }

            const destination = '/cart';
            if (!sessionUser || sessionUser.role === 'admin') {
                if (capped) {
                    req.flash('error', `${product.productName} only has ${available} in stock. Cart quantity set to the maximum.`);
                } else {
                    req.flash('success', `${product.productName} added to your cart.`);
                }
                return res.redirect(destination);
            }

            return UserCartModel.setItemQuantity(sessionUser.id, product.id, nextQuantity, (persistErr) => {
                if (persistErr) {
                    console.error('Failed to persist cart item:', persistErr);
                    req.flash('error', 'Unable to update your cart right now.');
                    return res.redirect('/shopping');
                }
                if (capped) {
                    req.flash('error', `${product.productName} only has ${available} in stock. Cart quantity set to the maximum.`);
                } else {
                    req.flash('success', `${product.productName} added to your cart.`);
                }
                return res.redirect(destination);
            });
        });
    });
});

// Cart page
app.get('/cart', (req, res) => {
    res.render('cart', {
        cart: req.session.cart || [],
        user: req.session.user,
        errors: req.flash('error'),
        success: req.flash('success')
    });
});

// Remove from cart
app.get('/remove-from-cart/:id', (req, res) => {
    const productId = parseInt(req.params.id, 10);

    if (!req.session.cart) req.session.cart = [];

    req.session.cart = req.session.cart.filter(item => item.productId !== productId);
    const user = req.session.user;
    if (user && user.role !== 'admin') {
        UserCartModel.removeItem(user.id, productId, (err) => {
            if (err) {
                console.error('Failed to remove cart item:', err);
                req.flash('error', 'Unable to remove item right now.');
                return res.redirect('/cart');
            }
            req.flash('success', 'Item removed.');
            return res.redirect('/cart');
        });
    } else {
        req.flash('success', 'Item removed.');
        return res.redirect('/cart');
    }
});

// Clear entire cart
app.post('/cart/clear', (req, res) => {
    if (!req.session.cart) req.session.cart = [];
    req.session.cart = [];
    const user = req.session.user;
    if (user && user.role !== 'admin') {
        UserCartModel.clearCart(user.id, (err) => {
            if (err) {
                console.error('Failed to clear cart:', err);
                req.flash('error', 'Unable to clear cart right now.');
                return res.redirect('/cart');
            }
            req.flash('success', 'Cart cleared.');
            return res.redirect('/cart');
        });
    } else {
        req.flash('success', 'Cart cleared.');
        return res.redirect('/cart');
    }
});

// Update quantity in cart
app.post('/cart/update/:id', (req, res) => {
    const productId = parseInt(req.params.id, 10);
    const quantity = parseInt(req.body.quantity, 10);
    const delta = parseInt(req.body.delta, 10);

    if (Number.isNaN(productId)) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/cart');
    }

    if (!req.session.cart) req.session.cart = [];

    ProductModel.getProductById(productId, (err, product) => {
        if (err || !product) {
            req.flash('error', 'Unable to update this item right now.');
            return res.redirect('/cart');
        }

        const existing = req.session.cart.find(i => i.productId === productId);
        if (!existing) {
            req.flash('error', 'Item not found in cart.');
            return res.redirect('/cart');
        }

        const available = Number(product.quantity) || 0;
        const currentQty = existing.quantity || 0;
        let desiredQty;
        if (!Number.isNaN(delta)) {
            desiredQty = currentQty + delta;
        } else {
            desiredQty = Number.isNaN(quantity) ? currentQty : quantity;
        }

        const sanitizedQty = Math.max(0, desiredQty);
        const nextQuantity = Math.min(sanitizedQty, available);

        const applyUpdate = (cb) => {
            if (nextQuantity === 0) {
                req.session.cart = req.session.cart.filter(i => i.productId !== productId);
                if (req.session.user && req.session.user.role !== 'admin') {
                    return UserCartModel.removeItem(req.session.user.id, productId, cb);
                }
                return cb();
            }
            existing.quantity = nextQuantity;
            if (req.session.user && req.session.user.role !== 'admin') {
                return UserCartModel.setItemQuantity(req.session.user.id, productId, nextQuantity, cb);
            }
            return cb();
        };

        applyUpdate((persistErr) => {
            if (persistErr) {
                console.error('Failed to update cart quantity:', persistErr);
                req.flash('error', 'Unable to update cart right now.');
                return res.redirect('/cart');
            }
            if (nextQuantity === 0) {
                req.flash('success', 'Item removed.');
            } else if (sanitizedQty > available) {
                req.flash('error', `${product.productName} only has ${available} in stock. Quantity adjusted.`);
            } else {
                req.flash('success', 'Quantity updated.');
            }
            return res.redirect('/cart');
        });
    });
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
