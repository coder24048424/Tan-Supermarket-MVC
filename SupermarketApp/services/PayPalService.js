const fetch = require('node-fetch');
require('dotenv').config();

const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = process.env.PAYPAL_API;

async function getAccessToken() {
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    const detail = data && data.error_description ? data.error_description : 'Unable to fetch PayPal token.';
    throw new Error(detail);
  }
  return data.access_token;
}

async function createOrder(amount, currency = 'SGD', options = {}) {
  const accessToken = await getAccessToken();
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: amount,
        },
      },
    ],
  };
  if (options.returnUrl && options.cancelUrl) {
    payload.application_context = {
      return_url: options.returnUrl,
      cancel_url: options.cancelUrl,
    };
  }
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.id) {
    const detail = data && data.message ? data.message : 'Unable to create PayPal order.';
    throw new Error(detail);
  }
  return data;
}

async function captureOrder(orderId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const detail = data && data.message ? data.message : 'Unable to capture PayPal order.';
    throw new Error(detail);
  }
  return data;
}

async function refundCapture(captureId, amount, currency = 'SGD') {
  if (!captureId) throw new Error('Missing capture ID for refund.');
  const accessToken = await getAccessToken();
  const payload = {
    amount: {
      currency_code: currency,
      value: Number(amount || 0).toFixed(2)
    }
  };
  const response = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = data && data.details && data.details[0] && data.details[0].issue ? data.details[0].issue : (data && data.message ? data.message : 'Unable to refund PayPal capture.');
    throw new Error(detail);
  }
  return data;
}

module.exports = { createOrder, captureOrder, refundCapture };
