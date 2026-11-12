# Proven — payment follows proof

**Agentic commerce solved shopping. It never solved work.**

Proven turns a plain-language job into a clause-by-clause agreement, has AI verify the delivered
evidence against those clauses, and settles the fair percentage through PayPal — a **real partial
capture** against a **real authorization**, with the remainder **voided**.

**Demo:** _<add hosted URL>_ · **Video:** _<add YouTube link>_ · **OpenAPI:**
[`docs/openapi.json`](docs/openapi.json) (served at `/api/openapi.json`) · **Built with:** PayPal
Orders v2 (`intent: AUTHORIZE`), PayPal Payments v2 (partial capture + void), React, TypeScript,
Node, Express, Zod, AG Grid, a vision-capable LLM via an OpenAI-compatible endpoint.

> 85% of freelancers report being paid late (Remote, 2025). 56% of US small businesses carry unpaid
> invoices averaging $17,500 (Intuit QuickBooks, 2025).

**The four things to look at**

1. **AI-authored acceptance criteria** — a vague text message becomes clauses with machine-checkable evidence requirements.
2. **Clause-level verdicts** — status, confidence, and the exact file cited, per clause.
3. **`PARTIALLY_CAPTURED` + `VOIDED`** — on a real PayPal sandbox authorization, verified server-side.
4. **Two surfaces, one state machine** — the same settlement is drivable by a human in a deal room or by an agent over [`/api/agent`](#agent-surface), with an OpenAPI 3.1 contract and an AG Grid ledger over the results.

---

## Try the live demo

The hosted instance runs against PayPal **sandbox** — disposable credentials, no real money.

1. Open the demo URL and press **Draft the agreement** (the backsplash text is prefilled).
2. Accept as **buyer**, then accept as **seller**.
3. Click the PayPal button and sign in with the sandbox personal account:

   | | |
   |---|---|
   | Email | `_<sandbox-buyer@personal.example.com>_` |
   | Password | `_<sandbox-buyer-password>_` |

4. Upload any 3–5 photos, run **Adjudicate**, then **Approve & settle**.
5. Open **Ledger** in the header to see every agreement with its released and returned split.

> The buyer account is a PayPal *sandbox* login created for this demo. It has no real funds and no
> access to anything outside the sandbox.

---

## The problem

Every payment product treats a job as either delivered or not. Reality is a gradient. When a
backsplash is 88% right, a chargeback punishes the seller for the 12% gap, and full payment punishes
the buyer for the same 12%. Nothing in the market prices the gap.

## How it works

**Agree.** Paste the message the way people actually type it. The model produces 4–6 clauses, each
with an observable requirement and a named piece of evidence. Both parties accept. The definition of
done is now shared, and it exists *before* anyone lifts a tool.

**Prove.** The seller uploads photos, receipts, and notes. Evidence is SHA-256 hashed and attached to
a clause. The interface shows which clauses still have no evidence *before* submission.

**Settle.** The model returns a per-clause `{ status, confidence, citedEvidence, explanation,
proposedFraction }`. The model proposes **fractions only** — `server/money.ts` computes the money
deterministically:

```
release = round( Σ (normalized_weight_i × fraction_i) × total )
void    = total − release
```

The buyer approves. The server calls:

```
POST /v2/payments/authorizations/{auth}/capture   amount=release   (no final_capture)
POST /v2/payments/authorizations/{auth}/void
```

then re-reads the authorization with `GET` so the receipt shows PayPal's own state, not ours.

`final_capture` is deliberately **omitted**. Setting it to `true` closes the authorization, which
leaves the uncaptured remainder to expire on its own — the buyer's money stays reserved for days.
Capturing partially and then voiding releases it immediately. See the comment in
`server/paypal.ts`.

## PayPal integration

| Primitive | Endpoint | Role |
|---|---|---|
| Create order, `intent: AUTHORIZE` | `POST /v2/checkout/orders` | Places the hold. Funds reserved, nothing charged. |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | Converts buyer approval into an authorization ID (29-day validity). |
| **Partial capture** | `POST /v2/payments/authorizations/{id}/capture` | Captures the adjudicated amount. |
| **Void remainder** | `POST /v2/payments/authorizations/{id}/void` | Releases the uncaptured balance immediately. |
| Get authorization | `GET /v2/payments/authorizations/{id}` | Server-side truth for the receipt. |

Every mutation sends `PayPal-Request-Id` for idempotency and `Prefer: return=representation`.

## AI integration

- **Model:** `deepseek-v4.1-flash-free` for clause drafting, `nemotron-3.5-super-vl-free` for
  multimodal adjudication (both via `https://opencode.ai/inference/openai/v1`; any OpenAI-compatible
  provider works).
- **Structured output:** every model response is parsed and validated with Zod before it can touch
  state. Malformed output fails loudly rather than silently scoring a clause.
- **Deterministic guard rails:** a clause with no attached evidence is forced to `missing` / `0`,
  regardless of what the model says. Cited filenames are filtered against the real evidence list.
- **Human control:** below `0.75` overall confidence (or any clause under `0.6`), settlement is
  blocked until a human ticks an explicit acknowledgement.
- **Offline fallback:** with no `AI_API_KEY`, the app runs a deterministic template and labels itself
  `heuristic-fallback` in the UI and ledger. It is never presented as model output.

## Run it

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, AI_API_KEY
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:8787/api/health

`npm run dev` runs Vite and the API together; Vite proxies `/api` and `/uploads` to port 8787.
Production: `npm run build && npm start` (Express serves `dist/`).

### Environment

| Variable | Required | Notes |
|---|---|---|
| `PAYPAL_CLIENT_ID` | yes | Sandbox app client ID. Public; also returned by `/api/health`. |
| `PAYPAL_CLIENT_SECRET` | yes | Server-only. Never exposed to the browser. |
| `PAYPAL_API_BASE` | no | Defaults to `https://api-m.sandbox.paypal.com`. |
| `AI_API_KEY` | no | Without it, the app runs the labelled offline fallback. |
| `AI_BASE_URL` | no | Defaults to the OpenCode Zen OpenAI-compatible endpoint. |
| `AI_MODEL` | no | Defaults to `deepseek-v4.1-flash-free`. |
| `AI_VISION_MODEL` | no | Blank = adjudicate from metadata only, with lower confidence. |
| `AI_JSON_MODE` | no | `0` disables `response_format: json_object` for gateways that reject it. |
| `PORT` | no | Defaults to `8787`. |
| `DATA_DIR` | no | Defaults to `./data` (JSON store + uploaded evidence). |
| `AGENT_API_KEY` | no | Set to require `Authorization: Bearer <key>` on `/api/agent`. Unset = open sandbox demo. |

### Sandbox setup

1. Create a sandbox app at <https://developer.paypal.com/dashboard/applications/sandbox>.
2. Create (or reuse) a **personal** sandbox account — that is the buyer during checkout.
3. Use the sandbox **business** account tied to the app as the seller.
4. Paste the client ID and secret into `.env`, restart.
5. The header pill should read `PayPal sandbox`.

> **Partial capture must be enabled on the receiving account.** PayPal's docs state that for
> payment authorizations, partial capture has to be enabled for the account
> ([source](https://developer.paypal.com/payment-methods/auth-honor)). If `capture` returns an error
> about partial captures, that is an account setting, not the app. Prove it end to end with
> `npm run spike` before recording.

## Real vs simulated

Before recording, run the mechanism test:

```bash
npm run ai:smoke    # verifies the model endpoint, JSON mode, and vision
npm run spike       # creates a real AUTHORIZE order, captures 88%, voids the rest
```

`npm run spike` is interactive: it prints a PayPal approval URL, waits for you to approve in the
browser, then captures and voids. It writes every returned id to `docs/paypal-proof.txt` — commit
that file, because real PayPal ids are the strongest evidence that the build works.

| Real | Simulated / out of scope |
|---|---|
| PayPal sandbox order, authorization, partial capture, void | Notifications (email/SMS) |
| Multimodal model calls with structured output | Identity / KYC |
| Deterministic money computation + idempotency keys | Legal arbitration and appeals |
| SHA-256 evidence hashing and append-only event ledger | Payouts to the seller (optional, not on the golden path) |
| Server-side re-read of authorization state | Webhook signature verification (`/api/paypal/webhook` records events only) |

## API surface

Proven has two front doors onto **one domain layer** (`server/service.ts`). The browser calls REST
with multipart uploads; an autonomous agent calls the same state machine with JSON and base64. The
money rules, guards, and event ledger are identical, so a settlement cannot diverge based on which
surface drove it.

### Browser surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Config + mode (never returns the secret). |
| `GET` | `/api/agreements` | Ledger rows: status, totals, released/returned, confidence. |
| `POST` | `/api/agreements` | Draft clauses from prose. |
| `GET` | `/api/agreements/:id` | Full agreement state. |
| `POST` | `/api/agreements/:id/approve` | `{ party: "buyer" \| "seller" }`. |
| `POST` | `/api/paypal/create-order` | Create the `AUTHORIZE` order. |
| `POST` | `/api/paypal/authorize` | Authorize after buyer approval. |
| `POST` | `/api/agreements/:id/evidence` | Multipart upload, bound to a clause. |
| `DELETE` | `/api/agreements/:id/evidence/:evidenceId` | Remove evidence (invalidates the verdict). |
| `POST` | `/api/agreements/:id/adjudicate` | Run adjudication. |
| `POST` | `/api/agreements/:id/settle` | Capture + void. `{ reviewAcknowledged?: boolean }`. |
| `GET` | `/api/openapi.json` | The agent contract, as OpenAPI 3.1. |

### Agent surface

`/api/agent` is a tool-shaped namespace: JSON in, JSON out, base64 evidence, and an ordered
**`nextActions`** array on every state-changing response so a caller never has to infer what the
state machine wants next.

| Tool | Call |
|---|---|
| `create_agreement` | `POST /api/agent/agreements` |
| `get_agreement` | `GET /api/agent/agreements/{id}` |
| `list_agreements` | `GET /api/agent/agreements` |
| `approve` | `POST /api/agent/agreements/{id}/approve` |
| `create_paypal_order` | `POST /api/agent/agreements/{id}/paypal/order` |
| `authorize_paypal_order` | `POST /api/agent/agreements/{id}/paypal/authorize` |
| `submit_evidence` | `POST /api/agent/agreements/{id}/evidence` |
| `adjudicate` | `POST /api/agent/agreements/{id}/adjudicate` |
| `settle` | `POST /api/agent/agreements/{id}/settle` |

Discovery: `GET /api/agent/manifest` (tool list with input schemas), `GET /api/openapi.json`
(OpenAPI 3.1, importable into Postman or APIMatic).

Set `AGENT_API_KEY` to require `Authorization: Bearer <key>` on every agent call. Left unset, the
surface is open so judges can poke it without credentials. The key is compared with
`crypto.timingSafeEqual`.

```bash
# 1. Draft
curl -s localhost:8787/api/agent/agreements \
  -H 'content-type: application/json' \
  -d '{"prose":"Kitchen backsplash, $5,000, level tile, 3mm grout, outlet cutout sealed, site cleaned. Materials receipt required."}'
# → { "agreement": { "id": "deal_…", "status": "DRAFT", … }, "nextActions": [ … ] }

# 2. Both parties accept
curl -s localhost:8787/api/agent/agreements/deal_…/approve \
  -H 'content-type: application/json' -d '{"party":"buyer"}'
curl -s localhost:8787/api/agent/agreements/deal_…/approve \
  -H 'content-type: application/json' -d '{"party":"seller"}'

# 3. Fund with a real hold, approve in a browser, then authorize
curl -s -X POST localhost:8787/api/agent/agreements/deal_…/paypal/order
# → { "orderId": "…", "approveUrl": "https://www.sandbox.paypal.com/…" }
curl -s -X POST localhost:8787/api/agent/agreements/deal_…/paypal/authorize

# 4. Attach proof to a clause (bare base64 or a data: URL)
curl -s localhost:8787/api/agent/agreements/deal_…/evidence \
  -H 'content-type: application/json' \
  -d '{"clauseId":"c1","filename":"grout.jpg","dataBase64":"data:image/jpeg;base64,/9j/4AAQ…"}'

# 5. Adjudicate, then settle
curl -s -X POST localhost:8787/api/agent/agreements/deal_…/adjudicate
curl -s localhost:8787/api/agent/agreements/deal_…/settle \
  -H 'content-type: application/json' -d '{"reviewAcknowledged":true}'
```

The last call performs the partial capture and void. The response carries the capture id, the
authorization's new status, and the two amounts — all read back from PayPal.

> The model only ever proposes fractions. Dollar figures are computed in `server/money.ts`, which is
> the only module allowed to do arithmetic on money. An agent cannot ask Proven to capture an amount
> the adjudication did not justify.

## Architecture

```
React (Vite)
  ├── Home · Deal        browser deal room
  └── Ledger             AG Grid, lazy-loaded (~900 kB not on the landing path)
        │
        ├── /api/…                  multipart, browser-shaped
        └── /api/agent/…            JSON + base64, agent-shaped
                    │
                    ▼
            service.ts   ← the only domain layer: guards, state machine, events
                    │
     ┌──────────────┼───────────────┬─────────────────┐
     ▼              ▼               ▼                 ▼
   ai.ts        money.ts         paypal.ts         store.ts
 draftAgreement  computeSettlement  token cache     JSON store
 adjudicate      (only money math)  orders          event log
 (Zod-validated)                    authorize       uploads
                                    capture · void
```

Two surfaces, one state machine. Adding a surface means writing a router, not a second
implementation of settlement.

## Known limitations

- Single-process JSON store. Fine for a demo; not for concurrency.
- No identity layer. Two "party" buttons stand in for signed-in users; the agent API is protected by
  a shared bearer token, not per-caller scopes.
- The 29-day authorization window is real, so a stale demo authorization will fail to capture —
  fund and settle in the same run.
- Webhook signature verification is not implemented.
- Vision mode only inspects the first four images per adjudication.
- Not legal advice, not a contract of record, and not a licensed escrow service.

## License

MIT — see [LICENSE](LICENSE).
