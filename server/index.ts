import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";

import { store, newId, logEvent, uploadsDir } from "./store.ts";
import { draftAgreement, adjudicate, aiConfigured, aiModels } from "./ai.ts";
import {
  PayPalError,
  paypalConfigured,
  paypalMode,
  createAuthorizeOrder,
  authorizeOrder,
  captureAuthorization,
  voidAuthorization,
  getAuthorization,
} from "./paypal.ts";
import { centsToUsd, usdToCents } from "./money.ts";
import type { Agreement, Party } from "./types.ts";

const PORT = Number(process.env.PORT || 8787);
const CURRENCY = "USD";

fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ------------------------------- uploads ------------------------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, "");
      cb(null, `${newId("ev")}${ext || ""}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|text\/plain)$/i.test(file.mimetype);
    cb(null, ok);
  },
});

/* -------------------------------- helpers ------------------------------ */

function getAgreement(id: string): Agreement | null {
  return store.get(id) ?? null;
}

function requireAgreement(id: string, res: express.Response): Agreement | null {
  const a = getAgreement(id);
  if (!a) {
    res.status(404).json({ error: "Agreement not found" });
    return null;
  }
  return a;
}

/**
 * Any change to the evidence invalidates the verdict, so the status must fall
 * back to EVIDENCE. Otherwise the UI would show "Verdict ready" with no verdict.
 */
function invalidateVerdict(a: Agreement, reason: string): void {
  if (!a.verdict && a.status !== "ADJUDICATED") return;

  const hadVerdict = Boolean(a.verdict);
  a.verdict = null;
  if (a.status === "ADJUDICATED") a.status = "EVIDENCE";
  if (hadVerdict) logEvent(a, "VERDICT_INVALIDATED", "system", reason);
}

/* -------------------------------- routes ------------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    paypalConfigured: paypalConfigured(),
    paypalMode: paypalMode(),
    aiConfigured,
    models: aiModels,
    currency: CURRENCY,
    clientId: process.env.PAYPAL_CLIENT_ID || null,
  });
});

app.get("/api/agreements", (_req, res) => {
  res.json({
    agreements: store.list().map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      totalCents: a.totalCents,
      buyerName: a.buyerName,
      sellerName: a.sellerName,
      createdAt: a.createdAt,
    })),
  });
});

const CreateBody = z.object({
  prose: z.string().min(12).max(4000),
  buyerName: z.string().min(1).max(80).default("Dev Malhotra"),
  sellerName: z.string().min(1).max(80).default("Marisol Vega"),
  totalUsd: z.coerce.number().positive().max(1_000_000).default(5000),
});

app.post("/api/agreements", async (req, res, next) => {
  try {
    const body = CreateBody.parse(req.body);
    const totalCents = usdToCents(body.totalUsd);
    if (totalCents < 100) throw new Error("Amount must be at least $1.00");

    const draft = await draftAgreement(body.prose, body.buyerName, body.sellerName, totalCents);

    const now = new Date().toISOString();
    const agreement: Agreement = {
      id: newId("deal"),
      title: draft.title,
      prose: body.prose,
      buyerName: body.buyerName,
      sellerName: body.sellerName,
      currency: CURRENCY,
      totalCents,
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
    store.create(agreement);
    res.status(201).json({ agreement });
  } catch (err) {
    next(err);
  }
});

app.get("/api/agreements/:id", (req, res) => {
  const a = requireAgreement(req.params.id, res);
  if (!a) return;
  res.json({ agreement: a });
});

app.post("/api/agreements/:id/approve", (req, res) => {
  const a = requireAgreement(req.params.id, res);
  if (!a) return;

  const party = String(req.body?.party || "") as Party;
  if (party !== "buyer" && party !== "seller") {
    res.status(400).json({ error: "party must be 'buyer' or 'seller'" });
    return;
  }
  if (a.status !== "DRAFT") {
    res.status(409).json({ error: `Cannot approve in status ${a.status}` });
    return;
  }

  a.approvals[party] = true;
  logEvent(a, "CLAUSE_APPROVED", party, `${party === "buyer" ? a.buyerName : a.sellerName} accepted the agreement`);

  if (a.approvals.buyer && a.approvals.seller) {
    a.status = "AGREED";
    logEvent(a, "AGREEMENT_EXECUTED", "system", "Both parties accepted — ready to fund");
  }

  store.put(a);
  res.json({ agreement: a });
});

app.post("/api/paypal/create-order", async (req, res, next) => {
  try {
    const a = requireAgreement(String(req.body?.agreementId || ""), res);
    if (!a) return;
    if (a.status !== "AGREED" && a.status !== "DRAFT") {
      res.status(409).json({ error: `Cannot fund in status ${a.status}` });
      return;
    }
    if (!a.approvals.buyer || !a.approvals.seller) {
      res.status(409).json({ error: "Both parties must approve before funding" });
      return;
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
    store.put(a);

    res.json({ orderId: order.id, approveUrl: order.approveUrl, status: order.status });
  } catch (err) {
    next(err);
  }
});

app.post("/api/paypal/authorize", async (req, res, next) => {
  try {
    const a = requireAgreement(String(req.body?.agreementId || ""), res);
    if (!a) return;

    const orderId = String(req.body?.orderId || a.paypal.orderId || "");
    if (!orderId) {
      res.status(400).json({ error: "Missing orderId" });
      return;
    }

    const result = await authorizeOrder(orderId);

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
    store.put(a);

    res.json({ agreement: a, authorization: result });
  } catch (err) {
    next(err);
  }
});

app.post("/api/agreements/:id/evidence", upload.single("file"), (req, res) => {
  const a = requireAgreement(req.params.id, res);
  if (!a) return;

  if (a.status === "SETTLED") {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(409).json({ error: "Cannot add evidence after settlement" });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded (jpeg, png, webp, pdf, or txt; max 8MB)" });
    return;
  }

  const clauseId = String(req.body?.clauseId || "");
  const clause = a.clauses.find((c) => c.id === clauseId);
  if (!clause) {
    fs.unlink(file.path, () => {});
    res.status(400).json({ error: "clauseId must reference an existing clause" });
    return;
  }

  const buffer = fs.readFileSync(file.path);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  const evidenceId = newId("ev");
  a.evidence.push({
    id: evidenceId,
    clauseId,
    filename: file.filename,
    originalName: file.originalname,
    mime: file.mimetype,
    size: file.size,
    sha256,
    note: String(req.body?.note || "").slice(0, 240),
    url: `/uploads/${file.filename}`,
    path: file.path,
    createdAt: new Date().toISOString(),
  });

  // New evidence invalidates a previous verdict.
  invalidateVerdict(a, "New evidence uploaded — adjudication must be re-run");

  if (a.status === "FUNDED") a.status = "EVIDENCE";
  logEvent(a, "EVIDENCE_UPLOADED", "seller", `${file.originalname} → ${clause.title} (sha256 ${sha256.slice(0, 12)}…)`);
  store.put(a);

  res.status(201).json({ agreement: a });
});

app.delete("/api/agreements/:id/evidence/:evidenceId", (req, res) => {
  const a = requireAgreement(req.params.id, res);
  if (!a) return;
  if (a.status === "SETTLED") {
    res.status(409).json({ error: "Cannot modify evidence after settlement" });
    return;
  }

  const ev = a.evidence.find((e) => e.id === req.params.evidenceId);
  if (!ev) {
    res.status(404).json({ error: "Evidence not found" });
    return;
  }

  a.evidence = a.evidence.filter((e) => e.id !== ev.id);
  invalidateVerdict(a, "Evidence removed — adjudication must be re-run");
  fs.unlink(ev.path, () => {});
  logEvent(a, "EVIDENCE_REMOVED", "seller", ev.originalName);
  store.put(a);
  res.json({ agreement: a });
});

app.post("/api/agreements/:id/adjudicate", async (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    if (!["FUNDED", "EVIDENCE", "AGREED"].includes(a.status)) {
      res.status(409).json({ error: `Cannot adjudicate in status ${a.status}` });
      return;
    }
    if (!a.evidence.length) {
      res.status(409).json({ error: "Upload at least one piece of evidence first" });
      return;
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
    store.put(a);

    res.json({ agreement: a });
  } catch (err) {
    next(err);
  }
});

app.post("/api/agreements/:id/settle", async (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    if (a.status === "SETTLED" && a.settlement) {
      res.json({ agreement: a, idempotent: true });
      return;
    }
    if (a.status !== "ADJUDICATED" || !a.verdict) {
      res.status(409).json({ error: "Nothing to settle — run adjudication first" });
      return;
    }
    if (!a.paypal.authorizationId) {
      res.status(409).json({ error: "No PayPal authorization on this agreement" });
      return;
    }
    if (a.verdict.needsHumanReview && !req.body?.reviewAcknowledged) {
      res.status(409).json({
        error: "REVIEW_REQUIRED",
        message: "Confidence is below the auto-settlement floor. A human must review and acknowledge.",
        overallConfidence: a.verdict.overallConfidence,
      });
      return;
    }

    const { releaseCents, voidedCents } = a.verdict;
    const idempotencyKey = `settle-${a.id}`;

    let captureId = "";
    let captureStatus = "NOT_CAPTURED";

    if (releaseCents > 0) {
      const capture = await captureAuthorization(
        a.paypal.authorizationId,
        releaseCents,
        a.currency,
        idempotencyKey,
      );
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
    store.put(a);

    res.json({ agreement: a });
  } catch (err) {
    next(err);
  }
});

/** Webhook receiver. Signature verification is listed as a post-hackathon item in the README. */
app.post("/api/paypal/webhook", (req, res) => {
  const eventType = req.body?.event_type || "unknown";
  console.log(`[paypal webhook] ${eventType}`);
  res.status(200).json({ received: true });
});

/* ------------------------------- static -------------------------------- */

app.use("/uploads", express.static(uploadsDir, { maxAge: "1h" }));

const distDir = path.join(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

/* -------------------------------- errors ------------------------------- */

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof PayPalError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message,
      issue: err.issue,
      debugId: err.debugId,
      source: "paypal",
    });
    return;
  }

  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ error: err?.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n  Proven API   http://localhost:${PORT}`);
  console.log(`  PayPal       ${paypalConfigured() ? paypalMode() : "NOT CONFIGURED"}`);
  console.log(`  AI           ${aiConfigured ? `${aiModels.text} / ${aiModels.vision ?? "no vision"}` : "offline fallback"}\n`);
});
