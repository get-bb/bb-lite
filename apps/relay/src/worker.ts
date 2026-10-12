import * as wire from "@bb/tunnel-contract";
import { apex, connectApi } from "./account.js";
import * as hosted from "./hosted.js";
import * as oauth from "./oauth.js";
import * as pages from "./pages.js";
import * as site from "./site.js";
import * as store from "./store.js";
import { TunnelDO } from "./tunnel-do.js";

export { TunnelDO };

type Site = site.Site;

interface Address {
  label: string;
  port: string | null;
}

interface Progress {
  stage: "routing" | "tunnel";
}

const SHARE = /^(.+)--(\d{1,5})$/u;
const MACHINE_PATH = /^\/(internal(\/|$)|api\/v1(\/|$))/u;
const STRIPPED_HEADERS = /^(x-bb-gate-.*|x-bb-via-tunnel|x-relay-.*)$/u;
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const REPLAYABLE_METHODS = ["GET", "HEAD"];
const TUNNEL_RETRY_DELAYS_MS = [50, 250];
const GATE_DEADLINE_MS = 120_000;

function addressOf(host: string, baseHost: string): Address | null {
  if (!host.endsWith(`.${baseHost}`)) return null;
  const name = host.slice(0, -baseHost.length - 1);
  if (name.includes(".")) return null;
  const share = SHARE.exec(name);
  const [label = name, port = null] = share === null ? [] : share.slice(1);
  return site.isValidLabel(label) ? { label, port } : null;
}

function refuse(status: number, code: string, message: string) {
  return site.json({ code, message }, status);
}

function wantsPage(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return request.method === "GET" && accept.includes("text/html");
}

function isForeignOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const upgrade = request.headers.get("upgrade") !== null;
  if (READ_METHODS.includes(request.method) && !upgrade) return false;
  return origin !== new URL(request.url).origin;
}

function offline() {
  const headers = { [site.OFFLINE_HEADER]: "1" };
  const message = "This bb server is not connected right now.\n";
  return new Response(message, { status: 503, headers });
}

async function toTunnel(
  context: Site,
  serverId: string,
  request: Request,
  progress: Progress,
): Promise<Response> {
  progress.stage = "tunnel";
  const replayable = REPLAYABLE_METHODS.includes(request.method);
  for (let attempt = 0; ; attempt += 1) {
    const stub = site.tunnelStub(context, serverId);
    const outgoing = replayable ? new Request(request) : request;
    try {
      return await stub.fetch(outgoing);
    } catch {
      const delay = TUNNEL_RETRY_DELAYS_MS[attempt];
      if (!replayable || delay === undefined) return offline();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function forward(
  request: Request,
  context: Site,
  server: store.Server,
  port: string | null,
  identity: Record<string, string>,
  progress: Progress,
) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (STRIPPED_HEADERS.test(name)) headers.delete(name);
  }
  headers.delete(site.MACHINE_HEADER);
  const cookies = site.withoutRelayCookies(headers.get("cookie"));
  if (cookies === "") headers.delete("cookie");
  else headers.set("cookie", cookies);
  for (const [name, value] of Object.entries(identity)) {
    headers.set(name, value);
  }
  if (port !== null) headers.set(site.TARGET_HEADER, port);
  const forwarded = new Request(request, { headers });
  return toTunnel(context, server.id, forwarded, progress);
}

function forwardMcp(
  request: Request,
  context: Site,
  server: store.Server,
  grant: wire.McpGrant,
  progress: Progress,
) {
  const target = new URL(request.url);
  target.pathname = wire.MCP_LOCAL_PATH;
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (STRIPPED_HEADERS.test(name)) headers.delete(name);
  }
  for (const name of [site.MACHINE_HEADER, "authorization", "cookie"]) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(wire.mcpForwardHeaders(grant))) {
    headers.set(name, value);
  }
  const moved = new Request(target, request);
  const forwarded = new Request(moved, { headers });
  return toTunnel(context, server.id, forwarded, progress);
}

async function mcp(
  request: Request,
  context: Site,
  server: store.Server,
  progress: Progress,
): Promise<Response | null> {
  const { origin, pathname: path } = new URL(request.url);
  if (wire.isMcpLocalPath(path)) {
    return refuse(404, "not_found", "There is nothing at this path");
  }
  const reading = request.method === "GET" || request.method === "HEAD";
  if (wire.isMcpMetadataPath(path) && reading) {
    const { apexOrigin } = context;
    const body = wire.mcpProtectedResourceMetadata(origin, apexOrigin);
    const headers = { "cache-control": "public, max-age=300" };
    return Response.json(body, { headers });
  }
  if (path !== wire.MCP_PUBLIC_PATH) return null;
  const challenge = (error: "invalid_token" | null) => {
    const headers = {
      "cache-control": "no-store",
      "www-authenticate": wire.mcpChallenge(origin, error),
    };
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  };
  const offered = wire.readBearerToken(request.headers.get("authorization"));
  if (offered === null) return challenge(null);
  const resource = wire.mcpResourceForOrigin(origin);
  const grant = await oauth.admit(context, offered, resource, server);
  if (grant === "unconfigured") {
    return refuse(503, "mcp_unavailable", oauth.SECRET_MISSING);
  }
  if (grant === null) return challenge("invalid_token");
  return forwardMcp(request, context, server, grant, progress);
}

