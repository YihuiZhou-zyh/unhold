// Deterministic cross-checks. The LLM never decides pass/fail — code does.
// The LLM only extracts fields from unstructured (Chinese) documents and explains results.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DOCS_DIR = new URL('../data/docs/', import.meta.url);

// Carriers/services that can produce a "delivered" scan PayPal can verify.
// Untracked economy parcels lose tracking after export -> no proof of delivery.
const TRACKED_TO_DOOR = {
  YUNEXPRESS: true, FOUR_PX_EXPRESS: true, CN_SF_EXPRESS: true, CN_CHINA_POST_EMS: true,
  USPS: true, UPS: true, FEDEX: true, DHL: true, CHINA_POST: false, YANWEN: null, CAINIAO: null,
};

export function loadDoc(name) {
  const raw = readFileSync(new URL(name, DOCS_DIR), 'utf8');
  return { id: name, raw, sha256: createHash('sha256').update(raw).digest('hex') };
}

const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

export function runChecks({ order, paypalOrder, purchase, waybill, tracking }) {
  const checks = [];
  const add = (id, title, status, detail, sources) => checks.push({ id, title, status, detail, sources });

  const pu = paypalOrder?.purchase_units?.[0] || {};
  const ppAmount = pu.payments?.captures?.[0]?.amount?.value || pu.amount?.value;
  const ppAddr = pu.shipping?.address || {};

  // 1. Amount: shop order vs PayPal vs declared value
  add('amount', 'Amount matches across shop order, PayPal and waybill',
    near(order.amount, ppAmount ?? order.amount, 0.01) && near(order.amount, waybill.declared_value_usd, 0.01) ? 'pass' : 'fail',
    `shop ${order.amount} USD / PayPal ${ppAmount ?? 'n/a'} USD / declared ${waybill.declared_value_usd} USD`,
    ['order.json', 'paypal:order', 'forwarder_waybill.json']);

  // 2. Quantity: shop order vs supplier purchase vs waybill pieces
  const qtyOk = order.quantity === purchase.quantity && order.quantity === waybill.pieces;
  add('quantity', 'Quantity matches supplier purchase and shipped pieces', qtyOk ? 'pass' : 'fail',
    `shop ${order.quantity} / purchased ${purchase.quantity} / shipped ${waybill.pieces}`,
    ['order.json', 'purchase_order_1688.txt', 'forwarder_waybill.json']);

  // 3. SKU / item identity
  const skuOk = purchase.sku === order.sku;
  add('sku', 'Supplier purchase is for the same SKU', skuOk ? 'pass' : 'fail',
    `shop SKU ${order.sku} / purchase SKU ${purchase.sku}`, ['order.json', 'purchase_order_1688.txt']);

  // 4. Weight: listing weight vs waybill gross weight (supplier gross weight as tie-breaker)
  const listed = order.weight_kg_per_unit * order.quantity;
  const supplierGross = purchase.gross_weight_kg_per_unit ? purchase.gross_weight_kg_per_unit * purchase.quantity : null;
  let wStatus = near(listed, waybill.gross_weight_kg, 0.1) ? 'pass' : 'warn';
  if (wStatus === 'warn' && supplierGross && near(supplierGross, waybill.gross_weight_kg, 0.1)) wStatus = 'explained';
  add('weight', 'Shipped weight is consistent with the goods', wStatus,
    `listing ${listed.toFixed(2)} kg / supplier gross ${supplierGross?.toFixed(2) ?? 'n/a'} kg / waybill ${waybill.gross_weight_kg} kg`,
    ['order.json', 'purchase_order_1688.txt', 'forwarder_waybill.json']);

  // 5. Timeline: purchase <= handover, order <= handover
  const tOk = purchase.date <= waybill.handover_date && order.created_at.slice(0, 10) <= waybill.handover_date;
  add('timeline', 'Purchase and order happen before handover to carrier', tOk ? 'pass' : 'fail',
    `purchase ${purchase.date} / order ${order.created_at.slice(0, 10)} / handover ${waybill.handover_date}`,
    ['purchase_order_1688.txt', 'order.json', 'forwarder_waybill.json']);

  // 6. Route: PayPal ship-to vs waybill consignee vs final scan location
  const shipZip = ppAddr.postal_code || order.ship_to.address.postal_code;
  const delivered = tracking.events.find((e) => e.status === 'DELIVERED');
  const routeOk = shipZip === waybill.consignee_postal_code && (!delivered || delivered.location.includes(shipZip));
  add('route', 'Destination matches PayPal shipping address', routeOk ? 'pass' : 'fail',
    `PayPal ZIP ${shipZip} / waybill ZIP ${waybill.consignee_postal_code} / final scan ${delivered?.location ?? 'not yet delivered'}`,
    ['paypal:order', 'forwarder_waybill.json', 'tracking_events.json']);

  // 7. Tracking strength: can this service ever show "delivered"?
  const strength = TRACKED_TO_DOOR[waybill.carrier_code_paypal];
  add('tracking_strength', 'Tracking can prove delivery (required for hold release & Seller Protection)',
    strength === true ? 'pass' : strength === false ? 'fail' : 'warn',
    `${waybill.forwarder} · ${waybill.service} · PayPal carrier code ${waybill.carrier_code_paypal}`,
    ['forwarder_waybill.json']);

  // 8. Seller Protection eligibility by payment method (CN/HK/SG sellers: guest/card not covered)
  const ps = paypalOrder?.payment_source || {};
  const viaWallet = Boolean(ps.paypal);
  add('seller_protection', 'Payment method is eligible for PayPal Seller Protection',
    paypalOrder ? (viaWallet ? 'pass' : 'fail') : 'warn',
    paypalOrder ? `payment_source: ${Object.keys(ps).join(', ') || 'unknown'}` : 'PayPal order not captured yet',
    ['paypal:order']);

  return checks;
}
