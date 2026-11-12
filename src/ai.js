// The LLM (Qwen via Alibaba Cloud Model Studio) does two narrow jobs: (1) extract fields from Chinese supplier documents,
// (2) explain check results in Chinese for the seller and draft English evidence statements.
// Every statement must cite source documents; a grounding guard rejects numbers that
// do not appear in the cited sources. Buyer PII is never sent (only city/state/ZIP).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Alibaba Cloud Model Studio (Bailian / DashScope), OpenAI-compatible endpoint.
const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen3.8-flash';
function apiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const f = `${homedir()}/.config/dashscope_key`;
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('DASHSCOPE_API_KEY missing (see .env.example)');
}

export async function jsonCall(system, user, schema) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      enable_thinking: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Qwen API ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return JSON.parse(json.choices[0].message.content);
}

const PURCHASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['po_number', 'date', 'sku', 'item_zh', 'item_en', 'quantity', 'unit_price_cny', 'total_cny', 'gross_weight_kg_per_unit', 'shop_order_ref'],
  properties: {
    po_number: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
    sku: { type: 'string' }, item_zh: { type: 'string' }, item_en: { type: 'string' },
    quantity: { type: 'integer' }, unit_price_cny: { type: 'number' }, total_cny: { type: 'number' },
    gross_weight_kg_per_unit: { type: ['number', 'null'] }, shop_order_ref: { type: 'string' },
  },
};

export function extractPurchase(rawText) {
  return jsonCall(
    'You extract structured fields from Chinese supplier purchase documents for a cross-border e-commerce seller. Copy values exactly as written; translate only item_en. If a field is absent use an empty string or null.',
    `Document id: purchase_order_1688.txt\n---\n${rawText}`,
    PURCHASE_SCHEMA,
  );
}

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_explainer_zh', 'hold_explainer_en', 'check_notes', 'evidence_statements', 'recommendation_zh', 'recommendation_en'],
  properties: {
    hold_explainer_zh: { type: 'string' },
    hold_explainer_en: { type: 'string' },
    check_notes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['check_id', 'note_zh', 'note_en', 'confidence'],
        properties: { check_id: { type: 'string' }, note_zh: { type: 'string' }, note_en: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
      },
    },
    evidence_statements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['text_en', 'sources'],
        properties: { text_en: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
      },
    },
    recommendation_zh: { type: 'string' },
    recommendation_en: { type: 'string' },
  },
};

const POLICY = `PayPal policy excerpts (cite as "policy:*"):
- policy:hold_hk_cn: "Risk-based holds generally remain in place for up to 30 days from the date the payment was received" (HK/CN User Agreement, 2026). Holds may be released earlier when shipment tracking is uploaded, at PayPal's sole discretion.
- policy:release_after_delivery: PayPal Help: when tracking from a supported carrier is added, the hold is released approximately 24 hours after the carrier confirms delivery.
- policy:seller_protection: Seller Protection for Item Not Received requires proof of delivery: online tracking showing "delivered" status to the address on the transaction. Guest Checkout / card payments are not covered when the seller account is registered in China, Hong Kong or Singapore. SNAD is never covered.
- policy:dispute_window: seller must respond within 10 days or the case is decided for the buyer.`;

export function explain({ checks, sources, holdStatus }) {
  const sourceList = Object.entries(sources).map(([id, text]) => `### ${id}\n${text}`).join('\n\n');
  return jsonCall(
    `You are an assistant for a small cross-border seller in China using PayPal. Code has already run deterministic checks; you must NOT change any pass/fail result.
Tasks:
1) hold_explainer_zh: in plain Chinese (<=120 chars), explain why this payment may be held / what PayPal rule applies and the exact next step that PayPal's own rules say unlocks it. Do not promise PayPal will release funds. Also give hold_explainer_en (same meaning, English).
2) check_notes: one short Chinese note (note_zh) and English note (note_en) per check explaining it; for 'explained' or 'warn' status explain the likely reason using the documents.
3) evidence_statements: 4-7 factual English sentences for a PayPal dispute evidence pack. Write them as a seller addressing PayPal (e.g. 'The buyer paid 68.00 USD via PayPal on ...'). Never mention file names or source ids inside text_en; put source ids only in the sources array (use the exact ids given). Each sentence may only state facts present in its cited sources. No speculation, no claims about the buyer's intent.
4) recommendation_zh / recommendation_en: one sentence on what the seller should approve next.
${POLICY}`,
    `Hold/capture status from PayPal API: ${JSON.stringify(holdStatus)}\n\nCheck results:\n${JSON.stringify(checks, null, 1)}\n\nSources:\n${sourceList}`,
    EXPLAIN_SCHEMA,
  );
}

// Grounding guard: every number in a statement must appear in at least one cited source.
export function groundingGuard(statements, sources) {
  return statements.map((s) => {
    const cited = s.sources.map((id) => sources[id] ?? '').join('\n');
    const unknown = s.sources.filter((id) => !(id in sources));
    const text = s.text_en.split(/\s+/).filter((w) => !Object.keys(sources).some((id) => w.includes(id))).join(' ');
    const nums = (text.match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));
    const missing = nums.filter((n) => !cited.replace(/,/g, '').includes(n) && !cited.includes(String(Number(n))));
    const ok = unknown.length === 0 && missing.length === 0 && s.sources.length > 0;
    return { ...s, grounded: ok, problems: [...unknown.map((u) => `unknown source ${u}`), ...missing.map((m) => `number ${m} not in cited sources`)] };
  });
}