async function openTunnel(
  request: Request,
  context: Site,
  server: store.Server,
  ctx: ExecutionContext,
  progress: Progress,
) {
  const credential = site.bearer(request);
  const linked =
    credential === null
      ? null
      : await store.serverByCredential(context.db, credential);
  if (linked?.id !== server.id) {
    return refuse(401, "unauthorized", "This credential is not accepted");
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(400, "invalid_request", "Expected a WebSocket upgrade");
  }
  ctx.waitUntil(store.touchServer(context.db, server.id));
  const headers = new Headers(request.headers);
  headers.set(site.TUNNEL_HEADER, "1");
  const dial = new Request(request, { headers });
  return toTunnel(context, server.id, dial, progress);
}

async function withinDeadline(
  context: Site,
  ctx: ExecutionContext,
  handle: (progress: Progress) => Promise<Response>,
): Promise<Response> {
  const progress: Progress = { stage: "routing" };
  const limit = Number(context.env.GATE_DEADLINE_MS) || GATE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), limit);
  });
  const handled = handle(progress);
  const first = await Promise.race([handled, late]);
  if (timer !== undefined) clearTimeout(timer);
  if (first !== null) return first;
  const discard = handled.then(
    (response) => {
      response.webSocket?.accept();
      response.webSocket?.close(1001, "gate deadline");
      return response.body?.cancel();
    },
    () => undefined,
  );
  ctx.waitUntil(discard);
  const message = `The relay timed out (stage: ${progress.stage})`;
  return refuse(504, "gateway_timeout", message);
}

async function gate(
  request: Request,
  context: Site,
  address: Address,
  ctx: ExecutionContext,
  progress: Progress,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const { label, port } = address;
  const server = await store.serverByLabel(context.db, label);
  if (server === null) {
    const message = "Nothing is linked to this address.";
    return pages.notice("No bb server here", message, 404, context.apexOrigin);
  }
  if (path === "/__tunnel" && port === null) {
    return openTunnel(request, context, server, ctx, progress);
  }
  if (path.startsWith("/api/connect/") && port === null) {
    return connectApi(request, context, path);
  }
  const answered =
    port === null ? await mcp(request, context, server, progress) : null;
  if (answered !== null) return answered;
  const machineCredential = request.headers.get(site.MACHINE_HEADER);
  if (MACHINE_PATH.test(path) && machineCredential !== null) {
    const machine =
      port === null
        ? await store.machineByCredential(context.db, machineCredential)
        : null;
    if (machine?.server_id !== server.id) {
      return refuse(403, "forbidden", "This machine is not authorized here");
    }
    const identity = {
      "x-bb-gate-auth": "machine",
      "x-bb-gate-machine-id": machine.id,
    };
    return forward(request, context, server, null, identity, progress);
  }
  if (path.startsWith("/internal")) {
    return refuse(403, "forbidden", "This machine is not authorized here");
  }
  const user = await site.visitor(request, context);
  if (user === null) {
    if (!wantsPage(request)) {
      return refuse(401, "unauthenticated", "Sign in to the relay first");
    }
    const next = encodeURIComponent(url.toString());
    const location = `${context.apexOrigin}/login?next=${next}`;
    return new Response(null, { status: 302, headers: { location } });
  }
  if (isForeignOrigin(request)) {
    return refuse(
      403,
      "forbidden_origin",
      "This request came from another site",
    );
  }
  const owner = user.id === server.user_id;
  if (port !== null && !owner) {
    return refuse(403, "forbidden", "Only the server's owner can open a share");
  }
  const identity: Record<string, string> = {
    "x-bb-gate-auth": "session",
    "x-bb-gate-user-id": user.id,
    "x-bb-gate-user-name": encodeURIComponent(user.name),
    "x-bb-gate-owner": owner ? "1" : "0",
  };
  if (user.email !== null) {
    identity["x-bb-gate-user-email"] = encodeURIComponent(user.email);
  }
  if (user.avatar_url !== null) {
    identity["x-bb-gate-user-avatar"] = encodeURIComponent(user.avatar_url);
  }
  if (server.hosted_state === null || port !== null) {
    return forward(request, context, server, port, identity, progress);
  }
  const page = wantsPage(request);
  const held = hosted.hold(request, context, server, owner, page, ctx);
  if (held !== null) return held;
  const answer = await forward(
    request,
    context,
    server,
    null,
    identity,
    progress,
  );
  if (answer.headers.get(site.OFFLINE_HEADER) !== "1") return answer;
  return hosted.offline(context, server, owner, page, ctx) ?? answer;
}

export async function route(
  request: Request,
  env: site.Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const context = site.siteOf(request, env);
  const host = new URL(request.url).host.toLowerCase();
  const { baseHost, apexOrigin } = context;
  if (host === baseHost) return apex(request, context);
  if (host === `www.${baseHost}`) return Response.redirect(apexOrigin, 302);
  const address = addressOf(host, baseHost);
  if (address === null) {
    const message = "This is not a bb-next address.";
    return pages.notice("Not found", message, 404, apexOrigin);
  }
  return withinDeadline(context, ctx, (progress) =>
    gate(request, context, address, ctx, progress),
  );
}

export async function scheduled(env: site.Env): Promise<void> {
  await hosted.sweep(env);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const answer = await route(request, env, ctx);
    return answer ?? site.json({ error: "not_found" }, 404);
  },
  scheduled: (_event, env) => scheduled(env),
} satisfies ExportedHandler<site.Env>;
