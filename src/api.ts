import type { Agreement, AgreementSummary, Health, Party } from "./types";

export class ApiError extends Error {
  status: number;
  issue?: string;
  debugId?: string;
  code?: string;

  constructor(message: string, status: number, extra?: { issue?: string; debugId?: string; code?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issue = extra?.issue;
    this.debugId = extra?.debugId;
    this.code = extra?.code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }

  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, {
      issue: data.issue || data.message,
      debugId: data.debugId,
      code: data.error,
    });
  }
  return data as T;
}

export const api = {
  health: () => req<Health>("/api/health"),

  createAgreement: (body: {
    prose: string;
    buyerName: string;
    sellerName: string;
    totalUsd: number;
  }) =>
    req<{ agreement: Agreement }>("/api/agreements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  getAgreement: (id: string) => req<{ agreement: Agreement }>(`/api/agreements/${id}`),

  listAgreements: () => req<{ agreements: AgreementSummary[] }>("/api/agreements"),
  approve: (id: string, party: Party) =>    req<{ agreement: Agreement }>(`/api/agreements/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ party }),
    }),

  createOrder: (agreementId: string) =>
    req<{ orderId: string; approveUrl: string | null; status: string }>("/api/paypal/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agreementId }),
    }),

  authorizeOrder: (agreementId: string, orderId: string) =>
    req<{ agreement: Agreement }>("/api/paypal/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agreementId, orderId }),
    }),

  uploadEvidence: (id: string, file: File, clauseId: string, note: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("clauseId", clauseId);
    form.append("note", note);
    return req<{ agreement: Agreement }>(`/api/agreements/${id}/evidence`, {
      method: "POST",
      body: form,
    });
  },

  deleteEvidence: (id: string, evidenceId: string) =>
    req<{ agreement: Agreement }>(`/api/agreements/${id}/evidence/${evidenceId}`, {
      method: "DELETE",
    }),

  adjudicate: (id: string) =>
    req<{ agreement: Agreement }>(`/api/agreements/${id}/adjudicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),

  settle: (id: string, reviewAcknowledged: boolean) =>
    req<{ agreement: Agreement }>(`/api/agreements/${id}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewAcknowledged }),
    }),
};
