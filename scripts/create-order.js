// Creates a sandbox checkout order (a real "goods" purchase, so the buyer can open an
// Item-Not-Received dispute later) and prints the buyer approval link.
import { createOrder } from '../src/paypal.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 3000);

const order = JSON.parse(readFileSync(new URL('../data/order.json', import.meta.url)));
const res = await createOrder({
  amount: order.amount,
  sku: order.sku,
  name: order.item_name,
  quantity: order.quantity,
  shipping: order.ship_to,
  returnUrl: `http://localhost:${PORT}/return`,
  cancelUrl: `http://localhost:${PORT}/`,
});
const approve = res.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
mkdirSync(new URL('../out/', import.meta.url), { recursive: true }); // out/ is gitignored
const statePath = new URL('../out/state.json', import.meta.url);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {};
state.orderId = res.id;
writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log('ORDER', res.id, res.status);
console.log('APPROVE_URL', approve?.href);
