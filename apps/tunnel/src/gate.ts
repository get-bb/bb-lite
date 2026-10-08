import * as http from "node:http";
import type { Duplex } from "node:stream";

export interface GateOptions {
  baseHost: string;
  secure: boolean;
  relayUrl: string;
  relaySecret: string;
  upstream: { host: string; port: number };
  log(message: string): void;
  cacheMs?: number;
  headTimeoutMs?: number;
}

interface Visitor {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

interface Resolution {
  server: { id: string; label: string; ownerId: string } | null;
  address?: string;
  user?: Visitor | null;
  linked?: boolean;
  machineId?: string | null;
}

interface Refusal {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Admission {
  headers: http.OutgoingHttpHeaders;
}

interface PluginCall {
  op?: string;
  content?: {
    user?: string | { user?: string; run_id?: string };
    run_id?: string;
    metas?: Record<string, string>;
    proxy_type?: string;
    subdomain?: string;
    custom_domains?: string[] | null;
  };
}

const SESSION_COOKIE = "bbr_session";
const MACHINE_HEADER = "x-bb-connect-machine";
const LABEL = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/u;
const MACHINE_PATH = /^\/(internal(\/|$)|api\/v1(\/|$))/u;
const STRIPPED_HEADERS = /^(x-bb-gate-.*|x-bb-via-tunnel|x-relay-.*)$/u;
const HOP_HEADERS =
  /^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade)$/iu;
const RESERVED_COOKIE = /^(__(host|secure)-)?bbr_/iu;
const COOKIE_DOMAIN = /;\s*domain\s*(?:=|;|$)/iu;
const COMBINED_COOKIES = /,\s*[^\s;=,]+=/u;
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const DEFAULT_CACHE_MS = 60_000;
const MISS_CACHE_MS = 5_000;
const CACHE_LIMIT = 20_000;
const DEFAULT_HEAD_TIMEOUT_MS = 120_000;
const OFFLINE = "This bb server is not connected right now.\n";

function header(request: http.IncomingMessage, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readCookie(cookies: string, name: string): string | null {
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return null;
}

function withoutRelayCookies(cookies: string) {
  const kept = cookies.split(";").filter((pair) => {
    const [key = ""] = pair.split("=");
    return key.trim() !== "" && !RESERVED_COOKIE.test(key.trim());
  });
  return kept.map((pair) => pair.trim()).join("; ");
}

function isRelayCookie(cookie: string): boolean {
  const [name = ""] = cookie.split("=");
  if (RESERVED_COOKIE.test(name.trim())) return true;
  return COOKIE_DOMAIN.test(cookie) || COMBINED_COOKIES.test(cookie);
}

function plain(status: number, body: string): Refusal {
  const headers = { "content-type": "text/plain; charset=utf-8" };
  return { status, headers, body };
}

function refuse(status: number, code: string, message: string): Refusal {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  return { status, headers, body: JSON.stringify({ code, message }) };
}

function relayedHeaders(upstream: http.IncomingMessage): string[] {
  const raw = upstream.rawHeaders;
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";
    const value = raw[index + 1] ?? "";
    const cookie = name.toLowerCase() === "set-cookie";
    if (HOP_HEADERS.test(name) || (cookie && isRelayCookie(value))) continue;
    kept.push(name, value);
  }
  return kept;
}

export function createGate(options: GateOptions) {
  const { baseHost, upstream, log } = options;
  const [subdomainHost = baseHost] = baseHost.split(":");
  const scheme = options.secure ? "https" : "http";
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const known = new Map<
    string,
    { until: number; found: Promise<Resolution> }
  >();
  const online = new Map<string, Set<string>>();

  function labelOf(host: string | undefined): string | null {
    const name = host?.toLowerCase() ?? "";
    if (!name.endsWith(`.${baseHost}`)) return null;
    const label = name.slice(0, -baseHost.length - 1);
    return LABEL.test(label) && !label.includes("--") ? label : null;
  }

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

  function resolve(body: Record<string, string>): Promise<Resolution> {
    const key = JSON.stringify(body);
    const now = Date.now();
    const cached = known.get(key);
    if (cached !== undefined && cached.until > now) return cached.found;
    if (known.size > CACHE_LIMIT) known.clear();
    const found = ask(body);
    const entry = { until: now + cacheMs, found };
    known.set(key, entry);
    found.then(
      (resolution) => {
        const missed = resolution.server === null || resolution.user === null;
        if (missed) entry.until = now + Math.min(cacheMs, MISS_CACHE_MS);
      },
      () => known.delete(key),
    );
    return found;
  }

  function forwarded(
    request: http.IncomingMessage,
    label: string,
    address: string,
    identity: Record<string, string>,
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_HEADERS.test(name)) continue;
      if (STRIPPED_HEADERS.test(name) || name === MACHINE_HEADER) continue;
      headers[name] = value;
    }
    const cookies = withoutRelayCookies(header(request, "cookie") ?? "");
    if (cookies === "") delete headers.cookie;
    else headers.cookie = cookies;
    if (headers.origin !== undefined) headers.origin = new URL(address).origin;
    headers.host = `${label}.${subdomainHost}`;
    return { ...headers, ...identity };
  }

  async function admit(
    request: http.IncomingMessage,
  ): Promise<Refusal | Admission> {
    const host = header(request, "host");
    const label = labelOf(host);
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    if (label === null) return plain(404, "This is not a bb-next address.\n");
    const machine = header(request, MACHINE_HEADER);
    const cookies = header(request, "cookie") ?? "";
    const session = readCookie(cookies, SESSION_COOKIE);
    const byMachine = MACHINE_PATH.test(path) && machine !== undefined;
    const credential: Record<string, string> = byMachine
      ? { machine }
      : session === null
        ? {}
        : { session };
    const found = await resolve({ label, ...credential });
    const { server, address } = found;
    if (server === null || address === undefined) {
      return plain(404, "Nothing is linked to this address.\n");
    }
    const identity: Record<string, string> = {};
    if (byMachine) {
      if (found.machineId == null) {
        return refuse(403, "forbidden", "This machine is not authorized here");
      }
      identity["x-bb-gate-auth"] = "machine";
      identity["x-bb-gate-machine-id"] = found.machineId;
    } else {
      if (path.startsWith("/internal")) {
        return refuse(403, "forbidden", "This machine is not authorized here");
      }
      const user = found.user ?? null;
      const own = `${scheme}://${host}`;
      if (user === null) {
        const accept = header(request, "accept") ?? "";
        if (method !== "GET" || !accept.includes("text/html")) {
          return refuse(401, "unauthenticated", "Sign in to the relay first");
        }
        const next = encodeURIComponent(`${own}${path}`);
        const location = `${options.relayUrl}/login?next=${next}`;
        return { status: 302, headers: { location }, body: "" };
      }
      const origin = header(request, "origin");
      const upgrade = header(request, "upgrade") !== undefined;
      const guarded = !READ_METHODS.includes(method) || upgrade;
      if (origin !== undefined && guarded && origin !== own) {
        const message = "This request came from another site";
        return refuse(403, "forbidden_origin", message);
      }
      identity["x-bb-gate-auth"] = "session";
      identity["x-bb-gate-user-id"] = user.id;
      identity["x-bb-gate-user-name"] = encodeURIComponent(user.name);
      identity["x-bb-gate-owner"] = user.id === server.ownerId ? "1" : "0";
      if (user.email !== null) {
        identity["x-bb-gate-user-email"] = encodeURIComponent(user.email);
      }
      if (user.avatarUrl !== null) {
        identity["x-bb-gate-user-avatar"] = encodeURIComponent(user.avatarUrl);
      }
    }
    if ((online.get(label)?.size ?? 0) === 0) return plain(503, OFFLINE);
    return { headers: forwarded(request, label, address, identity) };
  }

  function isRefusal(outcome: Refusal | Admission): outcome is Refusal {
    return "status" in outcome;
  }

  function failed(error: unknown): Refusal {
    log(`gate error: ${String(error)}`);
    return plain(502, "The gate could not check this request.\n");
  }

  async function serve(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.url === "/__gate/health") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    const outcome = await admit(request).catch(failed);
    if (isRefusal(outcome)) {
      request.resume();
      response.writeHead(outcome.status, outcome.headers).end(outcome.body);
      return;
    }
    const { method, url: path } = request;
    const { headers } = outcome;
    const target = { ...upstream, method, path, headers, agent };
    const outgoing = http.request(target, (answer) => {
      clearTimeout(deadline);
      response.writeHead(answer.statusCode ?? 502, relayedHeaders(answer));
      answer.pipe(response);
    });
    const giveUp = (status: number, message: string) => {
      clearTimeout(deadline);
      outgoing.destroy();
      if (response.headersSent) return void response.destroy();
      const reply = plain(status, message);
      response.writeHead(reply.status, reply.headers).end(reply.body);
    };
    const deadline = setTimeout(() => {
      giveUp(504, "The bb server did not answer in time.\n");
    }, headTimeoutMs);
    outgoing.on("error", () => giveUp(502, OFFLINE));
    response.on("close", () => {
      clearTimeout(deadline);
      if (!response.writableFinished) outgoing.destroy();
    });
    request.pipe(outgoing);
  }

  function head(status: number, message: string, headers: string[]) {
    const lines = [`HTTP/1.1 ${status} ${message}`];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      lines.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    return `${lines.join("\r\n")}\r\n\r\n`;
  }

  async function upgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    first: Buffer,
  ): Promise<void> {
    socket.on("error", () => {});
    const outcome = await admit(request).catch(failed);
    if (isRefusal(outcome)) {
      const pairs = Object.entries(outcome.headers).flat();
      const close = ["connection", "close"];
      const message = http.STATUS_CODES[outcome.status] ?? "";
      const opening = head(outcome.status, message, [...pairs, ...close]);
      socket.end(`${opening}${outcome.body}`);
      return;
    }
    const wanted = header(request, "upgrade") ?? "websocket";
    const switching = { connection: "Upgrade", upgrade: wanted };
    const headers = { ...outcome.headers, ...switching };
    const outgoing = http.request({ ...upstream, path: request.url, headers });
    outgoing.on("error", () => socket.destroy());
    outgoing.on("response", (answer) => {
      const code = answer.statusCode ?? 502;
      const message = answer.statusMessage ?? "";
      const close = ["connection", "close"];
      socket.write(head(code, message, [...relayedHeaders(answer), ...close]));
      answer.pipe(socket);
    });
    outgoing.on("upgrade", (answer, tunnel, rest) => {
      tunnel.on("error", () => socket.destroy());
      socket.on("error", () => tunnel.destroy());
      const kept = relayedHeaders(answer);
      const accepted = ["Connection", "Upgrade", "Upgrade", wanted];
      socket.write(head(101, "Switching Protocols", [...accepted, ...kept]));
      if (rest.length > 0) socket.write(rest);
      if (first.length > 0) tunnel.write(first);
      tunnel.pipe(socket);
      socket.pipe(tunnel);
      tunnel.on("close", () => socket.destroy());
      socket.on("close", () => tunnel.destroy());
    });
    outgoing.end();
  }

  async function plugin(call: PluginCall): Promise<object> {
    const accept = { reject: false, unchange: true };
    const reject = (reason: string) => {
      return { reject: true, reject_reason: reason };
    };
    const { op, content = {} } = call;
    const { user } = content;
    const label = typeof user === "string" ? user : (user?.user ?? "");
    if (!LABEL.test(label)) return reject("unknown server");
    if (op === "Login") {
      const credential = content.metas?.credential ?? "";
      if (credential === "") return reject("missing credential");
      const found = await ask({ label, credential });
      return found.linked === true ? accept : reject("credential refused");
    }
    const runId = (typeof user === "string" ? undefined : user?.run_id) ?? "";
    if (op === "NewProxy") {
      const domains = content.custom_domains ?? [];
      const own = content.proxy_type === "http" && content.subdomain === label;
      if (!own || domains.length > 0)
        return reject("not this server's address");
      online.set(label, (online.get(label) ?? new Set()).add(runId));
      log(`${label} connected`);
      return accept;
    }
    if (op === "CloseProxy") {
      online.get(label)?.delete(runId);
      log(`${label} disconnected`);
    }
    return accept;
  }

  const web = http.createServer((request, response) => {
    serve(request, response).catch((error: unknown) => {
      log(`gate error: ${String(error)}`);
      response.destroy();
    });
  });
  web.on("upgrade", (request, socket, first) => {
    upgrade(request, socket, first).catch(() => socket.destroy());
  });

  const hooks = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const answer = (async () => {
        const call = JSON.parse(Buffer.concat(chunks).toString()) as PluginCall;
        return plugin(call);
      })().catch((error: unknown) => {
        log(`frp hook error: ${String(error)}`);
        return { reject: true, reject_reason: "the gate could not check this" };
      });
      void answer.then((body) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
  });

  return { web, hooks };
}
