#!/usr/bin/env node
/**
 * AI smoke test — verify the model endpoint before you rely on it.
 *
 * Checks, in order:
 *   1. the endpoint answers at all
 *   2. JSON mode is honoured
 *   3. clause drafting produces schema-shaped output
 *   4. the vision model accepts an image part (skipped when AI_VISION_MODEL is blank)
 *
 * Usage: npm run ai:smoke
 */

import "dotenv/config";

const BASE = (process.env.AI_BASE_URL || "https://opencode.ai/inference/openai/v1").replace(/\/$/, "");
const KEY = (process.env.AI_API_KEY || "").trim();
const TEXT_MODEL = (process.env.AI_MODEL || "deepseek-v4.1-flash-free").trim();
const VISION_MODEL = (process.env.AI_VISION_MODEL || "").trim();
const JSON_MODE = process.env.AI_JSON_MODE !== "0";

if (!KEY) {
  console.error("\n  ✖ AI_API_KEY is not set. The app will run the labelled offline fallback.\n");
  process.exit(1);
}

// 1x1 transparent PNG — tiny enough to always pass a payload limit.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

async function chat(model, messages, { json = false, maxTokens = 900 } = {}) {
  const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
  if (json && JSON_MODE) body.response_format = { type: "json_object" };

  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - started;

  let json2 = null;
  try {
    json2 = JSON.parse(text);
  } catch {
    /* not json */
  }

  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " — free-tier models may be gated to OpenCode clients; use a paid model or your own provider key."
        : "";
    throw new Error(`HTTP ${res.status}${hint}\n${text.slice(0, 500)}`);
  }

  const content = json2?.choices?.[0]?.message?.content;
  return { content: typeof content === "string" ? content : JSON.stringify(content), ms, usage: json2?.usage };
}

function parseJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error(`not a JSON object: ${cleaned.slice(0, 160)}`);
  return JSON.parse(cleaned.slice(a, b + 1));
}

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log(`\n  AI smoke test · ${BASE}\n  text: ${TEXT_MODEL}   vision: ${VISION_MODEL || "(disabled)"}\n`);

  // 1 — reachability
  let r;
  try {
    r = await chat(TEXT_MODEL, [{ role: "user", content: "Reply with exactly: OK" }], { maxTokens: 16 });
    check("endpoint reachable", true, `${r.ms}ms`);
  } catch (err) {
    check("endpoint reachable", false, err.message);
    return;
  }

  // 2 — JSON mode
  try {
    const j = await chat(
      TEXT_MODEL,
      [
        { role: "system", content: 'Return JSON only: {"ok": true}' },
        { role: "user", content: "ping" },
      ],
      { json: true, maxTokens: 32 },
    );
    const parsed = parseJson(j.content);
    check("JSON mode", parsed.ok === true, `${j.ms}ms`);
  } catch (err) {
    check("JSON mode", false, `${err.message}  (try AI_JSON_MODE=0)`);
  }

  // 3 — drafting shape
  try {
    const j = await chat(
      TEXT_MODEL,
      [
        {
          role: "system",
          content:
            'Draft 4 clauses for a job. Return JSON only: {"title":string,"clauses":[{"title":string,"requirement":string,"evidenceRequired":string[],"weight":number}]}. Weights sum to 1.',
        },
        {
          role: "user",
          content:
            "Kitchen backsplash, $5,000, done by the 30th. Level, 3mm grout lines, outlet cutout centred and sealed, cleaned up, materials receipt required.",
        },
      ],
      { json: true, maxTokens: 1200 },
    );
    const parsed = parseJson(j.content);
    const clauses = Array.isArray(parsed.clauses) ? parsed.clauses : [];
    const shaped = clauses.every(
      (c) => c && typeof c.title === "string" && Array.isArray(c.evidenceRequired) && c.evidenceRequired.length >= 1,
    );
    check("drafting shape", clauses.length >= 3 && shaped, `${clauses.length} clauses, ${j.ms}ms`);
    const total = clauses.reduce((s, c) => s + Number(c.weight || 0), 0);
    check("weights plausible", total > 0, `sum=${total.toFixed(2)} (app renormalises anyway)`);
  } catch (err) {
    check("drafting shape", false, err.message);
  }

  // 4 — vision
  if (!VISION_MODEL) {
    console.log("  · vision skipped (AI_VISION_MODEL is blank)");
    return;
  }

  try {
    const v = await chat(
      VISION_MODEL,
      [
        {
          role: "user",
          content: [
            { type: "text", text: 'Describe this image in one short sentence. JSON only: {"seen": string}' },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } },
          ],
        },
      ],
      { json: true, maxTokens: 120 },
    );
    const parsed = parseJson(v.content);
    check("vision model", typeof parsed.seen === "string", `${v.ms}ms → ${parsed.seen.slice(0, 60)}`);
  } catch (err) {
    check("vision model", false, `${err.message}  (adjudication falls back to text+metadata)`);
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ✖ ${err?.message || err}\n`);
  process.exit(1);
});
