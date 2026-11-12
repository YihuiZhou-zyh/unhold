// Thin PayPal REST client (sandbox by default). Only official REST endpoints are used —
// no website automation (PayPal User Agreement forbids automated access to its sites).
const BASE =
  (process.env.PAYPAL_ENVIRONMENT || 'SANDBOX').toUpperCase() === 'LIVE'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cached = null;

export async function token() {
  if (cached && cached.exp > Date.now() + 60_000) return cached.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing (see .env.example)');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`OAuth failed: ${res.status} ${JSON.stringify(json)}`);
  cached = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return cached.value;
}

export async function api(method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${await token()}`, ...extraHeaders };
  let payload = body;
  if (body && !(body instanceof FormData) && !(body instanceof Uint8Array)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---------- Orders v2 ----------
export function createOrder({ amount, sku, name, quantity, shipping, returnUrl, cancelUrl }) {
  return api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: sku,
      description: name,
      amount: {
        currency_code: 'USD',
        value: amount,
        breakdown: { item_total: { currency_code: 'USD', value: amount } },
      },
      items: [{
        name, sku, quantity: String(quantity), category: 'PHYSICAL_GOODS',
        unit_amount: { currency_code: 'USD', value: (Number(amount) / quantity).toFixed(2) },
      }],
      shipping: {
        name: { full_name: shipping.full_name },
        address: shipping.address,
      },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          shipping_preference: 'SET_PROVIDED_ADDRESS',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  }, { Prefer: 'return=representation' });
}

const oid = (id) => { if (!/^[A-Z0-9]{8,32}$/.test(String(id))) throw new Error('invalid order id'); return id; };
export const getOrder = (id) => api('GET', `/v2/checkout/orders/${oid(id)}`);
export const captureOrder = (id) =>
  api('POST', `/v2/checkout/orders/${oid(id)}/capture`, {}, { Prefer: 'return=representation' });

// Add tracking to an order (Orders v2 — the recommended tracking path).
export function addTracking(orderId, { captureId, trackingNumber, carrier, carrierNameOther }) {
  const body = {
    capture_id: captureId,
    tracking_number: trackingNumber,
    carrier,
    notify_payer: false,
    ...(carrier === 'OTHER' ? { carrier_name_other: carrierNameOther } : {}),
  };
  return api('POST', `/v2/checkout/orders/${oid(orderId)}/track`, body, { Prefer: 'return=representation' });
}

// ---------- Payments / balances / transactions (read-only diagnosis) ----------
export const getCapture = (id) => api('GET', `/v2/payments/captures/${id}`);
export const balances = () => api('GET', '/v1/reporting/balances?currency_code=USD');
export function searchTransactions(days = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const q = new URLSearchParams({
    start_date: start.toISOString().replace(/\.\d+Z$/, 'Z'),
    end_date: end.toISOString().replace(/\.\d+Z$/, 'Z'),
    fields: 'transaction_info,shipping_info,cart_info',
    page_size: '50',
  });
  return api('GET', `/v1/reporting/transactions?${q}`);
}

// ---------- Disputes v1 ----------
const did = (id) => { if (!/^PP-[A-Z0-9-]{3,64}$/.test(String(id))) throw new Error('invalid dispute id'); return encodeURIComponent(id); };
export const listDisputes = () => api('GET', '/v1/customer/disputes?page_size=20');
export const getDispute = (id) => api('GET', `/v1/customer/disputes/${did(id)}`);

export function provideEvidence(disputeId, { evidences, files }) {
  // Hand-built multipart so the JSON part matches PayPal's curl sample
  // (-F 'input={...};type=application/json'): no filename on `input`. Node's FormData would add filename="blob".
  const boundary = `----unhold${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ evidences })}\r\n`),
  ];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence-file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(Buffer.from(f.buffer), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return api('POST', `/v1/customer/disputes/${did(disputeId)}/provide-evidence`, Buffer.concat(parts), {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });
}

export const sendMessage = (disputeId, message) =>
  api('POST', `/v1/customer/disputes/${did(disputeId)}/send-message`, { message });

// Sandbox-only helpers to move a dispute through its lifecycle for testing.
export const sandboxRequireEvidence = (disputeId, action = 'SELLER_EVIDENCE') =>
  api('POST', `/v1/customer/disputes/${did(disputeId)}/require-evidence`, { action });
export const sandboxAdjudicate = (disputeId, outcome = 'SELLER_FAVOR') =>
  !['SELLER_FAVOR', 'BUYER_FAVOR'].includes(outcome) ? Promise.reject(new Error('invalid outcome')) : api('POST', `/v1/customer/disputes/${did(disputeId)}/adjudicate`, { adjudication_outcome: outcome });

export const linkRels = (obj) => (obj?.links || []).map((l) => l.rel);
