# Unhold — get paid for what you actually shipped

![Unhold dashboard](docs/screenshot.png)

**Unhold** is a get-paid copilot for small cross-border sellers (e.g. a Shenzhen Shopify seller shipping to the US) who take payments with PayPal.

When PayPal holds a payment, the seller usually doesn't know *why*, *when* it will be released, or *what exactly* to do. Unhold reads the PayPal transaction, reads the seller's own (often Chinese) documents — shop order, supplier purchase order, forwarder waybill, tracking feed — cross-checks them with deterministic code, explains the result in English and Chinese with an LLM, and then, **only after the seller approves**, executes the next step PayPal's own rules ask for:

1. **Explain the hold** — status from PayPal Orders/Payments/Balances APIs + the policy that applies (HK/CN accounts: holds up to 30 days; released ~24h after a supported carrier confirms delivery).
2. **Verify fulfillment** — amount, quantity, SKU, weight, timeline, route, tracking strength and Seller Protection eligibility, each traced back to a source document.
3. **Push tracking** — `POST /v2/checkout/orders/{id}/track` with the correct PayPal carrier code (e.g. `YUNEXPRESS`). Blocked if any check fails (e.g. an untracked economy parcel that can never show "delivered").
4. **Answer disputes with the same evidence** — reads the actions PayPal currently allows (HATEOAS links), builds a hashed, source-cited evidence PDF and submits it via the Disputes API (`provide-evidence`, or `provide-supporting-info` while PayPal is reviewing a claim).

## Why this problem

- "Trouble accessing funds in your mobile or digital wallet" is the #1 non-fraud PayPal issue in the US CFPB complaint database: 1,259 complaints in 2025 and 1,980 in 2026 through Nov 13 (~17% of PayPal complaints).
- PayPal's HK/CN User Agreement: *"Risk-based holds generally remain in place for up to 30 days"*; releasing earlier depends on uploaded tracking and confirmed delivery.
- Seller Protection requires online tracking showing "delivered" to the transaction address, and does **not** cover Guest Checkout / card payments when the seller is registered in China, Hong Kong or Singapore.
- Small sellers already hold the facts (orders, purchase records, waybills, tracking) — but in Chinese, scattered across tools, and they surface only after a dispute starts, inside a 10-day response window.

![How it works](docs/how-it-works.png)

## How PayPal and AI are used

| Tool | What it does in Unhold |
|---|---|
| PayPal **Orders v2** | create/capture the sandbox order; read payment source & shipping address; **add tracking** (`/track`) |
| PayPal **Payments / Balances / Transaction Search** | read capture status, `status_details`, withheld balance for hold diagnosis |
| PayPal **Disputes v1** | list/get disputes, read allowed actions (HATEOAS), **provide-evidence** / **provide-supporting-info** (multipart PDF), escalate, sandbox `require-evidence` / `adjudicate` |
| PayPal **sandbox** | everything runs against `api-m.sandbox.paypal.com` |
| **Qwen (Alibaba Cloud Model Studio / Bailian)**, `qwen3.8-flash` via the OpenAI-compatible endpoint | (1) extracts structured fields from Chinese supplier documents; (2) explains each check and the hold in English + Chinese; (3) drafts English evidence statements with source citations |

**Guardrails (compliance by design)**

- The LLM never decides pass/fail — deterministic code does.
- **Grounding guard:** every evidence sentence must cite known source documents and every number in it must appear in those sources; otherwise it is blocked and not submitted.
- **Human approval** before every write (tracking, evidence) + an append-only audit log (`out/audit.log.jsonl`).
- **PII minimisation:** buyer name and street are never sent to the LLM (only city/state/ZIP).
- Only official REST APIs — no automation of PayPal web pages.
- Unhold never claims to release funds; PayPal decides. It does what PayPal's rules say unlocks funds.

## Run it

Requirements: Node.js ≥ 20.6, a PayPal Developer sandbox app, a DashScope (Bailian) API key.

```bash
git clone <this repo> && cd unhold
npm install
cp .env.example .env      # fill PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, DASHSCOPE_API_KEY
npm run create-order      # prints an approval URL
npm start                 # http://localhost:3000
```

1. Open the approval URL, log in with a **sandbox Personal (buyer) account** and pay. You are redirected to `localhost:3000/return`, which captures the payment.
2. Click **Run verification** (tick "untracked economy parcel" to see a blocked case).
3. Click **Approve & add tracking** (click twice to confirm).
4. As the sandbox buyer, open an *Item not received* dispute on the payment in the sandbox Resolution Center (sandbox.paypal.com). Wait a few minutes, then in Unhold: **Open** the dispute → **Approve & submit evidence** (Unhold picks `provide-evidence` or `provide-supporting-info` depending on what PayPal allows). Optional sandbox helpers: *Move to waiting for seller evidence*, *Adjudicate* (only accepted in certain dispute states).

Verified end-to-end in sandbox on 2026-11-12: order captured → tracking `YUNEXPRESS` added (visible on the buyer's case page) → buyer opened an Item-not-received claim → evidence PDF submitted and on file while PayPal reviews.

Seller documents in `data/docs/` are **mock data** (clearly labelled); all PayPal data is real sandbox data.

## Project layout

```
src/paypal.js   PayPal REST client (Orders, Payments, Balances, Transactions, Disputes)
src/verify.js   deterministic cross-checks + SHA-256 of source documents
src/ai.js       Qwen calls (extraction, explanation, evidence drafting) + grounding guard
src/pdf.js      dependency-free evidence PDF writer
src/server.js   local web app + API, approval gates, audit log
public/         single-page UI
data/           mock shop order and seller documents
```

## Limitations

- The sandbox cannot show a real hold being released; Unhold shows status and the rule, not a release.
- Tracking events are mock; a production build would call a tracking provider.
- Small sellers rarely hold per-parcel customs declarations (9610 parcels are declared by forwarders/postal operators), so customs documents are optional evidence, not required.

## License

MIT
