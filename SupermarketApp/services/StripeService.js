const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

async function createCheckoutSession(amount, currency = 'sgd', options = {}) {
  if (!stripe) throw new Error('Stripe is not configured.');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Invalid amount.');

  let successUrl = options.successUrl || (process.env.STRIPE_SUCCESS_URL || `${options.host || ''}/stripe/success`);
  const cancelUrl = options.cancelUrl || (process.env.STRIPE_CANCEL_URL || `${options.host || ''}/payment`);

  // Ensure successUrl contains the placeholder so Stripe redirects include session id
  if (successUrl && !successUrl.includes('{CHECKOUT_SESSION_ID}')) {
    // append the placeholder as a query param if not already present
    const sep = successUrl.includes('?') ? '&' : '?';
    successUrl = `${successUrl}${sep}session_id={CHECKOUT_SESSION_ID}`;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: options.payment_method_types || ['card'],
    line_items: [
      {
        price_data: {
          currency: String(currency || 'sgd').toLowerCase(),
          product_data: { name: options.productName || 'Supermarket order' },
          unit_amount: Math.round(Number(amount) * 100)
        },
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: options.metadata || {}
  });

  return session;
}

module.exports = { createCheckoutSession };
