const TransactionsModel = require('../models/TransactionsModel');

function TransactionController() {
  return {
    listTransactions(req, res) {
      const sessionUser = req.session.user;
      if (!sessionUser || sessionUser.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/orders');
      }
      const success = req.flash('success');
      const errors = req.flash('error');

      const filters = {
        orderId: req.query.orderId || null,
        method: req.query.method || null,
        status: req.query.status || null,
        payer: req.query.payer || null,
        from: req.query.from || null,
        to: req.query.to || null
      };
      TransactionsModel.listTransactions(filters, (err, transactions = []) => {
        if (err) {
          console.error('Failed to load transactions:', err);
          return res.status(500).render('error', { message: 'Failed to load transactions' });
        }

        return res.render('adminTransactions', {
          transactions,
          user: sessionUser,
          success,
          errors
          , filters
        });
      });
    }
  };
}

module.exports = TransactionController();
