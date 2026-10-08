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
      const missed = found.server === null || found.user === null;
      return missed ? Math.min(cacheMs, MISS_CACHE_MS) : cacheMs;
    },
  );

  return {
    shares: false,
    isPlatformCookie: (name) => RESERVED_COOKIE.test(name),
    isPrivateHeader: (name) => {
      return PRIVATE_HEADERS.test(name) || name === MACHINE_HEADER;
    },
    async admit(visit) {
      const { request, label, path, method, own } = visit;
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
