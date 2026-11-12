import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Agreement, Evidence, Party, Verdict } from "./types.ts";
import { store, newId, logEvent, uploadsDir } from "./store.ts";
import { draftAgreement, adjudicate } from "./ai.ts";
import { centsToUsd } from "./money.ts";
import {
  captureAuthorization,
  voidAuthorization,
  getAuthorization,
  createAuthorizeOrder,
  authorizeOrder,
} from "./paypal.ts";

export const CURRENCY = "USD";
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/**
 * A failure the caller caused, with a status code. Distinct from a bug.
 * The error middleware turns this into a clean JSON response, so both the
 * browser routes and the agent routes report failures the same way.
 */
export class DomainError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, status = 400, code = "DOMAIN_ERROR", details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Stored evidence keeps a server-side path; it must never leave the process. */
export type PublicAgreement = Omit<Agreement, "evidence"> & {
  evidence: Array<Omit<Evidence, "path">>;
};

export function publicAgreement(a: Agreement): PublicAgreement {
  return {
    ...a,
    evidence: a.evidence.map(({ path: _path, ...rest }) => rest),
  };
}

/* ------------------------------- agreement ------------------------------ */

export async function buildAgreement(input: {
  prose: string;
  buyerName: string;
  sellerName: string;
  totalCents: number;
}): Promise<Agreement> {
  if (input.totalCents < 100) throw new DomainError("Amount must be at least $1.00", 400, "AMOUNT_TOO_SMALL");

  const draft = await draftAgreement(input.prose, input.buyerName, input.sellerName, input.totalCents);

  const now = new Date().toISOString();
  const agreement: Agreement = {
    id: newId("deal"),
    title: draft.title,
    prose: input.prose,
    buyerName: input.buyerName,
    sellerName: input.sellerName,
    currency: CURRENCY,
    totalCents: input.totalCents,
    status: "DRAFT",
    clauses: draft.clauses,
    approvals: { buyer: false, seller: false },
    evidence: [],
    verdict: null,
    settlement: null,
    paypal: {
      orderId: null,
      orderStatus: null,
      authorizationId: null,
      authorizationStatus: null,
      authorizationExpiresAt: null,
      captureId: null,
    },
    draftModel: draft.model,
    createdAt: now,
    updatedAt: now,
    events: [],
  };

  logEvent(agreement, "AGREEMENT_DRAFTED", "ai", `Drafted ${draft.clauses.length} clauses with ${draft.model}`);
  return store.create(agreement);
}

/* -------------------------------- approval ------------------------------ */

export function approveAgreement(a: Agreement, party: Party): Agreement {
  if (a.status !== "DRAFT") {
    throw new DomainError(`Cannot approve in status ${a.status}`, 409, "BAD_STATUS");
  }
  if (a.approvals[party]) {
    throw new DomainError(`${party} has already accepted`, 409, "ALREADY_APPROVED");
  }

  a.approvals[party] = true;
  logEvent(a, "CLAUSE_APPROVED", party, `${party === "buyer" ? a.buyerName : a.sellerName} accepted the agreement`);

  if (a.approvals.buyer && a.approvals.seller) {
    a.status = "AGREED";
    logEvent(a, "AGREEMENT_EXECUTED", "system", "Both parties accepted — ready to fund");
  }

  return a;
}

/**
 * Any evidence change invalidates the verdict, so the status must fall back to
 * EVIDENCE. Otherwise the UI would show "Verdict ready" with no verdict.
 */
export function invalidateVerdict(a: Agreement, reason: string): void {  if (!a.verdict && a.status !== "ADJUDICATED") return;

  const hadVerdict = Boolean(a.verdict);
  a.verdict = null;
  if (a.status === "ADJUDICATED") a.status = "EVIDENCE";
  if (hadVerdict) logEvent(a, "VERDICT_INVALIDATED", "system", reason);
}

/* -------------------------------- evidence ------------------------------ */

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

export const ACCEPTED_MIME = Object.keys(MIME_EXT);

/**
 * Single ingestion path for both surfaces: the browser posts multipart (multer
 * gives us a Buffer) and the agent posts JSON with base64. Either way the file
 * is written once, hashed once, and bound to a clause.
 */
