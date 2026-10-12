import type {
  Dashboard,
  Failure,
  LinkView,
  ServerView,
  Viewer,
} from "./dashboard-types.js";
import * as hosted from "./hosted.js";
import * as oauth from "./oauth.js";
import * as site from "./site.js";
import * as store from "./store.js";

type Site = site.Site;
type Outcome<Value> = Value | (Failure & { status: number });

const HOUR_MS = 60 * 60_000;
const LABEL_RULE = "Use 1 to 32 letters, digits or single dashes.";
const SERVER_ACTION = /^\/api\/dashboard\/servers\/([^/]+)\/([a-z]+)$/u;
const APP = /^\/api\/dashboard\/apps\/([^/]+)\/revoke$/u;
const PERSON = /^\/api\/dashboard\/people\/([^/]+)$/u;

function fail(status: number, error: string, message: string) {
  return { status, error, message };
}

function isFailure<Value extends object>(
  outcome: Outcome<Value>,
): outcome is Failure & { status: number } {
  return "error" in outcome && "status" in outcome;
}

function isAdmin(context: Site, user: store.User) {
  const admin = context.env.ADMIN_LOGIN?.toLowerCase();
  return admin !== undefined && admin === user.login.toLowerCase();
}

export function canHost(context: Site, user: store.User) {
  if (context.env.HOSTING === "open" || user.can_host === 1) return true;
  return isAdmin(context, user);
}

function slug(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  return cleaned
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 32);
}

function versionOf(image: string | null) {
  const tag = /[:@]([^:@/]+)$/u.exec(image ?? "")?.[1] ?? "unknown";
  return /^[0-9a-f]{40}$/u.test(tag) ? tag.slice(0, 7) : tag;
}

export function viewerOf(context: Site, user: store.User): Viewer {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    admin: isAdmin(context, user),
    canHost: canHost(context, user),
  };
}

function serverView(
  context: Site,
  server: store.Server,
  image: string,
): ServerView {
  const { id, label, hosted_state: hostedState } = server;
  const url = context.origin(label);
  if (hostedState === null) {
    const state = server.credential_hash === null ? "signed-out" : "linked";
    const plain = { version: null, update: null, error: null, deletesAt: null };
    const clientName = server.client_name;
    return { id, label, url, hosted: false, clientName, state, ...plain };
  }
  const settled = hostedState === "running" || hostedState === "stopped";
  const outdated = settled && server.hosted_image !== image;
  const asleep = hostedState === "stopped" && server.stopped_at !== null;
  return {
    id,
    label,
    url,
    hosted: true,
    clientName: null,
    state: hostedState,
    version: settled ? versionOf(server.hosted_image) : null,
    update: outdated ? versionOf(image) : null,
    error: hostedState === "failed" ? server.hosted_error : null,
    deletesAt: asleep
      ? (server.stopped_at ?? 0) + hosted.deleteMs(context.env)
      : null,
  };
}

export async function dashboardOf(
  context: Site,
  user: store.User,
): Promise<Dashboard> {
  const { env, db, baseHost } = context;
  const viewer = viewerOf(context, user);
  const [servers, image, users] = await Promise.all([
    store.serversOf(db, user.id),
    hosted.currentImage(context),
    viewer.admin ? store.listUsers(db) : [],
  ]);
  const count = servers.filter((server) => server.hosted_state !== null).length;
  const canCreate =
    hosted.isAvailable(env) && viewer.canHost && count < hosted.perAccount(env);
  const apps = await oauth.appsOf(context, user.id);
  return {
    viewer,
    apps,
    baseHost,
    servers: servers.map((server) => serverView(context, server, image)),
    people: users.map((other) => ({
      id: other.id,
      login: other.login,
      name: other.name,
      avatarUrl: other.avatar_url,
      canHost: canHost(context, other),
      self: other.id === user.id,
    })),
    hosting: {
      canCreate,
      suggestedLabel: slug(user.login),
      idleHours: hosted.idleMs(env) / HOUR_MS,
    },
  };
}

async function usableLink(context: Site, code: string) {
  const link = await store.linkByUserCode(context.db, code.toUpperCase());
  const usable =
    link !== null && link.status === "pending" && link.expires_at > Date.now();
  return usable ? link : null;
}

const EXPIRED = fail(
  404,
  "expired",
  "This code is no longer valid. Run bb connect login again for a fresh one.",
);
const CANNOT_HOST = fail(
  403,
  "cannot_host",
  "Ask this relay's admin to allow hosting on your account.",
);

export async function linkViewOf(
  context: Site,
  user: store.User,
  code: string,
): Promise<Outcome<LinkView>> {
  if (!canHost(context, user)) return CANNOT_HOST;
  const link = await usableLink(context, code);
  if (link === null) return EXPIRED;
  const [existing] = await store.serversOf(context.db, user.id);
  return {
    userCode: link.user_code,
    clientName: link.client_name,
    suggestedLabel: existing?.label ?? slug(user.login),
    baseHost: context.baseHost,
  };
}

