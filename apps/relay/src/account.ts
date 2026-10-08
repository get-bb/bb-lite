import { newToken } from "./crypto.js";
import * as hosted from "./hosted.js";
import * as pages from "./pages.js";
import * as site from "./site.js";
import * as store from "./store.js";

type Site = site.Site;
type Fields = Record<string, string>;

const OAUTH_TTL_S = 600;
const LINK_POLL_INTERVAL_MS = 2_000;
const LINK_MIN_POLL_GAP_MS = 500;

function redirect(location: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  return new Response(null, { status: 303, headers });
}

function nextOf(request: Request, context: Site): string {
  const next = new URL(request.url).searchParams.get("next") ?? "";
  const local = next.startsWith("/") && !next.startsWith("//");
  return local || site.isOwnAddress(context, next) ? next : "";
}

async function formFields(request: Request): Promise<Fields> {
  const form = await request.formData().catch(() => new FormData());
  const fields: Fields = {};
  for (const [name, value] of form) {
    if (typeof value === "string") fields[name] = value;
  }
  return fields;
}

async function jsonBody(request: Request): Promise<Fields> {
  const body: unknown = await request.json().catch(() => null);
  const fields: Fields = {};
  if (body === null || typeof body !== "object") return fields;
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === "string") fields[name] = value;
  }
  return fields;
}

function isSameOriginPost(request: Request, context: Site) {
  return request.headers.get("origin") === context.apexOrigin;
}

function isAdmin(context: Site, user: store.User) {
  const admin = context.env.ADMIN_LOGIN?.toLowerCase();
  return admin !== undefined && admin === user.login.toLowerCase();
}

function canHost(context: Site, user: store.User) {
  if (context.env.HOSTING === "open" || user.can_host === 1) return true;
  return isAdmin(context, user);
}

function githubConfig(context: Site) {
  const { env } = context;
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: secret } = env;
  if (!clientId || !secret) return null;
  const oauthUrl = env.GITHUB_OAUTH_URL ?? "https://github.com";
  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const redirectUri = `${context.apexOrigin}/auth/github/callback`;
  return { clientId, secret, oauthUrl, apiUrl, redirectUri };
}

function notConfigured() {
  const message = "This relay has no GitHub app configured yet.";
  return pages.notice("Sign-in is not available", message, 503);
}

function startGithub(request: Request, context: Site) {
  const github = githubConfig(context);
  if (github === null) return notConfigured();
  const state = newToken("st");
  const next = encodeURIComponent(nextOf(request, context));
  const authorize = new URL(`${github.oauthUrl}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", github.clientId);
  authorize.searchParams.set("redirect_uri", github.redirectUri);
  authorize.searchParams.set("scope", "read:user user:email");
  authorize.searchParams.set("state", state);
  const pending = site.oauthCookie(context, `${state}.${next}`, OAUTH_TTL_S);
  const headers = { location: authorize.toString(), "set-cookie": pending };
  return new Response(null, { status: 302, headers });
}

async function githubJson(url: string, init: RequestInit): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("user-agent", "bb-next");
  const response = await fetch(url, { ...init, headers });
  return response.ok ? response.json().catch(() => null) : null;
}

function field<Value>(source: unknown, name: string, type: string) {
  if (source === null || typeof source !== "object") return null;
  const value: unknown = Reflect.get(source, name);
  return typeof value === type ? (value as Value) : null;
}

function verifiedEmail(emails: unknown): string | null {
  const listed: unknown[] = Array.isArray(emails) ? emails : [];
  const usable = listed.filter(
    (entry) => field<boolean>(entry, "verified", "boolean") === true,
  );
  const primary = usable.find(
    (entry) => field<boolean>(entry, "primary", "boolean") === true,
  );
  const address = field<string>(primary ?? usable[0], "email", "string");
  return address?.toLowerCase() ?? null;
}

async function githubProfile(
  github: NonNullable<ReturnType<typeof githubConfig>>,
  code: string,
): Promise<store.GithubProfile | null> {
  const { clientId, secret, redirectUri } = github;
  const exchange = {
    client_id: clientId,
    client_secret: secret,
    code,
    redirect_uri: redirectUri,
  };
  const granted = await githubJson(
    `${github.oauthUrl}/login/oauth/access_token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchange),
    },
  );
  const token = field<string>(granted, "access_token", "string");
  if (token === null) return null;
  const authorized = { headers: { authorization: `Bearer ${token}` } };
  const [account, emails] = await Promise.all([
    githubJson(`${github.apiUrl}/user`, authorized),
    githubJson(`${github.apiUrl}/user/emails`, authorized),
  ]);
  const githubId = field<number>(account, "id", "number");
  const login = field<string>(account, "login", "string");
  if (githubId === null || login === null) return null;
  const name = field<string>(account, "name", "string")?.trim() || login;
  return {
    github_id: githubId,
    login,
    name: name.slice(0, 80),
    email: verifiedEmail(emails),
    avatar_url: field<string>(account, "avatar_url", "string"),
  };
}