export function addEvidence(
  a: Agreement,
  input: {
    clauseId: string;
    originalName: string;
    mime: string;
    buffer: Buffer;
    note?: string;
  },
): Evidence {
  if (a.status === "SETTLED") {
    throw new DomainError("Cannot add evidence after settlement", 409, "ALREADY_SETTLED");
  }

  const clause = a.clauses.find((c) => c.id === input.clauseId);
  if (!clause) {
    throw new DomainError(
      `clauseId must be one of: ${a.clauses.map((c) => c.id).join(", ")}`,
      400,
      "BAD_CLAUSE",
      { clauseIds: a.clauses.map((c) => c.id) },
    );
  }

  const mime = input.mime.toLowerCase().split(";")[0].trim();
  if (!MIME_EXT[mime]) {
    throw new DomainError(
      `Unsupported file type "${mime}". Accepted: ${ACCEPTED_MIME.join(", ")}`,
      415,
      "UNSUPPORTED_MIME",
      { accepted: ACCEPTED_MIME },
    );
  }

  if (!input.buffer.byteLength) throw new DomainError("Empty file", 400, "EMPTY_FILE");
  if (input.buffer.byteLength > MAX_EVIDENCE_BYTES) {
    throw new DomainError("Evidence must be 8MB or smaller", 413, "FILE_TOO_LARGE");
  }

  const filename = `${newId("ev")}${MIME_EXT[mime]}`;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, filename), input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");

  const evidence: Evidence = {
    id: newId("ev"),
    clauseId: input.clauseId,
    filename,
    originalName: (input.originalName || filename).slice(0, 160),
    mime,
    size: input.buffer.byteLength,
    sha256,
    note: (input.note || "").slice(0, 240),
    url: `/uploads/${filename}`,
    path: path.join(uploadsDir, filename),
    createdAt: new Date().toISOString(),
  };

  a.evidence.push(evidence);
  invalidateVerdict(a, "New evidence uploaded — adjudication must be re-run");
  if (a.status === "FUNDED") a.status = "EVIDENCE";

  logEvent(
    a,
    "EVIDENCE_UPLOADED",
    "seller",
    `${evidence.originalName} → ${clause.title} (sha256 ${sha256.slice(0, 12)}…)`,
  );

  return evidence;
}

export function removeEvidence(a: Agreement, evidenceId: string): Evidence {
  if (a.status === "SETTLED") {
    throw new DomainError("Cannot modify evidence after settlement", 409, "ALREADY_SETTLED");
  }

  const evidence = a.evidence.find((e) => e.id === evidenceId);
  if (!evidence) throw new DomainError("Evidence not found", 404, "EVIDENCE_NOT_FOUND");

  a.evidence = a.evidence.filter((e) => e.id !== evidence.id);
  invalidateVerdict(a, "Evidence removed — adjudication must be re-run");
  logEvent(a, "EVIDENCE_REMOVED", "seller", evidence.originalName);

  fs.unlink(evidence.path, () => {});
  return evidence;
}

/* --------------------------------- money -------------------------------- */

export async function createHold(a: Agreement) {
  if (a.status !== "AGREED") {
    throw new DomainError(`Cannot fund in status ${a.status} — both parties must accept first`, 409, "NOT_AGREED");
  }

  const order = await createAuthorizeOrder({
    totalCents: a.totalCents,
    currency: a.currency,
    description: a.title,
    customId: a.id,
  });

  a.paypal.orderId = order.id;
  a.paypal.orderStatus = order.status;
  logEvent(a, "PAYPAL_ORDER_CREATED", "paypal", `Order ${order.id} created with intent=AUTHORIZE`);

  return order;
}

export async function authorizeHold(a: Agreement, orderId: string) {
  const result = await authorizeOrder(orderId);

  if (!result.authorizationId) {
    throw new DomainError(
      "PayPal did not return an authorization. Did the buyer approve the order?",
      409,
      "NO_AUTHORIZATION",
    );
  }

  a.paypal.orderStatus = result.orderStatus;
  a.paypal.authorizationId = result.authorizationId;
  a.paypal.authorizationStatus = result.authorizationStatus;
  a.paypal.authorizationExpiresAt = result.expiresAt;
  a.status = "FUNDED";

  logEvent(
    a,
    "PAYPAL_AUTHORIZED",
    "paypal",
    `Authorization ${result.authorizationId} ${result.authorizationStatus} — $${centsToUsd(a.totalCents)} held`,
  );

  return result;
}

export async function runAdjudication(a: Agreement): Promise<Verdict> {
  if (!["FUNDED", "EVIDENCE", "AGREED"].includes(a.status)) {
    throw new DomainError(`Cannot adjudicate in status ${a.status}`, 409, "BAD_STATUS");
  }
  if (!a.evidence.length) {
    throw new DomainError("Upload at least one piece of evidence first", 409, "NO_EVIDENCE");
  }

  const verdict = await adjudicate(a, a.evidence);
  a.verdict = verdict;
  a.status = "ADJUDICATED";

  logEvent(
    a,
    "ADJUDICATED",
    "ai",
    `${verdict.model} — release $${centsToUsd(verdict.releaseCents)}, return $${centsToUsd(verdict.voidedCents)}, confidence ${verdict.overallConfidence}`,
  );

  return verdict;
}

/**
 * Capture the adjudicated amount and void the remainder.
 * Idempotent: the same PayPal-Request-Id makes a retry return the first capture
 * rather than charging twice.
 */
