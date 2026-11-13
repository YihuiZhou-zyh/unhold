import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import * as pp from './paypal.js';
import { runChecks, loadDoc } from './verify.js';
import { extractPurchase, explain, groundingGuard } from './ai.js';
import { buildPdf } from './pdf.js';
import { answer as askAnswer } from './ask.js';

const PORT = Number(process.env.PORT || 3000);
// Hosted demo mode: set PUBLIC_URL (e.g. https://unhold.onrender.com; Render provides RENDER_EXTERNAL_URL)
// and DEMO_ACCESS_CODE. Every visitor then gets an isolated workspace behind the access code, with rate limits.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const HOSTED = Boolean(PUBLIC_URL);
const ACCESS_CODE = process.env.DEMO_ACCESS_CODE || '';
if (HOSTED && ACCESS_CODE.length < 6) { console.error('Hosted mode requires DEMO_ACCESS_CODE (at least 6 characters).'); process.exit(1); }
const BASE_URL = PUBLIC_URL || `http://localhost:${PORT}`;
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...(HOSTED ? [new URL(PUBLIC_URL).host] : [])];
const ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...(HOSTED ? [new URL(PUBLIC_URL).origin] : [])];
const MAX_SESSIONS = 500;
const root = (p) => new URL(`../${p}`, import.meta.url);
mkdirSync(root('out/sessions'), { recursive: true }); // out/ is gitignored; create it on a fresh clone

// A workspace holds one case: state, audit log and evidence PDF. Locally there is a single one (files in out/).
function workspace(sid) {
  const dir = sid === 'local' ? 'out' : `out/sessions/${sid}`;
  return { sid, state: root(`${dir}/state.json`), audit: root(`${dir}/audit.log.jsonl`), pdf: root(`${dir}/evidence.pdf`) };
}
const state = (w) => (existsSync(w.state) ? JSON.parse(readFileSync(w.state)) : {});
const save = (w, s) => writeFileSync(w.state, JSON.stringify(s, null, 2));
const audit = (w, action, detail) => appendFileSync(w.audit, JSON.stringify({ at: new Date().toISOString(), approved_by: 'seller (UI click)', action, detail }) + '\n');

const SID_RE = /^[a-f0-9]{32}$/;
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v));
function sessionOf(req) {
  if (!HOSTED) return workspace('local');
  const sid = cookies(req).uh_sid;
  return sid && SID_RE.test(sid) && existsSync(root(`out/sessions/${sid}`)) ? workspace(sid) : null;
}
function newSession() {
  if (readdirSync(root('out/sessions')).length >= MAX_SESSIONS) throw new Error('The demo is at capacity, please try again later');
  const sid = randomBytes(16).toString('hex');
  mkdirSync(root(`out/sessions/${sid}`));
  return sid;
}
const digest = (s) => createHash('sha256').update(String(s)).digest();
const codeMatches = (code) => timingSafeEqual(digest(code), digest(ACCESS_CODE));

// In-memory sliding-window rate limits (hosted mode only) to protect the shared API keys.
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { const e = new Error('Demo rate limit reached, please wait a few minutes and try again'); e.status = 429; throw e; }
  recent.push(now); hits.set(key, recent);
}
const HOUR = 3600e3, DAY = 24 * HOUR;
function quota(w, name, perHour, perDay) {
  if (!HOSTED) return;
  limit(`${name}:${w.sid}`, perHour, HOUR);
  limit(`${name}:all`, perDay, DAY);
}

// In hosted mode a visitor may only act on disputes raised against the order created in their own workspace.
async function captureIdOf(w) {
  const s = state(w);
  if (!s.orderId) return null;
  const o = await pp.getOrder(s.orderId);
  return o.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
}
async function ownDispute(w, id) {
  const d = await pp.getDispute(id);
  if (HOSTED) {
    const cap = await captureIdOf(w);
    if (!cap || !(d.disputed_transactions || []).some((t) => t.seller_transaction_id === cap)) throw new Error('This dispute is not on the order created in your session');
  }
  return d;
}

const order = JSON.parse(readFileSync(root('data/order.json')));

