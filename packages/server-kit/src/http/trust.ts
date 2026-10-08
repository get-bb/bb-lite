import type { IncomingHttpHeaders } from "node:http";
import type { UserRole } from "@bb/domain";
import { ApiError, forbidden, notFound } from "./errors.js";

export interface TrustedUser {
  id: string;
  role: UserRole;
  avatarUrl?: string | null;
}

export interface GateIdentity {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export type Principal =
  | { kind: "user"; userId: string; role: UserRole; implicit: boolean }
  | { kind: "runner"; hostId: string | null; connectMachineId: string | null }
  | { kind: "anonymous"; identity?: GateIdentity };

export interface TrustLookups {
  allowedHosts: readonly string[];
  sessionCookie: string;
  tunnelToken: string;
  publicUrl(): string | null;
  runnerMachine(
    token: string,
  ): { id: string; connectMachineId: string | null } | undefined;
  sessionUser(token: string): TrustedUser | undefined;
  externalUser(externalId: string): TrustedUser | undefined;
  rememberAvatar(userId: string, avatarUrl: string): void;
  ownerUser(): TrustedUser;
}

export interface TrustRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
const RUNNER_PREFIX = "/internal/runner/";
const API_PREFIX = "/api/v1/";
const AUTH_PREFIX = "/api/v1/auth/";
const GUARDED_PREFIXES = ["/api/", "/internal/", "/ws"];
const VIA_TUNNEL_HEADER = "x-bb-via-tunnel";
const AVATAR_MAX = 500;
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "via",
  "tailscale-user-login",
];
const RUNNER_BEARER = /^Bearer (bbr_\S+)$/u;
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const RUNNER_FORBIDDEN_WRITES =
  /^\/api\/v1\/(?:hosts|settings|system|users|user-invites)(?:\/|$)|\/machine-environment$/u;

