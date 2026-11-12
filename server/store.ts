import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Agreement, LedgerEvent } from "./types.ts";

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

const DB_PATH = path.join(DATA_DIR, "db.json");

interface DB {
  agreements: Record<string, Agreement>;
}

let db: DB = load();

function load(): DB {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as DB;
    if (!parsed.agreements) return { agreements: {} };
    return parsed;
  } catch {
    return { agreements: {} };
  }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_PATH);
}

export const uploadsDir = path.join(DATA_DIR, "uploads");

export const store = {
  get(id: string): Agreement | undefined {
    return db.agreements[id];
  },
  list(): Agreement[] {
    return Object.values(db.agreements).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  put(agreement: Agreement): Agreement {
    agreement.updatedAt = new Date().toISOString();
    db.agreements[agreement.id] = agreement;
    persist();
    return agreement;
  },
  create(agreement: Agreement): Agreement {
    db.agreements[agreement.id] = agreement;
    persist();
    return agreement;
  },
};

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export function logEvent(
  agreement: Agreement,
  type: string,
  actor: string,
  detail: string,
): LedgerEvent {
  const event: LedgerEvent = {
    id: newId("evt"),
    type,
    actor,
    detail,
    createdAt: new Date().toISOString(),
  };
  agreement.events.push(event);
  return event;
}