// Remove buyer PII before anything is sent to the LLM.
function redactedOrder() {
  const { ship_to, ...rest } = order;
  return { ...rest, ship_to: { city: ship_to.address.admin_area_2, state: ship_to.address.admin_area_1, postal_code: ship_to.address.postal_code, country: ship_to.address.country_code } };
}

async function analyze(w, waybillFile = 'forwarder_waybill.json') {
  const s = state(w);
  const paypalOrder = s.orderId ? await pp.getOrder(s.orderId) : null;
  const capture = paypalOrder?.purchase_units?.[0]?.payments?.captures?.[0];
  const docs = {
    purchase: loadDoc('purchase_order_1688.txt'),
    waybill: loadDoc(waybillFile),
    tracking: loadDoc('tracking_events.json'),
  };
  const purchase = await extractPurchase(docs.purchase.raw);
  purchase.gross_weight_kg_per_unit ??= null;
  const waybill = JSON.parse(docs.waybill.raw);
  const tracking = JSON.parse(docs.tracking.raw);
  const checks = runChecks({ order, paypalOrder, purchase, waybill, tracking });

  const holdStatus = capture
    ? { capture_id: capture.id, status: capture.status, status_details: capture.status_details || null, seller_receivable: capture.seller_receivable_breakdown?.net_amount }
    : { status: paypalOrder?.status || 'NO_ORDER' };
  let balance = null;
  try { balance = await pp.balances(); } catch (e) { balance = { unavailable: e.status || String(e.message).slice(0, 80) }; }

  const ppOrderLite = paypalOrder ? {
    id: paypalOrder.id, status: paypalOrder.status, payment_source: Object.keys(paypalOrder.payment_source || {}),
    amount: paypalOrder.purchase_units?.[0]?.amount, ship_to: { postal_code: paypalOrder.purchase_units?.[0]?.shipping?.address?.postal_code },
  } : null;
  const sources = {
    'order.json': JSON.stringify(redactedOrder()),
    'paypal:order': JSON.stringify(ppOrderLite),
    'purchase_order_1688.txt': docs.purchase.raw,
    [waybillFile]: docs.waybill.raw,
    'tracking_events.json': docs.tracking.raw,
  };
  const ai = await explain({ checks, sources, holdStatus });
  const statements = groundingGuard(ai.evidence_statements, sources);
  const result = {
    at: new Date().toISOString(), waybillFile, paypalOrder: ppOrderLite, holdStatus, balance, purchase, waybill, checks, ai: { ...ai, evidence_statements: statements },
    hashes: Object.fromEntries(Object.values(docs).map((d) => [d.id, d.sha256])),
  };
  save(w, { ...state(w), lastAnalysis: result });
  return result;
}

function evidencePdf(a, disputeId) {
  const ok = a.ai.evidence_statements.filter((s) => s.grounded);
  return buildPdf([
    { text: 'Fulfillment Evidence Pack', size: 18, bold: true },
    { text: `Dispute: ${disputeId || '-'}   PayPal order: ${a.paypalOrder?.id || '-'}   Shop order: ${order.shop_order_id}`, size: 9 },
    { text: `Generated ${a.at} by Unhold. Every statement cites its source documents; originals are hashed (SHA-256) below.`, size: 9 },
    { text: ' ' },
    { text: 'Statements', size: 13, bold: true },
    ...ok.map((s, i) => ({ text: `${i + 1}. ${s.text_en}  [sources: ${s.sources.join(', ')}]` })),
    { text: ' ' },
    { text: 'Cross-checks (deterministic)', size: 13, bold: true },
    ...a.checks.map((c) => ({ text: `- [${c.status.toUpperCase()}] ${c.title}: ${c.detail}` })),
    { text: ' ' },
    { text: 'Shipment', size: 13, bold: true },
    { text: `Carrier ${a.waybill.carrier_code_paypal}, tracking ${a.waybill.tracking_number}, service: tracked to door. Handover ${a.waybill.handover_date}.` },
    { text: ' ' },
    { text: 'Source documents (SHA-256)', size: 13, bold: true },
    ...Object.entries(a.hashes).map(([k, v]) => ({ text: `${k}: ${v}`, size: 8 })),
  ]);
}

