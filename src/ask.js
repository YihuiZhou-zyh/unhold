// "Ask about this case": grounded Q&A over a fixed corpus of PayPal policy excerpts + the seller's live case data.
// The model may only use the corpus and the redacted case context; code drops unknown citations and
// replaces uncited policy answers with a safe fallback. No buyer name/street is ever sent.
import { readFileSync } from 'node:fs';
import { jsonCall } from './ai.js';

const CORPUS = JSON.parse(readFileSync(new URL('../data/policy_corpus.json', import.meta.url)));
const BY_ID = new Map(CORPUS.map((p) => [p.id, p]));

export const FALLBACK = "I can't find this in PayPal's published policies I have on file, so I won't guess. Check the PayPal Resolution Center for this case or contact PayPal support directly.";

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer_en', 'citations', 'case_facts_used', 'confidence', 'out_of_scope'],
  properties: {
    answer_en: { type: 'string', description: 'max 90 words, plain English, actionable' },
    citations: { type: 'array', items: { type: 'string', description: 'policy excerpt id like P3' } },
    case_facts_used: { type: 'array', items: { type: 'string', description: 'short phrase, e.g. "$68 capture PENDING (BUYER_COMPLAINT)"' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    out_of_scope: { type: 'boolean' },
  },
};

const SYSTEM = `You answer a small cross-border e-commerce seller's questions about ONE PayPal case.
Rules:
- Use ONLY (a) the PayPal policy excerpts below and (b) the CASE CONTEXT JSON. No outside knowledge.
- Every policy claim must cite an excerpt id in "citations" (e.g. "P3"). You may also write the id in brackets in the text, e.g. [P3].
- Tie the answer to the live case facts (amounts, statuses, tracking, dispute) and list the facts you used in case_facts_used.
- If the excerpts do not cover the question (or it is unrelated to PayPal/this case), say so briefly, set out_of_scope true and citations [].
- Never promise or predict that PayPal will release funds or decide in the seller's favor; PayPal decides at its discretion.
- Not legal or financial advice. Never suggest providing false or misleading information.
- answer_en: at most 90 words, plain and actionable (what the seller should do next).
- confidence: high if excerpts directly answer it; medium if partially; low otherwise.

PAYPAL POLICY EXCERPTS:
${CORPUS.map((p) => `[${p.id}] ${p.title} — "${p.quote}" (${p.source_name})`).join('\n')}`;

const words = (s) => s.trim().split(/\s+/).filter(Boolean);

export async function answer(question, caseContext) {
  const raw = await jsonCall(SYSTEM, `CASE CONTEXT:\n${JSON.stringify(caseContext, null, 1)}\n\nQUESTION: ${question}`, SCHEMA);
  const outOfScope = raw.out_of_scope === true;
  const ids = [...new Set((Array.isArray(raw.citations) ? raw.citations : []).map((c) => String(c).trim().replace(/^\[|\]$/g, '').toUpperCase()))];
  const valid = ids.filter((id) => BY_ID.has(id));
  let text = String(raw.answer_en || '').trim();
  // Strip inline [Pn] markers that point at ids we don't have.
  text = text.replace(/\[(P\d+)\]/gi, (m, id) => (BY_ID.has(id.toUpperCase()) ? m : '')).replace(/\s{2,}/g, ' ').trim();
  const w = words(text);
  if (w.length > 110) text = `${w.slice(0, 90).join(' ')}…`;
  let fallback = false;
  if (!outOfScope && valid.length === 0) { text = FALLBACK; fallback = true; }
  return {
    answer_en: text,
    citations: outOfScope && !valid.length ? [] : valid.map((id) => ({ id, ...BY_ID.get(id) })),
    case_facts_used: (Array.isArray(raw.case_facts_used) ? raw.case_facts_used : []).map(String).slice(0, 6),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    out_of_scope: outOfScope || fallback,
    dropped_citations: ids.filter((id) => !BY_ID.has(id)),
    corpus_size: CORPUS.length,
    model: process.env.QWEN_MODEL || 'qwen3.8-flash',
  };
}