async function finishGithub(request: Request, context: Site) {
  const github = githubConfig(context);
  if (github === null) return notConfigured();
  const retry = (message: string, status: number) =>
    pages.signInPage("", message, status);
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code") ?? "";
  const pending = site.readCookie(request, site.OAUTH_COOKIE) ?? "";
  const separator = pending.indexOf(".");
  const state = pending.slice(0, separator);
  if (code === "" || separator < 1 || searchParams.get("state") !== state) {
    return retry("That sign-in expired. Try again.", 400);
  }
  const profile = await githubProfile(github, code);
  const user =
    profile === null ? null : await store.upsertGithubUser(context.db, profile);
  if (user === null) return retry("GitHub did not confirm the sign-in.", 502);
  const wanted = decodeURIComponent(pending.slice(separator + 1));
  const local = wanted.startsWith("/") && !wanted.startsWith("//");
  const next = local || site.isOwnAddress(context, wanted) ? wanted : "/";
  const token = await store.createSession(context.db, user.id);
  const maxAge = store.SESSION_MAX_AGE_SECONDS;
  const headers = new Headers({ location: next, "cache-control": "no-store" });
  headers.append("set-cookie", site.sessionCookie(context, token, maxAge));
  headers.append("set-cookie", site.accountCookie(context, token, maxAge));
  headers.append("set-cookie", site.oauthCookie(context, "", 0));
  return new Response(null, { status: 303, headers });
}

async function logOut(request: Request, context: Site) {
  const token = site.accountToken(request, context);
  if (token !== null) await store.deleteSession(context.db, token);
  const headers = new Headers({ location: "/login" });
  headers.append("set-cookie", site.sessionCookie(context, "", 0));
  headers.append("set-cookie", site.accountCookie(context, "", 0));
  return new Response(null, { status: 303, headers });
}

function slug(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  return cleaned
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 32);
}

async function linkView(
  context: Site,
  user: store.User,
  link: store.LinkCode,
  error: string | null,
) {
  const [existing] = await store.serversOf(context.db, user.id);
  const suggestedLabel = existing?.label ?? slug(user.login);
  const { user_code: userCode, client_name: clientName } = link;
  const view = { userCode, clientName, suggestedLabel };
  const status = error === null ? 200 : 400;
  return pages.linkPage(view, context.baseHost, error, status);
}

async function usableLink(context: Site, code: string) {
  const link = await store.linkByUserCode(context.db, code.toUpperCase());
  const usable =
    link !== null && link.status === "pending" && link.expires_at > Date.now();
  return usable ? link : null;
}

async function linkRoute(request: Request, context: Site, user: store.User) {
  const expired = () =>
    pages.notice(
      "This code is no longer valid",
      "Run bb connect login again to get a fresh code.",
      404,
    );
  if (!canHost(context, user)) {
    const message = "Ask this relay's admin to allow hosting on your account.";
    return pages.notice("This account cannot link servers", message, 403);
  }
  if (request.method === "GET") {
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const link = await usableLink(context, code);
    return link === null ? expired() : linkView(context, user, link, null);
  }
  const fields = await formFields(request);
  const link = await usableLink(context, fields.code ?? "");
  if (link === null) return expired();
  if (fields.action !== "approve") {
    await store.denyLink(context.db, link);
    return pages.notice("Denied", "That bb server was not connected.");
  }
  const label = (fields.label ?? "").trim().toLowerCase();
  if (!site.isValidLabel(label)) {
    const rule = "Use 1 to 32 letters, digits or single dashes.";
    return linkView(context, user, link, rule);
  }
  const outcome = await store.approveLink(context.db, link, user, label);
  if (outcome === "label-taken") {
    return linkView(context, user, link, "That address is taken.");
  }
  if (outcome === "stale") return expired();
  const linked = await store.serverByLabel(context.db, label);
  if (linked !== null) await site.closeTunnel(context, linked.id);
  const address = context.origin(label);
  return pages.notice("Connected", `Your bb server is now at ${address}.`);
}