// Redacted, live case context for "Ask about this case" (no buyer name/street; read-only PayPal calls).
async function caseContext(w) {
  const s = state(w);
  const a = s.lastAnalysis;
  const ppOrder = s.orderId ? await pp.getOrder(s.orderId).catch(() => null) : null;
  const pu = ppOrder?.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  const dispute = s.disputeId ? await pp.getDispute(s.disputeId).catch(() => null) : null;
  const trackers = (pu?.shipping?.trackers || []).map((t) => ({ status: t.status, carrier: a?.waybill?.carrier_code_paypal }));
  return {
    shop_order: { id: order.shop_order_id, item: order.item_name, quantity: order.quantity, amount: `${order.amount} ${order.currency}`, ship_to: redactedOrder().ship_to },
    seller: { ships_from: 'China (via forwarder)', paypal_account_region: 'not confirmed via API' },
    paypal_order: ppOrder ? { status: ppOrder.status, payment_source: Object.keys(ppOrder.payment_source || {}), amount: pu?.amount && `${pu.amount.value} ${pu.amount.currency_code}` } : (a?.paypalOrder || null),
    capture: cap ? { status: cap.status, status_details_reason: cap.status_details?.reason || null, amount: cap.amount && `${cap.amount.value} ${cap.amount.currency_code}`, captured_at: cap.create_time }
      : (a?.holdStatus ? { status: a.holdStatus.status, status_details_reason: a.holdStatus.status_details?.reason || null } : null),
    tracking: {
      pushed_to_paypal: Boolean(s.tracked) || trackers.length > 0, pushed_at: s.tracked?.at || null,
      carrier: a?.waybill?.carrier_code_paypal || null, service: a?.waybill?.service || null, handover_date: a?.waybill?.handover_date || null, paypal_trackers: trackers,
    },
    dispute: dispute ? {
      reason: dispute.reason, status: dispute.status, stage: dispute.dispute_life_cycle_stage, created: dispute.create_time,
      seller_response_due_date: dispute.seller_response_due_date || null, amount: dispute.dispute_amount && `${dispute.dispute_amount.value} ${dispute.dispute_amount.currency_code}`,
    } : (s.disputeId ? { id_known: true, details: 'unavailable' } : null),
    latest_checks: a ? { at: a.at, results: a.checks.map((c) => `${c.id}: ${c.status}`) } : null,
  };
}

