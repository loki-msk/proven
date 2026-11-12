import crypto from "node:crypto";
import express from "express";
import { z } from "zod";

import { store } from "./store.ts";
import { centsToUsd, usdToCents } from "./money.ts";
import {
  ACCEPTED_MIME,
  DomainError,
  addEvidence,
  approveAgreement,
  authorizeHold,
  buildAgreement,
  createHold,
  nextActions,
  publicAgreement,
  removeEvidence,
  runAdjudication,
  settleAgreement,
} from "./service.ts";
import type { Agreement, Party } from "./types.ts";

/**
 * The agent surface.
 *
 * Same domain layer as the browser UI (server/service.ts), different entry
 * point: JSON in, JSON out, base64 evidence instead of multipart, and every
 * response carries `nextActions` so an autonomous caller never has to guess
 * what the state machine expects next.
 */

const AGENT_KEY = (process.env.AGENT_API_KEY || "").trim();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Auth is opt-in: unset means the sandbox demo is open to judges. */
function guard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!AGENT_KEY) return next();

  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, AGENT_KEY)) {
    res.status(401).json({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
      hint: "Send Authorization: Bearer <AGENT_API_KEY>",
    });
    return;
  }
  next();
}

function load(id: string): Agreement {
  const a = store.get(id);
  if (!a) throw new DomainError(`No agreement with id ${id}`, 404, "AGREEMENT_NOT_FOUND");
  return a;
}

function state(a: Agreement) {
  return { agreement: publicAgreement(a), nextActions: nextActions(a) };
}

/* --------------------------------- inputs -------------------------------- */

const CreateBody = z.object({
  prose: z.string().min(12).max(4000),
  buyerName: z.string().min(1).max(80).default("Dev Malhotra"),
  sellerName: z.string().min(1).max(80).default("Marisol Vega"),
  totalUsd: z.coerce.number().positive().max(1_000_000).default(5000),
});

const ApproveBody = z.object({ party: z.enum(["buyer", "seller"]) });

const EvidenceBody = z.object({
  clauseId: z.string().min(1),
  filename: z.string().min(1).max(160),
  /** Either a bare base64 payload or a full `data:<mime>;base64,<payload>` URL. */
  dataBase64: z.string().min(4),
  mime: z.string().min(3).max(80).optional(),
  note: z.string().max(240).optional(),
});

const SettleBody = z.object({ reviewAcknowledged: z.boolean().default(false) }).default({});

function decodeDataUrl(input: { dataBase64: string; mime?: string; filename: string }) {
  let payload = input.dataBase64.trim();
  let mime = (input.mime || "").toLowerCase();

  if (payload.startsWith("data:")) {
    const comma = payload.indexOf(",");
    if (comma === -1) throw new DomainError("Malformed data URL", 400, "BAD_DATA_URL");
    const meta = payload.slice(5, comma);
    payload = payload.slice(comma + 1);
    if (!mime) mime = meta.split(";")[0].toLowerCase();
  }

  if (!mime) {
    const ext = input.filename.toLowerCase().split(".").pop() || "";
    const byExt: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
      pdf: "application/pdf",
      txt: "text/plain",
    };
    mime = byExt[ext] || "";
  }

  if (!ACCEPTED_MIME.includes(mime)) {
    throw new DomainError(
      `Could not determine a supported mime type. Send mime explicitly. Accepted: ${ACCEPTED_MIME.join(", ")}`,
      415,
      "UNSUPPORTED_MIME",
    );
  }

  const clean = payload.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new DomainError("dataBase64 is not valid base64", 400, "BAD_BASE64");
  }

  return { mime, buffer: Buffer.from(clean, "base64") };
}

/* --------------------------------- router -------------------------------- */

