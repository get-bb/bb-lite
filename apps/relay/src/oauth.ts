import * as wire from "@bb/tunnel-contract";
import { base64Url, newToken, sha256Hex } from "./crypto.js";
import type { AppView, ConsentView } from "./dashboard-types.js";
import * as site from "./site.js";
import * as store from "./store.js";

type Site = site.Site;
type Problem = { problem: string };

interface Client {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

interface Valid {
  client: Client;
  redirectUri: string;
  state: string | null;
  server: store.Server;
  resource: string;
  codeChallenge: string;
}

interface CodeRow {
  user_id: string;
  server_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  expires_at: number;
}

interface GrantRow {
  id: string;
  user_id: string;
  server_id: string;
  client_id: string;
  client_name: string;
  resource: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface RefreshRow {
  token_hash: string;
  grant_id: string;
  expires_at: number;
  rotated_at: number | null;
}

interface Claims {
  version: 1;
  userId: string;
  serverId: string;
  grantId: string;
  resource: string;
  scope: string;
  clientName: string;
  issuedAt: number;
  expiresAt: number;
}

export const CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const MAX_GRANTS_PER_CLIENT = 10;
export const SECRET_MISSING = "MCP_TOKEN_SECRET is not set on this relay";

const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60_000;
const REFRESH_REUSE_GRACE_MS = 60_000;
const ROTATED_REFRESH_RETENTION_MS = 24 * 60 * 60_000;
const REVOKED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
const CLIENT_METADATA_TIMEOUT_MS = 5_000;
const CLIENT_NAME_MAX_LENGTH = 80;
const ACCESS_PREFIX = "bbmcp_";
const REFRESH_PREFIX = "bbmcpr";
const CODE_PREFIX = "bbmcpc";
const ACCESS_CONTEXT = "bb-mcp-access-token-v1";
const SUCCESSOR_CONTEXT = "bb-mcp-refresh-successor-v1";
const SECRET_BODY = "[A-Za-z0-9_-]{43}";
const REFRESH_PATTERN = new RegExp(`^${REFRESH_PREFIX}_${SECRET_BODY}$`, "u");
const CODE_PATTERN = new RegExp(`^${CODE_PREFIX}_${SECRET_BODY}$`, "u");
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const IPV4_LITERAL = /^\d+(\.\d+){3}$/u;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/u;
const INVISIBLE = /[\p{Cc}\p{Bidi_Control}]/gu;
const FORM = "application/x-www-form-urlencoded";
const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };
const encoder = new TextEncoder();

function secretOf(context: Site): string | null {
  return context.env.MCP_TOKEN_SECRET?.trim() || null;
}

async function hmac(secret: string, text: string): Promise<string> {
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    algorithm,
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return base64Url(new Uint8Array(signature));
}

async function sign(claims: Claims, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmac(secret, `${ACCESS_CONTEXT}.${payload}`);
  return `${ACCESS_PREFIX}${payload}.${signature}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function claimsOf(payload: string): Claims | null {
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object") return null;
    const read = (name: string): unknown => Reflect.get(parsed, name);
    const userId = text(read("userId"));
    const serverId = text(read("serverId"));
    const grantId = text(read("grantId"));
    const resource = text(read("resource"));
    const scope = text(read("scope"));
    const clientName = text(read("clientName"));
    const issuedAt = read("issuedAt");
    const expiresAt = read("expiresAt");
    if (read("version") !== 1 || userId === null || serverId === null) {
      return null;
    }
    if (grantId === null || resource === null || scope === null) return null;
    if (clientName === null || typeof issuedAt !== "number") return null;
    if (typeof expiresAt !== "number") return null;
    const bound = { userId, serverId, grantId, resource };
    return { version: 1, ...bound, scope, clientName, issuedAt, expiresAt };
  } catch {
    return null;
  }
}

async function verify(token: string, secret: string): Promise<Claims | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const body = token.slice(ACCESS_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator <= 0) return null;
  const payload = body.slice(0, separator);
  const expected = await hmac(secret, `${ACCESS_CONTEXT}.${payload}`);
  const offered = await sha256Hex(body.slice(separator + 1));
  if (offered !== (await sha256Hex(expected))) return null;
  const claims = claimsOf(payload);
  return claims === null || claims.expiresAt <= Date.now() ? null : claims;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
}

function isUsableRedirect(value: string, url: URL): boolean {
  if (value.includes("#") || url.username !== "" || url.password !== "") {
    return false;
  }
  return url.protocol === "https:" || isLoopbackHttp(url);
}

export function matchRedirectUri(
  requested: string,
  registered: readonly string[],
): boolean {
  const wanted = parseUrl(requested);
  if (wanted === null || !isUsableRedirect(requested, wanted)) return false;
  if (!isLoopbackHttp(wanted)) return registered.includes(requested);
  return registered.some((candidate) => {
    const known = parseUrl(candidate);
    if (known === null || !isUsableRedirect(candidate, known)) return false;
    if (!isLoopbackHttp(known) || known.hostname !== wanted.hostname) {
      return false;
    }
    return known.pathname === wanted.pathname && known.search === wanted.search;
  });
}

function clientIdProblem(clientId: string, allowHttp: boolean): string | null {
  const url = parseUrl(clientId);
  if (url === null) return "client_id is not a URL";
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  const plain = url.protocol === "http:" && allowHttp && loopback;
  if (url.protocol !== "https:" && !plain) {
    return "client_id must be an https URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "client_id must not contain credentials";
  }
  if (clientId.includes("#")) return "client_id must not contain a fragment";
  if (url.pathname === "/" || url.pathname === "") {
    return "client_id must have a path";
  }
  const literal =
    url.hostname.startsWith("[") || IPV4_LITERAL.test(url.hostname);
  if (!allowHttp && (loopback || literal)) {
    return "client_id host is not allowed";
  }
  return null;
}

async function limitedText(response: Response, maxBytes: number) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let read = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return read + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    read += decoder.decode(value, { stream: true });
  }
}

function clientOf(clientId: string, body: string): Client | Problem {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { problem: "client metadata is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { problem: "client metadata is not a JSON object" };
  }
  const read = (name: string): unknown => Reflect.get(parsed, name);
  if (read("client_id") !== clientId) {
    return { problem: "client metadata client_id does not match its URL" };
  }
  const named = text(read("client_name")) ?? "";
  const clean = named.replace(INVISIBLE, "").trim();
  const clientName = clean.slice(0, CLIENT_NAME_MAX_LENGTH).trim();
  if (clientName === "") {
    return { problem: "client metadata has no client_name" };
  }
  const listed = read("redirect_uris");
  const redirectUris = Array.isArray(listed)
    ? listed.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!Array.isArray(listed) || listed.length === 0) {
    return { problem: "client metadata has no redirect_uris" };
  }
  if (redirectUris.length !== listed.length) {
    return { problem: "client metadata has no redirect_uris" };
  }
  const method = read("token_endpoint_auth_method");
  if (method !== undefined && method !== "none") {
    const kind = "token_endpoint_auth_method none";
    return { problem: `only public clients (${kind}) are supported` };
  }
  return { clientId, clientName, redirectUris };
}

export async function fetchClient(
  clientId: string,
  allowHttp: boolean,
): Promise<Client | Problem> {
  const problem = clientIdProblem(clientId, allowHttp);
  if (problem !== null) return { problem };
  const unreachable = "client metadata document could not be fetched";
  try {
    const response = await fetch(clientId, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
    });
    const [media = ""] = (response.headers.get("content-type") ?? "").split(
      ";",
    );
    const type = media.trim().toLowerCase();
    const json =
      type === "application/json" ||
      (type.startsWith("application/") && type.endsWith("+json"));
    if (response.status !== 200 || !json) {
      await response.body?.cancel().catch(() => undefined);
      const wrongType = "client metadata document is not JSON";
      return { problem: response.status === 200 ? wrongType : unreachable };
    }
    const body = await limitedText(response, CLIENT_METADATA_MAX_BYTES);
    if (body === null) {
      return { problem: "client metadata document is too large" };
    }
    return clientOf(clientId, body);
  } catch {
    return { problem: unreachable };
  }
}

export function parseResource(
  context: Site,
  value: string,
): { label: string; resource: string } | null {
  const url = parseUrl(value);
  if (url === null) return null;
  const { protocol } = new URL(context.apexOrigin);
  if (url.protocol !== "https:" && url.protocol !== protocol) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== wire.MCP_PUBLIC_PATH) return null;
  const frpBase = context.env.FRP_BASE_DOMAIN?.toLowerCase() ?? "";
  const bases =
    frpBase === "" ? [context.baseHost] : [frpBase, context.baseHost];
  const base = bases.find((suffix) => url.host.endsWith(`.${suffix}`));
  if (base === undefined) return null;
  const label = url.host.slice(0, -base.length - 1);
  if (!site.isValidLabel(label)) return null;
  return { label, resource: wire.mcpResourceForOrigin(url.origin) };
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

async function validate(
  context: Site,
  user: store.User,
  params: URLSearchParams,
): Promise<Valid | Problem> {
  const clientId = single(params, "client_id") ?? "";
  if (clientId === "") return { problem: "client_id is missing or repeated" };
  const client = await fetchClient(clientId, !context.secure);
  if ("problem" in client) return client;
  const redirectUri = single(params, "redirect_uri") ?? "";
  if (redirectUri === "") {
    return { problem: "redirect_uri is missing or repeated" };
  }
  if (!matchRedirectUri(redirectUri, client.redirectUris)) {
    return { problem: "redirect_uri is not registered for this client" };
  }
  if (params.get("response_type") !== "code") {
    const reason = "unsupported_response_type";
    return { problem: `response_type must be code (${reason})` };
  }
  const codeChallenge = single(params, "code_challenge") ?? "";
  const method = params.get("code_challenge_method");
  if (!CODE_CHALLENGE.test(codeChallenge) || method !== "S256") {
    const needed = "an S256 PKCE code_challenge is required";
    return { problem: `${needed} (invalid_request)` };
  }
  const target = parseResource(context, single(params, "resource") ?? "");
  if (target === null) {
    const needed = "resource must be a bb server MCP URL";
    return { problem: `${needed} (invalid_target)` };
  }
  const server = await store.serverByLabel(context.db, target.label);
  if (server === null || server.user_id !== user.id) {
    const needed = "resource is not a bb server owned by this account";
    return { problem: `${needed} (invalid_target)` };
  }
  const scopes = (params.get("scope") ?? "").split(/\s+/u).filter(Boolean);
  if (scopes.length > 0 && !scopes.includes(wire.MCP_SCOPE)) {
    return { problem: "no supported scope was requested (invalid_scope)" };
  }
  const state = params.get("state");
  const { resource } = target;
  return { client, redirectUri, state, server, resource, codeChallenge };
}

export async function consentOf(
  context: Site,
  user: store.User,
  params: URLSearchParams,
): Promise<ConsentView | Problem> {
  if (secretOf(context) === null) return { problem: SECRET_MISSING };
  const valid = await validate(context, user, params);
  if ("problem" in valid) return valid;
  const redirect = new URL(valid.redirectUri);
  return {
    clientName: valid.client.clientName,
    clientIdHost: new URL(valid.client.clientId).host,
    redirectHost: redirect.host,
    loopbackRedirect: isLoopbackHttp(redirect),
    serverLabel: valid.server.label,
    address: new URL(valid.resource).host,
  };
}

export async function decide(
  context: Site,
  user: store.User,
  params: URLSearchParams,
  approved: boolean,
): Promise<{ url: string } | Problem> {
  if (secretOf(context) === null) return { problem: SECRET_MISSING };
  const valid = await validate(context, user, params);
  if ("problem" in valid) return valid;
  const url = new URL(valid.redirectUri);
  const answer = (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      url.searchParams.set(name, value);
    }
    if (valid.state !== null) url.searchParams.set("state", valid.state);
    url.searchParams.set("iss", context.apexOrigin);
    return { url: url.toString() };
  };
  if (!approved) {
    const description = "the user denied the request";
    return answer({ error: "access_denied", error_description: description });
  }
  const now = Date.now();
  const code = newToken(CODE_PREFIX);
  const { db } = context;
  await store.run(db, "DELETE FROM oauth_codes WHERE expires_at < ?", now);
  await store.run(
    db,
    `INSERT INTO oauth_codes
       (code_hash, user_id, server_id, client_id, client_name, redirect_uri,
        resource, scope, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    await sha256Hex(code),
    user.id,
    valid.server.id,
    valid.client.clientId,
    valid.client.clientName,
    valid.redirectUri,
    valid.resource,
    wire.MCP_SCOPE,
    valid.codeChallenge,
    now + CODE_TTL_MS,
    now,
  );
  return answer({ code });
}

async function revokeGrant(db: D1Database, grantId: string, now: number) {
  const sql = `UPDATE oauth_grants SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL`;
  const changed = await store.run(db, sql, now, grantId);
  const tokens = "DELETE FROM oauth_refresh_tokens WHERE grant_id = ?";
  await store.run(db, tokens, grantId);
  return changed > 0;
}

function grantById(db: D1Database, id: string) {
  return store.one<GrantRow>(db, "SELECT * FROM oauth_grants WHERE id = ?", id);
}

function viewOf(grant: GrantRow): wire.McpGrantView {
  return {
    id: grant.id,
    clientId: grant.client_id,
    clientName: grant.client_name,
    scope: grant.scope,
    createdAt: grant.created_at,
    lastUsedAt: grant.last_used_at,
  };
}

export async function appsOf(
  context: Site,
  userId: string,
): Promise<AppView[]> {
  const grants = await store.all<GrantRow & { label: string }>(
    context.db,
    `SELECT oauth_grants.*, servers.label AS label FROM oauth_grants
     JOIN servers ON servers.id = oauth_grants.server_id
     WHERE oauth_grants.user_id = ? AND oauth_grants.revoked_at IS NULL
     ORDER BY oauth_grants.created_at DESC, oauth_grants.id`,
    userId,
  );
  return grants.map((grant) => ({
    ...viewOf(grant),
    serverLabel: grant.label,
    address: new URL(grant.resource).host,
  }));
}

export async function revokeForUser(
  db: D1Database,
  userId: string,
  id: string,
) {
  const grant = await grantById(db, id);
  if (grant === null || grant.user_id !== userId) return false;
  return revokeGrant(db, grant.id, Date.now());
}

export async function grantsOfServer(db: D1Database, server: store.Server) {
  const grants = await store.all<GrantRow>(
    db,
    `SELECT * FROM oauth_grants
     WHERE server_id = ? AND user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC, id`,
    server.id,
    server.user_id,
  );
  return grants.map(viewOf);
}

export async function revokeForServer(
  db: D1Database,
  server: store.Server,
  id: string,
) {
  const grant = await grantById(db, id);
  if (grant?.server_id !== server.id || grant.user_id !== server.user_id) {
    return false;
  }
  return revokeGrant(db, grant.id, Date.now());
}

function tokenError(error: string, description: string, status = 400) {
  const body = { error, error_description: description };
  return Response.json(body, { status, headers: TOKEN_HEADERS });
}

async function formOf(request: Request): Promise<URLSearchParams | null> {
  const [media = ""] = (request.headers.get("content-type") ?? "").split(";");
  if (media.trim().toLowerCase() !== FORM) return null;
  return new URLSearchParams(await request.text());
}

async function isActive(db: D1Database, serverId: string, userId: string) {
  const server = await store.serverById(db, serverId);
  return server !== null && server.user_id === userId;
}

function sameResource(context: Site, offered: string | null, stored: string) {
  if (offered === null) return true;
  return parseResource(context, offered)?.resource === stored;
}

async function issue(
  secret: string,
  grant: Pick<
    GrantRow,
    "id" | "user_id" | "server_id" | "resource" | "scope" | "client_name"
  >,
  refreshToken: string,
  now: number,
) {
  const claims: Claims = {
    version: 1,
    userId: grant.user_id,
    serverId: grant.server_id,
    grantId: grant.id,
    resource: grant.resource,
    scope: grant.scope,
    clientName: grant.client_name,
    issuedAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
  };
  const body = {
    access_token: await sign(claims, secret),
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1_000),
    refresh_token: refreshToken,
    scope: grant.scope,
  };
  return Response.json(body, { headers: TOKEN_HEADERS });
}

