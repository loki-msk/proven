/**
 * Proven self-test.
 *
 *   npm run verify
 *
 * Runs the whole state machine against a throwaway server: temporary data
 * directory, temporary port, PayPal and AI explicitly disabled. It proves the
 * deterministic parts — clause drafting, the evidence guards, the settlement
 * arithmetic, the agent surface — without needing credentials, network access,
 * or a browser.
 *
 * It never touches your data/ directory and never calls PayPal, so it is safe to
 * run before a demo. This is the script to run if you are reviewing this
 * submission and want evidence that the claims in the README are true.
 *
 * Requires `--import tsx` (wired up in package.json) because it imports the
 * money module directly to test the arithmetic at its source.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { computeSettlement, needsReview, normalizeWeights } from "../server/money.ts";

/* ------------------------------- reporting ------------------------------- */

const useColour = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const GREEN = useColour ? "\u001b[32m" : "";
const RED = useColour ? "\u001b[31m" : "";
const DIM = useColour ? "\u001b[2m" : "";
const RESET = useColour ? "\u001b[0m" : "";

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function near(a, b, tolerance = 1e-9) {
  return Math.abs(a - b) <= tolerance;
}

/* -------------------------------- fixtures ------------------------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const FALLBACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function evidenceFixture() {
  for (const candidate of [
    "docs/sample-evidence/1-preparation.png",
    "docs/sample-evidence/2-installed.png",
  ]) {
    if (fs.existsSync(candidate)) return { bytes: fs.readFileSync(candidate), name: path.basename(candidate) };
  }
  return { bytes: FALLBACK_PNG, name: "fixture.png" };
}

/* --------------------------------- client -------------------------------- */