export function createAgentRouter(): express.Router {
  const router = express.Router();
  router.use(guard);

  const manifest = {
    name: "proven",
    version: "1.0.0",
    description:
      "Settlement for work, not shopping. Draft a clause-by-clause agreement from prose, verify evidence against it, then settle the fair percentage with a PayPal partial capture and void the remainder.",
    baseUrl: "/api/agent",
    protocol: "REST + JSON. MCP-style tool manifest; not an MCP server.",
    auth: AGENT_KEY
      ? { type: "bearer", header: "Authorization", scheme: "Bearer <AGENT_API_KEY>" }
      : { type: "none", note: "Sandbox demo. Set AGENT_API_KEY to require a bearer token." },
    money: {
      note: "The model proposes fractions in [0,1]. All amounts are computed server-side.",
      capture: "POST /v2/payments/authorizations/{id}/capture",
      void: "POST /v2/payments/authorizations/{id}/void",
    },
    conventions: {
      evidence: "JSON with base64, not multipart.",
      nextActions: "Every state-changing response includes an ordered nextActions array.",
      review: 'If nextActions mentions human review, settle requires {"reviewAcknowledged":true}.',
    },
    tools: [
      {
        name: "create_agreement",
        method: "POST",
        path: "/api/agent/agreements",
        description: "Turn a plain-language job into 4-6 checkable clauses. Returns status DRAFT.",
        input: {
          type: "object",
          required: ["prose"],
          properties: {
            prose: { type: "string", description: "The job, verbatim. Messy is fine." },
            buyerName: { type: "string" },
            sellerName: { type: "string" },
            totalUsd: { type: "number" },
          },
        },
      },
      {
        name: "get_agreement",
        method: "GET",
        path: "/api/agent/agreements/{id}",
        description: "Full state plus nextActions. Poll this instead of guessing.",
        input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
      {
        name: "list_agreements",
        method: "GET",
        path: "/api/agent/agreements",
        description: "All agreements with settlement totals.",
        input: { type: "object", properties: {} },
      },
      {
        name: "approve",
        method: "POST",
        path: "/api/agent/agreements/{id}/approve",
        description: "Record one party's acceptance. Both are required before funding.",
        input: {
          type: "object",
          required: ["id", "party"],
          properties: { id: { type: "string" }, party: { enum: ["buyer", "seller"] } },
        },
      },
      {
        name: "create_paypal_order",
        method: "POST",
        path: "/api/agent/agreements/{id}/paypal/order",
        description: "Create a PayPal order with intent=AUTHORIZE. Returns approveUrl.",
        input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
      {
        name: "authorize_paypal_order",
        method: "POST",
        path: "/api/agent/agreements/{id}/paypal/authorize",
        description: "After the buyer approves in a browser, convert the order into an authorization.",
        input: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, orderId: { type: "string" } },
        },
      },
      {
        name: "submit_evidence",
        method: "POST",
        path: "/api/agent/agreements/{id}/evidence",
        description: "Attach a photo, receipt, or note to a clause. Base64 JSON.",
        input: {
          type: "object",
          required: ["id", "clauseId", "filename", "dataBase64"],
          properties: {
            id: { type: "string" },
            clauseId: { type: "string" },
            filename: { type: "string" },
            dataBase64: { type: "string", description: "Bare base64 or data:<mime>;base64,<payload>" },
            mime: { type: "string" },
            note: { type: "string" },
          },
        },
      },
      {
        name: "adjudicate",
        method: "POST",
        path: "/api/agent/agreements/{id}/adjudicate",
        description: "Score every clause against the evidence. Returns release/void amounts.",
        input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
      {
        name: "settle",
        method: "POST",
        path: "/api/agent/agreements/{id}/settle",
        description: "Partial capture the adjudicated amount, then void the remainder.",
        input: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, reviewAcknowledged: { type: "boolean" } },
        },
      },
    ],
  };

  router.get("/", (_req, res) => res.json(manifest));
  router.get("/manifest", (_req, res) => res.json(manifest));

  router.get("/agreements", (_req, res) => {
    res.json({
      count: store.list().length,
      agreements: store.list().map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        currency: a.currency,
        totalCents: a.totalCents,
        totalUsd: centsToUsd(a.totalCents),
        releasedCents: a.settlement?.capturedCents ?? a.verdict?.releaseCents ?? 0,
        returnedCents: a.settlement?.voidedCents ?? a.verdict?.voidedCents ?? 0,
        authorizationId: a.paypal.authorizationId ?? null,
        clauseCount: a.clauses.length,
        confidence: a.verdict?.overallConfidence ?? null,
        createdAt: a.createdAt,
      })),
    });
  });

  router.post("/agreements", async (req, res, next) => {
    try {
      const body = CreateBody.parse(req.body);
      const a = await buildAgreement({
        prose: body.prose,
        buyerName: body.buyerName,
        sellerName: body.sellerName,
        totalCents: usdToCents(body.totalUsd),
      });
      res.status(201).json(state(a));
    } catch (err) {
      next(err);
    }
  });

  router.get("/agreements/:id", (req, res, next) => {
    try {
      res.json(state(load(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/approve", (req, res, next) => {
    try {
      const a = load(req.params.id);
      const { party } = ApproveBody.parse(req.body) as { party: Party };

      approveAgreement(a, party);
      store.put(a);
      res.json(state(a));
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/paypal/order", async (req, res, next) => {
    try {
      const a = load(req.params.id);
      const order = await createHold(a);
      store.put(a);
      res.json({ orderId: order.id, approveUrl: order.approveUrl, status: order.status, nextActions: nextActions(a) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/paypal/authorize", async (req, res, next) => {
    try {
      const a = load(req.params.id);
      const orderId = String(req.body?.orderId || a.paypal.orderId || "");
      if (!orderId) throw new DomainError("Missing orderId — create an order first", 400, "MISSING_ORDER_ID");

      await authorizeHold(a, orderId);
      store.put(a);
      res.json(state(a));
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/evidence", (req, res, next) => {
    try {
      const a = load(req.params.id);
      const body = EvidenceBody.parse(req.body);
      const { mime, buffer } = decodeDataUrl(body);

      const evidence = addEvidence(a, {
        clauseId: body.clauseId,
        originalName: body.filename,
        mime,
        buffer,
        note: body.note,
      });

      store.put(a);
      res.status(201).json({
        ...state(a),
        evidence: { id: evidence.id, clauseId: evidence.clauseId, sha256: evidence.sha256, bytes: evidence.size },
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/agreements/:id/evidence/:evidenceId", (req, res, next) => {
    try {
      const a = load(req.params.id);
      removeEvidence(a, req.params.evidenceId);
      store.put(a);
      res.json(state(a));
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/adjudicate", async (req, res, next) => {
    try {
      const a = load(req.params.id);
      const verdict = await runAdjudication(a);
      store.put(a);
      res.json({
        ...state(a),
        verdict: {
          model: verdict.model,
          overallConfidence: verdict.overallConfidence,
          needsHumanReview: verdict.needsHumanReview,
          releaseCents: verdict.releaseCents,
          voidedCents: verdict.voidedCents,
          releaseUsd: centsToUsd(verdict.releaseCents),
          voidedUsd: centsToUsd(verdict.voidedCents),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agreements/:id/settle", async (req, res, next) => {
    try {
      const a = load(req.params.id);
      const body = SettleBody.parse(req.body ?? {});

      await settleAgreement(a, body.reviewAcknowledged);
      store.put(a);
      res.json(state(a));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
