import * as http from "node:http";
import type { Duplex } from "node:stream";
import {
  header,
  plain,
  type Accounts,
  type Admitted,
  type Refusal,
} from "./accounts.js";

export interface GateOptions {
  baseHost: string;
  secure: boolean;
  accounts: Accounts;
  upstream: { host: string; port: number };
  log(message: string): void;
  headTimeoutMs?: number;
  hostLabels?: Record<string, string>;
}

interface Admission {
  headers: http.OutgoingHttpHeaders;
  responseHeaders: Record<string, string>;
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

const LABEL = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/u;
const SHARE = /^(.+)--(\d{1,5})$/u;
const HOP_HEADERS =
  /^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade)$/iu;
const COOKIE_DOMAIN = /;\s*domain\s*(?:=|;|$)/iu;
const COMBINED_COOKIES = /,\s*[^\s;=,]+=/u;
const DEFAULT_HEAD_TIMEOUT_MS = 120_000;
const OFFLINE = "This bb server is not connected right now.\n";

export function createGate(options: GateOptions) {
  const { accounts, baseHost, upstream, log } = options;
  const [subdomainHost = baseHost] = baseHost.split(":");
  const scheme = options.secure ? "https" : "http";
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const online = new Map<string, Set<string>>();

  function addressOf(host: string | undefined) {
    const name = host?.toLowerCase() ?? "";
    const alias = options.hostLabels?.[name];
    if (alias !== undefined) return { label: alias, target: null };
    if (!name.endsWith(`.${baseHost}`)) return null;
    const first = name.slice(0, -baseHost.length - 1);
    const share = SHARE.exec(first);
    const [label = first, target = null] = share === null ? [] : share.slice(1);
    if (!LABEL.test(label) || label.includes("--")) return null;
    return target !== null && !accounts.shares ? null : { label, target };
  }

  function withoutPlatformCookies(cookies: string) {
    const kept = cookies.split(";").filter((pair) => {
      const [key = ""] = pair.split("=");
      return key.trim() !== "" && !accounts.isPlatformCookie(key.trim());
    });
    return kept.map((pair) => pair.trim()).join("; ");
  }

  function isPlatformSetCookie(cookie: string): boolean {
    const [name = ""] = cookie.split("=");
    if (accounts.isPlatformCookie(name.trim())) return true;
    return COOKIE_DOMAIN.test(cookie) || COMBINED_COOKIES.test(cookie);
  }

  function relayedHeaders(
    answer: http.IncomingMessage,
    replaced: Record<string, string> = {},
  ): string[] {
    const raw = answer.rawHeaders;
    const kept: string[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index] ?? "";
      const value = raw[index + 1] ?? "";
      const lower = name.toLowerCase();
      if (HOP_HEADERS.test(name) || lower in replaced) continue;
      if (lower === "set-cookie" && isPlatformSetCookie(value)) continue;
      kept.push(name, value);
    }
    return [...kept, ...Object.entries(replaced).flat()];
  }

  function forwarded(
    request: http.IncomingMessage,
    label: string,
    own: string,
    admitted: Admitted,
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_HEADERS.test(name)) continue;
      if (accounts.isPrivateHeader(name)) continue;
      headers[name] = value;
    }
    const cookies = withoutPlatformCookies(header(request, "cookie") ?? "");
    if (cookies === "") delete headers.cookie;
    else headers.cookie = cookies;
    if (headers.origin === own) {
      headers.origin = new URL(admitted.address).origin;
    }
    headers.host = `${label}.${subdomainHost}`;
    return { ...headers, ...admitted.identity };
  }

  async function admit(
    request: http.IncomingMessage,
  ): Promise<Refusal | Admission> {
    const host = header(request, "host");
    const address = addressOf(host);
    if (address === null) return plain(404, "This is not a bb-next address.\n");
    const { label, target } = address;
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    const own = `${scheme}://${host}`;
    const visit = { request, label, target, method, path, own };
    const outcome = await accounts.admit(visit);
    if ("status" in outcome) return outcome;
    if ((online.get(label)?.size ?? 0) === 0) return plain(503, OFFLINE);
    return {
      headers: forwarded(request, label, own, outcome),
      responseHeaders: outcome.responseHeaders ?? {},
    };
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
    const { headers, responseHeaders } = outcome;
    const target = { ...upstream, method, path, headers, agent };
    const outgoing = http.request(target, (answer) => {
      clearTimeout(deadline);
      const relayed = relayedHeaders(answer, responseHeaders);
      response.writeHead(answer.statusCode ?? 502, relayed);
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
      const linked = await accounts.linked(label, credential);
      return linked ? accept : reject("credential refused");
    }
    const runId = (typeof user === "string" ? undefined : user?.run_id) ?? "";
    if (op === "NewProxy") {
      const domains = content.custom_domains ?? [];
      const own = content.proxy_type === "http" && content.subdomain === label;
      if (!own || domains.length > 0) {
        return reject("not this server's address");
      }
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
