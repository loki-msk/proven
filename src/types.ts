export type Party = "buyer" | "seller";

export type AgreementStatus =
  | "DRAFT"
  | "AGREED"
  | "FUNDED"
  | "EVIDENCE"
  | "ADJUDICATED"
  | "SETTLED";

export type ClauseStatus = "pass" | "partial" | "fail" | "missing";

export interface Clause {
  id: string;
  title: string;
  requirement: string;
  evidenceRequired: string[];
  weight: number;
}

export interface Evidence {
  id: string;
  clauseId: string;
  filename: string;
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
  note: string;
  url: string;
  createdAt: string;
}

export interface ClauseVerdict {
  clauseId: string;
  status: ClauseStatus;
  confidence: number;
  citedEvidence: string[];
  explanation: string;
  proposedFraction: number;
}

export interface Verdict {
  model: string;
  clauses: ClauseVerdict[];
  overallConfidence: number;
  summaryForBuyer: string;
  summaryForSeller: string;
  needsHumanReview: boolean;
  releaseCents: number;
  voidedCents: number;
  createdAt: string;
}

export interface Settlement {
  captureId: string;
  captureStatus: string;
  capturedCents: number;
  voidedCents: number;
  voidedAt: string | null;
  authorizationStatus: string;
  settledAt: string;
  idempotencyKey: string;
}

export interface LedgerEvent {
  id: string;
  type: string;
  actor: string;
  detail: string;
  createdAt: string;
}

export interface Agreement {
  id: string;
  title: string;
  prose: string;
  buyerName: string;
  sellerName: string;
  currency: string;
  totalCents: number;
  status: AgreementStatus;
  clauses: Clause[];
  approvals: { buyer: boolean; seller: boolean };
  evidence: Evidence[];
  verdict: Verdict | null;
  settlement: Settlement | null;
  paypal: {
    orderId: string | null;
    orderStatus: string | null;
    authorizationId: string | null;
    authorizationStatus: string | null;
    authorizationExpiresAt: string | null;
    captureId: string | null;
  };
  draftModel: string;
  createdAt: string;
  updatedAt: string;
  events: LedgerEvent[];
}

export interface Health {
  ok: boolean;
  paypalConfigured: boolean;
  paypalMode: string;
  aiConfigured: boolean;
  models: { text: string; vision: string | null };
  currency: string;
  clientId: string | null;
}