export function requestHeader(
  request: Pick<TrustRequest, "headers">,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function requestCookie(
  request: Pick<TrustRequest, "headers">,
  name: string,
): string | undefined {
  const cookies = requestHeader(request, "cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}

function isLoopbackAddress(address: string | undefined) {
  const ipv4 = address?.replace(/^::ffff:/u, "");
  return ipv4 === "::1" || ipv4?.startsWith("127.") === true;
}

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

function isLoopbackAuthority(authority: string | undefined) {
  if (authority === undefined) return true;
  const hostname = hostnameOf(authority);
  return hostname !== null && LOOPBACK_HOSTNAMES.includes(hostname);
}

function isOwnAuthority(authority: string, allowed: readonly string[]) {
  const hostname = hostnameOf(authority);
  if (hostname === null) return false;
  return LOOPBACK_HOSTNAMES.includes(hostname) || allowed.includes(hostname);
}

function implicitOwner(lookups: TrustLookups): Principal {
  const { id: userId, role } = lookups.ownerUser();
  return { kind: "user", userId, role, implicit: true };
}

function isProxied(request: TrustRequest) {
  return PROXY_HEADERS.some((name) => request.headers[name] !== undefined);
}

function gateText(request: TrustRequest, name: string): string | null {
  const value = requestHeader(request, name);
  if (value === undefined || value === "") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function gateAvatar(request: TrustRequest): string | null {
  const url = gateText(request, "x-bb-gate-user-avatar");
  const usable =
    url !== null && url.startsWith("https://") && url.length <= AVATAR_MAX;
  return usable ? url : null;
}

function gateVisitor(request: TrustRequest, lookups: TrustLookups): Principal {
  const id = requestHeader(request, "x-bb-gate-user-id");
  const owns = requestHeader(request, "x-bb-gate-owner") === "1";
  const avatarUrl = gateAvatar(request);
  const known =
    id === undefined || owns ? lookups.ownerUser() : lookups.externalUser(id);
  if (known !== undefined) {
    if (id !== undefined && avatarUrl !== null) {
      const stale = (known.avatarUrl ?? null) !== avatarUrl;
      if (stale) lookups.rememberAvatar(known.id, avatarUrl);
    }
    const { id: userId, role } = known;
    return { kind: "user", userId, role, implicit: id === undefined || owns };
  }
  const name = gateText(request, "x-bb-gate-user-name");
  const email = gateText(request, "x-bb-gate-user-email");
  const identity = { id: id ?? "", name, email, avatarUrl };
  return { kind: "anonymous", identity };
}

function identify(request: TrustRequest, lookups: TrustLookups): Principal {
  const marker = requestHeader(request, VIA_TUNNEL_HEADER);
  if (marker !== undefined && marker !== lookups.tunnelToken) {
    return { kind: "anonymous" };
  }
  const direct = marker === undefined;
  const authorization = requestHeader(request, "authorization") ?? "";
  const runnerToken = RUNNER_BEARER.exec(authorization)?.[1];
  if (direct && runnerToken !== undefined) {
    const machine = lookups.runnerMachine(runnerToken);
    if (machine === undefined) return { kind: "anonymous" };
    const { id: hostId, connectMachineId } = machine;
    return { kind: "runner", hostId, connectMachineId };
  }
  const sessionToken = requestCookie(request, lookups.sessionCookie);
  const signedIn =
    sessionToken === undefined ? undefined : lookups.sessionUser(sessionToken);
  if (signedIn !== undefined) {
    const { id: userId, role } = signedIn;
    return { kind: "user", userId, role, implicit: false };
  }
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return { kind: "anonymous" };
  }
  if (direct) {
    const local = isLoopbackAuthority(request.headers.host);
    return local && !isProxied(request)
      ? implicitOwner(lookups)
      : { kind: "anonymous" };
  }
  switch (requestHeader(request, "x-bb-gate-auth")) {
    case "session":
      return gateVisitor(request, lookups);
    case "machine": {
      const machineId = requestHeader(request, "x-bb-gate-machine-id");
      return {
        kind: "runner",
        hostId: null,
        connectMachineId: machineId ?? null,
      };
    }
    default:
      return { kind: "anonymous" };
  }
}

function assertOwnOrigin(
  request: TrustRequest,
  { publicUrl }: TrustLookups,
): void {
  const { host, origin } = request.headers;
  if (origin === undefined) return;
  const own = [`http://${host}`, `https://${host}`];
  const stored = publicUrl();
  if (stored !== null) own.push(new URL(stored).origin);
  if (own.includes(origin)) return;
  throw new ApiError(
    403,
    "forbidden_origin",
    `origin "${origin}" is not this bb server`,
  );
}

function assertOwnBrowserRequest(request: TrustRequest, lookups: TrustLookups) {
  const host = request.headers.host;
  if (host !== undefined && !isOwnAuthority(host, lookups.allowedHosts)) {
    throw new ApiError(
      403,
      "forbidden_host",
      `host "${host}" is not an address of this bb server`,
    );
  }
  assertOwnOrigin(request, lookups);
}

function assertAnonymousAccess(
  request: TrustRequest,
  identity: GateIdentity | undefined,
): void {
  const { method, path } = request;
  const tunnelled = requestHeader(request, VIA_TUNNEL_HEADER) !== undefined;
  if (tunnelled && identity === undefined) throw notFound();
  if (path.startsWith(RUNNER_PREFIX)) return;
  if (path.startsWith(AUTH_PREFIX)) return;
  const guarded = GUARDED_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!guarded && READ_METHODS.includes(method)) return;
  throw new ApiError(401, "unauthenticated", "Sign in to use this bb");
}

export function authorize(
  request: TrustRequest,
  lookups: TrustLookups,
): Principal {
  const principal = identify(request, lookups);
  const { path } = request;
  if (principal.kind === "user") {
    if (principal.implicit) assertOwnBrowserRequest(request, lookups);
    else assertOwnOrigin(request, lookups);
  } else if (principal.kind === "anonymous") {
    assertAnonymousAccess(request, principal.identity);
  } else if (!path.startsWith(RUNNER_PREFIX) && !path.startsWith(API_PREFIX)) {
    throw notFound();
  } else if (
    !READ_METHODS.includes(request.method) &&
    RUNNER_FORBIDDEN_WRITES.test(path)
  ) {
    throw forbidden("Machine credentials cannot manage machines or settings");
  }
  return principal;
}

export const principals = new WeakMap<Request, Principal>();

export function principalOf(context: { req: { raw: Request } }): Principal {
  const principal = principals.get(context.req.raw);
  if (principal === undefined) throw new Error("Request has no principal");
  return principal;
}

export function requireUser(context: {
  req: { raw: Request };
}): Extract<Principal, { kind: "user" }> {
  const principal = principalOf(context);
  if (principal.kind === "user") return principal;
  if (principal.kind === "runner") {
    throw forbidden("Machine credentials cannot do this");
  }
  throw new ApiError(401, "unauthenticated", "Sign in to use this bb");
}

export function requireOwner(
  context: { req: { raw: Request } },
  refusal: string,
): void {
  const principal = principalOf(context);
  if (principal.kind === "user" && principal.role === "owner") return;
  throw forbidden(refusal);
}

export function sessionCookieName(config: { port: number }): string {
  return `bb_session_${config.port}`;
}
