const OrdersModel = require('../models/OrdersModel');

function FraudController() {
  return {
    analysis(req, res) {
      const success = req.flash('success');
      const errors = req.flash('error');
      OrdersModel.getAllOrders((err, orders = []) => {
        if (err) {
          console.error('Failed to load orders for fraud analysis:', err);
          return res.status(500).render('error', { message: 'Unable to load fraud analysis' });
        }

        const severityCounts = { high: 0, medium: 0, low: 0, unknown: 0 };
        const reasonCounts = {};
        const flaggedOrders = [];
        let totalScore = 0;

        orders.forEach((order) => {
          if (!order.payment_summary) return;
          let summary;
          try {
            summary = typeof order.payment_summary === 'string'
              ? JSON.parse(order.payment_summary)
              : order.payment_summary;
          } catch (parseErr) {
            console.error('Unable to parse payment summary for order', order.id, parseErr);
            return;
          }
          const fraud = summary && summary.fraud;
          if (!fraud || typeof fraud.score !== 'number') return;
          const severity = (fraud.severity || 'unknown').toLowerCase();
          severityCounts[severity] = (severityCounts[severity] || 0) + 1;
          totalScore += Number(fraud.score) || 0;
          (Array.isArray(fraud.reasons) ? fraud.reasons : []).forEach(reason => {
            const text = String(reason || '').trim();
            if (!text) return;
            reasonCounts[text] = (reasonCounts[text] || 0) + 1;
          });

          flaggedOrders.push({
            id: order.id,
            username: order.username || 'Unknown',
            email: order.email || '',
            total: Number(order.total) || 0,
            method: order.payment_method || 'unknown',
            created_at: order.created_at,
            severity,
            score: Number(fraud.score) || 0,
            reasons: Array.isArray(fraud.reasons) ? fraud.reasons : []
          });
        });

        const averageScore = flaggedOrders.length ? (totalScore / flaggedOrders.length) : 0;
        const reasonBreakdown = Object.entries(reasonCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => ({ reason, count }))
          .slice(0, 5);

        return res.render('adminFraud', {
          user: req.session.user,
          success,
          errors,
          stats: {
            total: flaggedOrders.length,
            averageScore: averageScore.toFixed(1),
            severityCounts,
            topReasons: reasonBreakdown
          },
          flaggedOrders
        });
      });
    }
  };
}

module.exports = FraudController();
