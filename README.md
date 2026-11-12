# Proven

**Payment follows proof.**

Every payment product treats a job as either delivered or not. Reality is a gradient. Proven turns
a vague text message into a clause-by-clause agreement, has AI adjudicate the seller's evidence
against those clauses, and settles **exactly the proven percentage** through PayPal — a real
**partial capture** on a real authorization, with the remainder **voided** immediately.

> **Status:** PayPal sandbox only. No real money moves. Runs locally in about a minute; a Render
> blueprint is included for a public demo. **Not legal advice, not a licensed escrow service.**
>
> **Verified against PayPal:** a $5,000 authorization, `$4,000` partially captured and `$1,000`
> voided on the same authorization — ids and statuses re-read from PayPal's API in
> [`docs/paypal-proof.txt`](docs/paypal-proof.txt).

| | |
|---|---|
| Run it | `npm install && npm run dev` → <http://localhost:5173> |
| Test it, no credentials needed | `npm run verify` → 19 checks |
| Prove the PayPal path | `npm run spike` → writes `docs/paypal-proof.txt` |
| Agent contract | `/api/agent/manifest` · [`docs/openapi.json`](docs/openapi.json) |

---

## The problem

Freelance and small-contract work settles in one of two bad ways.

- Pay up front: the buyer carries all the risk.
- Pay on completion: the seller carries all the risk, and 85% of freelancers report being paid late
  (Remote, 2025). US small businesses carry roughly $17,500 in unpaid invoices on average (Intuit
  QuickBooks, 2025).

The real world is neither. A backsplash can be level and correctly grouted but have a chipped
outlet cutout and no materials receipt. Chargeback punishes the seller for the gap; full payment
punishes the buyer for the same gap. **Nothing in the stack prices the gap.**

## The idea

Make the unit of payment a **clause**, not a job.

1. **Agree** — the scope is drafted into 4–6 clauses, each with an observable requirement, a named
   piece of evidence, and a weight. Both parties accept the same definition of done *before* work
   starts.
2. **Prove** — the seller attaches photos, receipts, or documents. Each file is SHA-256 hashed and
   bound to one clause.
3. **Settle** — a model judges each clause and proposes a **fraction from 0 to 1**. Deterministic
   server code converts fractions into money. PayPal captures that amount and voids the rest.

The design rule that makes it safe: **the model never sees dollars.** It emits fractions and
confidence. `server/money.ts` is the only module allowed to multiply by the contract total.

## What happens in ninety seconds

| Act | Screen | What is real |
|---|---|---|
| Agree | Paste a messy job description → **Draft the agreement** | 4–6 clauses with evidence requirements and weights summing to 1.000 |
| Fund | **Reserve $5,000** → PayPal button → sandbox login | `intent: AUTHORIZE` order; funds held, nothing captured |
| Prove | Upload photos per clause | SHA-256 hash, clause binding, `/uploads/*` served back |
| Judge | **Adjudicate** | Per-clause `status`, `confidence`, cited filename, `proposedFraction` |
| Settle | **Approve & settle** | `POST …/capture` for the proven amount, `POST …/void` for the rest, then a `GET` to show PayPal's own state |

Released + returned always equals the contract total, to the cent.

## Where PayPal is load-bearing

Proven is not a payments app with an AI wrapper, and it is not a generic escrow UI. The product only
exists because PayPal authorizations support this exact sequence:

| Primitive | Endpoint | Why it matters |
|---|---|---|
| Authorize | `POST /v2/checkout/orders` (`intent: AUTHORIZE`) | Reserves the full amount without charging it |
| Authorize (approve) | `POST /v2/checkout/orders/{id}/authorize` | Returns an authorization id valid for ~29 days |
| **Partial capture** | `POST /v2/payments/authorizations/{id}/capture` | Charges only the adjudicated amount |
| **Void remainder** | `POST /v2/payments/authorizations/{id}/void` | Releases the rest immediately |
| Read back | `GET /v2/payments/authorizations/{id}` | The receipt shows PayPal's state, not ours |

`final_capture` is deliberately **omitted** from the capture call. Setting it to `true` closes the
authorization and leaves the uncaptured remainder to expire on its own, which keeps the buyer's
money reserved for days. Capturing partially and then voiding is what returns the money now. That
trade-off is documented in `server/paypal.ts`.

---

## Quickstart

**Requirements:** Node **20.11+**. Nothing else — no database, no Docker, no PayPal account.

```bash
git clone <repo-url>
cd <repo>
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run dev
```

Open <http://localhost:5173>. The API runs on <http://localhost:8787>.

With an empty `.env` the app is fully usable for everything except moving money:

- **AI** runs the deterministic fallback, labelled `heuristic-fallback` in the UI, ledger, and event
  log. It is never passed off as model output.
- **PayPal** is reported as not configured; the Fund step explains what to add.

Verify the install before configuring anything:

```bash
npm run verify       # 19 checks, ~5 seconds, uses a throwaway port and data dir
npm run typecheck    # silent
npm run build        # writes dist/
```

### Enable the AI (recommended)

Put any OpenAI-compatible key in `.env`:

```ini
AI_BASE_URL=https://opencode.ai/inference/openai/v1
AI_API_KEY=...
AI_MODEL=deepseek-v4.1-flash-free
AI_VISION_MODEL=nemotron-3.5-super-vl-free
```

Then confirm the endpoint supports what the app needs — plain chat, JSON mode, and image input:

```bash
npm run ai:smoke
```

Restart `npm run dev`. The startup banner changes from `AI offline fallback` to the model names, and
the deal room loses its amber fallback banner.

### Enable PayPal (required for the money step)

1. **Create a sandbox business account** at
   <https://developer.paypal.com/dashboard/accounts> → **Sandbox → Accounts → Create Account**.
   Type **Business**, country **United States**, currency **USD**. This is the **payee**.
2. **Create a sandbox personal account** the same way. Country **United States**, currency **USD**,
   starting balance **5,000**. This is the **buyer** at checkout.
3. **Create the app** at <https://developer.paypal.com/dashboard/applications/sandbox> →
   **Create App** → type **Merchant** → select the **US business account** from step 1.
4. Copy **Client ID** and **Secret** into `.env`:

   ```ini
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
   ```

5. Restart. The header pill reads **PayPal sandbox**; `GET /api/health` reports
   `"paypalConfigured": true`.

> **The one trap that costs an hour.** The payee is bound to the *client ID*, not to the order. If
> the app is linked to an India-linked business account, USD checkout fails with
> `UNSUPPORTED_PAYEE_CURRENCY` no matter which buyer you use. Create the app *after* the US business
> account, and check which account is listed on the app page.
>
> **The second trap.** Partial capture must be enabled on the receiving account. If capture fails
> with an account error rather than a payload error, that is an account setting. `npm run spike`
> surfaces it before you record anything.
>
> **The third trap.** A business account cannot pay itself. Sign in at checkout as the **personal**
> account.

---

## Validate the submission

This section is the point of the repository. Each claim below has a command and an observable
result. `npm run verify` needs no credentials, no network, and no browser.

### 1. Deterministic core — `npm run verify`

Spawns the real server on a temporary port with `PAYPAL_*` and `AI_API_KEY` forced empty, then drives
the whole state machine through HTTP and asserts the money at its source.

```
  ✓ weights normalise to exactly 1
  ✓ settlement splits the contract exactly          $5,000 × 80% → $4,000 captured, $1,000 voided
  ✓ fractions outside 0..1 are clamped
  ✓ a clause with no verdict releases nothing
  ✓ rounding never invents or loses a cent
  ✓ low confidence requires a human
  ✓ health advertises offline mode honestly
  ✓ OpenAPI contract is served                      OpenAPI 3.1.0, 10 paths
  ✓ unknown API routes return JSON, not HTML
  ✓ agent manifest lists its tools                  9 tools
  ✓ draft agreement produces checkable clauses       5 clauses, weights sum to 1.000
  ✓ both parties must accept
  ✓ evidence is bound to a real clause
  ✓ upload hashes the file and serves it back
  ✓ adjudication cites evidence and totals the contract
  ✓ settlement is blocked without a PayPal hold      409 NO_AUTHORIZATION
  ✓ removing evidence invalidates the verdict
  ✓ ledger exposes a settled/unsettled split
  ✓ agent surface drives the same state machine

19 checks passed.
```

It never touches `data/`, so it is safe to run in the middle of a demo.

### 2. The PayPal primitive — `npm run spike`

Creates a real sandbox `AUTHORIZE` order for $5,000, waits while you approve it in a browser, then
captures 88% and voids the remaining 12%. Every id it prints came back from PayPal.

```bash
npm run spike                 # optional: -- --amount 5000 --fraction 0.88
```

Expected shape of `docs/paypal-proof.txt`:

```
mode: sandbox
order_id: <21 chars>
order_status: CREATED
authorization_id: <17 chars>
authorization_status: CREATED
capture_id: <17 chars>
capture_status: COMPLETED
capture_amount: 4400.00
void_status: VOIDED
final_authorization_status: VOIDED
```

