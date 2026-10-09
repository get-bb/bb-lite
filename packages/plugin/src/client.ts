import type { z } from "zod";
import type { HttpDoor, Op } from "./contract.js";

export const DEFAULT_CALL_TIMEOUT_MS = 75_000;
export const THREAD_ID_HEADER = "x-bb-thread-id";

const API_PREFIX = "/api/v1";
const DOOR_HEADER = "x-bb-door";
const PATH_PARAM = /:([A-Za-z]+)/gu;

export interface OpClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  door?: "app" | "cli";
  threadId?: string;
  timeoutMs?: number;
}

export interface RemoteCallOptions {
  signal?: AbortSignal;
}

export interface OpClient {
  call<O extends Op>(
    op: O,
    input: z.input<O["input"]>,
    options?: RemoteCallOptions,
  ): Promise<z.output<O["output"]>>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface CallFailure {
  status: number;
  code: string | null;
  message: string;
  body: unknown;
}

export class CallError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(failure: CallFailure) {
    super(`HTTP ${failure.status}: ${failure.message}`);
    this.name = "CallError";
    this.status = failure.status;
    this.code = failure.code;
    this.body = failure.body;
  }

  get details(): unknown {
    return fieldOf(this.body, "details");
  }
}

export class CallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const seconds = timeoutMs / 1000;
    const unit = seconds === 1 ? "second" : "seconds";
    const duration = Number.isInteger(seconds)
      ? `${seconds} ${unit}`
      : `${timeoutMs} ms`;
    super(`BB request timed out after ${duration}.`);
    this.name = "CallTimeoutError";
  }
}

function fieldOf(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[name];
}

function messageOf(body: unknown): string | null {
  for (const name of ["message", "detail", "error"]) {
    const text = fieldOf(body, name);
    if (typeof text !== "string") continue;
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (normalized !== "") return normalized;
  }
  return null;
}

function describeFailure(response: Response, raw: string): CallFailure {
  const { status } = response;
  const normalized = raw.replace(/\s+/gu, " ").trim();
  const fallback =
    response.statusText || `Request failed with status ${status}`;
  if (normalized === "") {
    return { status, code: null, message: fallback, body: null };
  }
  try {
    const body: unknown = JSON.parse(normalized);
    const code = fieldOf(body, "code");
    return {
      status,
      code: typeof code === "string" ? code : null,
      message: messageOf(body) ?? normalized,
      body,
    };
  } catch {
    const message = normalized.startsWith("<") ? fallback : normalized;
    return { status, code: null, message, body: null };
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return fieldOf(error.cause, "code") === "ECONNREFUSED";
}

function queryOf(fields: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const each of value) search.append(name, String(each));
    } else {
      search.set(name, String(value));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

function doorRequest(
  door: HttpDoor,
  input: unknown,
): { path: string; init: RequestInit } {
  const fields: Record<string, unknown> = { ...(input as object) };
  const path = door.path.replace(PATH_PARAM, (_match, name: string) => {
    const value = fields[name];
    delete fields[name];
    return encodeURIComponent(String(value));
  });
  const { method } = door;
  if (method === "GET") {
    return { path: `${API_PREFIX}${path}${queryOf(fields)}`, init: {} };
  }
  const body = door.body === undefined ? fields : fields[door.body];
  const empty = door.body === undefined && Object.keys(fields).length === 0;
  if (empty) return { path: `${API_PREFIX}${path}`, init: { method } };
  const headers = { "content-type": "application/json" };
  const init = { method, headers, body: JSON.stringify(body) };
  return { path: `${API_PREFIX}${path}`, init };
}

function opRequest(op: Op, input: unknown) {
  const door = op.doors.http;
  if (door !== undefined) return doorRequest(door, input);
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify(input ?? {});
  const path = `${API_PREFIX}/ops/${encodeURIComponent(op.name)}`;
  return { path, init: { method: "POST", headers, body } };
}

export function createOpClient(options: OpClientOptions = {}): OpClient {
  const { timeoutMs, door, threadId } = options;
  const usable = Number.isFinite(timeoutMs) && Number(timeoutMs) >= 0;
  if (timeoutMs !== undefined && !usable) {
    throw new RangeError(
      "BB request timeout must be a non-negative finite number.",
    );
  }
  const send = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/u, "");

  async function request(path: string, init: RequestInit = {}) {
    const timeout =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const signal =
      timeout && init.signal
        ? AbortSignal.any([init.signal, timeout])
        : (timeout ?? init.signal ?? undefined);
    const timedOut = (error: unknown): boolean => {
      if (!timeout?.aborted) return false;
      if (error === timeout.reason) return true;
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      return aborted && signal?.reason === timeout.reason;
    };
    const guarded = async <Value>(read: () => Promise<Value>) => {
      try {
        return await read();
      } catch (error) {
        if (timedOut(error)) throw new CallTimeoutError(timeoutMs ?? 0);
        throw error;
      }
    };
    const headers = new Headers(init.headers);
    if (door !== undefined) headers.set(DOOR_HEADER, door);
    if (threadId !== undefined) headers.set(THREAD_ID_HEADER, threadId);
    const connect = () =>
      send(`${baseUrl}${path}`, {
        ...init,
        headers,
        ...(signal && { signal }),
      });
    const response = await guarded(connect).catch((error: unknown) => {
      if (!isConnectionRefused(error)) throw error;
      throw new Error(
        "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
      );
    });
    if (response.ok) return response;
    const raw = await guarded(() => response.text()).catch((error) => {
      if (error instanceof CallTimeoutError) throw error;
      return "";
    });
    throw new CallError(describeFailure(response, raw));
  }

  return {
    request,
    async call(op, input, { signal } = {}) {
      const { path, init } = opRequest(op, input);
      const response = await request(path, {
        ...init,
        ...(signal && { signal }),
      });
      if (response.status === 204) return null as never;
      const body: unknown = await response.json();
      if (op.doors.http !== undefined) return body as never;
      return (fieldOf(body, "result") ?? null) as never;
    },
  };
}