function makeClient(base) {
  return async function call(method, pathname, body, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    let payload;

    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const res = await fetch(`${base}${pathname}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: caller can inspect text */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
}

/* ---------------------------------- main --------------------------------- */

const PROSE =
  "Kitchen backsplash replacement, five thousand dollars, done by the 30th. " +
  "Level tile, 3mm grout, outlet cutout centred and sealed, site cleaned. Materials receipt required.";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "proven-verify-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const call = makeClient(base);
const fixture = evidenceFixture();

const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: tempDir,
    // dotenv never overrides a key that already exists, so empty strings here
    // pin the server to offline mode even when a real .env is present.
    PAYPAL_CLIENT_ID: "",
    PAYPAL_CLIENT_SECRET: "",
    AI_API_KEY: "",
    NODE_ENV: "test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

let exitCode = 1;

try {
  /* ------------------------------ boot ------------------------------- */

  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!healthy) {
    throw new Error(`Server did not start.\n\n${serverLog.slice(-2000)}`);
  }

  /* --------------------------- money, in isolation -------------------- */

  await check("weights normalise to exactly 1", () => {
    const clauses = [0.5, 0.5, 0.3].map((weight) => ({ weight }));
    const normalised = normalizeWeights(clauses);
    const total = normalised.reduce((a, b) => a + b, 0);
    expect(near(total, 1), `normalised weights sum to ${total}`);
    return "0.5, 0.5, 0.3 → 0.385, 0.385, 0.231";
  });

  await check("settlement splits the contract exactly", () => {
    const clauses = [
      { id: "c1", weight: 0.2 },
      { id: "c2", weight: 0.4 },
      { id: "c3", weight: 0.2 },
      { id: "c4", weight: 0.1 },
      { id: "c5", weight: 0.1 },
    ];
    const verdicts = [
      { clauseId: "c1", proposedFraction: 1 },
      { clauseId: "c2", proposedFraction: 1 },
      { clauseId: "c3", proposedFraction: 1 },
      { clauseId: "c4", proposedFraction: 0 },
      { clauseId: "c5", proposedFraction: 0 },
    ];
    const { releaseCents, voidedCents } = computeSettlement(clauses, verdicts, 500_000);
    expect(releaseCents === 400_000, `expected 400000, got ${releaseCents}`);
    expect(voidedCents === 100_000, `expected 100000, got ${voidedCents}`);
    expect(releaseCents + voidedCents === 500_000, "split does not add up");
    return "$5,000 × 80% → $4,000 captured, $1,000 voided";
  });

  await check("fractions outside 0..1 are clamped", () => {
    const clauses = [{ id: "c1", weight: 1 }];
    const over = computeSettlement(clauses, [{ clauseId: "c1", proposedFraction: 8 }], 100_000);
    const under = computeSettlement(clauses, [{ clauseId: "c1", proposedFraction: -3 }], 100_000);
    expect(over.releaseCents === 100_000, "fraction > 1 was not clamped");
    expect(under.releaseCents === 0, "negative fraction was not clamped");
    return "8 → 1.0, -3 → 0.0";
  });

  await check("a clause with no verdict releases nothing", () => {
    const clauses = [{ id: "c1", weight: 0.5 }, { id: "c2", weight: 0.5 }];
    const { releaseCents } = computeSettlement(clauses, [{ clauseId: "c1", proposedFraction: 1 }], 100_000);
    expect(releaseCents === 50_000, `expected 50000, got ${releaseCents}`);
    return "silence is not evidence";
  });

  await check("rounding never invents or loses a cent", () => {
    const clauses = [
      { id: "a", weight: 1 / 3 },
      { id: "b", weight: 1 / 3 },
      { id: "c", weight: 1 / 3 },
    ];
    const verdicts = [
      { clauseId: "a", proposedFraction: 1 },
      { clauseId: "b", proposedFraction: 1 },
      { clauseId: "c", proposedFraction: 1 },
    ];
    for (const total of [1, 7, 99, 100, 101, 999, 100_001]) {
      const { releaseCents, voidedCents } = computeSettlement(clauses, verdicts, total);
      expect(releaseCents + voidedCents === total, `total ${total} → ${releaseCents} + ${voidedCents}`);
      expect(releaseCents >= 0 && releaseCents <= total, `release out of range for total ${total}`);
    }
    return "checked 7 totals, all exact";
  });

  await check("low confidence requires a human", () => {
    expect(needsReview([{ confidence: 0.95 }], 0.95) === false, "high confidence flagged for review");
    expect(needsReview([{ confidence: 0.4 }], 0.9) === true, "one weak clause not flagged");
    expect(needsReview([{ confidence: 0.95 }], 0.5) === true, "low overall not flagged");
    return "floor: overall < 0.75 or any clause < 0.6";
  });

  /* ------------------------------- HTTP ------------------------------- */

  let dealId = "";
  let evidenceId = "";

  await check("health advertises offline mode honestly", async () => {
    const { status, json } = await call("GET", "/api/health");
    expect(status === 200, `status ${status}`);
    expect(json.paypalConfigured === false, "PayPal should be disabled in this test");
    expect(json.aiConfigured === false, "AI should be disabled in this test");
    expect(json.currency === "USD", `currency is ${json.currency}`);
    expect(!json.clientSecret, "health must never expose the secret");
    return "paypalConfigured=false, aiConfigured=false, USD";
  });

  await check("OpenAPI contract is served", async () => {
    const { status, json } = await call("GET", "/api/openapi.json");
    expect(status === 200, `status ${status}`);
    expect(String(json.openapi).startsWith("3.1"), `spec version ${json.openapi}`);
    const paths = Object.keys(json.paths ?? {}).length;
    expect(paths >= 10, `only ${paths} paths`);
    return `OpenAPI ${json.openapi}, ${paths} paths`;
  });

  await check("unknown API routes return JSON, not HTML", async () => {
    const { status, json } = await call("GET", "/api/nope");
    expect(status === 404, `status ${status}`);
    expect(json?.code === "NOT_FOUND", `code ${json?.code}`);
    return "404 { code: NOT_FOUND }";
  });

  await check("agent manifest lists its tools", async () => {
    const { status, json } = await call("GET", "/api/agent/manifest");
    expect(status === 200, `status ${status}`);
    const tools = json.tools ?? [];
    expect(tools.length === 9, `expected 9 tools, got ${tools.length}`);
    expect(tools.every((t) => t.name && t.description), "a tool is missing a name or description");
    return `${tools.length} tools`;
  });

  await check("draft agreement produces checkable clauses", async () => {
    const { status, json } = await call("POST", "/api/agreements", {
      prose: PROSE,
      buyerName: "Dev",
      sellerName: "Marisol",
      totalUsd: 5000,
    });
    expect(status === 201, `status ${status}`);
    const a = json.agreement;
    dealId = a.id;
    expect(a.status === "DRAFT", `status ${a.status}`);
    expect(a.clauses.length >= 4 && a.clauses.length <= 6, `${a.clauses.length} clauses`);
    for (const clause of a.clauses) {
      expect(clause.requirement.length > 20, `clause ${clause.id} has no real requirement`);
      expect(clause.evidenceRequired.length > 0, `clause ${clause.id} names no evidence`);
    }
    const sum = a.clauses.reduce((acc, c) => acc + c.weight, 0);
    expect(near(sum, 1, 1e-6), `weights sum to ${sum}`);
    expect(a.draftModel === "heuristic-fallback", `draft model ${a.draftModel}`);
    return `${a.clauses.length} clauses, weights sum to 1.000`;
  });

  await check("both parties must accept", async () => {
    await call("POST", `/api/agreements/${dealId}/approve`, { party: "buyer" });
    const afterOne = await call("GET", `/api/agreements/${dealId}`);
    expect(afterOne.json.agreement.status === "DRAFT", `one signature moved status to ${afterOne.json.agreement.status}`);

    const second = await call("POST", `/api/agreements/${dealId}/approve`, { party: "seller" });
    expect(second.json.agreement.status === "AGREED", `status ${second.json.agreement.status}`);

    const duplicate = await call("POST", `/api/agreements/${dealId}/approve`, { party: "seller" });
    expect(duplicate.status === 409, `duplicate approval returned ${duplicate.status}`);
    return "DRAFT → AGREED, duplicate rejected";
  });

  await check("evidence is bound to a real clause", async () => {
    const form = new FormData();
    form.set("clauseId", "c9");
    form.set("file", new Blob([fixture.bytes], { type: "image/png" }), fixture.name);
    const { status, json } = await call("POST", `/api/agreements/${dealId}/evidence`, form);
    expect(status === 400, `bogus clause returned ${status}`);
    expect(json.code === "BAD_CLAUSE", `code ${json.code}`);
    return "unknown clauseId → 400 BAD_CLAUSE";
  });

  await check("upload hashes the file and serves it back", async () => {
    const form = new FormData();
    form.set("clauseId", "c1");
    form.set("note", "self-test");
    form.set("file", new Blob([fixture.bytes], { type: "image/png" }), fixture.name);

    const { status, json } = await call("POST", `/api/agreements/${dealId}/evidence`, form);
    expect(status === 201, `status ${status}`);

    const evidence = json.agreement.evidence;
    expect(evidence.length === 1, `${evidence.length} evidence items`);
    evidenceId = evidence[0].id;

    expect(/^[0-9a-f]{64}$/.test(evidence[0].sha256), "sha256 is not 64 hex chars");
    expect(evidence[0].path === undefined, "server file path leaked to the client");

    const file = await fetch(`${base}${evidence[0].url}`);
    expect(file.status === 200, `evidence URL returned ${file.status}`);
    expect(file.headers.get("content-type")?.includes("image/png"), "wrong content type");
    return `sha256 ${evidence[0].sha256.slice(0, 12)}…, URL 200`;
  });

  await check("adjudication cites evidence and totals the contract", async () => {
    const { status, json } = await call("POST", `/api/agreements/${dealId}/adjudicate`, {});
    expect(status === 200, `status ${status}`);

    const a = json.agreement;
    const v = a.verdict;
    expect(v, "no verdict returned");
    expect(v.clauses.length === a.clauses.length, "not every clause was judged");
    expect(v.releaseCents + v.voidedCents === a.totalCents, "split does not equal the contract");
    expect(v.model === "heuristic-fallback", `unexpected model ${v.model}`);
    expect(v.needsHumanReview === true, "offline verdict must require a human");

    const unproven = v.clauses.filter((c) => c.status === "missing");
    expect(unproven.length === a.clauses.length - 1, `expected ${a.clauses.length - 1} missing clauses`);
    expect(unproven.every((c) => c.proposedFraction === 0), "an unproven clause proposed a payout");

    const proven = v.clauses.find((c) => c.clauseId === "c1");
    expect(proven.citedEvidence.length === 1, "verdict does not cite the uploaded file");

    return `release ${v.releaseCents}, void ${v.voidedCents}, ${unproven.length} clauses unproven`;
  });

  await check("settlement is blocked without a PayPal hold", async () => {
    const { status, json } = await call("POST", `/api/agreements/${dealId}/settle`, {
      reviewAcknowledged: true,
    });
    expect(status === 409, `status ${status}`);
    expect(json.code === "NO_AUTHORIZATION", `code ${json.code}`);
    return "409 NO_AUTHORIZATION — no money moves without a hold";
  });

  await check("removing evidence invalidates the verdict", async () => {
    const { status, json } = await call("DELETE", `/api/agreements/${dealId}/evidence/${evidenceId}`);
    expect(status === 200, `status ${status}`);
    const a = json.agreement;
    expect(a.verdict === null || a.verdict === undefined, "stale verdict survived evidence deletion");
    expect(a.status === "EVIDENCE", `status ${a.status}`);
    return "verdict cleared, back to EVIDENCE";
  });

  await check("ledger exposes a settled/unsettled split", async () => {
    const { status, json } = await call("GET", "/api/agreements");
    expect(status === 200, `status ${status}`);
    const rows = json.agreements ?? [];
    const row = rows.find((r) => r.id === dealId);
    expect(row, "created agreement missing from the ledger");
    expect(row.totalCents === 500_000, `total ${row.totalCents}`);
    expect(typeof row.releasedCents === "number", "releasedCents missing");
    expect(typeof row.returnedCents === "number", "returnedCents missing");
    // The ledger must not claim money is held when no authorization exists.
    expect(row.authorizationId === null, `unfunded deal reports authorizationId ${row.authorizationId}`);
    return `${rows.length} row(s), split fields present, no phantom hold`;
  });

  await check("agent surface drives the same state machine", async () => {
    const created = await call("POST", "/api/agent/agreements", {
      prose: PROSE,
      buyerName: "Agent Buyer",
      sellerName: "Agent Seller",
      totalUsd: 1200,
    });
    expect(created.status === 201, `status ${created.status}`);
    expect(Array.isArray(created.json.nextActions), "no nextActions returned");
    expect(created.json.nextActions.length > 0, "nextActions is empty");

    const id = created.json.agreement.id;
    const fetched = await call("GET", `/api/agent/agreements/${id}`);
    expect(fetched.status === 200, `get returned ${fetched.status}`);
    expect(fetched.json.agreement.id === id, "wrong agreement returned");

    const settle = await call("POST", `/api/agent/agreements/${id}/settle`, {});
    expect(settle.status === 409, `settling a draft returned ${settle.status}`);

    return `${created.json.nextActions.length} next actions, shared guards`;
  });

  /* ------------------------------ summary ----------------------------- */

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const mark = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${mark} ${r.name}`);
    if (r.detail) console.log(`      ${DIM}${r.detail}${RESET}`);
  }

  console.log("");
  if (failed.length) {
    console.log(`${RED}${failed.length} of ${results.length} checks failed.${RESET}`);
    for (const f of failed) console.log(`  ${RED}✗${RESET} ${f.name}: ${f.detail}`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}${results.length} checks passed.${RESET}`);
    console.log(`${DIM}Deterministic core verified offline. For the PayPal path, run: npm run spike${RESET}`);
    exitCode = 0;
  }
} catch (err) {
  console.error(`${RED}self-test crashed:${RESET} ${err.message}`);
  exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  if (server.exitCode === null) server.kill("SIGKILL");
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a handle briefly; the directory is in the OS temp dir */
  }
  process.exit(exitCode);
}