That file is the strongest evidence in the repo: capture and void on **one** authorization, in
PayPal's own state.

### 3. The product — a five-minute manual walkthrough

| Step | Action | Expected |
|---|---|---|
| 1 | Home → **Draft the agreement** | `POST /api/agreements` → 201, status `DRAFT`, 4–6 clauses |
| 2 | Accept as buyer, then seller | status `AGREED`; a duplicate approval returns 409 |
| 3 | **Reserve $5,000** → PayPal → sandbox personal login | status `FUNDED`, `authorizationId` present |
| 4 | Upload `docs/sample-evidence/*.png` to three clauses, leave two empty | status `EVIDENCE`, each file hashed |
| 5 | **Adjudicate** | status `ADJUDICATED`, release + return = $5,000 |
| 6 | **Approve & settle** | status `SETTLED`, capture id, `PARTIALLY_CAPTURED`, remainder `VOIDED` |
| 7 | Header → **Ledger** | the row shows the same split as the deal room |
| 8 | Re-read `GET /v2/payments/authorizations/{id}` in PayPal | PayPal agrees with the receipt |

No photos of your own? `docs/sample-evidence/` contains three generated, clearly-labelled
placeholder cards. They exist so the flow can be completed end to end; swap in real photos for a
recording.

### Claim → evidence

| Claim | Where to look |
|---|---|
| AI writes the acceptance criteria | Deal room clauses; `draftModel` in `GET /api/agreements/:id` |
| AI judges the work | `verdict.clauses[]` — status, confidence, cited file, explanation |
| The model never sets the amount | `server/money.ts` is the only money arithmetic; `proposedFraction` is 0–1 |
| Money moves for real | capture id + `PARTIALLY_CAPTURED` / `VOIDED` in `docs/paypal-proof.txt` |
| The remainder is released | void event in the agreement's `events[]` |
| Unproven work releases nothing | upload one file, adjudicate, watch the other clauses score 0 |
| Low confidence blocks settlement | `409 REVIEW_REQUIRED` until acknowledged |
| Two surfaces, one state machine | `npm run verify` drives both and asserts identical guards |

---

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | for money | — | Sandbox app client ID. Also returned by `/api/health`. |
| `PAYPAL_CLIENT_SECRET` | for money | — | Server-only. Never sent to the browser. |
| `PAYPAL_API_BASE` | no | `https://api-m.sandbox.paypal.com` | Point at live only if you mean it. |
| `AI_API_KEY` | no | — | Blank = labelled offline fallback. |
| `AI_BASE_URL` | no | OpenCode Zen endpoint | Any OpenAI-compatible `/chat/completions`. |
| `AI_MODEL` | no | `deepseek-v4.1-flash-free` | Clause drafting. |
| `AI_VISION_MODEL` | no | `nemotron-3.5-super-vl-free` | Evidence adjudication. Blank = text/metadata only, lower confidence. |
| `AI_JSON_MODE` | no | `1` | Set `0` if your gateway rejects `response_format: json_object`. |
| `PORT` | no | `8787` | API and production web. |
| `DATA_DIR` | no | `./data` | JSON store plus uploaded evidence. |
| `AGENT_API_KEY` | no | — | Set to require `Authorization: Bearer <key>` on `/api/agent`. |

Evidence limits: **8 MB per file**, one file per multipart request, accepted types
`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`, `application/pdf`,
`text/plain`.

---

## How the money is computed

```ts
// server/money.ts — the only place that multiplies money
release = round( Σ (normalized_weight_i × proposedFraction_i) × totalCents )
voided  = totalCents − release
```

Invariants enforced in code, and asserted by `npm run verify`:

- Weights are normalised on ingest, so they always sum to 1.000 and never display as 130%.
- `proposedFraction` is clamped to `[0, 1]`; a missing verdict counts as 0.
- A clause with **no attached evidence** is forced to `missing` / `0` regardless of model output.
- Cited filenames are filtered against the actual evidence list, so a verdict cannot cite a file
  that does not exist.
- `release + voided === total`, exactly, for every rounding case tested.
- If overall confidence < 0.75 or any clause < 0.6, `needsHumanReview` is set and settlement returns
  `409 REVIEW_REQUIRED` until a human acknowledges.

Settlement guard order: `NOT_ADJUDICATED` → `NO_AUTHORIZATION` → `REVIEW_REQUIRED`. No authorization,
no capture — the state machine cannot spend money it was never given.

## Architecture