const routes = {
  'GET /api/state': async (_, w) => {
    const s = state(w);
    let paypalOrder = null, disputes = [];
    if (s.orderId) paypalOrder = await pp.getOrder(s.orderId).catch((e) => ({ error: e.message }));
    if (HOSTED) {
      // Only disputes raised against this workspace's own payment.
      const cap = paypalOrder?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      if (cap) {
        try { disputes = (await pp.listDisputes(cap)).items || []; } catch (e) { disputes = e.status === 400 ? [] : [{ error: e.message }]; }
      }
    } else {
      try { disputes = (await pp.listDisputes()).items || []; } catch (e) { disputes = [{ error: e.message }]; }
      if (s.disputeId && !disputes.some((d) => d.dispute_id === s.disputeId)) {
        try { disputes.unshift(await pp.getDispute(s.disputeId)); } catch {}
      }
    }
    const demo = {
      hosted: HOSTED,
      buyer: HOSTED && process.env.SANDBOX_BUYER_EMAIL ? { email: process.env.SANDBOX_BUYER_EMAIL, password: process.env.SANDBOX_BUYER_PASSWORD || null } : null,
    };
    return { orderId: s.orderId, approveUrl: s.approveUrl, paypalOrder, disputes, lastAnalysis: s.lastAnalysis, tracked: s.tracked, order, demo };
  },
  'POST /api/order/create': async (_, w) => {
    quota(w, 'order', 10, 300);
    const r = await pp.createOrder({
      amount: order.amount, sku: order.sku, name: order.item_name, quantity: order.quantity, shipping: order.ship_to,
      returnUrl: `${BASE_URL}/return`, cancelUrl: `${BASE_URL}/`,
    });
    const approveUrl = r.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    save(w, { orderId: r.id, approveUrl }); // a new order starts a fresh case
    audit(w, 'create_order', { orderId: r.id });
    return { orderId: r.id, approveUrl };
  },
  'POST /api/analyze': async (body, w) => {
    quota(w, 'ai', 20, 400);
    return analyze(w, body.waybill === 'weak' ? 'weak_waybill_example.json' : 'forwarder_waybill.json');
  },
  'POST /api/capture': async (_, w) => {
    const s = state(w);
    const r = await pp.captureOrder(s.orderId);
    audit(w, 'capture', { orderId: s.orderId, status: r.status });
    return r;
  },
  'POST /api/track': async (_, w) => {
    const s = state(w);
    const a = s.lastAnalysis;
    if (!a) throw new Error('Run verification first');
    const failed = a.checks.filter((c) => c.status === 'fail');
    if (failed.length) throw new Error(`Blocked: ${failed.map((c) => c.id).join(', ')} failed — fix before pushing tracking`);
    const captureId = a.holdStatus.capture_id;
    if (!captureId) throw new Error('The payment has not been captured yet — pay as the sandbox buyer first, then run verification again');
    const r = await pp.addTracking(s.orderId, { captureId, trackingNumber: a.waybill.tracking_number, carrier: a.waybill.carrier_code_paypal });
    audit(w, 'add_tracking', { orderId: s.orderId, captureId, tracking: a.waybill.tracking_number, carrier: a.waybill.carrier_code_paypal });
    save(w, { ...state(w), tracked: { at: new Date().toISOString(), tracking: a.waybill.tracking_number } });
    return r;
  },
  'POST /api/dispute': async (body, w) => {
    const d = await ownDispute(w, body.id);
    save(w, { ...state(w), disputeId: body.id });
    return { dispute: d, actions: pp.linkRels(d) };
  },
  'POST /api/dispute/escalate': async (body, w) => {
    await ownDispute(w, body.id);
    return pp.escalate(body.id, 'Seller requests PayPal review: tracked shipment with verified fulfillment evidence is available.');
  },
  'POST /api/dispute/require-evidence': async (body, w) => { await ownDispute(w, body.id); return pp.sandboxRequireEvidence(body.id); },
  'POST /api/dispute/evidence': async (body, w) => {
    const s = state(w);
    const a = s.lastAnalysis;
    if (!a) throw new Error('Run verification first');
    const d = await ownDispute(w, body.id);
    const pdf = evidencePdf(a, body.id);
    writeFileSync(w.pdf, pdf);
    const evidences = [
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        evidence_info: { tracking_info: [{ carrier_name: a.waybill.carrier_code_paypal, tracking_number: a.waybill.tracking_number }] },
        documents: [{ name: 'evidence.pdf' }],
        notes: a.ai.evidence_statements.filter((x) => x.grounded).map((x) => x.text_en).join(' ').slice(0, 1900),
      },
    ];
    const rels = pp.linkRels(d);
    const file = [{ name: 'evidence.pdf', type: 'application/pdf', buffer: pdf }];
    // Use whichever response PayPal currently allows (HATEOAS links): evidence, or supporting info during review.
    const r = rels.includes('provide_evidence')
      ? await pp.provideEvidence(body.id, { evidences, files: file })
      : await pp.provideSupportingInfo(body.id, { notes: evidences[0].notes, files: file });
    audit(w, 'provide_evidence', { disputeId: body.id, statements: evidences[0].notes.length, pdf_bytes: pdf.length });
    return r;
  },
  'POST /api/ask': async (body, w) => {
    const q = body.question;
    if (typeof q !== 'string' || !q.trim() || q.length > 500) throw new Error('question must be a non-empty string of at most 500 characters');
    quota(w, 'ask', 40, 800);
    return askAnswer(q.trim(), await caseContext(w));
  },
  'POST /api/dispute/adjudicate': async (body, w) => { await ownDispute(w, body.id); return pp.sandboxAdjudicate(body.id, body.outcome || 'SELLER_FAVOR'); },
};

const send = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body); };
const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, ...headers }); res.end(); };
async function readBody(req, max = 20_000) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > max) throw new Error('request body too large'); }
  return body;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unhold demo</title><style>
