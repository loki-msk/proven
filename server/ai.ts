import fs from "node:fs";
import { z } from "zod";
import type { Agreement, Clause, ClauseVerdict, Evidence, Verdict } from "./types.ts";
import { computeSettlement, needsReview, overallConfidence, clamp01 } from "./money.ts";

/**
 * Provider-agnostic, OpenAI-compatible chat client.
 * Defaults target OpenCode Zen (https://opencode.ai/docs/zen/), but any
 * OpenAI-compatible endpoint works by changing AI_BASE_URL + AI_MODEL.
 */

const BASE = (process.env.AI_BASE_URL || "https://opencode.ai/inference/openai/v1").replace(/\/$/, "");
const KEY = (process.env.AI_API_KEY || "").trim();
const TEXT_MODEL = (process.env.AI_MODEL || "deepseek-v4.1-flash-free").trim();
const VISION_MODEL = (process.env.AI_VISION_MODEL || "").trim();
const JSON_MODE = process.env.AI_JSON_MODE !== "0";

export const aiConfigured = Boolean(KEY);
export const aiModels = { text: TEXT_MODEL, vision: VISION_MODEL || null };

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

type Content = string | Part[];

async function chat(model: string, system: string, content: Content, maxTokens = 1800): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  if (JSON_MODE) body.response_format = { type: "json_object" };

  const send = async (payload: Record<string, unknown>) =>
    fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  let res = await send(body);

  // Some gateways reject response_format. Retry once without it.
  if (res.status === 400 && JSON_MODE) {
    const clone = { ...body };
    delete clone.response_format;
    res = await send(clone);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Model request failed (${res.status}): ${text.slice(0, 400)}`);
  }

  const json: any = await res.json();
  const out = json?.choices?.[0]?.message?.content;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    return out.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  throw new Error("Model returned no content");
}

function parseJsonObject(text: string): any {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ------------------------------------------------------------------ */
/* Act 1 — draft machine-checkable clauses from plain language          */
/* ------------------------------------------------------------------ */

const DraftSchema = z.object({
  title: z.string().min(2).max(90),
  clauses: z
    .array(
      z.object({
        title: z.string().min(2).max(70),
        requirement: z.string().min(8).max(320),
        evidenceRequired: z.array(z.string().min(2).max(90)).min(1).max(4),
        weight: z.coerce.number().gt(0).lte(1),
      }),
    )
    .min(3)
    .max(7),
});

const DRAFT_SYSTEM = `You are a contracts engineer who turns vague job descriptions into short, checkable milestone agreements.

Rules:
- Produce 4 to 6 clauses. Each clause must be verifiable from photos, documents, or a short written statement.
- Every clause needs 1-3 CONCRETE evidence items (say exactly what to photograph or upload, e.g. "straight-on photo of the full wall", "materials receipt showing tile SKU").
- Requirements must be observable by a non-expert. No legal jargon. No "satisfactory quality" language.
- Weights must reflect the share of the total price the clause is worth. Weights must sum to exactly 1.0.
- Never invent facts about the job that were not stated. If something is unspecified, require evidence rather than assuming a value.
- Return JSON only, matching: {"title": string, "clauses": [{"title": string, "requirement": string, "evidenceRequired": string[], "weight": number}]}`;

export async function draftAgreement(
  prose: string,
  buyerName: string,
  sellerName: string,
  totalCents: number,
): Promise<{ title: string; clauses: Clause[]; model: string }> {
  if (!aiConfigured) return heuristicDraft(prose, totalCents);

  const user = `Buyer: ${buyerName}
Seller: ${sellerName}
Total price: $${(totalCents / 100).toFixed(2)} USD
Job description (verbatim, may be messy):
"""
${prose}
"""

Draft the agreement now.`;

  const raw = await chat(TEXT_MODEL, DRAFT_SYSTEM, user, 1600);
  const parsed = DraftSchema.parse(parseJsonObject(raw));

  const clauses: Clause[] = parsed.clauses.map((c, i) => ({
    id: `c${i + 1}`,
    title: c.title.trim(),
    requirement: c.requirement.trim(),
    evidenceRequired: c.evidenceRequired.map((e) => e.trim()).filter(Boolean).slice(0, 4),
    weight: clamp01(c.weight) || 1 / parsed.clauses.length,
  }));

  return { title: parsed.title.trim(), clauses, model: TEXT_MODEL };
}

/* ------------------------------------------------------------------ */
/* Act 2 — adjudicate evidence against those clauses                   */
/* ------------------------------------------------------------------ */

const VerdictSchema = z.object({
  clauses: z
    .array(
      z.object({
        clauseId: z.string(),
        status: z.enum(["pass", "partial", "fail", "missing"]),
        confidence: z.coerce.number(),
        citedEvidence: z.array(z.string()).default([]),
        explanation: z.string().default(""),
        proposedFraction: z.coerce.number(),
      }),
    )
    .default([]),
  summaryForBuyer: z.string().default(""),
  summaryForSeller: z.string().default(""),
  needsHumanReview: z.boolean().default(false),
});

const ADJUDICATE_SYSTEM = `You are an impartial settlement adjudicator. You decide how much of each clause was actually delivered, based ONLY on the evidence provided.

For every clause return:
- status: "pass" | "partial" | "fail" | "missing"
- confidence: 0..1 (your certainty in this judgment)
- citedEvidence: exact filenames from the evidence list that you relied on (empty if none)
- explanation: max 200 characters, neutral, readable by BOTH parties, reference what you saw
- proposedFraction: 0..1, the share of THIS clause that was delivered

Hard rules:
- If a clause has no evidence attached, status MUST be "missing" and proposedFraction MUST be 0.
- If required evidence is present but does not demonstrate the requirement, use "fail" or "partial" and say what is absent.
- Never invent evidence. Never reference files that are not in the list.
- No dollar amounts. Fractions only.
- Be conservative: when a photo is ambiguous, lower confidence rather than guessing.

Return JSON only:
{"clauses":[{"clauseId":string,"status":string,"confidence":number,"citedEvidence":string[],"explanation":string,"proposedFraction":number}],"summaryForBuyer":string,"summaryForSeller":string,"needsHumanReview":boolean}`;

function evidenceImages(agreement: Agreement): Part[] {
  if (!VISION_MODEL) return [];
  const parts: Part[] = [];
  const withImages = agreement.evidence.filter((e) => e.mime.startsWith("image/")).slice(0, 4);

  for (const ev of withImages) {
    try {
      const file = fs.readFileSync(ev.path);
      if (file.byteLength > 3.5 * 1024 * 1024) continue;
      parts.push({ type: "text", text: `Evidence file: ${ev.originalName} (clause ${ev.clauseId})` });
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${ev.mime};base64,${file.toString("base64")}`,
          detail: "high",
        },
      });
    } catch {
      /* skip unreadable file */
    }
  }
  return parts;
}

