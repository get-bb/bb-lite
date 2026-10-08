import type { IncomingMessage } from "node:http";

export interface Refusal {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Admitted {
  identity: Record<string, string>;
  address: string;
  responseHeaders?: Record<string, string>;
}

export interface Visit {
  request: IncomingMessage;
  label: string;
  target: string | null;
  method: string;
  path: string;
  own: string;
}

export interface Accounts {
  shares: boolean;
  isPlatformCookie(name: string): boolean;
  isPrivateHeader(name: string): boolean;
  admit(visit: Visit): Promise<Refusal | Admitted>;
  linked(label: string, credential: string): Promise<boolean>;
}

interface Remembered<Value> {
  until: number;
  found: Promise<Value>;
}

const CACHE_LIMIT = 20_000;

export function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function readCookie(cookies: string, name: string): string | null {
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return null;
}

export function plain(status: number, body: string): Refusal {
  const headers = { "content-type": "text/plain; charset=utf-8" };
  return { status, headers, body };
}

export function refuse(status: number, code: string, message: string): Refusal {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  return { status, headers, body: JSON.stringify({ code, message }) };
}

export function isForeignOrigin(visit: Visit): boolean {
  const origin = header(visit.request, "origin");
  if (origin === undefined) return false;
  const upgrade = header(visit.request, "upgrade") !== undefined;
  const read = ["GET", "HEAD", "OPTIONS"].includes(visit.method);
  return (!read || upgrade) && origin !== visit.own;
}

export function remembering<Value>(
  load: (key: string) => Promise<Value>,
  ttlMs: (value: Value) => number,
) {
  const known = new Map<string, Remembered<Value>>();
  return (key: string): Promise<Value> => {
    const now = Date.now();
    const cached = known.get(key);
    if (cached !== undefined && cached.until > now) return cached.found;
    if (known.size > CACHE_LIMIT) known.clear();
    const found = load(key);
    const entry = { until: Number.POSITIVE_INFINITY, found };
    known.set(key, entry);
    found.then(
      (value) => {
        entry.until = now + ttlMs(value);
      },
      () => known.delete(key),
    );
    return found;
  };
}