async function storeRefresh(db: D1Database, grantId: string, token: string) {
  const now = Date.now();
  await store.run(
    db,
    `INSERT INTO oauth_refresh_tokens
       (token_hash, grant_id, expires_at, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING`,
    await sha256Hex(token),
    grantId,
    now + REFRESH_TOKEN_TTL_MS,
    now,
  );
}

async function trimGrants(db: D1Database, grant: GrantRow, now: number) {
  const excess = await store.all<{ id: string }>(
    db,
    `SELECT id FROM oauth_grants
     WHERE user_id = ? AND server_id = ? AND client_id = ?
       AND revoked_at IS NULL AND id != ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    grant.user_id,
    grant.server_id,
    grant.client_id,
    grant.id,
    MAX_GRANTS_PER_CLIENT,
    MAX_GRANTS_PER_CLIENT - 1,
  );
  for (const earlier of excess) await revokeGrant(db, earlier.id, now);
  const stale = "DELETE FROM oauth_grants WHERE user_id = ? AND revoked_at < ?";
  await store.run(db, stale, grant.user_id, now - REVOKED_GRANT_RETENTION_MS);
}

async function exchangeCode(
  context: Site,
  secret: string,
  form: URLSearchParams,
) {
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (code === "" || clientId === "" || verifier === "") {
    const needed = "code, client_id and code_verifier are required";
    return tokenError("invalid_request", needed);
  }
  const invalid = () => {
    const message = "authorization code is invalid or expired";
    return tokenError("invalid_grant", message);
  };
  if (!CODE_PATTERN.test(code)) return invalid();
  const { db } = context;
  const consume = "DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *";
  const row = await store.one<CodeRow>(db, consume, await sha256Hex(code));
  const now = Date.now();
  if (row === null || row.expires_at <= now) return invalid();
  if (row.client_id !== clientId) return invalid();
  const redirectUri = form.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== row.redirect_uri) {
    return invalid();
  }
  if (!sameResource(context, form.get("resource"), row.resource)) {
    return invalid();
  }
  if (!CODE_VERIFIER.test(verifier)) return invalid();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  if (base64Url(new Uint8Array(digest)) !== row.code_challenge) {
    return invalid();
  }
  if (!(await isActive(db, row.server_id, row.user_id))) return invalid();
  const grant: GrantRow = {
    id: crypto.randomUUID(),
    user_id: row.user_id,
    server_id: row.server_id,
    client_id: row.client_id,
    client_name: row.client_name,
    resource: row.resource,
    scope: row.scope,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  await store.run(
    db,
    `INSERT INTO oauth_grants
       (id, user_id, server_id, client_id, client_name, resource, scope,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    grant.id,
    grant.user_id,
    grant.server_id,
    grant.client_id,
    grant.client_name,
    grant.resource,
    grant.scope,
    now,
  );
  const refreshToken = newToken(REFRESH_PREFIX);
  await storeRefresh(db, grant.id, refreshToken);
  await trimGrants(db, grant, now);
  return issue(secret, grant, refreshToken, now);
}

async function exchangeRefresh(
  context: Site,
  secret: string,
  form: URLSearchParams,
) {
  const offered = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  if (offered === "" || clientId === "") {
    const needed = "refresh_token and client_id are required";
    return tokenError("invalid_request", needed);
  }
  const invalid = () => {
    return tokenError("invalid_grant", "refresh token is invalid or expired");
  };
  if (!REFRESH_PATTERN.test(offered)) return invalid();
  const { db } = context;
  const find = "SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?";
  const token = await store.one<RefreshRow>(db, find, await sha256Hex(offered));
  const grant = token === null ? null : await grantById(db, token.grant_id);
  const now = Date.now();
  if (token === null || grant === null || token.expires_at <= now) {
    return invalid();
  }
  if (grant.revoked_at !== null || grant.client_id !== clientId) {
    return invalid();
  }
  if (!sameResource(context, form.get("resource"), grant.resource)) {
    return invalid();
  }
  if (!(await isActive(db, grant.server_id, grant.user_id))) return invalid();
  const { rotated_at: rotatedAt } = token;
  if (rotatedAt !== null && now - rotatedAt > REFRESH_REUSE_GRACE_MS) {
    await revokeGrant(db, grant.id, now);
    return invalid();
  }
  const signature = await hmac(secret, `${SUCCESSOR_CONTEXT}.${offered}`);
  const successor = `${REFRESH_PREFIX}_${signature}`;
  await storeRefresh(db, grant.id, successor);
  await store.run(
    db,
    `UPDATE oauth_refresh_tokens SET rotated_at = ?
     WHERE token_hash = ? AND rotated_at IS NULL`,
    now,
    token.token_hash,
  );
  await store.run(
    db,
    `DELETE FROM oauth_refresh_tokens
     WHERE grant_id = ? AND (expires_at < ? OR rotated_at < ?)`,
    grant.id,
    now,
    now - ROTATED_REFRESH_RETENTION_MS,
  );
  const used = "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?";
  await store.run(db, used, now, grant.id);
  return issue(secret, grant, successor, now);
}

async function token(request: Request, context: Site): Promise<Response> {
  const secret = secretOf(context);
  if (secret === null) return tokenError("server_error", SECRET_MISSING, 503);
  const form = await formOf(request);
  if (form === null) {
    return tokenError("invalid_request", `request body must be ${FORM}`);
  }
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    return exchangeCode(context, secret, form);
  }
  if (grantType === "refresh_token") {
    return exchangeRefresh(context, secret, form);
  }
  const supported = "grant_type must be authorization_code or refresh_token";
  return tokenError("unsupported_grant_type", supported);
}

