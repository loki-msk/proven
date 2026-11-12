import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { api, ApiError } from "../api";
import type { Agreement, Clause, ClauseVerdict, Evidence, Health } from "../types";
import {
  Button,
  Card,
  ClausePill,
  Confidence,
  Dots,
  Field,
  Mono,
  MoneySplit,
  Notice,
  SectionLabel,
  StatusPill,
  clock,
  day,
  money,
  pct,
  short,
} from "../ui";

export default function Deal({
  id,
  health,
  onBack,
  onNew,
}: {
  id: string;
  health: Health | null;
  onBack: () => void;
  onNew: () => void;
}) {
  const [a, setA] = useState<Agreement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reviewAck, setReviewAck] = useState(false);

  const load = useCallback(async () => {
    try {
      const { agreement } = await api.getAgreement(id);
      setA(agreement);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<{ agreement: Agreement }>) => {
      setBusy(key);
      setError(null);
      try {
        const { agreement } = await fn();
        setA(agreement);
      } catch (err) {
        const e = err as ApiError;
        const extra = [e.issue, e.debugId ? `debug ${e.debugId}` : null].filter(Boolean).join(" · ");
        setError(extra && extra !== e.message ? `${e.message} (${extra})` : e.message);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (!a) {
    return (
      <main className="deal-shell">
        <div className="loading-card">
          <Dots label={error ? "Could not load" : "Opening the deal room"} />
          {error && <Notice tone="red">{error}</Notice>}
          <Button variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        </div>
      </main>
    );
  }

  const s = a.status;
  const isDraft = s === "DRAFT";
  const isAgreed = s === "AGREED";
  const isFunded = ["FUNDED", "EVIDENCE", "ADJUDICATED", "SETTLED"].includes(s);
  const canProve = ["FUNDED", "EVIDENCE", "ADJUDICATED"].includes(s);
  const hasVerdict = Boolean(a.verdict);
  const isSettled = s === "SETTLED";
  // Status is not proof of a hold: adjudication is allowed before funding, so an
  // ADJUDICATED deal can have no authorization at all. Only PayPal's own
  // authorization id means money is actually reserved.
  const moneyIsHeld = Boolean(a.paypal.authorizationId) && !isSettled;

  const evidenceFor = (clauseId: string) => a.evidence.filter((e) => e.clauseId === clauseId);
  const missingClauses = a.clauses.filter((c) => evidenceFor(c.id).length === 0);
  const fallbackAI = a.draftModel === "heuristic-fallback" || a.verdict?.model === "heuristic-fallback";

  const daysLeft = a.paypal.authorizationExpiresAt
    ? Math.max(
        0,
        Math.ceil((new Date(a.paypal.authorizationExpiresAt).getTime() - Date.now()) / 86_400_000),
      )
    : null;

  return (
    <main className="deal-shell">
      <div className="deal-top">
        <button className="back" onClick={onBack}>
          ← All deals
        </button>
        <div className="deal-title">
          <h1 className="serif">{a.title}</h1>
          <div className="deal-meta">
            <StatusPill status={a.status} />
            <span className="muted small">
              {a.buyerName} <span className="faint">→</span> {a.sellerName}
            </span>
            <span className="faint small">·</span>
            <span className="mono small">{a.id}</span>
          </div>
        </div>
        <div className="deal-amount">
          <span className="muted small">Contract</span>
          <strong className="mono">{money(a.totalCents, a.currency)}</strong>
        </div>
      </div>

      <Stepper status={a.status} />

      {fallbackAI && (
        <Notice tone="amber" title="Offline fallback mode">
          No AI key is configured, so clause drafting and adjudication are running on a deterministic
          template. This is labelled everywhere and is <em>not</em> presented as model output. Set{" "}
          <code>AI_API_KEY</code> to enable real reasoning.
        </Notice>
      )}

      {error && (
        <Notice tone="red" title="Something went wrong">
          <div className="row-between">
            <span>{error}</span>
            <button className="linkish" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        </Notice>
      )}

      <div className="deal-grid">
        <div className="deal-main">
          {/* ---------------------------- ACT 1 ---------------------------- */}
          <Card className="panel">
            <SectionLabel step="01">Agree</SectionLabel>

            <div className="panel-head">
              <h2>The definition of done</h2>
              <span className="muted small">
                {a.clauses.length} clauses · drafted by <Mono>{a.draftModel}</Mono>
              </span>
            </div>

            <blockquote className="prose-quote">{a.prose}</blockquote>

            <div className="clause-list">
              {a.clauses.map((c, i) => (
                <ClauseRow
                  key={c.id}
                  clause={c}
                  index={i}
                  evidenceCount={evidenceFor(c.id).length}
                  verdict={a.verdict?.clauses.find((v) => v.clauseId === c.id)}
                  showVerdict={Boolean(a.verdict)}
                />
              ))}
            </div>

            {isDraft && (
              <div className="approve-row">
                <ApproveTile
                  who="Buyer"
                  name={a.buyerName}
                  approved={a.approvals.buyer}
                  disabled={Boolean(busy) || a.approvals.buyer}
                  onApprove={() => run("buyer", () => api.approve(a.id, "buyer"))}
                />
                <ApproveTile
                  who="Seller"
                  name={a.sellerName}
                  approved={a.approvals.seller}
                  disabled={Boolean(busy) || a.approvals.seller}
                  onApprove={() => run("seller", () => api.approve(a.id, "seller"))}
                />
              </div>
            )}

            {!isDraft && (
              <div className="agreed-strip">
                <span className="tick-circle">✓</span>
                Both parties accepted these clauses
                {a.verdict && (
                  <span className="muted small">
                    {" "}
                    · verified against evidence on {day(a.verdict.createdAt)}
                  </span>
                )}
              </div>
            )}
          </Card>

          {/* ---------------------------- FUND ---------------------------- */}
          {(isDraft || isAgreed) && (
            <Card className={`panel ${isAgreed ? "panel-focus" : "panel-locked"}`}>
              <SectionLabel step="02">Fund the hold</SectionLabel>

              {!isAgreed && (
                <div className="locked-body">
                  <p className="muted">
                    Both parties need to accept the clauses first. Then the buyer funds a PayPal
                    authorization — a hold, not a charge.
                  </p>
                </div>
              )}

              {isAgreed && (
                <>
                  <div className="fund-head">
                    <div>
                      <h2>Reserve {money(a.totalCents, a.currency)}</h2>
                      <p className="muted">
                        PayPal places a hold on the buyer's funding source. Nothing is captured until
                        the evidence is adjudicated and the buyer approves. The hold lasts up to 29
                        days.
                      </p>
                    </div>
                    <div className="hold-badge">
                      <span className="muted small">Hold</span>
                      <strong className="mono">{money(a.totalCents, a.currency)}</strong>
                      <span className="pill pill-mint">
                        <i className="pill-dot" /> intent: AUTHORIZE
                      </span>
                    </div>
                  </div>

                  {!health?.clientId ? (
                    <Notice tone="amber" title="PayPal is not configured">
                      Set <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> in{" "}
                      <code>.env</code>, restart, then reload. Use the sandbox credentials from{" "}
                      <a href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">
                        the developer dashboard
                      </a>
                      .
                    </Notice>
                  ) : (
                    <div className="paypal-slot">
                      <PayPalScriptProvider
                        options={
                          {
                            clientId: health.clientId,
                            currency: "USD",
                            intent: "authorize",
                            components: "buttons",
                          } as any
                        }
                      >
                        <PayPalButtons
                          style={{
                            layout: "horizontal",
                            color: "black",
                            shape: "pill",
                            label: "paypal",
                            height: 46,
                            tagline: false,
                          }}
                          forceReRender={[a.id]}
                          createOrder={async () => {
                            const r = await api.createOrder(a.id);
                            return r.orderId;
                          }}
                          onApprove={async (data) => {
                            if (!data.orderID) return;
                            await run("authorize", () => api.authorizeOrder(a.id, data.orderID!));
                          }}
                          onError={(err) => {
                            setError(
                              `PayPal error: ${(err as any)?.message || "could not complete the flow"}`,
                            );
                          }}
                        />
                      </PayPalScriptProvider>
                      <p className="micro">
                        Sandbox checkout. Sign in with a PayPal sandbox personal account, not your real
                        one.
                      </p>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {/* ---------------------------- PROVE ---------------------------- */}
          {isFunded && !isSettled && (
            <Card className="panel">
              <SectionLabel step="02">Prove</SectionLabel>
              <div className="panel-head">
                <h2>Evidence</h2>
                <span className="muted small">
                  {a.evidence.length} file{a.evidence.length === 1 ? "" : "s"} ·{" "}
                  {missingClauses.length === 0 ? (
                    <span className="mint">all clauses covered</span>
                  ) : (
                    <span className="amber">{missingClauses.length} clauses without evidence</span>
                  )}
                </span>
              </div>

              {canProve && (
                <EvidenceUploader
                  clauses={a.clauses}
                  busy={busy === "upload"}
                  onUpload={async (file, clauseId, note) => {
                    await run("upload", () => api.uploadEvidence(a.id, file, clauseId, note));
                  }}
                />
              )}

              {a.evidence.length > 0 && (
                <div className="evidence-grid">
                  {a.evidence.map((ev) => (
                    <EvidenceTile
                      key={ev.id}
                      evidence={ev}
                      clause={a.clauses.find((c) => c.id === ev.clauseId)}
                      onDelete={
                        canProve
                          ? () => run("del-" + ev.id, () => api.deleteEvidence(a.id, ev.id))
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}

              <div className="adjudicate-row">
                <div>
                  <strong>Run adjudication</strong>
                  <p className="muted small">
                    The model reviews every clause against the evidence. Missing items score zero — it
                    cannot invent proof. Low confidence routes to human review.
                  </p>
                </div>
                <Button
                  variant="money"
                  disabled={Boolean(busy) || a.evidence.length === 0}
                  onClick={() => run("adjudicate", () => api.adjudicate(a.id))}
                >
                  {busy === "adjudicate" ? <Dots label="Reading evidence" /> : "Adjudicate →"}
                </Button>
              </div>
            </Card>
          )}

          {/* ---------------------------- VERDICT ---------------------------- */}
          {hasVerdict && a.verdict && !isSettled && (
            <Card className="panel panel-focus">
              <SectionLabel step="03">Settle</SectionLabel>
              <div className="panel-head">
                <h2>The verdict</h2>
                <span className="muted small">
                  <Mono>{a.verdict.model}</Mono> · overall confidence{" "}
                  <strong>{pct(a.verdict.overallConfidence)}</strong>
                </span>
              </div>

              <div className="summary-pair">
                <div className="summary-card">
                  <span className="muted small">For {a.buyerName}</span>
                  <p>{a.verdict.summaryForBuyer}</p>
                </div>
                <div className="summary-card">
                  <span className="muted small">For {a.sellerName}</span>
                  <p>{a.verdict.summaryForSeller}</p>
                </div>
              </div>

              <div className="verdict-list">
                {a.clauses.map((c) => (
                  <VerdictRow
                    key={c.id}
                    clause={c}
                    verdict={a.verdict!.clauses.find((v) => v.clauseId === c.id)}
                  />
                ))}
              </div>

              <div className="settlement-preview">
                <div className="sp-head">
                  <span className="muted small">Proposed settlement</span>
                  <strong className="serif sp-title">
                    {pct(a.verdict.releaseCents / a.totalCents)} of the contract earned
                  </strong>
                </div>
                <MoneySplit
                  total={a.totalCents}
                  released={a.verdict.releaseCents}
                  returned={a.verdict.voidedCents}
                  large
                  animateKey={a.verdict.createdAt}
                />
                <div className="sp-math mono">
                  capture {money(a.verdict.releaseCents, a.currency)} · void{" "}
                  {money(a.verdict.voidedCents, a.currency)}
                </div>
              </div>

              {a.verdict.needsHumanReview && (
                <Notice tone="amber" title="Human review required">
                  Confidence is below the auto-settlement floor. Read the flagged clauses and confirm
                  that you have reviewed the evidence before any money moves.
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={reviewAck}
                      onChange={(e) => setReviewAck(e.target.checked)}
                    />
                    I reviewed the evidence and the flagged clauses
                  </label>
                </Notice>
              )}

              {!confirming ? (
                <div className="settle-row">
                  <div>
                    <strong>Approve and settle</strong>
                    <p className="muted small">
                      This captures {money(a.verdict.releaseCents)} and voids{" "}
                      {money(a.verdict.voidedCents)} against authorization{" "}
                      <Mono>{short(a.paypal.authorizationId)}</Mono>.
                    </p>
                  </div>
                  <Button
                    variant="money"
                    disabled={
                      Boolean(busy) || (a.verdict.needsHumanReview && !reviewAck) || !a.paypal.authorizationId
                    }
                    onClick={() => setConfirming(true)}
                  >
                    Approve &amp; settle →
                  </Button>
                </div>
              ) : (
                <div className="confirm-box">
                  <span className="muted small">Confirm — this moves money</span>
                  <div className="confirm-amounts">
                    <div>
                      <span>Capture</span>
                      <strong className="mono">{money(a.verdict.releaseCents)}</strong>
                    </div>
                    <div>
                      <span>Void</span>
                      <strong className="mono">{money(a.verdict.voidedCents)}</strong>
                    </div>
                  </div>
                  <div className="confirm-actions">
                    <Button variant="quiet" onClick={() => setConfirming(false)} disabled={Boolean(busy)}>
                      Cancel
                    </Button>
                    <Button
                      variant="money"
                      disabled={Boolean(busy)}
                      onClick={() => run("settle", () => api.settle(a.id, reviewAck))}
                    >
                      {busy === "settle" ? <Dots label="Settling with PayPal" /> : "Confirm settlement"}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ---------------------------- RECEIPT ---------------------------- */}
          {isSettled && a.settlement && (
            <Card className="panel receipt-panel">
              <div className="stamp">SETTLED</div>
              <SectionLabel step="03">Settlement receipt</SectionLabel>

              <div className="receipt-head">
                <div>
                  <span className="muted small">Released to {a.sellerName}</span>
                  <h2 className="receipt-amount mono">{money(a.settlement.capturedCents, a.currency)}</h2>
                </div>
                <div className="receipt-side">
                  <span className="muted small">Returned to {a.buyerName}</span>
                  <strong className="mono">{money(a.settlement.voidedCents, a.currency)}</strong>
                  <span className="muted small">in {settlementDuration(a)}</span>
                </div>
              </div>

              <MoneySplit
                total={a.totalCents}
                released={a.settlement.capturedCents}
                returned={a.settlement.voidedCents}
                large
                animateKey={a.settlement.settledAt}
              />

              <dl className="kv">
                <div>
                  <dt>Order</dt>
                  <dd className="mono">{a.paypal.orderId}</dd>
                </div>
                <div>
                  <dt>Authorization</dt>
                  <dd className="mono">{a.paypal.authorizationId}</dd>
                </div>
                <div>
                  <dt>Capture</dt>
                  <dd className="mono">
                    {a.settlement.captureId ? (
                      <>
                        {a.settlement.captureId}{" "}
                        <span className="mint">· {a.settlement.captureStatus}</span>
                      </>
                    ) : (
                      <span className="muted">no capture — full amount voided</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Void</dt>
                  <dd className="mono">
                    {a.settlement.voidedCents > 0 ? (
                      <>
                        {money(a.settlement.voidedCents)}{" "}
                        <span className="mint">· VOIDED</span>
                      </>
                    ) : (
                      <span className="muted">no remainder — full amount captured</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Authorization status</dt>
                  <dd className="mono">{a.settlement.authorizationStatus}</dd>
                </div>
                <div>
                  <dt>Idempotency key</dt>
                  <dd className="mono">{a.settlement.idempotencyKey}</dd>
                </div>
              </dl>

              <p className="verified mono">
                verified server-side · GET /v2/payments/authorizations/
                {a.paypal.authorizationId} → {a.settlement.authorizationStatus}
              </p>

              <div className="receipt-actions">
                <Button variant="ghost" onClick={() => window.print()}>
                  Print receipt
                </Button>
                <Button variant="primary" onClick={onNew}>
                  Start another agreement →
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* ------------------------------ RAIL ------------------------------ */}
        <aside className="deal-rail">
          <Card className="rail-card">
            <span className="muted small">Money</span>
            <div className="rail-money">
              <div>
                <span>Held</span>
                <strong className="mono">{moneyIsHeld ? money(a.totalCents) : "—"}</strong>
              </div>
              <div>
                <span>Released</span>
                <strong className="mono mint">{a.settlement ? money(a.settlement.capturedCents) : "—"}</strong>
              </div>
              <div>
                <span>Returned</span>
                <strong className="mono amber">{a.settlement ? money(a.settlement.voidedCents) : "—"}</strong>
              </div>
            </div>
            {daysLeft !== null && !isSettled && (
              <p className="micro">Authorization expires in {daysLeft} day{daysLeft === 1 ? "" : "s"}</p>
            )}
            {isSettled && <p className="micro">Settled {day(a.settlement!.settledAt)}</p>}
          </Card>

          <Card className="rail-card">
            <span className="muted small">PayPal</span>
            <dl className="kv kv-tight">
              <div>
                <dt>Mode</dt>
                <dd className="mono">{health?.paypalMode ?? "sandbox"}</dd>
              </div>
              <div>
                <dt>Order</dt>
                <dd className="mono">{short(a.paypal.orderId, 12)}</dd>
              </div>
              <div>
                <dt>Auth</dt>
                <dd className="mono">
                  {short(a.paypal.authorizationId, 12)}
                  {a.paypal.authorizationStatus && (
                    <span className="muted"> · {a.paypal.authorizationStatus}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Capture</dt>
                <dd className="mono">{short(a.paypal.captureId, 12)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="rail-card">
            <div className="row-between">
              <span className="muted small">Ledger</span>
              <span className="muted small mono">{a.events.length}</span>
            </div>
            <ol className="ledger">
              {[...a.events].reverse().map((e) => (
                <li key={e.id}>
                  <span className={`led-dot led-${toneFor(e.type)}`} />
                  <div>
                    <span className="led-type mono">{e.type.toLowerCase().replace(/_/g, " ")}</span>
                    <p>{e.detail}</p>
                    <span className="led-meta mono">
                      {clock(e.createdAt)} · {e.actor}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </main>
  );
}

/* ------------------------------ sub-views ------------------------------ */

function ApproveTile({
  who,
  name,
  approved,
  disabled,
  onApprove,
}: {
  who: string;
  name: string;
  approved: boolean;
  disabled: boolean;
  onApprove: () => void;
}) {
  return (
    <div className={`approve-tile ${approved ? "accepted" : ""}`}>
      <div>
        <span className="muted small">{who}</span>
        <strong>{name}</strong>
      </div>
      {approved ? (
        <span className="tick-badge" aria-label="Accepted">
          ✓
        </span>
      ) : (
        <Button variant="ghost" onClick={onApprove} disabled={disabled}>
          Accept
        </Button>
      )}
    </div>
  );
}

function Stepper({ status }: { status: Agreement["status"] }) {
  const order = ["DRAFT", "AGREED", "FUNDED", "EVIDENCE", "ADJUDICATED", "SETTLED"];
  const idx = order.indexOf(status);
  const steps = [
    { label: "Agree", at: 0 },
    { label: "Fund", at: 2 },
    { label: "Prove", at: 3 },
    { label: "Settle", at: 4 },
  ];
  return (
    <div className="stepper">
      {steps.map((st, i) => {
        const done = idx >= st.at;
        const active = i === steps.filter((x) => idx >= x.at).length - 1;
        return (
          <div key={st.label} className={`stepper-item ${done ? "done" : ""} ${active ? "active" : ""}`}>
            <span className="stepper-dot">{done ? "✓" : i + 1}</span>
            <span>{st.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ClauseRow({
  clause,
  index,
  evidenceCount,
  verdict,
  showVerdict,
}: {
  clause: Clause;
  index: number;
  evidenceCount: number;
  verdict?: ClauseVerdict;
  showVerdict: boolean;
}) {
  return (
    <div className="clause">
      <div className="clause-top">
        <span className="clause-num mono">{String(index + 1).padStart(2, "0")}</span>
        <div className="clause-body">
          <div className="clause-title">
            <h4>{clause.title}</h4>
            {showVerdict && verdict && <ClausePill status={verdict.status} />}
          </div>
          <p>{clause.requirement}</p>
          <div className="chips">
            {clause.evidenceRequired.map((e) => (
              <span key={e} className="chip">
                {e}
              </span>
            ))}
          </div>
        </div>
        <div className="clause-side">
          <span className="mono weight">{pct(clause.weight)}</span>
          <span className={`ev-count ${evidenceCount ? "has" : "none"}`}>
            {evidenceCount ? `${evidenceCount} file${evidenceCount > 1 ? "s" : ""}` : "no evidence"}
          </span>
        </div>
      </div>
      {verdict && (
        <div className="clause-verdict">
          <Confidence value={verdict.confidence} />
          <span className="explain">{verdict.explanation}</span>
          {verdict.citedEvidence.length > 0 && (
            <span className="cited mono">cited: {verdict.citedEvidence.join(", ")}</span>
          )}
        </div>
      )}
    </div>
  );
}

function VerdictRow({ clause, verdict }: { clause: Clause; verdict?: ClauseVerdict }) {
  if (!verdict) return null;
  return (
    <div className={`verdict verdict-${verdict.status}`}>
      <div className="verdict-top">
        <div className="verdict-left">
          <ClausePill status={verdict.status} />
          <strong>{clause.title}</strong>
        </div>
        <div className="verdict-right">
          <span className="muted small">weight {pct(clause.weight)}</span>
          <span className="mono">{pct(verdict.proposedFraction)} earned</span>
        </div>
      </div>
      <p className="verdict-explain">{verdict.explanation}</p>
      <div className="verdict-foot">
        <Confidence value={verdict.confidence} />
        {verdict.citedEvidence.length > 0 ? (
          <span className="cited mono">{verdict.citedEvidence.join(" · ")}</span>
        ) : (
          <span className="cited muted mono">no evidence cited</span>
        )}
      </div>
    </div>
  );
}

function EvidenceUploader({
  clauses,
  busy,
  onUpload,
}: {
  clauses: Clause[];
  busy: boolean;
  onUpload: (file: File, clauseId: string, note: string) => Promise<void>;
}) {
  const [clauseId, setClauseId] = useState(clauses[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="uploader">
      <div className="uploader-fields">
        <Field label="Attach to clause">
          <select className="input" value={clauseId} onChange={(e) => setClauseId(e.target.value)}>
            {clauses.map((c, i) => (
              <option key={c.id} value={c.id}>
                {i + 1}. {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" hint="optional">
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. finished 14 Nov, grout cured 24h"
          />
        </Field>
      </div>

      <div className="uploader-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf,text/plain"
          hidden
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="button" className="filepick" onClick={() => inputRef.current?.click()}>
          {file ? file.name : "Choose photo or receipt"}
        </button>
        <Button
          variant="ghost"
          disabled={!file || busy}
          onClick={async () => {
            if (!file) return;
            await onUpload(file, clauseId, note);
            setFile(null);
            setNote("");
            if (inputRef.current) inputRef.current.value = "";
          }}
        >
          {busy ? <Dots label="Uploading" /> : "Upload evidence"}
        </Button>
      </div>
    </div>
  );
}

function EvidenceTile({
  evidence,
  clause,
  onDelete,
}: {
  evidence: Evidence;
  clause?: Clause;
  onDelete?: () => void;
}) {
  const isImage = evidence.mime.startsWith("image/");
  return (
    <figure className="ev">
      <div className="ev-thumb">
        {isImage ? (
          <img src={evidence.url} alt={evidence.originalName} />
        ) : (
          <span className="ev-file mono">{evidence.mime.includes("pdf") ? "PDF" : "TXT"}</span>
        )}
      </div>
      <figcaption>
        <span className="ev-name" title={evidence.originalName}>
          {evidence.originalName}
        </span>
        <span className="ev-clause">{clause ? clause.title : evidence.clauseId}</span>
        <span className="ev-hash mono">sha256 {evidence.sha256.slice(0, 10)}…</span>
      </figcaption>
      {onDelete && (
        <button className="ev-del" onClick={onDelete} aria-label="Remove evidence">
          ×
        </button>
      )}
    </figure>
  );
}

function settlementDuration(a: Agreement): string {
  if (!a.settlement) return "";
  const start = new Date(a.createdAt).getTime();
  const end = new Date(a.settlement.settledAt).getTime();
  const mins = Math.max(1, Math.round((end - start) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.round(mins / 60)}h`;
}

function toneFor(type: string): string {
  if (type.includes("PAYPAL")) return "mint";
  if (type.includes("ADJUDICAT")) return "violet";
  if (type.includes("EVIDENCE")) return "amber";
  if (type.includes("SETTLED")) return "mint";
  return "neutral";
}
