import { extractErrorMessage } from "@bb/core-ui";
import type {
  RouteDefinition,
  RouteInput,
  RouteOutput,
} from "@bb/server-contract";

export const DEFAULT_BB_REQUEST_TIMEOUT_MS = 75_000;

export type FetchImplementation = typeof fetch;

type QueryValue = string | number | readonly string[] | undefined;

interface RequestParts {
  param?: Record<string, string>;
  query?: Record<string, QueryValue>;
  json?: unknown;
}

export interface HttpReply {
  status: number;
  json(): Promise<unknown>;
}

export interface Http {
  json<Route extends RouteDefinition>(
    route: Route,
    input: RouteInput<Route> & RequestParts,
    signal?: AbortSignal,
  ): Promise<RouteOutput<Route>>;
  send<Route extends RouteDefinition>(
    route: Route,
    input: RouteInput<Route> & RequestParts,
    signal?: AbortSignal,
  ): Promise<HttpReply>;
  request(path: string, init?: RequestInit): Promise<HttpReply>;
}

export interface CreateHttpArgs {
  baseUrl: string;
  fetch: FetchImplementation;
  timeoutMs?: number;
}

export class BbRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const seconds = timeoutMs / 1000;
    const unit = seconds === 1 ? "second" : "seconds";
    const duration = Number.isInteger(seconds)
      ? `${seconds} ${unit}`
      : `${timeoutMs} ms`;
    super(`BB request timed out after ${duration}.`);
    this.name = "BbRequestTimeoutError";
  }
}

export interface BbHttpErrorArgs {
  body: unknown;
  code: string | null;
  message: string;
  status: number;
}

export class BbHttpError extends Error {
  readonly body: unknown;
  readonly code: string | null;
  readonly status: number;

  constructor(args: BbHttpErrorArgs) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "BbHttpError";
    this.body = args.body;
    this.code = args.code;
    this.status = args.status;
  }
}

export function pick<Source extends object, Key extends keyof Source>(
  source: Source,
  keys: readonly Key[],
): Pick<Source, Key> {
  const entries = keys.map((key) => [key, source[key]]);
  return Object.fromEntries(entries) as Pick<Source, Key>;
}

export function flag(value: boolean | undefined): "true" | "false" | undefined {
  if (value === undefined) return undefined;
  return value ? "true" : "false";
}

export function count(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function routeUrl(route: RouteDefinition, parts: RequestParts): string {
  let path: string = route.path;
  for (const [name, value] of Object.entries(parts.param ?? {})) {
    const segment = new RegExp(`/:${name}(?:\\{[^/]+\\})?\\??`, "u");
    path = path.replace(segment, value ? `/${value}` : "");
  }
  if (parts.query === undefined) return `/api/v1${path}`;
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parts.query)) {
    if (value === undefined) continue;
    if (typeof value !== "object") search.set(name, String(value));
    else for (const each of value) search.append(name, each);
  }
  return `/api/v1${path}?${search.toString()}`;
}

function routeInit(
  route: RouteDefinition,
  parts: RequestParts,
  signal: AbortSignal | undefined,
): RequestInit {
  const method = route.method.toUpperCase();
  const body = parts.json ? JSON.stringify(parts.json) : undefined;
  return {
    method,
    ...(body === undefined || method === "GET"
      ? {}
      : { body, headers: { "content-type": "application/json" } }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const { cause } = error;
  if (!cause || typeof cause !== "object") return false;
  return "code" in cause && cause.code === "ECONNREFUSED";
}

function errorCode(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") return null;
  if (Array.isArray(parsed) || !("code" in parsed)) return null;
  return typeof parsed.code === "string" ? parsed.code : null;
}

function describeFailure(response: Response, rawBody: string) {
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return { body: null, code: null, message: response.statusText };
  }
  const contentType = response.headers.get("content-type");
  const looksJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (!looksJson) {
    const message = normalized.startsWith("<")
      ? response.statusText || `Request failed with status ${response.status}`
      : normalized;
    return { body: null, code: null, message };
  }
  try {
    const parsed: unknown = JSON.parse(normalized);
    const legacyKeys = ["detail", "error"] as const;
    const message = extractErrorMessage(parsed, { legacyKeys }) ?? normalized;
    return { body: parsed, code: errorCode(parsed), message };
  } catch {
    return { body: null, code: null, message: normalized };
  }
}

export function createHttp(args: CreateHttpArgs): Http {
  const { timeoutMs } = args;
  if (
    timeoutMs !== undefined &&
    !(Number.isFinite(timeoutMs) && timeoutMs >= 0)
  )
    throw new RangeError(
      "BB request timeout must be a non-negative finite number.",
    );
  const baseUrl = args.baseUrl.replace(/\/+$/u, "");

  async function exchange(path: string, init: RequestInit): Promise<HttpReply> {
    const timeout =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const signal =
      timeout && init.signal
        ? AbortSignal.any([init.signal, timeout])
        : (timeout ?? init.signal);
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
        if (timedOut(error)) throw new BbRequestTimeoutError(timeoutMs ?? 0);
        throw error;
      }
    };
    const connect = () =>
      args.fetch(`${baseUrl}${path}`, { ...init, ...(signal && { signal }) });
    const response = await guarded(connect).catch((error: unknown) => {
      if (!isConnectionRefused(error)) throw error;
      throw new Error(
        "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
      );
    });
    if (response.ok) {
      const json = (): Promise<unknown> => guarded(() => response.json());
      return { status: response.status, json };
    }
    const rawBody = await guarded(() => response.text()).catch((error) => {
      if (error instanceof BbRequestTimeoutError) throw error;
      return "";
    });
    const failure = describeFailure(response, rawBody);
    throw new BbHttpError({ ...failure, status: response.status });
  }

  const send: Http["send"] = (route, input, signal) =>
    exchange(routeUrl(route, input), routeInit(route, input, signal));

  return {
    send,
    request: (path, init = {}) => exchange(path, init),
    async json<Route extends RouteDefinition>(
      route: Route,
      input: RouteInput<Route> & RequestParts,
      signal?: AbortSignal,
    ) {
      const reply = await send(route, input, signal);
      return (await reply.json()) as RouteOutput<Route>;
    },
  };
}
