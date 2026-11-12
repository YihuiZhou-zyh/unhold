import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import * as pp from './paypal.js';
import { runChecks, loadDoc } from './verify.js';
import { extractPurchase, explain, groundingGuard } from './ai.js';
import { buildPdf } from './pdf.js';

const PORT = Number(process.env.PORT || 3000);
const root = (p) => new URL(`../${p}`, import.meta.url);
const STATE = root('out/state.json');
const AUDIT = root('out/audit.log.jsonl');
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE)) : {});
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const audit = (action, detail) => appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), approved_by: 'seller (UI click)', action, detail }) + '\n');

const order = JSON.parse(readFileSync(root('data/order.json')));

// Remove buyer PII before anything is sent to the LLM.
function redactedOrder() {
  const { ship_to, ...rest } = order;
  return { ...rest, ship_to: { city: ship_to.address.admin_area_2, state: ship_to.address.admin_area_1, postal_code: ship_to.address.postal_code, country: ship_to.address.country_code } };
}

async function analyze(waybillFile = 'forwarder_waybill.json') {
  const s = state();
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
  save({ ...s, lastAnalysis: result });
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

const routes = {
  'GET /api/state': async () => {
    const s = state();
    let paypalOrder = null, disputes = [];
    if (s.orderId) paypalOrder = await pp.getOrder(s.orderId).catch((e) => ({ error: e.message }));
    try { disputes = (await pp.listDisputes()).items || []; } catch (e) { disputes = [{ error: e.message }]; }
    return { orderId: s.orderId, paypalOrder, disputes, lastAnalysis: s.lastAnalysis, tracked: s.tracked, order };
  },
  'POST /api/analyze': async (body) => analyze(body.waybill === 'weak' ? 'weak_waybill_example.json' : 'forwarder_waybill.json'),
  'POST /api/capture': async () => {
    const s = state();
    const r = await pp.captureOrder(s.orderId);
    audit('capture', { orderId: s.orderId, status: r.status });
    return r;
  },
  'POST /api/track': async () => {
    const s = state();
    const a = s.lastAnalysis;
    if (!a) throw new Error('Run verification first');
    const failed = a.checks.filter((c) => c.status === 'fail');
    if (failed.length) throw new Error(`Blocked: ${failed.map((c) => c.id).join(', ')} failed — fix before pushing tracking`);
    const captureId = a.holdStatus.capture_id;
    const r = await pp.addTracking(s.orderId, { captureId, trackingNumber: a.waybill.tracking_number, carrier: a.waybill.carrier_code_paypal });
    audit('add_tracking', { orderId: s.orderId, captureId, tracking: a.waybill.tracking_number, carrier: a.waybill.carrier_code_paypal });
    save({ ...s, tracked: { at: new Date().toISOString(), tracking: a.waybill.tracking_number } });
    return r;
  },
  'POST /api/dispute': async (body) => {
    const d = await pp.getDispute(body.id);
    return { dispute: d, actions: pp.linkRels(d) };
  },
  'POST /api/dispute/require-evidence': async (body) => pp.sandboxRequireEvidence(body.id),
  'POST /api/dispute/evidence': async (body) => {
    const s = state();
    const a = s.lastAnalysis;
    if (!a) throw new Error('Run verification first');
    const pdf = evidencePdf(a, body.id);
    writeFileSync(root('out/evidence.pdf'), pdf);
    const evidences = [
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        evidence_info: { tracking_info: [{ carrier_name: a.waybill.carrier_code_paypal, tracking_number: a.waybill.tracking_number }] },
        documents: [{ name: 'evidence.pdf' }],
        notes: a.ai.evidence_statements.filter((x) => x.grounded).map((x) => x.text_en).join(' ').slice(0, 1900),
      },
    ];
    const r = await pp.provideEvidence(body.id, { evidences, files: [{ name: 'evidence.pdf', type: 'application/pdf', buffer: pdf }] });
    audit('provide_evidence', { disputeId: body.id, statements: evidences[0].notes.length, pdf_bytes: pdf.length });
    return r;
  },
  'POST /api/dispute/adjudicate': async (body) => pp.sandboxAdjudicate(body.id, body.outcome || 'SELLER_FAVOR'),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/return') {
      const s = state();
      if (url.searchParams.get('token') !== s.orderId) { res.writeHead(302, { Location: '/' }); return res.end(); }
      try { await pp.captureOrder(s.orderId); audit('capture', { orderId: s.orderId }); } catch {}
      res.writeHead(302, { Location: '/' }); return res.end();
    }
    if (url.pathname === '/evidence.pdf' && existsSync(root('out/evidence.pdf'))) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(readFileSync(root('out/evidence.pdf')));
    }
    const key = `${req.method} ${url.pathname}`;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) || !String(req.headers['content-type']).includes('application/json')) {
        res.writeHead(403); return res.end('forbidden');
      }
    }
    if (routes[key]) {
      let body = '';
      for await (const c of req) body += c;
      const out = await routes[key](body ? JSON.parse(body) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(root('public/index.html')));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message, details: e.body }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Unhold running on http://localhost:${PORT}`));
