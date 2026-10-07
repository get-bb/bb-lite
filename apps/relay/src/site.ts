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

export function siteOf(request: Request, env: Env): Site {
  const { protocol } = new URL(request.url);
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

export function withoutCookie(header: string | null, name: string) {
  const kept = (header ?? "").split(";").filter((pair) => {
    const [key = ""] = pair.split("=");
    return key.trim() !== "" && key.trim() !== name;
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

export function oauthCookie(site: Site, value: string, maxAge: number) {
  return cookie(site, `${OAUTH_COOKIE}=${value}`, ["Path=/auth"], maxAge);
}

export async function visitor(request: Request, site: Site) {
  const token = readCookie(request, SESSION_COOKIE);
  return token === null ? null : store.sessionUser(site.db, token);
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