:root{--navy:#0a2a5e;--navy2:#061a3d;--mint:#3ee0a8;--ink:#0f1d35;--mute:#5d6982}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;font:16px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:linear-gradient(160deg,var(--navy),var(--navy2))}
.card{width:100%;max-width:420px;background:#fff;color:var(--ink);border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{margin:0 0 4px;font-size:24px}p{margin:0 0 18px;color:var(--mute);font-size:14px}
label{font-weight:600;font-size:14px}input{width:100%;margin:6px 0 14px;padding:11px 12px;font-size:16px;border:1px solid #dfe5ee;border-radius:10px}
button{width:100%;padding:12px;font-size:15px;font-weight:700;border:0;border-radius:10px;background:var(--navy);color:#fff;cursor:pointer}
.err{color:#d33b3b;font-size:14px;margin:-6px 0 12px}.foot{margin-top:16px;font-size:13px;color:var(--mute)}a{color:#0b5bd3}
</style></head><body><form class="card" method="post" action="/login">
<h1>Unhold</h1><p>Get paid for what you actually shipped — live demo on the PayPal sandbox. Each visitor gets a private workspace.</p>
<label for="code">Demo access code</label><input id="code" name="code" type="password" autocomplete="off" required autofocus>
${error ? `<div class="err">${error}</div>` : ''}<button type="submit">Enter demo</button>
<div class="foot">Judges: the access code is in the Devpost testing instructions. Code and setup: <a href="https://github.com/YihuiZhou-zyh/unhold">GitHub</a>.</div>
</form></body></html>`;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok');
  if (!HOSTS.includes(req.headers.host)) return send(res, 421, 'text/plain', 'bad host');
  try {
    if (url.pathname === '/login') {
      if (!HOSTED) return redirect(res, '/');
      if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', loginPage(url.searchParams.has('e') ? 'Wrong access code.' : ''));
      if (req.method !== 'POST' || (req.headers.origin && !ORIGINS.includes(req.headers.origin))) return send(res, 403, 'text/plain', 'forbidden');
      limit(`login:${clientIp(req)}`, 10, 15 * 60e3);
      const code = new URLSearchParams(await readBody(req, 2000)).get('code') || '';
      if (!codeMatches(code)) return redirect(res, '/login?e=1');
      const sid = sessionOf(req)?.sid || newSession();
      const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
      return redirect(res, '/', { 'Set-Cookie': `uh_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}` });
    }
    const w = sessionOf(req);
    if (!w) return url.pathname.startsWith('/api/') ? send(res, 401, 'application/json', JSON.stringify({ error: 'Enter the demo access code first (reload the page)' })) : redirect(res, '/login');

    if (url.pathname === '/return') {
      const s = state(w);
      if (!s.orderId || url.searchParams.get('token') !== s.orderId) return redirect(res, '/');
      try { await pp.captureOrder(s.orderId); audit(w, 'capture', { orderId: s.orderId }); } catch {}
      return redirect(res, '/');
    }
    if (url.pathname === '/evidence.pdf' && existsSync(w.pdf)) return send(res, 200, 'application/pdf', readFileSync(w.pdf));
    if (req.method === 'GET' && (url.pathname === '/ask.js' || url.pathname === '/ask.css')) {
      return send(res, 200, url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', readFileSync(root(`public${url.pathname}`)));
    }
    const key = `${req.method} ${url.pathname}`;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if ((origin && !ORIGINS.includes(origin)) || !String(req.headers['content-type']).includes('application/json')) return send(res, 403, 'text/plain', 'forbidden');
    }
    if (routes[key]) {
      const body = await readBody(req);
      const out = await routes[key](body ? JSON.parse(body) : {}, w);
      return send(res, 200, 'application/json', JSON.stringify(out));
    }
    send(res, 200, 'text/html; charset=utf-8', readFileSync(root('public/index.html')));
  } catch (e) {
    send(res, e.status === 429 ? 429 : 400, 'application/json', JSON.stringify({ error: e.message, details: e.body }));
  }
}).listen(PORT, HOSTED ? '0.0.0.0' : '127.0.0.1', () => console.log(`Unhold running on ${BASE_URL}${HOSTED ? ' (hosted demo mode)' : ''}`));