export async function adjudicate(
  agreement: Agreement,
  evidence: Evidence[],
): Promise<Verdict> {
  const model = VISION_MODEL && evidence.some((e) => e.mime.startsWith("image/")) ? VISION_MODEL : TEXT_MODEL;
  const canSee = Boolean(VISION_MODEL && evidence.some((e) => e.mime.startsWith("image/")));

  if (!aiConfigured) return heuristicAdjudicate(agreement, evidence);

  const clausePayload = agreement.clauses.map((c) => ({
    id: c.id,
    title: c.title,
    requirement: c.requirement,
    evidenceRequired: c.evidenceRequired,
    weight: c.weight,
  }));

  const evidencePayload = evidence.map((e) => ({
    filename: e.originalName,
    clauseId: e.clauseId,
    kind: e.mime,
    note: e.note || "",
  }));

  const header = `Agreement: ${agreement.title}
Buyer: ${agreement.buyerName}
Seller: ${agreement.sellerName}
Total: $${(agreement.totalCents / 100).toFixed(2)} ${agreement.currency}

CLAUSES:
${JSON.stringify(clausePayload, null, 2)}

EVIDENCE PROVIDED (${evidencePayload.length}):
${evidencePayload.length ? JSON.stringify(evidencePayload, null, 2) : "(none)"}

${canSee ? "Image contents are attached below." : "No images attached — judge from the evidence metadata only and lower confidence accordingly."}

Adjudicate every clause by id.`;

  const images = canSee ? evidenceImages(agreement) : [];
  const content: Content = images.length
    ? [{ type: "text", text: header }, ...images]
    : header;

  const raw = await chat(model, ADJUDICATE_SYSTEM, content, 2200);
  const parsed = VerdictSchema.parse(parseJsonObject(raw));

  // Normalize + apply deterministic safety rules.
  const verdicts: ClauseVerdict[] = agreement.clauses.map((clause) => {
    const found = parsed.clauses.find(
      (v) => v.clauseId === clause.id || v.clauseId === clause.title,
    );
    const hasEvidence = evidence.some((e) => e.clauseId === clause.id);

    if (!found) {
      return {
        clauseId: clause.id,
        status: "missing",
        confidence: 1,
        citedEvidence: [],
        explanation: "No verdict was returned for this clause. Treated as not evidenced.",
        proposedFraction: 0,
      };
    }

    let status = found.status;
    let fraction = clamp01(found.proposedFraction);

    // Deterministic guard: no evidence ⇒ cannot pass.
    if (!hasEvidence) {
      status = "missing";
      fraction = 0;
    }
    if (status === "missing" || status === "fail") fraction = 0;

    const cited = (found.citedEvidence || []).filter((name) =>
      evidence.some((e) => e.originalName === name || e.filename === name),
    );

    return {
      clauseId: clause.id,
      status,
      confidence: clamp01(found.confidence),
      citedEvidence: cited,
      explanation: (found.explanation || "").slice(0, 260),
      proposedFraction: fraction,
    };
  });

  const overall = overallConfidence(verdicts);
  const { releaseCents, voidedCents } = computeSettlement(
    agreement.clauses,
    verdicts,
    agreement.totalCents,
  );

  return {
    model,
    clauses: verdicts,
    overallConfidence: overall,
    summaryForBuyer: parsed.summaryForBuyer || defaultSummary(verdicts, "buyer"),
    summaryForSeller: parsed.summaryForSeller || defaultSummary(verdicts, "seller"),
    needsHumanReview: parsed.needsHumanReview || needsReview(verdicts, overall),
    releaseCents,
    voidedCents,
    createdAt: new Date().toISOString(),
  };
}

