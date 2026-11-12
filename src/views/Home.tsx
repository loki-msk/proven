import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Button, Card, Dots, Field, MoneySplit, Notice, SectionLabel, money } from "../ui";

const DEMO_PROSE =
  "Kitchen backsplash replacement. I'll supply the white zellige tile, you supply thinset, grout and labour. Five thousand dollars, done by the 30th. Must be level, 3mm grout lines max, the outlet cutout centred and sealed, everything cleaned up after. I need a photo of the waterproofing before the tile goes on, and the receipt for the materials.";

export default function Home({ onCreated }: { onCreated: (id: string) => void }) {
  const [prose, setProse] = useState(DEMO_PROSE);
  const [buyerName, setBuyerName] = useState("Dev Malhotra");
  const [sellerName, setSellerName] = useState("Marisol Vega");
  const [totalUsd, setTotalUsd] = useState("5000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agreement } = await api.createAgreement({
        prose,
        buyerName,
        sellerName,
        totalUsd: Number(totalUsd),
      });
      onCreated(agreement.id);
    } catch (err) {
      const e = err as ApiError;
      setError(e.issue && e.issue !== e.message ? `${e.message} — ${e.issue}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-copy rise">
          <div className="eyebrow">
            <span className="eyebrow-dot" />
            PayPal AI Hackathon · 2026
          </div>
          <h1>
            Payment
            <br />
            follows <em>proof.</em>
          </h1>
          <p className="lede">
            Agentic commerce solved shopping. It never solved <strong>work</strong>. Proven turns a
            vague text message into a clause-by-clause agreement, has AI adjudicate the evidence, and
            settles the fair percentage through PayPal — capturing what was delivered and voiding the
            rest.
          </p>

          <div className="hero-stats">
            <div>
              <b className="mono">85%</b>
              <span>of freelancers paid late</span>
            </div>
            <div>
              <b className="mono">$17.5k</b>
              <span>unpaid per US small business</span>
            </div>
            <div>
              <b className="mono">29d</b>
              <span>a PayPal hold can last</span>
            </div>
          </div>
          <p className="hero-sources">
            Remote, 2025 · Intuit QuickBooks, 2025 · PayPal authorization docs
          </p>
        </div>

        <Card className="hero-form rise rise-2">
          <SectionLabel step="01">Start with the message</SectionLabel>
          <p className="muted small">
            This is a real scope, typed the way people actually type. Watch what happens to it.
          </p>

          <form onSubmit={submit}>
            <textarea
              className="textarea"
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              rows={7}
              spellCheck={false}
              aria-label="Job description"
            />

            <div className="form-row">
              <Field label="Buyer">
                <input className="input" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
              </Field>
              <Field label="Seller">
                <input className="input" value={sellerName} onChange={(e) => setSellerName(e.target.value)} />
              </Field>
              <Field label="Amount" hint="USD">
                <input
                  className="input mono"
                  value={totalUsd}
                  onChange={(e) => setTotalUsd(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
            </div>

            {error && (
              <Notice tone="red" title="Could not draft the agreement">
                {error}
              </Notice>
            )}

            <Button type="submit" variant="primary" className="btn-block" disabled={busy}>
              {busy ? (
                <Dots label="Drafting clauses" />
              ) : (
                <>
                  Draft the agreement <span className="arrow">→</span>
                </>
              )}
            </Button>

            <p className="micro">
              PayPal sandbox only. No real money moves. AI proposes fractions; deterministic code sets
              the amount, and money moves only on an explicit settlement call.
            </p>
          </form>
        </Card>
      </section>

      <section className="acts">
        <Card className="act">
          <span className="act-num mono">01</span>
          <h3>Agree</h3>
          <p>
            AI converts prose into four to six clauses, each with a checkable acceptance test and a
            named piece of evidence. Both sides approve the same definition of done — before anyone
            lifts a tool.
          </p>
        </Card>
        <Card className="act">
          <span className="act-num mono">02</span>
          <h3>Prove</h3>
          <p>
            The seller uploads photos, receipts and notes. The model scores every clause, cites the
            exact file it relied on, and reports its confidence. Missing evidence is called out before
            submission.
          </p>
        </Card>
        <Card className="act">
          <span className="act-num mono">03</span>
          <h3>Settle</h3>
          <p>
            The buyer approves. PayPal captures the fair percentage against a real authorization and
            voids the remainder. Not a refund. A partial capture — the primitive nobody ships.
          </p>
        </Card>
      </section>

      <section className="mechanic">
        <div className="mechanic-copy">
          <SectionLabel>The part nobody built</SectionLabel>
          <h2>
            Disputes are binary.
            <br />
            <em>Work isn't.</em>
          </h2>
          <p className="muted">
            Every payment product treats a job as either delivered or not. Reality is a gradient. A
            chargeback punishes the seller for a 12% gap; a full payment punishes the buyer for the same
            12%. Proven prices the gap — and moves exactly that amount.
          </p>
          <ul className="ticks">
            <li>
              <span className="tick">✓</span> Real <code>intent: AUTHORIZE</code> hold — funds reserved, not charged
            </li>
            <li>
              <span className="tick">✓</span> Partial capture of the adjudicated amount
            </li>
            <li>
              <span className="tick">✓</span> Immediate void of the remainder
            </li>
          </ul>
        </div>

        <Card className="mechanic-visual">
          <div className="mv-top">
            <span className="muted small">Authorized</span>
            <span className="mv-amount mono">{money(500000)}</span>
          </div>
          <div className="mv-target">
            <span className="muted small">AI proposes</span>
            <span className="mv-pct serif">88%</span>
          </div>
          <MoneySplit total={500000} released={440000} returned={60000} large animateKey="home" />
          <div className="mv-foot mono">
            <span>capture 4400.00 → COMPLETED</span>
            <span>void 600.00 → VOIDED</span>
          </div>
        </Card>
      </section>

      <footer className="foot">
        <div>
          <strong className="serif">Proven</strong>
          <span className="muted"> · payment follows proof</span>
        </div>
        <div className="muted small">
          Built for the PayPal AI Hackathon · Sandbox environment · MIT licensed
        </div>
      </footer>
    </main>
  );
}