async function startLink(request: Request, context: Site) {
  const { clientName = "bb server" } = await jsonBody(request);
  const name = clientName.trim().slice(0, 100) || "bb server";
  const started = await store.startLink(context.db, name);
  const code = encodeURIComponent(started.userCode);
  const verificationUrl = `${context.apexOrigin}/link?code=${code}`;
  const intervalMs = LINK_POLL_INTERVAL_MS;
  return site.json({ ...started, verificationUrl, intervalMs });
}

async function pollLink(request: Request, context: Site) {
  const { deviceCode = "" } = await jsonBody(request);
  const link = await store.linkByDeviceCode(context.db, deviceCode);
  if (link === null) return site.json({ error: "unknown" }, 404);
  if (link.status === "denied") return site.json({ error: "denied" }, 403);
  if (link.status === "delivered") {
    return site.json({ error: "completed" }, 409);
  }
  if (link.status === "pending") {
    if (link.expires_at <= Date.now()) {
      return site.json({ error: "expired" }, 410);
    }
    const gap = Date.now() - (link.polled_at ?? 0);
    if (gap < LINK_MIN_POLL_GAP_MS) return site.json({ error: "slow" }, 429);
    await store.markPolled(context.db, link);
    return site.json({ status: "pending" });
  }
  const { credential, server_id: serverId } = link;
  const delivered = await store.deliverLink(context.db, link);
  if (!delivered || credential === null || serverId === null) {
    return site.json({ error: "completed" }, 409);
  }
  return site.json({ status: "approved", credential, serverId });
}

async function linkedServer(request: Request, context: Site) {
  const credential = site.bearer(request);
  if (credential === null) return null;
  return store.serverByCredential(context.db, credential);
}

export async function connectApi(
  request: Request,
  context: Site,
  path: string,
): Promise<Response> {
  const unauthorized = () => site.json({ error: "unauthorized" }, 401);
  if (path === "/api/connect/redeem-machine") {
    const { code = "" } = await jsonBody(request);
    const redeemed = await store.redeemMachineCode(context.db, code);
    if (redeemed !== null) return site.json(redeemed);
    return site.json({ error: "invalid code" }, 404);
  }
  const server = await linkedServer(request, context);
  if (server === null) return unauthorized();
  if (path === "/api/connect/disconnect") {
    await store.clearServerCredential(context.db, server.id);
    await site.closeTunnel(context, server.id);
    return site.json({ ok: true });
  }
  if (path === "/api/connect/activity") {
    await store.noteActive(context.db, server.id);
    return site.json({ ok: true });
  }
  if (path === "/api/connect/machine-code") {
    const code = await store.mintMachineCode(context.db, server.id);
    if (code !== null) return site.json({ code });
    return site.json({ error: "machine limit" }, 409);
  }
  if (path === "/api/connect/revoke-machine") {
    const { machineId = "" } = await jsonBody(request);
    await store.revokeMachine(context.db, server.id, machineId);
    return site.json({ ok: true });
  }
  return site.json({ error: "not found" }, 404);
}

async function accountApi(request: Request, context: Site, path: string) {
  const { method } = request;
  if (path === "/api/account/me" && method === "GET") {
    const server = await linkedServer(request, context);
    if (server === null) return site.json({ error: "unauthorized" }, 401);
    const { id: serverId, label: serverLabel } = server;
    const serverUrl = context.origin(serverLabel);
    return site.json({ serverId, serverLabel, serverUrl });
  }
  if (method !== "POST") return site.json({ error: "not found" }, 404);
  if (path === "/api/account/link/start") return startLink(request, context);
  if (path === "/api/account/link/poll") return pollLink(request, context);
  if (path.startsWith("/api/connect/")) {
    return connectApi(request, context, path);
  }
  return site.json({ error: "not found" }, 404);
}

