import type { IncomingHttpHeaders } from "node:http";
import { ApiError, notFound } from "./errors.js";

export type Principal =
  | { kind: "owner" }
  | { kind: "runner"; connectMachineId: string | null }
  | { kind: "anonymous" };

export interface TrustRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string; localPort?: number };
}

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
const RUNNER_PREFIX = "/internal/runner/";
const API_PREFIX = "/api/v1/";
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const RUNNER_FORBIDDEN_WRITES =
  /^\/api\/v1\/(?:hosts|settings|system)(?:\/|$)|\/machine-environment$/u;

export function requestHeader(
  request: Pick<TrustRequest, "headers">,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  const ipv4 = address?.replace(/^::ffff:/u, "");
  return ipv4 === "::1" || ipv4?.startsWith("127.") === true;
}

function isLoopbackAuthority(authority: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.includes(new URL(`http://${authority}`).hostname);
  } catch {
    return false;
  }
}

function identify(request: TrustRequest): Principal {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return { kind: "anonymous" };
  }
  if (requestHeader(request, "x-bb-via-tunnel") !== "1") {
    return { kind: "owner" };
  }
  switch (requestHeader(request, "x-bb-gate-auth")) {
    case "session":
      return { kind: "owner" };
    case "machine": {
      const machineId = requestHeader(request, "x-bb-gate-machine-id");
      return { kind: "runner", connectMachineId: machineId ?? null };
    }
    default:
      return { kind: "anonymous" };
  }
}

function assertOwnBrowserRequest(
  request: TrustRequest,
  publicUrl: () => string | null,
): void {
  const host = request.headers.host;
  if (host !== undefined && !isLoopbackAuthority(host)) {
    throw new ApiError(
      403,
      "forbidden_host",
      `host "${host}" is not a loopback address of this bb server`,
    );
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;
  const own = LOOPBACK_HOSTNAMES.map(
    (hostname) => `http://${hostname}:${request.socket.localPort}`,
  );
  const stored = publicUrl();
  if (stored !== null) own.push(new URL(stored).origin);
  if (!own.includes(origin)) {
    throw new ApiError(
      403,
      "forbidden_origin",
      `origin "${origin}" is not this bb server`,
    );
  }
}

export function authorize(
  request: TrustRequest,
  publicUrl: () => string | null,
): Principal {
  const principal = identify(request);
  const { path } = request;
  if (principal.kind === "owner") {
    assertOwnBrowserRequest(request, publicUrl);
  } else if (principal.kind === "anonymous") {
    const direct = requestHeader(request, "x-bb-via-tunnel") !== "1";
    if (!direct || !path.startsWith(RUNNER_PREFIX)) throw notFound();
  } else if (!path.startsWith(RUNNER_PREFIX) && !path.startsWith(API_PREFIX)) {
    throw notFound();
  } else if (
    !READ_METHODS.includes(request.method) &&
    RUNNER_FORBIDDEN_WRITES.test(path)
  ) {
    throw new ApiError(
      403,
      "forbidden",
      "Machine credentials cannot manage machines or settings",
    );
  }
  return principal;
}

export const principals = new WeakMap<Request, Principal>();

export function principalOf(context: { req: { raw: Request } }): Principal {
  const principal = principals.get(context.req.raw);
  if (principal === undefined) throw new Error("Request has no principal");
  return principal;
}
