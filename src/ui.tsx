import React from "react";
import type { AgreementStatus, ClauseStatus } from "./types";

export function money(cents: number, currency = "USD"): string {
  const showCents = cents % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function clock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function day(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function short(id: string | null | undefined, n = 10): string {
  if (!id) return "—";
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

type Tone = "neutral" | "mint" | "amber" | "red" | "violet";

export function Pill({
  tone = "neutral",
  children,
  dot = true,
}: {
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot && <i className="pill-dot" />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<AgreementStatus, Tone> = {
  DRAFT: "neutral",
  AGREED: "violet",
  FUNDED: "mint",
  EVIDENCE: "amber",
  ADJUDICATED: "violet",
  SETTLED: "mint",
};

const STATUS_LABEL: Record<AgreementStatus, string> = {
  DRAFT: "Draft",
  AGREED: "Agreed",
  FUNDED: "Funds held",
  EVIDENCE: "Evidence in",
  ADJUDICATED: "Verdict ready",
  SETTLED: "Settled",
};

export function StatusPill({ status }: { status: AgreementStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

const CLAUSE_TONE: Record<ClauseStatus, Tone> = {
  pass: "mint",
  partial: "amber",
  fail: "red",
  missing: "red",
};

const CLAUSE_LABEL: Record<ClauseStatus, string> = {
  pass: "Verified",
  partial: "Partial",
  fail: "Failed",
  missing: "Missing",
};

export function ClausePill({ status }: { status: ClauseStatus }) {
  return (
    <Pill tone={CLAUSE_TONE[status]} dot={false}>
      {CLAUSE_LABEL[status]}
    </Pill>
  );
}

export function MoneySplit({
  total,
  released,
  returned,
  large = false,
  animateKey,
}: {
  total: number;
  released: number;
  returned: number;
  large?: boolean;
  animateKey?: string;
}) {
  const relPct = total > 0 ? Math.max(0, Math.min(100, (released / total) * 100)) : 0;
  return (
    <div className={`split-wrap ${large ? "split-lg" : ""}`}>
      <div className="split-bar" key={animateKey}>
        <div className="split-rel" style={{ width: `${relPct}%` }} />
        <div className="split-ret" style={{ width: `${100 - relPct}%` }} />
      </div>
      <div className="split-legend">
        <div className="split-legend-item">
          <i className="dot dot-mint" />
          <span>Released to seller</span>
          <strong className="mono">{money(released)}</strong>
        </div>
        <div className="split-legend-item">
          <i className="dot dot-stripe" />
          <span>Returned to buyer</span>
          <strong className="mono">{money(returned)}</strong>
        </div>
      </div>
    </div>
  );
}

export function Confidence({ value }: { value: number }) {
  const tone = value >= 0.85 ? "mint" : value >= 0.6 ? "amber" : "red";
  return (
    <span className={`conf conf-${tone}`} title={`Confidence ${pct(value)}`}>
      <span className="conf-track">
        <span className="conf-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono conf-num">{pct(value)}</span>
    </span>
  );
}

export function Card({
  children,
  className = "",
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section";
}) {
  const Tag = as as any;
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function SectionLabel({ children, step }: { children: React.ReactNode; step?: string }) {
  return (
    <div className="section-label">
      {step && <span className="step-chip mono">{step}</span>}
      <span>{children}</span>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "money" | "quiet" | "danger";
}) {
  return (
    <button className={`btn btn-${variant} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Dots({ label }: { label?: string }) {
  return (
    <span className="dots">
      <i />
      <i />
      <i />
      {label && <em>{label}</em>}
    </span>
  );
}

export function Notice({
  tone = "amber",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      {title && <strong className="notice-title">{title}</strong>}
      <div className="notice-body">{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </label>
  );
}

export function Mono({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`mono ${className}`}>{children}</span>;
}