function defaultSummary(verdicts: ClauseVerdict[], who: "buyer" | "seller"): string {
  const missing = verdicts.filter((v) => v.status === "missing").length;
  const partial = verdicts.filter((v) => v.status === "partial").length;
  if (who === "buyer") {
    return `${verdicts.length - missing - partial} of ${verdicts.length} clauses fully evidenced${partial ? `, ${partial} partially` : ""}${missing ? `, ${missing} without evidence` : ""}.`;
  }
  return missing
    ? `${missing} clause${missing > 1 ? "s" : ""} still need evidence. Upload the missing items to unlock the full amount.`
    : "All required evidence is present. You can contest any clause before settlement.";
}

/* ------------------------------------------------------------------ */
/* Honest offline fallback (clearly labelled, never passed off as AI)  */
/* ------------------------------------------------------------------ */

const FALLBACK_TEMPLATE: Array<Omit<Clause, "id">> = [
  {
    title: "Preparation completed",
    requirement:
      "Site preparation and substrate/underlay work completed before the visible finish is installed, consistent with the agreed scope.",
    evidenceRequired: ["Photo of the prepared surface before the finish was installed", "Short note describing the preparation method"],
    weight: 0.2,
  },
  {
    title: "Primary work installed",
    requirement:
      "The main deliverable described in the agreement is installed or delivered as specified, with workmanship that is level, aligned and consistent.",
    evidenceRequired: ["Two wide photos of the completed work", "One straight-on photo showing alignment"],
    weight: 0.4,
  },
  {
    title: "Details and finishes",
    requirement:
      "Edges, cutouts, seams and fixtures are finished cleanly, sealed and centred where the scope requires it.",
    evidenceRequired: ["Close-up photo of cutouts, seams and edges"],
    weight: 0.2,
  },
  {
    title: "Site left clean",
    requirement: "Work area cleaned, debris removed, and the surrounding surfaces left undamaged.",
    evidenceRequired: ["Photo of the cleaned work area"],
    weight: 0.1,
  },
  {
    title: "Materials accounted for",
    requirement:
      "Materials used match the agreed specification and are supported by a receipt or supplier record.",
    evidenceRequired: ["Receipt or supplier record showing item and quantity"],
    weight: 0.1,
  },
];

function heuristicDraft(prose: string, totalCents: number) {
  const firstLine = prose.split(/[\n.!]/).map((s) => s.trim()).find(Boolean) || "Milestone agreement";
  return {
    title: firstLine.slice(0, 70),
    clauses: FALLBACK_TEMPLATE.map((c, i) => ({ ...c, id: `c${i + 1}` })),
    model: "heuristic-fallback",
  };
}

function heuristicAdjudicate(agreement: Agreement, evidence: Evidence[]): Verdict {
  const verdicts: ClauseVerdict[] = agreement.clauses.map((clause) => {
    const attached = evidence.filter((e) => e.clauseId === clause.id);
    if (!attached.length) {
      return {
        clauseId: clause.id,
        status: "missing",
        confidence: 0.99,
        citedEvidence: [],
        explanation: `No evidence attached for "${clause.title}". Required: ${clause.evidenceRequired.join("; ")}.`,
        proposedFraction: 0,
      };
    }
    return {
      clauseId: clause.id,
      status: "pass",
      confidence: 0.8,
      citedEvidence: attached.map((e) => e.originalName),
      explanation: `Evidence attached (${attached.map((e) => e.originalName).join(", ")}). Offline mode cannot judge quality.`,
      proposedFraction: 1,
    };
  });

  const overall = overallConfidence(verdicts);
  const { releaseCents, voidedCents } = computeSettlement(
    agreement.clauses,
    verdicts,
    agreement.totalCents,
  );

  return {
    model: "heuristic-fallback",
    clauses: verdicts,
    overallConfidence: overall,
    summaryForBuyer: defaultSummary(verdicts, "buyer"),
    summaryForSeller: defaultSummary(verdicts, "seller"),
    needsHumanReview: true,
    releaseCents,
    voidedCents,
    createdAt: new Date().toISOString(),
  };
}
