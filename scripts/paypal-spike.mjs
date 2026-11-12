#!/usr/bin/env node
/**
 * PayPal spike — prove the money moves before you write the demo.
 *
 *   1. create an order with intent=AUTHORIZE
 *   2. wait for you to approve it in the browser
 *   3. authorize  -> authorization id
 *   4. partially capture the adjudicated amount
 *   5. void the remainder
 *   6. re-read the authorization and print PayPal's own final state
 *
 * Writes the result to docs/paypal-proof.txt (the artifact to commit).
 *
 * Usage:  npm run spike  [-- --amount 5000 --fraction 0.88]
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || "").trim();
const BASE = (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`)) || null;
  if (hit) return Number(hit.split("=")[1]);
  const idx = argv.indexOf(`--${name}`);
  return idx !== -1 && argv[idx + 1] ? Number(argv[idx + 1]) : fallback;
};

const AMOUNT = arg("amount", 5000); // dollars
const FRACTION = arg("fraction", 0.88);
const CAPTURE = Math.round(AMOUNT * FRACTION * 100) / 100;
const VOID = Math.round((AMOUNT - CAPTURE) * 100) / 100;

const log = [];
function record(label, value) {
  const line = `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  log.push(line);
  console.log(line);
}

function die(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  die("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first (copy .env.example).");
}

let token = "";
let tokenExpiry = 0;

async function accessToken() {
  if (token && Date.now() < tokenExpiry - 60_000) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`token request failed (${res.status}): ${JSON.stringify(json)}`);
  token = json.access_token;
  tokenExpiry = Date.now() + Number(json.expires_in || 3600) * 1000;
  return token;
}

async function call(method, pathname, body, requestId) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  if (method === "POST") headers.Prefer = "return=representation";

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = Array.isArray(json.details) ? json.details[0] : null;
    die(
      `${method} ${pathname} -> ${res.status} ${detail?.issue || json.name || ""}\n` +
        `     ${detail?.description || json.message || ""}\n` +
        `     debug_id: ${json.debug_id || "n/a"}\n` +
        `     ${JSON.stringify(json)}`,
    );
  }
  return json;
}

const rid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function main() {
  console.log(`\n  PayPal spike · ${BASE} · $${AMOUNT.toFixed(2)} → capture $${CAPTURE.toFixed(2)} / void $${VOID.toFixed(2)}\n`);
  await accessToken();
  record("mode", BASE.includes("sandbox") ? "sandbox" : "LIVE");
  record("started", new Date().toISOString());

  /* 1 — order ------------------------------------------------------------ */
  const order = await call(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: rid("spike"),
          description: "Proven spike — kitchen backsplash",
          amount: { currency_code: "USD", value: AMOUNT.toFixed(2) },
        },
      ],
      application_context: {
        brand_name: "Proven",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    },
    rid("order"),
  );

  const approveUrl = (order.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  record("order_id", order.id);
  record("order_status", order.status);
  record("approve_url", approveUrl || "(none returned)");

  if (!approveUrl) die("No approve link returned. Is the app a sandbox REST app with Orders v2 enabled?");

  console.log("\n  1. Open this URL and sign in with a SANDBOX PERSONAL account:");
  console.log(`     ${approveUrl}\n`);
  console.log("  2. Approve the payment. Leave this terminal running.\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  await rl.question("  Press Enter once you have approved in the browser… ");
  rl.close();

  /* 2 — authorize -------------------------------------------------------- */
  let auth = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await call("POST", `/v2/checkout/orders/${order.id}/authorize`, {}, rid("authorize"));
      auth = res.purchase_units?.[0]?.payments?.authorizations?.[0];
      record("order_status_after_approval", res.status);
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(`     not approved yet (attempt ${attempt}) — retry in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!auth?.id) die("No authorization id returned. Check the buyer actually approved.");
  record("authorization_id", auth.id);
  record("authorization_status", auth.status);
  record("authorization_expires", auth.expiration_time);

  /* 3 — partial capture -------------------------------------------------- */
  const capture = await call(
    "POST",
    `/v2/payments/authorizations/${auth.id}/capture`,
    {
      amount: { currency_code: "USD", value: CAPTURE.toFixed(2) },
      note_to_payer: "Proven spike — adjudicated partial settlement",
    },
    rid("capture"),
  );

  record("capture_id", capture.id);
  record("capture_status", capture.status);
  record("capture_amount", capture.amount?.value);

  /* 4 — void the remainder ----------------------------------------------- */
  let voidStatus = "skipped (nothing left)";
  if (VOID > 0.004) {
    const v = await call("POST", `/v2/payments/authorizations/${auth.id}/void`, {}, rid("void"));
    voidStatus = v.status || "VOIDED";
    record("void_status", voidStatus);
  }

  /* 5 — server-side truth ------------------------------------------------ */
  const final = await call("GET", `/v2/payments/authorizations/${auth.id}`);
  record("final_authorization_status", final.status);
  record("final_authorization_amount", final.amount?.value);
  record("finished", new Date().toISOString());

  const proof = [
    "Proven — PayPal proof of mechanism",
    "==================================",
    "",
    "Generated by `npm run spike`.",
    "Nothing here is mocked: every id below came back from PayPal.",
    "",
    ...log,
    "",
    "Expected: capture_status COMPLETED, final_authorization_status VOIDED,",
    "and the buyer charged only the adjudicated portion.",
    "",
  ].join("\n");

  const dir = path.join(process.cwd(), "docs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "paypal-proof.txt");
  fs.writeFileSync(file, proof, "utf8");

  console.log(`\n  ✓ Mechanism proven. Wrote ${path.relative(process.cwd(), file)}\n`);
  console.log("  Commit that file. Real ids in a public repo are the strongest evidence of a working build.\n");
}

main().catch((err) => die(err?.stack || String(err)));