async function setHosting(request: Request, context: Site, user: store.User) {
  if (!isAdmin(context, user)) {
    return pages.notice(
      "Not allowed",
      "Only this relay's admin can do that.",
      403,
    );
  }
  const fields = await formFields(request);
  await store.setCanHost(context.db, fields.userId ?? "", fields.allow === "1");
  return redirect("/");
}

async function hostedRoute(
  request: Request,
  context: Site,
  user: store.User,
  action: string,
) {
  if (!canHost(context, user)) {
    const message = "Ask this relay's admin to allow hosting on your account.";
    return pages.notice("This account cannot host servers", message, 403);
  }
  const fields = await formFields(request);
  if (action === "create") {
    const label = (fields.label ?? "").trim().toLowerCase();
    if (!site.isValidLabel(label)) {
      const rule = "Use 1 to 32 letters, digits or single dashes.";
      return pages.notice("That address cannot be used", rule, 400);
    }
    const owned = await store.serversOf(context.db, user.id);
    const count = owned.filter((server) => server.hosted_state !== null).length;
    if (count >= hosted.perAccount(context.env)) {
      const message = "Delete your hosted server before creating another.";
      return pages.notice("You already have a hosted server", message, 409);
    }
    const failure = await hosted.create(context, user, label);
    if (failure !== null) return pages.notice("Not created", failure, 502);
    return redirect(context.origin(label));
  }
  const server = await store.serverById(context.db, fields.serverId ?? "");
  if (server?.user_id !== user.id || server.hosted_state === null) {
    return pages.notice("Not found", "", 404);
  }
  if (action === "start") await hosted.wake(context, server);
  else if (action === "stop") await hosted.stop(context, server);
  else if (action === "delete") {
    const removed = await hosted.remove(context, server);
    if (!removed) {
      const message = "The server could not be deleted. Try again.";
      return pages.notice("Not deleted", message, 502);
    }
  } else return pages.notice("Not found", "", 404);
  return redirect("/");
}

export async function apex(request: Request, context: Site): Promise<Response> {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const { method } = request;
  if (path.startsWith("/api/")) return accountApi(request, context, path);
  const reading = method === "GET" || method === "HEAD";
  if (!reading && method !== "POST") return pages.notice("Not found", "", 404);
  if (method === "POST" && !isSameOriginPost(request, context)) {
    return pages.notice("Refused", "This form came from another site.", 403);
  }
  const user = await site.accountHolder(request, context);
  if (reading && path === "/auth/github/callback") {
    return finishGithub(request, context);
  }
  if (path === "/login" || path === "/signup" || path === "/auth/github") {
    const next = nextOf(request, context);
    if (user !== null) return redirect(next || "/");
    if (!reading) return pages.notice("Not found", "", 404);
    if (path === "/auth/github") return startGithub(request, context);
    return pages.signInPage(next);
  }
  if (path === "/logout" && method === "POST") return logOut(request, context);
  if (user === null) {
    const next = encodeURIComponent(`${path}${url.search}`);
    return redirect(`/login?next=${next}`);
  }
  if (path === "/link") return linkRoute(request, context, user);
  if (path === "/admin/hosting" && method === "POST") {
    return setHosting(request, context, user);
  }
  if (path.startsWith("/hosted/") && method === "POST") {
    return hostedRoute(request, context, user, path.slice("/hosted/".length));
  }
  if (path !== "/" || !reading) return pages.notice("Not found", "", 404);
  const servers = await store.serversOf(context.db, user.id);
  const admin = isAdmin(context, user);
  const users = admin ? await store.listUsers(context.db) : [];
  const count = servers.filter((server) => server.hosted_state !== null).length;
  const { env, baseHost } = context;
  const canCreate =
    hosted.isAvailable(env) &&
    canHost(context, user) &&
    count < hosted.perAccount(env);
  const suggestedLabel = slug(user.login);
  const deleteAfterMs = hosted.deleteMs(env);
  const view = { baseHost, canCreate, suggestedLabel, deleteAfterMs };
  return pages.dashboard(user, servers, users, context.origin, view);
}
