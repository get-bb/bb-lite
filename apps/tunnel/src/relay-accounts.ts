import * as wire from "@bb/tunnel-contract";
import * as accounts from "./accounts.js";

export interface RelayAccountsOptions {
  relayUrl: string;
  relaySecret: string;
  cacheMs?: number;
}

interface Resolution {
  server: { id: string; label: string; ownerId: string } | null;
  address?: string;
  user?: {
    id: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
  } | null;
  linked?: boolean;
  machineId?: string | null;
  oauth?: wire.McpGrant | null;
  oauthUnavailable?: boolean;
}

const SESSION_COOKIE = "bbr_session";
const MACHINE_HEADER = "x-bb-connect-machine";
const MACHINE_PATH = /^\/(internal(\/|$)|api\/v1(\/|$))/u;
const PRIVATE_HEADERS = /^(x-bb-gate-.*|x-bb-via-tunnel|x-relay-.*)$/u;
const RESERVED_COOKIE = /^(__(host|secure)-)?bbr_/iu;
const DEFAULT_CACHE_MS = 60_000;
const MISS_CACHE_MS = 5_000;

export function relayAccounts(
  options: RelayAccountsOptions,
): accounts.Accounts {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;

  async function ask(body: Record<string, string>): Promise<Resolution> {
    const response = await fetch(`${options.relayUrl}/api/gate/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.relaySecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`the relay answered ${response.status}`);
    return (await response.json()) as Resolution;
  }

  const resolve = accounts.remembering(
    (key) => ask(JSON.parse(key) as Record<string, string>),
    (found) => {
      if (found.oauth != null) {
        return Math.min(cacheMs, wire.MCP_GRANT_CACHE_TTL_MS);
      }
      const missed = found.server === null || found.user === null;
      return missed ? Math.min(cacheMs, MISS_CACHE_MS) : cacheMs;
    },
  );
  const issuer = options.relayUrl.replace(/\/+$/u, "");
  const missing = () => {
    return accounts.plain(404, "Nothing is linked to this address.\n");
  };

  async function mcp(visit: accounts.Visit) {
    const { request, label, path, method, own } = visit;
    const cut = path.indexOf("?");
    const pathname = cut < 0 ? path : path.slice(0, cut);
    const reading = method === "GET" || method === "HEAD";
    if (wire.isMcpMetadataPath(pathname) && reading) {
      const found = await resolve(JSON.stringify({ label }));
      if (found.server === null) return missing();
      const headers = {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      };
      const body = wire.mcpProtectedResourceMetadata(own, issuer);
      return { status: 200, headers, body: JSON.stringify(body) };
    }
    if (pathname !== wire.MCP_PUBLIC_PATH) return null;
    const challenge = (error: "invalid_token" | null) => {
      const headers = {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": wire.mcpChallenge(own, error),
      };
      const body = JSON.stringify({ error: "unauthorized" });
      return { status: 401, headers, body };
    };
    const authorization = accounts.header(request, "authorization");
    const offered = wire.readBearerToken(authorization);
    const resource = wire.mcpResourceForOrigin(own);
    const asked = offered === null ? { label } : { label, oauth: offered };
    const found = await resolve(JSON.stringify({ ...asked, resource }));
    const { server, address } = found;
    if (server === null || address === undefined) return missing();
    if (offered === null) return challenge(null);
    if (found.oauthUnavailable === true) {
      const message = "MCP is not set up on this relay";
      return accounts.refuse(503, "mcp_unavailable", message);
    }
    if (found.oauth == null) return challenge("invalid_token");
    return {
      identity: wire.mcpForwardHeaders(found.oauth),
      address,
      path: `${wire.MCP_LOCAL_PATH}${cut < 0 ? "" : path.slice(cut)}`,
      dropHeaders: ["authorization", "cookie"],
    };
  }

  return {
    shares: false,
    isPlatformCookie: (name) => RESERVED_COOKIE.test(name),
    isPrivateHeader: (name) => {
      return PRIVATE_HEADERS.test(name) || name === MACHINE_HEADER;
    },
    async admit(visit) {
      const { request, label, path, method, own } = visit;
      const answered = visit.target === null ? await mcp(visit) : null;
      if (answered !== null) return answered;
      const machine = accounts.header(request, MACHINE_HEADER);
      const cookies = accounts.header(request, "cookie") ?? "";
      const session = accounts.readCookie(cookies, SESSION_COOKIE);
      const byMachine = MACHINE_PATH.test(path) && machine !== undefined;
      const credential: Record<string, string> = byMachine
        ? { machine }
        : session === null
          ? {}
          : { session };
      const found = await resolve(JSON.stringify({ label, ...credential }));
      const { server, address } = found;
      if (server === null || address === undefined) {
        return accounts.plain(404, "Nothing is linked to this address.\n");
      }
      const forbidden = "This machine is not authorized here";
      if (byMachine) {
        if (found.machineId == null) {
          return accounts.refuse(403, "forbidden", forbidden);
        }
        const identity = {
          "x-bb-gate-auth": "machine",
          "x-bb-gate-machine-id": found.machineId,
        };
        return { identity, address };
      }
      if (path.startsWith("/internal")) {
        return accounts.refuse(403, "forbidden", forbidden);
      }
      const user = found.user ?? null;
      if (user === null) {
        const accept = accounts.header(request, "accept") ?? "";
        if (method !== "GET" || !accept.includes("text/html")) {
          const message = "Sign in to the relay first";
          return accounts.refuse(401, "unauthenticated", message);
        }
        const next = encodeURIComponent(`${own}${path}`);
        const location = `${options.relayUrl}/login?next=${next}`;
        return { status: 302, headers: { location }, body: "" };
      }
      if (accounts.isForeignOrigin(visit)) {
        const message = "This request came from another site";
        return accounts.refuse(403, "forbidden_origin", message);
      }
      const identity: Record<string, string> = {
        "x-bb-gate-auth": "session",
        "x-bb-gate-user-id": user.id,
        "x-bb-gate-user-name": encodeURIComponent(user.name),
        "x-bb-gate-owner": user.id === server.ownerId ? "1" : "0",
      };
      if (user.email !== null) {
        identity["x-bb-gate-user-email"] = encodeURIComponent(user.email);
      }
      if (user.avatarUrl !== null) {
        identity["x-bb-gate-user-avatar"] = encodeURIComponent(user.avatarUrl);
      }
      return { identity, address };
    },
    async linked(label, credential) {
      return (await ask({ label, credential })).linked === true;
    },
  };
}
