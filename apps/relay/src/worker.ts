import { apex, connectApi } from "./account.js";
import * as pages from "./pages.js";
import * as site from "./site.js";
import * as store from "./store.js";
import { TARGET_HEADER, TUNNEL_HEADER, TunnelDO } from "./tunnel-do.js";

export { TunnelDO };

type Site = site.Site;

interface Address {
  label: string;
  port: string | null;
}

const SHARE = /^(.+)--(\d{1,5})$/u;
const MACHINE_PATH = /^\/(internal(\/|$)|api\/v1(\/|$))/u;
const STRIPPED_HEADERS = /^(x-bb-gate-.*|x-bb-via-tunnel|x-relay-.*)$/u;
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

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

function forward(
  request: Request,
  context: Site,
  server: store.Server,
  port: string | null,
  identity: Record<string, string>,
) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (STRIPPED_HEADERS.test(name)) headers.delete(name);
  }
  headers.delete(site.MACHINE_HEADER);
  const cookies = site.withoutCookie(
    headers.get("cookie"),
    site.SESSION_COOKIE,
  );
  if (cookies === "") headers.delete("cookie");
  else headers.set("cookie", cookies);
  for (const [name, value] of Object.entries(identity)) {
    headers.set(name, value);
  }
  if (port !== null) headers.set(TARGET_HEADER, port);
  const tunnels = context.env.TUNNEL_DO;
  const stub = tunnels.get(tunnels.idFromName(server.id));
  return stub.fetch(new Request(request, { headers }));
}

async function openTunnel(
  request: Request,
  context: Site,
  server: store.Server,
  ctx: ExecutionContext,
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
  headers.set(TUNNEL_HEADER, "1");
  const tunnels = context.env.TUNNEL_DO;
  const stub = tunnels.get(tunnels.idFromName(server.id));
  return stub.fetch(new Request(request, { headers }));
}

async function gate(
  request: Request,
  context: Site,
  address: Address,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const { label, port } = address;
  const server = await store.serverByLabel(context.db, label);
  if (server === null) {
    return pages.notice(
      "No bb server here",
      "Nothing is linked to this address.",
      404,
    );
  }
  if (path === "/__tunnel" && port === null) {
    return openTunnel(request, context, server, ctx);
  }
  if (path.startsWith("/api/connect/") && port === null) {
    return connectApi(request, context, path);
  }
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
    return forward(request, context, server, null, identity);
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
  return forward(request, context, server, port, identity);
}

export default {
  async fetch(
    request: Request,
    env: site.Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const context = site.siteOf(request, env);
    const host = new URL(request.url).host.toLowerCase();
    const { baseHost } = context;
    if (host === baseHost) return apex(request, context);
    if (host === `www.${baseHost}`) {
      return Response.redirect(context.apexOrigin, 302);
    }
    const address = addressOf(host, baseHost);
    if (address === null) {
      return pages.notice("Not found", "This is not a bb-next address.", 404);
    }
    return gate(request, context, address, ctx);
  },
} satisfies ExportedHandler<site.Env>;
