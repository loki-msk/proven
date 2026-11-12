# Proven — payment follows proof

**Agentic commerce solved shopping. It never solved work.**

Proven turns a plain-language job into a clause-by-clause agreement, has AI verify the delivered
evidence against those clauses, and settles the fair percentage through PayPal — a **real partial
capture** against a **real authorization**, with the remainder **voided**.

**Demo:** _<add hosted URL>_ · **Video:** _<add YouTube link>_ · **Built with:** PayPal Orders v2
(`intent: AUTHORIZE`), PayPal Payments v2 (partial capture + void), React, TypeScript, Node,
Express, Zod, a vision-capable LLM via an OpenAI-compatible endpoint.

> 85% of freelancers report being paid late (Remote, 2025). 56% of US small businesses carry unpaid
> invoices averaging $17,500 (Intuit QuickBooks, 2025).

**The three things to look at**

1. **AI-authored acceptance criteria** — a vague text message becomes clauses with machine-checkable evidence requirements.
2. **Clause-level verdicts** — status, confidence, and the exact file cited, per clause.
3. **`PARTIALLY_CAPTURED` + `VOIDED`** — on a real PayPal sandbox authorization, verified server-side.

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
POST /v2/payments/authorizations/{auth}/capture   amount=release, final_capture=true
POST /v2/payments/authorizations/{auth}/void
```

then re-reads the authorization with `GET` so the receipt shows PayPal's own state, not ours.

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

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Config + mode (never returns the secret). |
| `POST` | `/api/agreements` | Draft clauses from prose. |
| `GET` | `/api/agreements/:id` | Full agreement state. |
| `POST` | `/api/agreements/:id/approve` | `{ party: "buyer" \| "seller" }`. |
| `POST` | `/api/paypal/create-order` | Create the `AUTHORIZE` order. |
| `POST` | `/api/paypal/authorize` | Authorize after buyer approval. |
| `POST` | `/api/agreements/:id/evidence` | Multipart upload, bound to a clause. |
| `DELETE` | `/api/agreements/:id/evidence/:evidenceId` | Remove evidence (invalidates the verdict). |
| `POST` | `/api/agreements/:id/adjudicate` | Run adjudication. |
| `POST` | `/api/agreements/:id/settle` | Capture + void. `{ reviewAcknowledged?: boolean }`. |

## Architecture

```
React (Vite) ── /api ──▶ Express
                          ├── ai.ts      draftAgreement · adjudicate (Zod-validated)
                          ├── money.ts   computeSettlement (the only place money is computed)
                          ├── paypal.ts  token cache · orders · authorize · capture · void
                          └── store.ts   JSON store + append-only event log + uploads
                                        data/db.json · data/uploads/
```

## Known limitations

- Single-process JSON store. Fine for a demo; not for concurrency.
- No auth. Two "party" buttons stand in for identity.
- The 29-day authorization window is real, so a stale demo authorization will fail to capture —
  fund and settle in the same run.
- Webhook signature verification is not implemented.
- Vision mode only inspects the first four images per adjudication.
- Not legal advice, not a contract of record, and not a licensed escrow service.

## License

MIT — see [LICENSE](LICENSE).
