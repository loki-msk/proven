/**
 * Minimal, dependency-free PayPal REST client.
 * Docs: https://developer.paypal.com/api/rest/
 *
 * Only the primitives this product needs are exposed:
 *   Orders v2  : create (intent=AUTHORIZE) → authorize
 *   Payments v2: capture authorized payment (partial) → void remaining
 */

const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || "").trim();
const BASE = (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");

let cached: { token: string; expiresAt: number } | null = null;
let cachedFor = "";

export function paypalConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function paypalMode(): string {
  return BASE.includes("sandbox") ? "sandbox" : "live";
}

export class PayPalError extends Error {
  status: number;
  issue: string;
  debugId: string;
  raw: unknown;

  constructor(message: string, status: number, issue: string, debugId: string, raw: unknown) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
    this.raw = raw;
  }
}

async function accessToken(): Promise<string> {
  if (!paypalConfigured()) {
    throw new PayPalError(
      "PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      503,
      "NOT_CONFIGURED",
      "",
      null,
    );
  }

  const key = `${CLIENT_ID}:${BASE}`;
  if (cached && cachedFor === key && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    throw new PayPalError(
      json?.error_description || json?.error || "Could not obtain PayPal access token",
      res.status,
      json?.error || "TOKEN_ERROR",
      json?.debug_id || "",
      json,
    );
  }

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  cachedFor = key;
  return cached.token;
}

async function request<T = any>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["PayPal-Request-Id"] = idempotencyKey;
  if (method === "POST") headers["Prefer"] = "return=representation";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const detail = Array.isArray(json?.details) ? json.details[0] : null;
    throw new PayPalError(
      detail?.description || json?.message || `PayPal request failed (${res.status})`,
      res.status,
      detail?.issue || json?.name || "PAYPAL_ERROR",
      json?.debug_id || "",
      json,
    );
  }

  return (json ?? {}) as T;
}

export interface CreateOrderInput {
  totalCents: number;
  currency: string;
  description: string;
  customId: string;
}

export async function createAuthorizeOrder(input: CreateOrderInput) {
  const value = (input.totalCents / 100).toFixed(2);
  const order = await request<any>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: input.customId,
          description: input.description.slice(0, 127),
          amount: { currency_code: input.currency, value },
        },
      ],
      application_context: {
        brand_name: "Proven",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    },
    `order-${input.customId}`,
  );

  return {
    id: order.id as string,
    status: order.status as string,
    approveUrl:
      (order.links || []).find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href ??
      null,
  };
}

export async function authorizeOrder(orderId: string) {
  const res = await request<any>(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    {},
    `auth-${orderId}`,
  );

  const authorization = res?.purchase_units?.[0]?.payments?.authorizations?.[0];

  return {
    orderId: res.id as string,
    orderStatus: res.status as string,
    authorizationId: (authorization?.id as string) || null,
    authorizationStatus: (authorization?.status as string) || null,
    expiresAt: (authorization?.expiration_time as string) || null,
    raw: res,
  };
}

export async function getAuthorization(authorizationId: string) {
  return request<any>(
    "GET",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
  );
}

/** Capture an amount up to the authorized total.
 *
 * Deliberately does NOT send `final_capture: true`: marking the capture final
 * closes the authorization, which would leave the remainder to expire on its
 * own. We want the uncaptured balance released immediately, so we capture the
 * adjudicated amount and then POST /void on the same authorization.
 * Ref: https://developer.paypal.com/checkout/delay-capture ("The remainder can
 * be voided or left to expire.")
 */
export async function captureAuthorization(
  authorizationId: string,
  amountCents: number,
  currency: string,
  idempotencyKey: string,
) {
  const value = (amountCents / 100).toFixed(2);
  return request<any>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    {
      amount: { currency_code: currency, value },
      note_to_payer: "Settled by Proven against verified delivery",
    },
    idempotencyKey,
  );
}

/** Release the uncaptured remainder of an authorization. Returns voided status. */
export async function voidAuthorization(authorizationId: string) {
  await request<any>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    {},
    `void-${authorizationId}`,
  );
  const auth = await getAuthorization(authorizationId);
  return { status: auth.status as string, raw: auth };
}
