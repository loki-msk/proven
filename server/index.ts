import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

import { store, uploadsDir } from "./store.ts";
import { aiConfigured, aiModels } from "./ai.ts";
import { PayPalError, paypalConfigured, paypalMode } from "./paypal.ts";
import { usdToCents } from "./money.ts";
import {
  ACCEPTED_MIME,
  CURRENCY,
  DomainError,
  addEvidence,
  approveAgreement,
  authorizeHold,
  buildAgreement,
  createHold,
  publicAgreement,
  removeEvidence,
  runAdjudication,
  settleAgreement,
} from "./service.ts";
import { createAgentRouter } from "./agent.ts";
import type { Agreement } from "./types.ts";

const PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.use(cors());
// Evidence can arrive as base64 JSON from an agent, so the limit is generous.
app.use(express.json({ limit: "12mb" }));
// Pretty JSON: every curl in the demo is read by a human (and on camera).
app.set("json spaces", 2);

/* ------------------------------- uploads ------------------------------- */

// Memory storage: server/service.ts owns writing evidence to disk for both the
// multipart (browser) and base64 (agent) paths, so there is exactly one
// ingestion implementation and no orphaned temp files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ACCEPTED_MIME.includes(file.mimetype.toLowerCase()));
  },
});

/* -------------------------------- helpers ------------------------------ */

function requireAgreement(id: string, res: express.Response): Agreement | null {
  const a = store.get(id);
  if (!a) {
    res.status(404).json({ error: "Agreement not found", code: "AGREEMENT_NOT_FOUND" });
    return null;
  }
  return a;
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
    // The client ID is public by design; the secret never leaves the server.
    clientId: process.env.PAYPAL_CLIENT_ID || null,
    agentApi: { enabled: true, auth: process.env.AGENT_API_KEY ? "bearer" : "none" },
  });
});

/**
 * The agent API's contract. Served from the repo rather than generated, because
 * the spec is a deliverable in its own right: APIMatic turns it into SDKs and
 * context plugins, and a judge can paste it straight into Postman.
 */
app.get("/api/openapi.json", (_req, res) => {
  const spec = path.join(process.cwd(), "docs", "openapi.json");
  if (!fs.existsSync(spec)) {
    res.status(404).json({ error: "OpenAPI spec not found", code: "SPEC_MISSING" });
    return;
  }
  res.type("application/json").sendFile(spec);
});

app.get("/api/agreements", (_req, res) => {
  res.json({
    agreements: store.list().map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      currency: a.currency,
      totalCents: a.totalCents,
      buyerName: a.buyerName,
      sellerName: a.sellerName,
      clauseCount: a.clauses.length,
      releasedCents: a.settlement?.capturedCents ?? a.verdict?.releaseCents ?? 0,
      returnedCents: a.settlement?.voidedCents ?? a.verdict?.voidedCents ?? 0,
      authorizationId: a.paypal.authorizationId ?? null,
      confidence: a.verdict?.overallConfidence ?? null,
      draftModel: a.draftModel,
      createdAt: a.createdAt,
      settledAt: a.settlement?.settledAt ?? null,
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
    const agreement = await buildAgreement({
      prose: body.prose,
      buyerName: body.buyerName,
      sellerName: body.sellerName,
      totalCents: usdToCents(body.totalUsd),
    });
    res.status(201).json({ agreement: publicAgreement(agreement) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/agreements/:id", (req, res) => {
  const a = requireAgreement(req.params.id, res);
  if (!a) return;
  res.json({ agreement: publicAgreement(a) });
});

app.post("/api/agreements/:id/approve", (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    const party = String(req.body?.party || "");
    if (party !== "buyer" && party !== "seller") {
      res.status(400).json({ error: "party must be 'buyer' or 'seller'" });
      return;
    }

    approveAgreement(a, party);
    store.put(a);
    res.json({ agreement: publicAgreement(a) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/paypal/create-order", async (req, res, next) => {
  try {
    const a = requireAgreement(String(req.body?.agreementId || ""), res);
    if (!a) return;

    const order = await createHold(a);
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

    const result = await authorizeHold(a, orderId);
    store.put(a);
    res.json({ agreement: publicAgreement(a), authorization: result });
  } catch (err) {
    next(err);
  }
});

app.post("/api/agreements/:id/evidence", upload.single("file"), (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: "No file uploaded",
        code: "NO_FILE",
        accepted: ACCEPTED_MIME,
        maxBytes: 8 * 1024 * 1024,
      });
      return;
    }

    addEvidence(a, {
      clauseId: String(req.body?.clauseId || ""),
      originalName: file.originalname,
      mime: file.mimetype,
      buffer: file.buffer,
      note: String(req.body?.note || ""),
    });

    store.put(a);
    res.status(201).json({ agreement: publicAgreement(a) });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/agreements/:id/evidence/:evidenceId", (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    removeEvidence(a, req.params.evidenceId);
    store.put(a);
    res.json({ agreement: publicAgreement(a) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/agreements/:id/adjudicate", async (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    await runAdjudication(a);
    store.put(a);
    res.json({ agreement: publicAgreement(a) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/agreements/:id/settle", async (req, res, next) => {
  try {
    const a = requireAgreement(req.params.id, res);
    if (!a) return;

    const wasSettled = a.status === "SETTLED";
    await settleAgreement(a, Boolean(req.body?.reviewAcknowledged));
    store.put(a);
    res.json({ agreement: publicAgreement(a), idempotent: wasSettled });
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

/* ------------------------------ agent surface --------------------------- */

app.use("/api/agent", createAgentRouter());

/* ------------------------------- static -------------------------------- */

// An agent that mistypes a path should get JSON, not Express's HTML 404 page.
app.use("/api", (req, res) => {
  res.status(404).json({
    error: `No route for ${req.method} ${req.originalUrl}`,
    code: "NOT_FOUND",
    hint: "GET /api/agent/manifest lists the agent tools; GET /api/openapi.json is the full contract.",
  });
});

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
  if (err instanceof DomainError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.details || {}),
    });
    return;
  }

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
      code: "VALIDATION_ERROR",
      issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ error: err?.message || "Internal server error" });
});

app.listen(PORT, () => {
  const auth = process.env.AGENT_API_KEY ? "bearer token" : "open (sandbox demo)";
  console.log(`\n  Proven API   http://localhost:${PORT}`);
  console.log(`  Agent API    http://localhost:${PORT}/api/agent   auth: ${auth}`);
  console.log(`  Manifest     http://localhost:${PORT}/api/agent/manifest`);
  console.log(`  PayPal       ${paypalConfigured() ? paypalMode() : "NOT CONFIGURED"}`);
  console.log(`  AI           ${aiConfigured ? `${aiModels.text} / ${aiModels.vision ?? "no vision"}` : "offline fallback"}\n`);
});
