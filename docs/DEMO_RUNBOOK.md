# Demo runbook

**Published walkthrough:** <https://youtu.be/yzS9dXiAHZA> (2:37, recorded from this app with no AI
key). This runbook is the manual fallback if you need to re-record or walk a judge through it live.

Operational companion to the validation section of the [README](../README.md). This is the sheet you
keep on a second monitor while recording. It assumes nothing works by luck.

---

## 0. Pre-flight (do this before you record anything)

```bash
npm run typecheck          # must be silent
npm run build              # must print "built in"
npm run ai:smoke           # must show 4 ✓
npm run spike              # writes docs/paypal-proof.txt with real ids
```

Then:

1. **Commit `docs/paypal-proof.txt`.** A judge can read the ids. This is the single strongest
   artifact in the repo.
2. **Open the demo URL once.** On Render Free the service sleeps after 15 minutes; the first
   request takes ~60s. Never open it cold on camera.
3. **Sign in to the PayPal sandbox personal account** in a second tab so the checkout is three
   clicks, not a password hunt.
4. **Clear `data/`** so the ledger starts empty and the only rows on screen are the ones you made
   (`Ctrl+C`, `rm -rf data`, restart). A ledger with one clean row beats a ledger with test junk.
5. **Set the browser zoom to 110%** and hide bookmarks. The UI is dark and dense; 110% films better.

### The one setting that can kill the demo

Partial capture must be enabled on the **receiving** PayPal account. If `capture` returns an error
about partial captures, that is an account setting, not the app. `npm run spike` catches this before
you record. Do not skip it.

---

## 1. What must be on screen for the claim to land

| Claim | Evidence on screen |
|---|---|
| AI wrote the contract | 4–6 clauses with checkable evidence requirements |
| AI judged the work | per-clause status, confidence, and the cited filename |
| Money moved for real | `capture id`, `PARTIALLY_CAPTURED` **or** authorization `VOIDED` |
| The remainder was released | the void line in the event ledger + authorization status |
| Deterministic money | Released + Returned = Contract, exactly |

If the video shows a number but not an id, it proves nothing.

---

## 2. The 2:45 shot list

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Hero | "Every payment product treats a job as delivered or not. Reality is a gradient." |
| 0:15–0:35 | Paste the message, press **Draft the agreement** | "This is a real scope, typed the way people type. Watch what it becomes." |
| 0:35–0:55 | Deal room, clauses | "Five clauses. Each one has an observable test and the exact evidence that satisfies it. Both sides accept the same definition of done." |
| 0:55–1:10 | **Fund** → PayPal button | "PayPal authorizes the full amount. Nothing is captured. This is a hold, not a charge." |
| 1:10–1:35 | **Prove** → upload photos | "The seller uploads proof. It is hashed and bound to a clause." |
| 1:35–1:55 | **Adjudicate** | "The model scores each clause and cites the file it relied on. It proposes fractions — never dollars." |
| 1:55–2:15 | Verdict + split | "Eighty-eight percent verified. The server computes $4,400 of $5,000. Deterministic, not model arithmetic." |
| 2:15–2:35 | **Settle** → receipt | "Partial capture of $4,400 against the real authorization, then void the $600 remainder." |
| 2:35–2:45 | Receipt ids + ledger | "Both ids are from PayPal. The buyer was charged for what was delivered, and the rest was released immediately." |

Narration rules: never say "AI decides how much to pay." Say "AI proposes a fraction; code sets the
amount." That sentence is the difference between a demo and a liability.

---

## 3. Recovery paths

**PayPal button does nothing / popup blocked.** Use the agent surface instead; it hits the same
domain layer and the same state machine:

```bash
curl -s -X POST localhost:8787/api/agent/agreements/$ID/paypal/order
# open approveUrl, approve, then:
curl -s -X POST localhost:8787/api/agent/agreements/$ID/paypal/authorize
```

**Capture fails with an account error.** Say so on camera, show `docs/paypal-proof.txt`, and switch
to the recorded spike. Do not fake a receipt.

**AI call fails mid-demo.** The app falls back to the labelled heuristic and shows the amber
"Offline fallback mode" banner. Show the banner, say "this is the deterministic fallback, clearly
labelled," and keep moving. Never hide it.

**Settlement returns `REVIEW_REQUIRED`.** That is the guard rail working. Tick the acknowledgement,
say "confidence below the floor requires a human," and settle.

**Render is asleep.** The loading screen is the spin-up. Start talking over it; by the time you
finish the first sentence it is awake.

---

## 4. What not to do

- Do not claim "first AI escrow." Settlex, Justra, Kustodia and Circle `arc-escrow` exist. Claim the
  primitive none of them ship: **partial capture plus void on the same authorization**.
- Do not show the ledger with fabricated rows. There is no seed data; make the row on camera.
- Do not leave `AGENT_API_KEY` set during judging unless you put the token in the README — a judge
  who curls a 401 and gets no hint will assume the API is broken.
- Do not record after the deadline. Upload the video first; the repo can stay untouched.