```
React 18 + Vite                          Express + TypeScript
┌───────────────────────┐               ┌──────────────────────────────┐
│ Home   Deal   Ledger  │  /api/...     │ index.ts    browser routes   │
│ (Ledger lazy-loaded)  │──────────────▶│ agent.ts    9 agent tools    │
└───────────────────────┘  /api/agent/… │            │                 │
                                        │            ▼                 │
                                        │      service.ts  ← only domain layer
                                        │      guards · state machine · events
                                        │            │
                                        │   ┌────────┼─────────┬──────────┐
                                        │   ▼        ▼         ▼          ▼
                                        │ ai.ts   money.ts  paypal.ts  store.ts
                                        │ draft   fractions capture    JSON db
                                        │ judge   only math void       uploads
                                        └──────────────────────────────┘
```

Both surfaces call the same six domain functions, so a settlement cannot diverge based on who drove
it. Adding a surface means writing a router, not a second implementation of the money rules.

Statuses: `DRAFT → AGREED → FUNDED → EVIDENCE → ADJUDICATED → SETTLED`. Adjudication is also allowed
from `AGREED` (offline evaluation before funding), which is why "Held" is rendered from the
authorization id rather than from status.

## API

### Browser surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Config + mode. Never returns the secret. |
| `GET` | `/api/agreements` | Ledger rows with totals and splits. |
| `POST` | `/api/agreements` | Draft clauses from prose. |
| `GET` | `/api/agreements/:id` | Full state, verdict, evidence, events. |
| `POST` | `/api/agreements/:id/approve` | `{ party: "buyer" \| "seller" }` |
| `POST` | `/api/paypal/create-order` | Create the `AUTHORIZE` order. |
| `POST` | `/api/paypal/authorize` | Authorize after the buyer approves. |
| `POST` | `/api/agreements/:id/evidence` | Multipart upload, bound to a clause. |
| `DELETE` | `/api/agreements/:id/evidence/:evidenceId` | Remove evidence; invalidates the verdict. |
| `POST` | `/api/agreements/:id/adjudicate` | Run adjudication. |
| `POST` | `/api/agreements/:id/settle` | Capture + void. `{ reviewAcknowledged?: boolean }` |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 contract. |

### Agent surface

`/api/agent` is a tool-shaped namespace: JSON in, JSON out, base64 evidence, and an ordered
`nextActions` array on every response so a caller never has to guess the next step.

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

```bash
# Draft, approve, attach a screenshot, adjudicate, settle — one continuous run
curl -s localhost:8787/api/agent/agreements \
  -H 'content-type: application/json' \
  -d '{"prose":"Kitchen backsplash, $5,000, level tile, 3mm grout, outlet cutout sealed, site cleaned. Materials receipt required."}'

curl -s localhost:8787/api/agent/agreements/deal_.../approve \
  -H 'content-type: application/json' -d '{"party":"buyer"}'
curl -s localhost:8787/api/agent/agreements/deal_.../approve \
  -H 'content-type: application/json' -d '{"party":"seller"}'

curl -s localhost:8787/api/agent/agreements/deal_.../evidence \
  -H 'content-type: application/json' \
  -d '{"clauseId":"c1","filename":"prep.jpg","dataBase64":"data:image/jpeg;base64,/9j/4AAQ..."}'

curl -s -X POST localhost:8787/api/agent/agreements/deal_.../adjudicate
curl -s localhost:8787/api/agent/agreements/deal_.../settle \
  -H 'content-type: application/json' -d '{"reviewAcknowledged":true}'
```

> PowerShell parses inline JSON badly. Use `curl.exe --data-binary "@body.json"` with the payload
> written to a file, or a tool like Postman importing `docs/openapi.json`.

## Data, privacy, safety

- **No real money.** The app defaults to `api-m.sandbox.paypal.com`. Only change `PAYPAL_API_BASE` if
  you intend to move real funds.
- **Secrets stay server-side.** `PAYPAL_CLIENT_SECRET` and `AI_API_KEY` are read only by the server;
  the client id is public by design.
- **No accounts, no PII.** There is no identity layer and no user database. Names in a demo are text
  fields; the store is a local JSON file.
- **Evidence is local.** Uploads are written under `DATA_DIR/uploads` and served from `/uploads/`.
  Deleting `data/` removes everything.
- **Agent surface is open by default** so judges can call it. Set `AGENT_API_KEY` to lock it; the key
  is compared with `crypto.timingSafeEqual`.
- **No telemetry.** The only outbound calls are to the PayPal API and your configured AI endpoint.

## Real vs simulated

