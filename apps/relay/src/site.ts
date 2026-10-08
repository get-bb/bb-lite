import * as store from "./store.js";

export interface Env {
  DB: D1Database;
  TUNNEL_DO: DurableObjectNamespace;
  BASE_DOMAIN: string;
  HOSTING?: string;
  ADMIN_LOGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
  GATE_DEADLINE_MS?: string;
  GATE_SECRET?: string;
  FLY_API_TOKEN?: string;
  FLY_API_URL?: string;
  FLY_ORG?: string;
  FLY_IMAGE?: string;
  FLY_REGION?: string;
  FLY_CPU_KIND?: string;
  FLY_CPUS?: string;
  FLY_MEMORY_MB?: string;
  FLY_VOLUME_GB?: string;
  HOSTED_IDLE_HOURS?: string;
  HOSTED_DELETE_DAYS?: string;
  HOSTED_PER_ACCOUNT?: string;
}

export interface Site {
  env: Env;
  db: D1Database;
  baseHost: string;
  apexOrigin: string;
  secure: boolean;
  origin(label: string): string;
}

export const SESSION_COOKIE = "bbr_session";
export const OAUTH_COOKIE = "bbr_oauth";
export const TUNNEL_HEADER = "x-relay-tunnel";
export const TARGET_HEADER = "x-relay-target";
export const CLOSE_HEADER = "x-relay-close";
export const OFFLINE_HEADER = "x-relay-offline";

const ACCOUNT_COOKIE = "bbr_account";
const RESERVED_COOKIE = /^(__(host|secure)-)?bbr_/iu;

export function isReservedCookie(name: string): boolean {
  return RESERVED_COOKIE.test(name.trim());
}

function accountCookieName(site: Site) {
  return site.secure ? `__Host-${ACCOUNT_COOKIE}` : ACCOUNT_COOKIE;
}
export const MACHINE_HEADER = "x-bb-connect-machine";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/u;
const RESERVED_LABELS = [
  "www",
  "api",
  "app",
  "admin",
  "login",
  "signup",
  "relay",
  "mail",
  "static",
  "assets",
];

export function siteOf(request: Request | null, env: Env): Site {
  const { protocol } = new URL(request?.url ?? "https://relay");
  const baseHost = env.BASE_DOMAIN.toLowerCase();
  return {
    env,
    db: env.DB,
    baseHost,
    apexOrigin: `${protocol}//${baseHost}`,
    secure: protocol === "https:",
    origin: (label) => `${protocol}//${label}.${baseHost}`,
  };
}

export function isValidLabel(label: string): boolean {
  if (!LABEL.test(label) || label.includes("--")) return false;
  return !RESERVED_LABELS.includes(label);
}

export function json(body: unknown, status = 200): Response {
  const headers = { "cache-control": "no-store" };
  return Response.json(body, { status, headers });
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return null;
}

export function withoutRelayCookies(header: string | null) {
  const kept = (header ?? "").split(";").filter((pair) => {
    const [key = ""] = pair.split("=");
    return key.trim() !== "" && !isReservedCookie(key);
  });
  return kept.map((pair) => pair.trim()).join("; ");
}

function cookie(site: Site, pair: string, scope: string[], maxAge: number) {
  const fixed = ["HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  const secure = site.secure ? ["Secure"] : [];
  return [pair, ...scope, ...fixed, ...secure].join("; ");
}

export function sessionCookie(site: Site, token: string, maxAge: number) {
  const [domain] = site.baseHost.split(":");
  const scope = [`Domain=${domain}`, "Path=/"];
  return cookie(site, `${SESSION_COOKIE}=${token}`, scope, maxAge);
}

export function accountCookie(site: Site, token: string, maxAge: number) {
  const pair = `${accountCookieName(site)}=${token}`;
  return cookie(site, pair, ["Path=/"], maxAge);
}

export function oauthCookie(site: Site, value: string, maxAge: number) {
  return cookie(site, `${OAUTH_COOKIE}=${value}`, ["Path=/auth"], maxAge);
}

export async function visitor(request: Request, site: Site) {
  const token = readCookie(request, SESSION_COOKIE);
  return token === null ? null : store.sessionUser(site.db, token);
}

export function accountToken(request: Request, site: Site) {
  return readCookie(request, accountCookieName(site));
}

export async function accountHolder(request: Request, site: Site) {
  const token = accountToken(request, site);
  return token === null ? null : store.sessionUser(site.db, token);
}

export function tunnelStub(site: Site, serverId: string) {
  const tunnels = site.env.TUNNEL_DO;
  return tunnels.get(tunnels.idFromName(serverId));
}

export async function closeTunnel(site: Site, serverId: string) {
  const headers = { [CLOSE_HEADER]: "1" };
  const request = new Request("https://tunnel/close", { headers });
  await tunnelStub(site, serverId)
    .fetch(request)
    .catch(() => null);
}

export function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  return /^Bearer (\S+)$/u.exec(authorization)?.[1] ?? null;
}

export function isOwnAddress(site: Site, candidate: string): boolean {
  try {
    const { host, protocol } = new URL(candidate);
    const ours = host === site.baseHost || host.endsWith(`.${site.baseHost}`);
    return ours && `${protocol}//` === site.apexOrigin.split(site.baseHost)[0];
  } catch {
    return false;
  }
}
