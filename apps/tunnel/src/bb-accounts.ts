import { createHmac, timingSafeEqual } from "node:crypto";
import * as accounts from "./accounts.js";

export interface BbAccountsOptions {
  accountUrl: string;
  serverBase: string;
  secureCookies: boolean;
  cacheMs?: number;
  resolveServerHost?(label: string): string;
  ownerCredentialHeader?: string;
  ownerCredentialCookie?: string;
  entryKey?: string;
}

interface ServerList {
  status: number;
  handles: string[];
}

const MACHINE_HEADER = "x-bb-connect-machine";
const TARGET_HEADER = "x-bb-tunnel-target";
const PRIVATE_HEADERS =
  /^(x-bb-gate-.*|x-bb-relay.*|x-bb-frp-token|x-bb-cloud-dev-host)$/u;
const PLATFORM_COOKIE =
  /^(__Secure-better-auth\.|better-auth\.|__Secure-bb-connect\.|bb-connect\.)/u;
const INSTALL_PATHS = [
  "/install.sh",
  "/install.ps1",
  "/install/version",
  "/install/bb-app.tgz",
];
const MACHINE_PATH = /^\/(internal(\/|$)|api\/v1(\/|$))/u;
const DEFAULT_CACHE_MS = 20_000;
const ENTRY_PATH = "/__gate/enter";
const ENTRY_COOKIE = "bb-gate-entry";
const ENTRY_SESSION_MS = 12 * 60 * 60_000;

export function signEntry(
  key: string,
  purpose: "enter" | "session",
  label: string,
  expiresAt: number,
): string {
  const signed = `${purpose}\n${label}\n${expiresAt}`;
  const mac = createHmac("sha256", key).update(signed).digest("hex");
  return `${expiresAt}.${mac}`;
}