| Real | Simulated / deliberately out of scope |
|---|---|
| PayPal sandbox: order, authorization, partial capture, void | Notifications (email/SMS) |
| Model calls with Zod-validated structured output | Identity, KYC, and signatures |
| SHA-256 evidence hashing, append-only event log | Legal arbitration and appeals |
| Deterministic money math and idempotency keys | Payouts to the seller (not on the golden path) |
| Server-side re-read of PayPal authorization state | Webhook signature verification — `/api/paypal/webhook` records events only |

## Deploy

`render.yaml` is a ready Blueprint for [Render](https://render.com). Import the repo, then fill the
three `sync: false` variables in the dashboard: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`AI_API_KEY`.

Free-plan facts that matter:

- **The filesystem is ephemeral.** Free services cannot attach a disk, so `data/` is lost on restart
  or spin-down. An agreement takes ~40 seconds to recreate; for persistence switch `plan` to
  `starter`, uncomment the disk block, and set `DATA_DIR` to the mount path.
- **It sleeps after 15 minutes of inactivity** and takes about a minute to wake. Open the URL once
  before presenting.
- `npm start` runs TypeScript through `tsx`, which is therefore a runtime dependency, not a dev one.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `UNSUPPORTED_PAYEE_CURRENCY` at checkout | App is linked to a non-US payee | Create a US business sandbox account, then create the app against it |
| Checkout says the account cannot pay itself | Signed in as the business account | Sign in with the **personal** sandbox account |
| Guest card form rejects the payment | Sandbox guest checkout, not a bug | Use **Log In** and the sandbox personal account |
| `PARTIAL_CAPTURE_NOT_SUPPORTED` on settle | Partial capture disabled on the payee | Enable it on the receiving account, then `npm run spike` |
| `401` on every agent call | `AGENT_API_KEY` is set | Send `Authorization: Bearer <key>`, or unset it |
| Ledger loads slowly once | AG Grid is lazy-loaded (~900 kB) | Expected; the landing path stays small |
| `EADDRINUSE :8787` | Another instance is running | Stop it, or set `PORT` |
| `Expected property name …` in a curl | PowerShell mangled the JSON | Use `curl.exe --data-binary "@body.json"` |
| First request to the hosted demo hangs | Render Free cold start | Wait ~60 s, or warm it before demoing |
| AI banner says offline fallback | No `AI_API_KEY` | Expected and clearly labelled; add a key to enable the model |

## Known limitations

- Single-process JSON store. Right for a demo, not for concurrent writers.
- No identity layer. Two "party" buttons stand in for signed-in users; the agent API uses one shared
  bearer token, not per-caller scopes.
- The authorization window is real (~29 days), so a stale authorization will fail to capture. Fund
  and settle in the same run.
- Vision mode inspects at most the first four images per adjudication.
- Webhook signature verification is not implemented.
- Not a licensed escrow provider, not legal advice, and not a contract of record.

## Repository map

```
server/
  index.ts     browser REST routes, static hosting, error mapping
  agent.ts     agent tool router + manifest + bearer guard
  service.ts   the only domain layer: guards, state machine, events
  ai.ts        drafting and adjudication prompts, Zod schemas, offline fallback
  money.ts     weights and settlement arithmetic (only money math)
  paypal.ts    OAuth cache, orders, authorize, capture, void, get authorization
  store.ts     JSON persistence and evidence paths
  types.ts     shared domain types
src/
  views/       Home (draft), Deal (three acts), Ledger (AG Grid, lazy)
  ui.tsx       small design-system components
  api.ts       typed fetch wrapper
scripts/
  verify.mjs       offline end-to-end self-test (npm run verify)
  paypal-spike.mjs real capture + void proof (npm run spike)
  ai-smoke.mjs     endpoint, JSON mode, and vision check (npm run ai:smoke)
docs/
  openapi.json     OpenAPI 3.1 contract, served at /api/openapi.json
  sample-evidence/ labelled placeholders for a photo-free walkthrough
  DEMO_RUNBOOK.md  recording shot list and recovery paths
  HACKATHON_PLAN.md archival research and decision record
```

## AI disclosure

- **Drafting:** `deepseek-v4.1-flash-free` via an OpenAI-compatible endpoint (OpenCode Zen by default).
- **Adjudication:** `nemotron-3.5-super-vl-free` for image evidence, same endpoint.
- **What the model is allowed to do:** propose clause text, and per-clause `{status, confidence,
  citedEvidence, explanation, proposedFraction}`.
- **What it is not allowed to do:** produce dollar amounts, cite evidence that does not exist, or
  override the deterministic rules in `server/money.ts`.
- **Without a key:** a deterministic template runs instead, labelled `heuristic-fallback` everywhere
  it appears. It checks whether evidence exists, not what it shows — and says so in its explanation.

## License

MIT — see [LICENSE](LICENSE).