async function answerLink(
  context: Site,
  user: store.User,
  body: Record<string, unknown>,
): Promise<Outcome<{ url: string | null }>> {
  if (!canHost(context, user)) return CANNOT_HOST;
  const link = await usableLink(context, String(body.code ?? ""));
  if (link === null) return EXPIRED;
  if (body.action !== "approve") {
    await store.denyLink(context.db, link);
    return { url: null };
  }
  const label = String(body.label ?? "")
    .trim()
    .toLowerCase();
  if (!site.isValidLabel(label)) return fail(400, "invalid_label", LABEL_RULE);
  const outcome = await store.approveLink(context.db, link, user, label);
  if (outcome === "label-taken") {
    return fail(409, "label_taken", "That address is taken.");
  }
  if (outcome === "stale") return EXPIRED;
  const linked = await store.serverByLabel(context.db, label);
  if (linked !== null) await site.closeTunnel(context, linked.id);
  return { url: context.origin(label) };
}

async function createServer(
  context: Site,
  user: store.User,
  body: Record<string, unknown>,
): Promise<Outcome<{ url: string }>> {
  if (!canHost(context, user)) return CANNOT_HOST;
  const label = String(body.label ?? "")
    .trim()
    .toLowerCase();
  if (!site.isValidLabel(label)) return fail(400, "invalid_label", LABEL_RULE);
  const owned = await store.serversOf(context.db, user.id);
  const count = owned.filter((server) => server.hosted_state !== null).length;
  if (count >= hosted.perAccount(context.env)) {
    const message = "Delete your hosted server before creating another.";
    return fail(409, "limit", message);
  }
  const failure = await hosted.create(context, user, label);
  if (failure !== null) return fail(502, "not_created", failure);
  return { url: context.origin(label) };
}

async function actOnServer(
  context: Site,
  user: store.User,
  serverId: string,
  action: string,
): Promise<Outcome<{ ok: true }>> {
  const missing = fail(404, "not_found", "There is no such server.");
  const server = await store.serverById(context.db, serverId);
  if (server?.user_id !== user.id || server.hosted_state === null) {
    return missing;
  }
  if (action === "wake") await hosted.wake(context, server);
  else if (action === "sleep") await hosted.stop(context, server);
  else if (action === "update") {
    const updated = await hosted.update(context, server);
    const message = "The server could not be updated. Try again.";
    if (!updated) return fail(502, "not_updated", message);
  } else if (action === "delete") {
    const removed = await hosted.remove(context, server);
    const message = "The server could not be deleted. Try again.";
    if (!removed) return fail(502, "not_deleted", message);
  } else return missing;
  return { ok: true };
}

export function asked<Value extends object>(
  outcome: Value | { problem: string },
): Outcome<Value> {
  if (!("problem" in outcome)) return outcome;
  return fail(400, "invalid_request", outcome.problem);
}

function signOut(context: Site) {
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", site.sessionCookie(context, "", 0));
  headers.append("set-cookie", site.accountCookie(context, "", 0));
  return Response.json({ ok: true }, { headers });
}

function answer(outcome: Outcome<object>) {
  if (!isFailure(outcome)) return site.json(outcome);
  const { status, error, message } = outcome;
  return site.json({ error, message }, status);
}

export async function dashboardApi(
  request: Request,
  context: Site,
  path: string,
): Promise<Response> {
  const { method } = request;
  const posting = method === "POST";
  if (posting && request.headers.get("origin") !== context.apexOrigin) {
    return answer(
      fail(403, "forbidden_origin", "This came from another site."),
    );
  }
  const user = await site.accountHolder(request, context);
  if (user === null)
    return answer(fail(401, "unauthenticated", "Sign in first."));
  const { db } = context;
  if (method === "GET" && path === "/api/dashboard") {
    return site.json(await dashboardOf(context, user));
  }
  if (method === "GET" && path === "/api/dashboard/link") {
    const code = new URL(request.url).searchParams.get("code") ?? "";
    return answer(await linkViewOf(context, user, code));
  }
  if (method === "GET" && path === "/api/dashboard/oauth/consent") {
    const { searchParams } = new URL(request.url);
    return answer(asked(await oauth.consentOf(context, user, searchParams)));
  }
  if (!posting) return answer(fail(404, "not_found", "Not found."));
  const parsed: unknown = await request.json().catch(() => null);
  const body: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" ? { ...parsed } : {};
  if (path === "/api/dashboard/logout") {
    const token = site.accountToken(request, context);
    if (token !== null) await store.deleteSession(db, token);
    return signOut(context);
  }
  if (path === "/api/dashboard/link") {
    return answer(await answerLink(context, user, body));
  }
  if (path === "/api/dashboard/oauth/decision") {
    const query = typeof body.query === "string" ? body.query : "";
    const params = new URLSearchParams(query);
    const approved = body.approved === true;
    return answer(asked(await oauth.decide(context, user, params, approved)));
  }
  const [, appId = ""] = APP.exec(path) ?? [];
  if (appId !== "") {
    const revoked = await oauth.revokeForUser(db, user.id, appId);
    return site.json({ revoked });
  }
  if (path === "/api/dashboard/servers") {
    return answer(await createServer(context, user, body));
  }
  const [, serverId = "", action = ""] = SERVER_ACTION.exec(path) ?? [];
  if (serverId !== "") {
    return answer(await actOnServer(context, user, serverId, action));
  }
  const [, personId = ""] = PERSON.exec(path) ?? [];
  if (personId !== "") {
    if (!isAdmin(context, user)) {
      const message = "Only this relay's admin can do that.";
      return answer(fail(403, "forbidden", message));
    }
    await store.setCanHost(db, personId, body.canHost === true);
    return site.json({ ok: true });
  }
  return answer(fail(404, "not_found", "Not found."));
}
