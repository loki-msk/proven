import type { Clause, ClauseVerdict, Verdict } from "./types.ts";

/**
 * Money is ALWAYS computed here, never by the model.
 * The model may only propose a fraction (0..1) per clause and a confidence.
 */

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function normalizeWeights(clauses: Clause[]): number[] {
  const raw = clauses.map((c) => (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0));
  const total = raw.reduce((a, b) => a + b, 0);
  if (total <= 0) return clauses.map(() => 1 / Math.max(1, clauses.length));
  return raw.map((w) => w / total);
}

/**
 * release = Σ (normalized_weight_i × proposed_fraction_i) × total
 * Rounded to the nearest cent. The remainder is voided.
 */
export function computeSettlement(
  clauses: Clause[],
  verdicts: ClauseVerdict[],
  totalCents: number,
): { releaseCents: number; voidedCents: number } {
  const weights = normalizeWeights(clauses);
  let fraction = 0;

  clauses.forEach((clause, i) => {
    const v = verdicts.find((x) => x.clauseId === clause.id);
    const f = v ? clamp01(v.proposedFraction) : 0;
    fraction += weights[i] * f;
  });

  const releaseCents = Math.round(Math.min(1, Math.max(0, fraction)) * totalCents);
  return { releaseCents, voidedCents: totalCents - releaseCents };
}

export function centsToUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function usdToCents(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid amount");
  return Math.round(n * 100);
}

export function overallConfidence(verdicts: ClauseVerdict[]): number {
  if (!verdicts.length) return 0;
  const sum = verdicts.reduce((acc, v) => acc + clamp01(v.confidence), 0);
  return Number((sum / verdicts.length).toFixed(3));
}

export function needsReview(verdicts: ClauseVerdict[], overall: number): boolean {
  return overall < 0.75 || verdicts.some((v) => clamp01(v.confidence) < 0.6);
}

export function summarize(verdict: Verdict): string {
  const released = (verdict.releaseCents / 100).toFixed(2);
  const voided = (verdict.voidedCents / 100).toFixed(2);
  return `Released $${released} · Returned $${voided}`;
}