async function revoke(request: Request, context: Site): Promise<Response> {
  const done = new Response(null, { headers: TOKEN_HEADERS });
  const form = await formOf(request).catch(() => null);
  const offered = form?.get("token") ?? "";
  const secret = secretOf(context);
  if (offered === "" || secret === null) return done;
  const { db } = context;
  let grantId: string | null = null;
  if (REFRESH_PATTERN.test(offered)) {
    const find = "SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?";
    const hash = await sha256Hex(offered);
    grantId = (await store.one<RefreshRow>(db, find, hash))?.grant_id ?? null;
  } else {
    grantId = (await verify(offered, secret))?.grantId ?? null;
  }
  if (grantId !== null) await revokeGrant(db, grantId, Date.now());
  return done;
}

function metadata(context: Site): Response {
  const issuer = context.apexOrigin;
  const body = {
    issuer,
    authorization_endpoint: `${issuer}${wire.OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${wire.OAUTH_TOKEN_PATH}`,
    revocation_endpoint: `${issuer}${wire.OAUTH_REVOKE_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [wire.MCP_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  const headers = { "cache-control": "public, max-age=300" };
  return Response.json(body, { headers });
}

export function apexRoute(
  request: Request,
  context: Site,
  path: string,
): Promise<Response> | Response | null {
  const { method } = request;
  const reading = method === "GET" || method === "HEAD";
  if (path === wire.OAUTH_AUTHORIZATION_SERVER_METADATA_PATH && reading) {
    return metadata(context);
  }
  if (method !== "POST") return null;
  if (path === wire.OAUTH_TOKEN_PATH) return token(request, context);
  if (path === wire.OAUTH_REVOKE_PATH) return revoke(request, context);
  return null;
}

export async function admit(
  context: Site,
  offered: string,
  resource: string,
  server: store.Server,
): Promise<wire.McpGrant | "unconfigured" | null> {
  const secret = secretOf(context);
  if (secret === null) return "unconfigured";
  const claims = await verify(offered, secret);
  if (claims === null || claims.resource !== resource) return null;
  if (parseResource(context, resource)?.label !== server.label) return null;
  if (claims.serverId !== server.id || claims.userId !== server.user_id) {
    return null;
  }
  if (!claims.scope.split(/\s+/u).includes(wire.MCP_SCOPE)) return null;
  const grant = await grantById(context.db, claims.grantId);
  if (grant === null || grant.revoked_at !== null) return null;
  if (grant.user_id !== claims.userId || grant.server_id !== claims.serverId) {
    return null;
  }
  if (grant.last_used_at === null) {
    const first = `UPDATE oauth_grants SET last_used_at = ?
       WHERE id = ? AND last_used_at IS NULL`;
    await store.run(context.db, first, Date.now(), grant.id);
  }
  const { grantId, clientName } = claims;
  return { grantId, scope: wire.MCP_SCOPE, clientName };
}