function isValidEntry(
  key: string | undefined,
  purpose: "enter" | "session",
  label: string,
  offered: string | null,
): boolean {
  if (key === undefined || offered === null) return false;
  const expiresAt = Number(offered.split(".")[0]);
  if (!Number.isInteger(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(signEntry(key, purpose, label, expiresAt));
  const given = Buffer.from(offered);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function installHeaders(path: string): Record<string, string> {
  const hardened = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  };
  if (path !== "/install/bb-app.tgz") {
    return { ...hardened, "content-type": "text/plain; charset=utf-8" };
  }
  return {
    ...hardened,
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="bb-app.tgz"',
  };
}

export function bbAccounts(options: BbAccountsOptions): accounts.Accounts {
  const accountUrl = new URL(options.accountUrl);
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const sessionCookie = options.secureCookies
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  const addressOf = (label: string, target: string | null) => {
    const name = target === null ? label : `${label}--${target}`;
    return `${accountUrl.protocol}//${name}.${options.serverBase}`;
  };

  const serversOf = accounts.remembering(
    async (key): Promise<ServerList> => {
      const [label = "", session = ""] = key.split("\n");
      const address = new URL(addressOf(label, null));
      const host = options.resolveServerHost?.(label) ?? address.host;
      const url = `${address.protocol}//${host}/api/connect/servers`;
      const response = await fetch(url, {
        headers: { cookie: `${sessionCookie}=${session}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const listed: unknown = await response.json().catch(() => null);
      const servers: unknown[] =
        listed !== null &&
        typeof listed === "object" &&
        "servers" in listed &&
        Array.isArray(listed.servers)
          ? listed.servers
          : [];
      const handles = servers.flatMap((entry) => {
        const named =
          entry !== null && typeof entry === "object" && "handle" in entry;
        return named && typeof entry.handle === "string" ? [entry.handle] : [];
      });
      return { status: response.status, handles };
    },
    () => cacheMs,
  );

  async function linked(label: string, credential: string) {
    const response = await fetch(new URL("/api/account/me", accountUrl), {
      headers: {
        authorization: `Bearer ${credential}`,
        [MACHINE_HEADER]: credential,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      throw new Error(`the account service answered ${response.status}`);
    }
    const me: unknown = await response.json().catch(() => null);
    const named = me !== null && typeof me === "object" && "serverLabel" in me;
    return named && me.serverLabel === label;
  }

  const ownsServer = accounts.remembering(
    (key) => {
      const [label = "", credential = ""] = key.split("\n");
      return linked(label, credential);
    },
    () => cacheMs,
  );
  const ownerHeader = options.ownerCredentialHeader?.toLowerCase();
  const ownerCookie = options.ownerCredentialCookie;
  const offeredCredential = (request: accounts.Visit["request"]) => {
    const sent =
      ownerHeader === undefined
        ? undefined
        : accounts.header(request, ownerHeader);
    if (sent !== undefined || ownerCookie === undefined) return sent;
    const cookies = accounts.header(request, "cookie") ?? "";
    return accounts.readCookie(cookies, ownerCookie) ?? undefined;
  };

  return {
    shares: true,
    isPlatformCookie: (name) => {
      const own = name === ownerCookie || name === ENTRY_COOKIE;
      return own || PLATFORM_COOKIE.test(name);
    },
    isPrivateHeader: (name) => {
      const reserved = name === MACHINE_HEADER || name === TARGET_HEADER;
      return reserved || name === ownerHeader || PRIVATE_HEADERS.test(name);
    },
    async admit(visit) {
      const { request, label, target, path, method, own } = visit;
      const pathname = path.split("?")[0] ?? path;
      const address = addressOf(label, target);
      const targeted: Record<string, string> =
        target === null ? {} : { [TARGET_HEADER]: target };
      const cookies = accounts.header(request, "cookie") ?? "";
      if (pathname === ENTRY_PATH && target === null) {
        const token = new URL(path, own).searchParams.get("token");
        if (!isValidEntry(options.entryKey, "enter", label, token)) {
          return accounts.plain(
            403,
            "bb connect: this entry link has expired\n",
          );
        }
        const until = Date.now() + ENTRY_SESSION_MS;
        const value = signEntry(
          options.entryKey ?? "",
          "session",
          label,
          until,
        );
        const lasting = `Max-Age=${ENTRY_SESSION_MS / 1_000}`;
        const scope = `Path=/; HttpOnly; SameSite=Lax; ${lasting}`;
        const secure = own.startsWith("https:") ? "; Secure" : "";
        const issued = `${ENTRY_COOKIE}=${value}; ${scope}${secure}`;
        const headers = { location: "/", "set-cookie": issued };
        return { status: 302, headers, body: "" };
      }
      if (pathname.startsWith("/__")) {
        return accounts.plain(404, "bb connect: not found\n");
      }
      if (method === "GET" && INSTALL_PATHS.includes(pathname)) {
        if (target !== null) {
          return accounts.plain(404, "bb connect: not found\n");
        }
        const responseHeaders = installHeaders(pathname);
        return { identity: {}, address, responseHeaders };
      }
      const machine = accounts.header(request, MACHINE_HEADER);
      const internal = pathname.startsWith("/internal");
      if (internal || (MACHINE_PATH.test(pathname) && machine !== undefined)) {
        const message = "bb connect: machines are not served on this address\n";
        return accounts.plain(target === null ? 403 : 404, message);
      }
      const identity = { "x-bb-gate-auth": "session", ...targeted };
      const offered = offeredCredential(request);
      if (offered !== undefined) {
        const owns = await ownsServer(`${label}\n${offered}`);
        if (owns) return { identity, address };
        return accounts.plain(403, "bb connect: not your server\n");
      }
      const entered = accounts.readCookie(cookies, ENTRY_COOKIE);
      if (isValidEntry(options.entryKey, "session", label, entered)) {
        return { identity, address };
      }
      const session = accounts.readCookie(cookies, sessionCookie);
      const signIn = (): accounts.Refusal => {
        const accept = accounts.header(request, "accept") ?? "";
        if (method !== "GET" || !accept.includes("text/html")) {
          return accounts.plain(401, "bb connect: sign in to open this bb\n");
        }
        const dashboard = new URL("/dashboard", accountUrl);
        dashboard.searchParams.set("returnTo", `${own}${path}`);
        const headers = { location: dashboard.toString() };
        return { status: 302, headers, body: "" };
      };
      if (session === null) return signIn();
      const listed = await serversOf(`${label}\n${session}`);
      if (listed.status === 401) return signIn();
      if (listed.status === 404) {
        return accounts.plain(404, `bb connect: no server for "${label}"\n`);
      }
      if (listed.status !== 200) {
        throw new Error(`the account service answered ${listed.status}`);
      }
      if (!listed.handles.includes(label)) {
        return accounts.plain(403, "bb connect: not your server\n");
      }
      return { identity, address };
    },
    linked,
  };
}