export async function settleAgreement(a: Agreement, reviewAcknowledged: boolean): Promise<Agreement> {
  if (a.status === "SETTLED" && a.settlement) return a;

  if (a.status !== "ADJUDICATED" || !a.verdict) {
    throw new DomainError("Nothing to settle — run adjudication first", 409, "NOT_ADJUDICATED");
  }
  if (!a.paypal.authorizationId) {
    throw new DomainError("No PayPal authorization on this agreement", 409, "NO_AUTHORIZATION");
  }
  if (a.verdict.needsHumanReview && !reviewAcknowledged) {
    throw new DomainError(
      "Confidence is below the auto-settlement floor. A human must review and acknowledge.",
      409,
      "REVIEW_REQUIRED",
      { overallConfidence: a.verdict.overallConfidence },
    );
  }

  const { releaseCents, voidedCents } = a.verdict;
  const idempotencyKey = `settle-${a.id}`;

  let captureId = "";
  let captureStatus = "NOT_CAPTURED";

  if (releaseCents > 0) {
    const capture = await captureAuthorization(a.paypal.authorizationId, releaseCents, a.currency, idempotencyKey);
    captureId = capture.id;
    captureStatus = capture.status;
    a.paypal.captureId = captureId;
    logEvent(
      a,
      "PAYPAL_CAPTURED",
      "paypal",
      `Partial capture $${centsToUsd(releaseCents)} → ${captureStatus} (${captureId})`,
    );
  }

  let voidedAt: string | null = null;
  let authStatus = "PARTIALLY_CAPTURED";

  if (voidedCents > 0) {
    const voided = await voidAuthorization(a.paypal.authorizationId);
    authStatus = voided.status;
    voidedAt = new Date().toISOString();
    logEvent(
      a,
      "PAYPAL_VOIDED",
      "paypal",
      `Remainder $${centsToUsd(voidedCents)} voided → authorization ${voided.status}`,
    );
  } else {
    const auth = await getAuthorization(a.paypal.authorizationId);
    authStatus = auth.status;
  }

  a.paypal.authorizationStatus = authStatus;
  a.settlement = {
    captureId,
    captureStatus,
    capturedCents: releaseCents,
    voidedCents,
    voidedAt,
    authorizationStatus: authStatus,
    settledAt: new Date().toISOString(),
    idempotencyKey,
  };
  a.status = "SETTLED";

  logEvent(a, "SETTLED", "system", `Settled $${centsToUsd(releaseCents)} of $${centsToUsd(a.totalCents)}`);
  return a;
}

/* ------------------------------ agent hints ----------------------------- */

export interface NextAction {
  action: string;
  method: "GET" | "POST" | "DELETE";
  endpoint: string;
  note: string;
}

/**
 * What an autonomous caller should do next. This is the difference between an
 * API that happens to be RESTful and one an agent can actually drive.
 */
export function nextActions(a: Agreement): NextAction[] {
  const base = `/api/agent/agreements/${a.id}`;

  switch (a.status) {
    case "DRAFT":
      return [
        {
          action: "approve",
          method: "POST",
          endpoint: `${base}/approve`,
          note: `body {"party":"buyer"} then {"party":"seller"} — both must accept before funding`,
        },
      ];
    case "AGREED":
      return [
        {
          action: "create_paypal_order",
          method: "POST",
          endpoint: `${base}/paypal/order`,
          note: "returns approveUrl; the buyer must approve it in a browser, then call paypal/authorize",
        },
      ];
    case "FUNDED":
    case "EVIDENCE": {
      const missing = a.clauses.filter((c) => !a.evidence.some((e) => e.clauseId === c.id)).map((c) => c.id);
      const actions: NextAction[] = [
        {
          action: "submit_evidence",
          method: "POST",
          endpoint: `${base}/evidence`,
          note: `base64 JSON: {clauseId, filename, mime, dataBase64}. Clauses with no evidence: ${missing.join(", ") || "none"}`,
        },
      ];
      if (a.evidence.length) {
        actions.push({
          action: "adjudicate",
          method: "POST",
          endpoint: `${base}/adjudicate`,
          note: "runs the clause-by-clause verdict; money is computed server-side",
        });
      }
      return actions;
    }
    case "ADJUDICATED":
      return [
        {
          action: "settle",
          method: "POST",
          endpoint: `${base}/settle`,
          note: a.verdict?.needsHumanReview
            ? `human review required (confidence ${a.verdict.overallConfidence}) — body {"reviewAcknowledged":true} after a human checks the evidence`
            : `captures $${centsToUsd(a.verdict?.releaseCents ?? 0)} and voids $${centsToUsd(a.verdict?.voidedCents ?? 0)}`,
        },
      ];
    default:
      return [];
  }
}
