import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as oauth from "../src/oauth.js";
import * as site from "../src/site.js";
import * as store from "../src/store.js";

type Json = Record<string, unknown>;
type Over = Record<string, string | null>;
type Call = { url: string; init: RequestInit | undefined };
type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

interface TokenBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface Grant {
  id: string;
  user_id: string;
  server_id: string;
  client_id: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface Refresh {
  token_hash: string;
  expires_at: number;
  rotated_at: number | null;
}

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const T0 = Date.UTC(2026, 9, 11, 12);
const BASE = "getbb.dev";
const APEX = `https://${BASE}`;
const SECRET = "test-secret";
const CLIENT_ID = "https://claude.example/oauth/client.json";
const REDIRECT_URI = "https://claude.example/callback?tenant=1";
const RESOURCE = `https://alice.${BASE}/mcp`;
const SECOND = `https://alice2.${BASE}/mcp`;
const FRP = `https://alice.fly.${BASE}/mcp`;
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const JSON_HEADERS = { "content-type": "application/json" };
const FORM = "application/x-www-form-urlencoded";
const SECRET_SHAPE = "[A-Za-z0-9_-]{43}";
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60_000;
const REFRESH_REUSE_GRACE_MS = 60_000;
const REVOKED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

let relay: Miniflare;
let db: Database;
let context: site.Site;
let now = T0;

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function siteFor(url: string, secret: string | null = SECRET) {
  const env = {
    DB: db,
    BASE_DOMAIN: new URL(url).host,
    FRP_BASE_DOMAIN: `fly.${new URL(url).host}`,
    ...(secret === null ? {} : { MCP_TOKEN_SECRET: secret }),
  } as unknown as site.Env;
  return site.siteOf(new Request(url), env);
}

async function rows<Row>(sql: string, ...values: (string | number)[]) {
  const found = await db
    .prepare(sql)
    .bind(...values)
    .all();
  return found.results as Row[];
}

async function change(sql: string, ...values: (string | number | null)[]) {
  await db
    .prepare(sql)
    .bind(...values)
    .run();
}

function grants() {
  return rows<Grant>("SELECT * FROM oauth_grants ORDER BY created_at, rowid");
}

function refreshRows() {
  return rows<Refresh>("SELECT * FROM oauth_refresh_tokens");
}

function codes() {
  return rows<Json>("SELECT * FROM oauth_codes");
}

async function liveRefreshRows() {
  return (await refreshRows()).filter((row) => row.rotated_at === null).length;
}

async function person(id: string): Promise<store.User> {
  const found = await store.userById(db, id);
  if (found === null) throw new Error(`no user ${id}`);
  return found;
}

async function serverOf(id: string): Promise<store.Server> {
  const found = await store.serverById(db, id);
  if (found === null) throw new Error(`no server ${id}`);
  return found;
}

function clientDocument(over: Json = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: "Claude",
    redirect_uris: [REDIRECT_URI, "http://127.0.0.1/cb"],
    token_endpoint_auth_method: "none",
    ...over,
  };
}

function answering(respond: () => Response, calls: Call[] = []) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  });
  return calls;
}

function serving(over: Json = {}) {
  const headers = JSON_HEADERS;
  return answering(() => Response.json(clientDocument(over), { headers }));
}

function authorizeParams(over: Over = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "bb",
    state: "st-1",
  });
  for (const [name, value] of Object.entries(over)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  return params;
}

async function consent(over: Over = {}, userId = "alice") {
  return oauth.consentOf(context, await person(userId), authorizeParams(over));
}

async function decide(over: Over = {}, approved = true) {
  const user = await person("alice");
  return oauth.decide(context, user, authorizeParams(over), approved);
}

function redirected(outcome: { url: string } | { problem: string }) {
  if ("problem" in outcome) throw new Error(outcome.problem);
  return new URL(outcome.url);
}

async function authorize(over: Over = {}) {
  const code = redirected(await decide(over)).searchParams.get("code");
  if (code === null) throw new Error("no code issued");
  return code;
}

async function post(path: string, body: Json, contentType = FORM) {
  const sent = new URLSearchParams(body as Record<string, string>).toString();
  const headers = { "content-type": contentType };
  const request = new Request(`${APEX}${path}`, {
    method: "POST",
    headers,
    body: sent,
  });
  const answered = await oauth.apexRoute(request, context, path);
  if (answered === null) throw new Error(`nothing answered ${path}`);
  return answered;
}

function tokenRequest(body: Json, contentType = FORM) {
  return post("/oauth/token", body, contentType);
}

function revokeRequest(token: string) {
  return post("/oauth/revoke", { token });
}

function codeBody(code: string, over: Json = {}) {
  return {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    ...over,
  };
}

async function tokens(response: Response): Promise<TokenBody> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

async function expectTokenError(response: Response, error: string) {
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error });
}

async function exchange(over: Over = {}) {
  return tokens(await tokenRequest(codeBody(await authorize(over))));
}

function refresh(offered: string, clientId = CLIENT_ID, over: Json = {}) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: offered,
    client_id: clientId,
    ...over,
  });
}

function claimsOf(accessToken: string): Json {
  const [payload = ""] = accessToken.slice("bbmcp_".length).split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Json;
}

function signed(over: Json = {}, secret = SECRET) {
  const claims = {
    version: 1,
    userId: "alice",
    serverId: "srv-alice",
    grantId: "grant-1",
    resource: RESOURCE,
    scope: "bb",
    clientName: "Claude",
    issuedAt: T0,
    expiresAt: T0 + 60_000,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`bb-mcp-access-token-v1.${payload}`)
    .digest("base64url");
  return `bbmcp_${payload}.${signature}`;
}

async function seedGrant(over: Json = {}) {
  const grant = {
    id: "grant-1",
    user_id: "alice",
    server_id: "srv-alice",
    resource: RESOURCE,
    revoked_at: null,
    ...over,
  } as Record<string, string | number | null>;
  await change(
    `INSERT INTO oauth_grants
       (id, user_id, server_id, client_id, client_name, resource, scope,
        created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'Claude', ?, 'bb', ?, ?)`,
    grant.id ?? null,
    grant.user_id ?? null,
    grant.server_id ?? null,
    CLIENT_ID,
    grant.resource ?? null,
    T0,
    grant.revoked_at ?? null,
  );
}

async function admit(token: string, resource = RESOURCE) {
  const server = await serverOf("srv-alice");
  return oauth.admit(context, token, resource, server);
}

beforeAll(async () => {
  relay = new Miniflare({
    modules: true,
    script: "export default { fetch: () => new Response(null) }",
    d1Databases: ["DB"],
  });
  db = await relay.getD1Database("DB");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    const statements = readFileSync(join(MIGRATIONS, file), "utf8").split(";");
    const prepared = statements.flatMap((statement) =>
      statement.trim() === "" ? [] : [db.prepare(statement)],
    );
    await db.batch(prepared);
  }
});

afterAll(() => relay.dispose());

beforeEach(async () => {
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  context = siteFor(APEX);
  for (const table of ["oauth_codes", "oauth_grants", "servers", "users"]) {
    await change(`DELETE FROM ${table}`);
  }
  const people = [
    ["alice", 1],
    ["bob", 2],
  ] as const;
  for (const [id, githubId] of people) {
    const add = `INSERT INTO users (id, github_id, login, name, created_at)
       VALUES (?, ?, ?, ?, ?)`;
    await change(add, id, githubId, id, `Name ${id}`, T0);
  }
  const servers = [
    ["srv-alice", "alice", "alice", hash("bbcred_alice")],
    ["srv-alice-2", "alice", "alice2", hash("bbcred_two")],
    ["srv-bob", "bob", "bob", null],
  ] as const;
  for (const [id, userId, label, credential] of servers) {
    const add = `INSERT INTO servers
         (id, user_id, label, credential_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`;
    await change(add, id, userId, label, credential, T0);
  }
  serving();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authorization server metadata", () => {
  it("describes a CIMD-only public-client server under the issuer", async () => {
    const path = "/.well-known/oauth-authorization-server";
    const request = new Request(`${APEX}${path}`);
    const answered = await oauth.apexRoute(request, context, path);
    expect(answered?.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await answered?.json()).toEqual({
      issuer: APEX,
      authorization_endpoint: `${APEX}/oauth/authorize`,
      token_endpoint: `${APEX}/oauth/token`,
      revocation_endpoint: `${APEX}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["bb"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("client metadata documents", () => {
  const load = (clientId = CLIENT_ID) => oauth.fetchClient(clientId, false);

  it("fetches without following redirects and normalizes the name", async () => {
    const headers = { "content-type": "application/json; charset=utf-8" };
    const named = clientDocument({ client_name: `  ${"n".repeat(90)}` });
    const calls = answering(() => Response.json(named, { headers }));
    expect(await load()).toEqual({
      clientId: CLIENT_ID,
      clientName: "n".repeat(80),
      redirectUris: [REDIRECT_URI, "http://127.0.0.1/cb"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CLIENT_ID);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a redirect response", async () => {
    const headers = { location: "https://evil.example/client.json" };
    answering(() => new Response(null, { status: 302, headers }));
    expect(await load()).toHaveProperty("problem");
  });

  it("rejects a document over 5 KB even when it streams without a length", async () => {
    const big = JSON.stringify(clientDocument({ padding: "x".repeat(6000) }));
    answering(() => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      });
      return new Response(body, { headers: JSON_HEADERS });
    });
    const problem = "client metadata document is too large";
    expect(await load()).toEqual({ problem });
  });

  it("accepts a document of exactly 5 KB and rejects one byte more", async () => {
    const empty = JSON.stringify(clientDocument({ padding: "" })).length;
    for (const [extra, accepted] of [
      [0, true],
      [1, false],
    ] as const) {
      const padding = "x".repeat(5 * 1024 - empty + extra);
      const body = JSON.stringify(clientDocument({ padding }));
      expect(body.length).toBe(5 * 1024 + extra);
      answering(() => new Response(body, { headers: JSON_HEADERS }));
      expect("problem" in (await load())).toBe(!accepted);
    }
  });

  it.each([
    ["a mismatched client_id", { client_id: `${CLIENT_ID}/` }],
    [
      "a confidential auth method",
      { token_endpoint_auth_method: "client_secret_basic" },
    ],
    ["an empty client_name", { client_name: "   " }],
    ["empty redirect_uris", { redirect_uris: [] }],
    ["non-string redirect_uris", { redirect_uris: [REDIRECT_URI, 7] }],
  ])("rejects %s", async (_label, over) => {
    serving(over);
    expect(await load()).toHaveProperty("problem");
  });

  it("rejects a non-JSON content type", async () => {
    const headers = { "content-type": "text/html" };
    const body = JSON.stringify(clientDocument());
    answering(() => new Response(body, { headers }));
    expect(await load()).toHaveProperty("problem");
  });

  it.each([
    "http://claude.example/oauth/client.json",
    "http://localhost:3000/client.json",
    "https://203.0.113.9/client.json",
    "https://[2001:db8::1]/client.json",
    "https://user:pw@claude.example/client.json",
    "https://claude.example/client.json#frag",
    "https://claude.example",
    "not a url",
  ])("never fetches the disallowed client_id %s", async (clientId) => {
    const calls = answering(() => Response.json({}));
    expect(await load(clientId)).toHaveProperty("problem");
    expect(calls).toHaveLength(0);
  });

  it("allows a loopback http client_id only in local dev", async () => {
    const clientId = "http://localhost:3000/client.json";
    serving({ client_id: clientId });
    expect(await oauth.fetchClient(clientId, true)).not.toHaveProperty(
      "problem",
    );
    const remote = "http://claude.example/client.json";
    serving({ client_id: remote });
    expect(await oauth.fetchClient(remote, true)).toHaveProperty("problem");
  });

  it("treats a thrown fetch as a failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    expect(await load()).toHaveProperty("problem");
  });
});

describe("redirect URI matching", () => {
  const match = oauth.matchRedirectUri;

  it("requires an exact match for https redirect URIs", () => {
    const registered = ["https://app.example/cb"];
    expect(match("https://app.example/cb", registered)).toBe(true);
    expect(match("https://app.example/cb/", registered)).toBe(false);
    expect(match("https://app.example/cb?x=1", registered)).toBe(false);
    expect(match("https://app.example:8443/cb", registered)).toBe(false);
    expect(match("https://app.example.evil.test/cb", registered)).toBe(false);
  });

  it("ignores only the port for loopback redirect URIs", () => {
    const registered = ["http://127.0.0.1/cb", "http://[::1]:1/cb"];
    expect(match("http://127.0.0.1:51234/cb", registered)).toBe(true);
    expect(match("http://[::1]:9/cb", registered)).toBe(true);
    expect(match("http://127.0.0.1:51234/other", registered)).toBe(false);
    expect(match("http://localhost:51234/cb", registered)).toBe(false);
  });

  it("rejects non-https, non-loopback redirect URIs even when registered", () => {
    const plain = "http://app.example/cb";
    const fragment = "https://app.example/cb#f";
    expect(match(plain, [plain])).toBe(false);
    expect(match("myapp://cb", ["myapp://cb"])).toBe(false);
    expect(match(fragment, [fragment])).toBe(false);
  });
});

describe("authorization requests", () => {
  it("shows consent for a valid request", async () => {
    const shown = await consent({ redirect_uri: "http://127.0.0.1:4455/cb" });
    expect(shown).toEqual({
      clientName: "Claude",
      clientIdHost: "claude.example",
      redirectHost: "127.0.0.1:4455",
      loopbackRedirect: true,
      serverLabel: "alice",
      address: `alice.${BASE}`,
    });
  });

  it("shows consent for the server's second public origin", async () => {
    expect(await consent({ resource: FRP })).toMatchObject({
      serverLabel: "alice",
      address: `alice.fly.${BASE}`,
    });
    expect((await exchange({ resource: FRP })).scope).toBe("bb");
    expect(claimsOf((await exchange({ resource: FRP })).access_token)).toEqual(
      expect.objectContaining({ resource: FRP, serverId: "srv-alice" }),
    );
  });

  it("shows an error page instead of redirecting to an unregistered URI", async () => {
    const evil = { redirect_uri: "https://evil.example/cb" };
    expect(await consent(evil)).toHaveProperty("problem");
    expect(await decide(evil)).toHaveProperty("problem");
    expect(await consent({ redirect_uri: null })).toHaveProperty("problem");
    answering(() => new Response("nope", { status: 404 }));
    expect(await consent()).toHaveProperty("problem");
    expect(await codes()).toHaveLength(0);
  });

  it.each([
    ["unsupported_response_type", { response_type: "token" }],
    ["invalid_request", { code_challenge: null }],
    ["invalid_request", { code_challenge_method: "plain" }],
    ["invalid_target", { resource: null }],
    ["invalid_target", { resource: `https://bob.${BASE}/mcp` }],
    ["invalid_target", { resource: `https://nobody.${BASE}/mcp` }],
    ["invalid_target", { resource: `https://alice.${BASE}/other` }],
    ["invalid_target", { resource: `http://alice.${BASE}/mcp` }],
    ["invalid_target", { resource: `https://alice--8000.${BASE}/mcp` }],
    ["invalid_target", { resource: `https://alice.${BASE}.evil.test/mcp` }],
    ["invalid_scope", { scope: "admin offline_access" }],
  ])("shows an error page naming %s for %o", async (error, over) => {
    const outcomes = [
      await consent(over),
      await decide(over, true),
      await decide(over, false),
    ];
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ problem: expect.stringContaining(error) });
    }
    expect(await codes()).toHaveLength(0);
  });

  it("never bounces a malformed request to an attacker-hosted client", async () => {
    const evilClient = "https://evil.example/c.json";
    const evilRedirect = "https://evil.example/x";
    const document = {
      client_id: evilClient,
      client_name: "Evil",
      redirect_uris: [evilRedirect],
    };
    answering(() => Response.json(document, { headers: JSON_HEADERS }));
    const evil = { client_id: evilClient, redirect_uri: evilRedirect };
    const malformed = { ...evil, response_type: "bogus" };
    const shown = await consent(malformed);
    expect(shown).toHaveProperty("problem");
    expect(JSON.stringify(shown)).not.toContain("evil.example");
    for (const approved of [true, false]) {
      const decided = await decide(malformed, approved);
      expect(decided).toHaveProperty("problem");
      expect(JSON.stringify(decided)).not.toContain("evil.example");
    }
    expect(await consent(evil)).toMatchObject({ clientName: "Evil" });
    const denied = redirected(await decide(evil, false));
    expect(denied.searchParams.get("error")).toBe("access_denied");
  });

  it("returns access_denied without a code when the user declines", async () => {
    const denied = redirected(await decide({ state: null }, false));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.has("state")).toBe(false);
    expect(denied.searchParams.has("code")).toBe(false);
    expect(await codes()).toHaveLength(0);
  });

  it("stores only the code hash and keeps the redirect URI query", async () => {
    const url = redirected(await decide());
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://claude.example/callback",
    );
    expect(url.searchParams.get("tenant")).toBe("1");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("iss")).toBe(APEX);
    const code = url.searchParams.get("code") ?? "";
    expect(code).toMatch(new RegExp(`^bbmcpc_${SECRET_SHAPE}$`, "u"));
    const stored = await codes();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored[0]).toMatchObject({
      code_hash: hash(code),
      user_id: "alice",
      server_id: "srv-alice",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      scope: "bb",
      code_challenge: CHALLENGE,
      expires_at: T0 + oauth.CODE_TTL_MS,
    });
    expect(oauth.CODE_TTL_MS).toBe(60_000);
  });

  it.each([["bb"], [null], [""], ["bb offline_access"]])(
    "grants scope bb when the requested scope is %o",
    async (scope) => {
      expect((await exchange({ scope })).scope).toBe("bb");
      expect((await grants())[0]?.scope).toBe("bb");
    },
  );
});

describe("token endpoint: authorization_code", () => {
  it("issues a verifiable access token and a hashed refresh token", async () => {
    const body = await exchange();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(oauth.ACCESS_TOKEN_TTL_MS).toBe(3600 * 1000);
    expect(body.refresh_token).toMatch(
      new RegExp(`^bbmcpr_${SECRET_SHAPE}$`, "u"),
    );
    const [grant] = await grants();
    expect(grant).toMatchObject({
      user_id: "alice",
      server_id: "srv-alice",
      client_id: CLIENT_ID,
      revoked_at: null,
    });
    expect(claimsOf(body.access_token)).toEqual({
      version: 1,
      userId: "alice",
      serverId: "srv-alice",
      grantId: grant?.id,
      resource: RESOURCE,
      scope: "bb",
      clientName: "Claude",
      issuedAt: T0,
      expiresAt: T0 + oauth.ACCESS_TOKEN_TTL_MS,
    });
    expect(await admit(body.access_token)).toEqual({
      grantId: grant?.id,
      scope: "bb",
      clientName: "Claude",
      expiresAt: T0 + oauth.ACCESS_TOKEN_TTL_MS,
    });
    context = siteFor(APEX, "other-secret");
    expect(await admit(body.access_token)).toBeNull();
    const stored = await refreshRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toBe(hash(body.refresh_token));
    expect(stored[0]?.expires_at).toBe(T0 + REFRESH_TOKEN_TTL_MS);
  });

  it("rejects a replayed code", async () => {
    const code = await authorize();
    await tokens(await tokenRequest(codeBody(code)));
    await expectTokenError(await tokenRequest(codeBody(code)), "invalid_grant");
    expect(await grants()).toHaveLength(1);
  });

  it.each([
    ["a wrong PKCE verifier", { code_verifier: "w".repeat(64) }],
    ["a malformed PKCE verifier", { code_verifier: "short" }],
    ["a different redirect_uri", { redirect_uri: "http://127.0.0.1/cb" }],
    [
      "a different client_id",
      { client_id: "https://other.example/client.json" },
    ],
    ["a different resource", { resource: SECOND }],
    ["the server's other public origin", { resource: FRP }],
  ])("rejects %s and burns the code", async (_label, over) => {
    const code = await authorize();
    const changed = await tokenRequest(codeBody(code, over));
    await expectTokenError(changed, "invalid_grant");
    await expectTokenError(await tokenRequest(codeBody(code)), "invalid_grant");
    expect(await grants()).toHaveLength(0);
  });

  it("rejects an expired code", async () => {
    const early = await authorize();
    now = T0 + oauth.CODE_TTL_MS - 1;
    await tokens(await tokenRequest(codeBody(early)));
    now = T0;
    const code = await authorize();
    now = T0 + oauth.CODE_TTL_MS;
    await expectTokenError(await tokenRequest(codeBody(code)), "invalid_grant");
  });

  it("rejects a code whose server changed owner before the exchange", async () => {
    const code = await authorize();
    await change("UPDATE servers SET user_id = 'bob' WHERE id = 'srv-alice'");
    await expectTokenError(await tokenRequest(codeBody(code)), "invalid_grant");
    expect(await grants()).toHaveLength(0);
  });

  it("rejects missing parameters, other content types and grant types", async () => {
    const code = await authorize();
    const partial = { grant_type: "authorization_code", code };
    await expectTokenError(await tokenRequest(partial), "invalid_request");
    const typed = await tokenRequest(codeBody(code), "application/json");
    await expectTokenError(typed, "invalid_request");
    const other = await tokenRequest({ grant_type: "client_credentials" });
    await expectTokenError(other, "unsupported_grant_type");
    await tokens(await tokenRequest(codeBody(code)));
  });

  it("accepts an exchange that omits redirect_uri", async () => {
    const { redirect_uri: _omitted, ...body } = codeBody(await authorize());
    const issued = await tokens(await tokenRequest(body));
    expect(issued.refresh_token).toMatch(/^bbmcpr_/u);
    expect(await grants()).toHaveLength(1);
  });

  it("compares a presented resource after normalising it", async () => {
    const shouted = { resource: `https://ALICE.${BASE}:443/mcp` };
    await tokens(await tokenRequest(codeBody(await authorize(), shouted)));
    for (const resource of [
      "not a url",
      `${RESOURCE}?x=1`,
      `${RESOURCE}/`,
      `http://alice.${BASE}/mcp`,
    ]) {
      const refused = await tokenRequest(
        codeBody(await authorize(), { resource }),
      );
      await expectTokenError(refused, "invalid_grant");
    }
    expect(await grants()).toHaveLength(1);
  });

  it("leaves a stored code alone when the offered code is unknown", async () => {
    const code = await authorize();
    const unknown = `bbmcpc_${"A".repeat(43)}`;
    const refused = await tokenRequest(codeBody(unknown));
    await expectTokenError(refused, "invalid_grant");
    expect(await codes()).toHaveLength(1);
    expect(await grants()).toHaveLength(0);
    await tokens(await tokenRequest(codeBody(code)));
  });

  it("keeps an earlier device connected when a second one connects", async () => {
    const laptop = await exchange();
    now += 1000;
    const desktop = await exchange();
    const made = await grants();
    expect(made).toHaveLength(2);
    expect(made.every((grant) => grant.revoked_at === null)).toBe(true);
    await tokens(await refresh(laptop.refresh_token));
    await tokens(await refresh(desktop.refresh_token));
    expect(await oauth.appsOf(context, "alice")).toHaveLength(2);
  });

  it("caps live grants per client and server by revoking the oldest", async () => {
    expect(oauth.MAX_GRANTS_PER_CLIENT).toBe(10);
    const issued: TokenBody[] = [];
    for (let index = 0; index < oauth.MAX_GRANTS_PER_CLIENT + 2; index += 1) {
      issued.push(await exchange());
      now += 1000;
    }
    const otherServer = await exchange({ resource: SECOND });
    const made = await grants();
    const live = made.filter((grant) => grant.revoked_at === null);
    const own = live.filter((grant) => grant.server_id === "srv-alice");
    expect(own).toHaveLength(oauth.MAX_GRANTS_PER_CLIENT);
    expect(made.filter((grant) => grant.revoked_at !== null)).toHaveLength(2);
    for (const oldest of issued.slice(0, 2)) {
      const refused = await refresh(oldest.refresh_token);
      await expectTokenError(refused, "invalid_grant");
      expect(await admit(oldest.access_token)).toBeNull();
    }
    for (const kept of [...issued.slice(2), otherServer]) {
      await tokens(await refresh(kept.refresh_token));
    }
  }, 60_000);

  it("deletes the user's long-revoked grants when a new grant is created", async () => {
    await exchange();
    now += 1;
    await exchange();
    now = T0;
    const [stale, recent] = await grants();
    if (!stale || !recent) throw new Error("grants were not created");
    const revokeAt = "UPDATE oauth_grants SET revoked_at = ? WHERE id = ?";
    await change(revokeAt, T0, stale.id);
    await change(revokeAt, T0 + 1000, recent.id);
    const bobs = { id: "bob-stale", user_id: "bob", server_id: "srv-bob" };
    await seedGrant({ ...bobs, revoked_at: T0 });
    now = T0 + REVOKED_GRANT_RETENTION_MS + 500;
    await exchange();
    const remaining = (await grants()).map((grant) => grant.id);
    expect(remaining).not.toContain(stale.id);
    expect(remaining).toContain(recent.id);
    expect(remaining).toContain("bob-stale");
    expect(remaining).toHaveLength(3);
  });
});

describe("token endpoint: refresh_token", () => {
  it("rotates the refresh token and keeps the grant's claims", async () => {
    const first = await exchange();
    now += 5 * 60 * 1000;
    const second = await tokens(await refresh(first.refresh_token));
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe("bb");
    const [grant] = await grants();
    expect(claimsOf(second.access_token)).toMatchObject({
      grantId: grant?.id,
      scope: "bb",
      issuedAt: now,
      expiresAt: now + oauth.ACCESS_TOKEN_TTL_MS,
    });
    expect(await admit(second.access_token)).toMatchObject({ scope: "bb" });
    expect(grant?.last_used_at).toBe(now);
    now += 5 * 60 * 1000;
    await tokens(await refresh(second.refresh_token));
  });

  it("gives a client that retries inside the grace window the same new refresh token", async () => {
    const first = await exchange();
    const second = await tokens(await refresh(first.refresh_token));
    now += REFRESH_REUSE_GRACE_MS;
    const retried = await tokens(await refresh(first.refresh_token));
    expect(retried.refresh_token).toBe(second.refresh_token);
    expect(retried.access_token).not.toBe(second.access_token);
    expect(await liveRefreshRows()).toBe(1);
    expect((await grants())[0]?.revoked_at).toBeNull();
    const next = await tokens(await refresh(second.refresh_token));
    expect(await liveRefreshRows()).toBe(1);
    await tokens(await refresh(next.refresh_token));
  });

  it("keeps one token chain when a rotated token is replayed inside the grace window after its successor was used", async () => {
    const first = await exchange();
    const second = await tokens(await refresh(first.refresh_token));
    const third = await tokens(await refresh(second.refresh_token));
    now += 1000;
    const replayed = await tokens(await refresh(first.refresh_token));
    expect(replayed.refresh_token).toBe(second.refresh_token);
    expect(await liveRefreshRows()).toBe(1);
    expect((await grants())[0]?.revoked_at).toBeNull();
    now += REFRESH_REUSE_GRACE_MS + 1;
    const reused = await refresh(replayed.refresh_token);
    await expectTokenError(reused, "invalid_grant");
    expect((await grants())[0]?.revoked_at).toBe(now);
    await expectTokenError(await refresh(third.refresh_token), "invalid_grant");
  });

  it("gives two refreshes issued back to back the same refresh token", async () => {
    const first = await exchange();
    const responses = await Promise.all([
      refresh(first.refresh_token),
      refresh(first.refresh_token),
    ]);
    const issued: string[] = [];
    for (const response of responses) {
      issued.push((await tokens(response)).refresh_token);
    }
    expect(new Set(issued).size).toBe(1);
    expect(await liveRefreshRows()).toBe(1);
    expect(await refreshRows()).toHaveLength(2);
    expect((await grants())[0]?.revoked_at).toBeNull();
    await tokens(await refresh(issued[0] ?? ""));
  });

  it("derives refresh tokens that cannot be predicted from an earlier one", async () => {
    const first = await exchange();
    const second = await tokens(await refresh(first.refresh_token));
    const other = await exchange();
    const otherSecond = await tokens(await refresh(other.refresh_token));
    expect(second.refresh_token).toMatch(
      new RegExp(`^bbmcpr_${SECRET_SHAPE}$`, "u"),
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(otherSecond.refresh_token).not.toBe(second.refresh_token);
    const third = await exchange();
    context = siteFor(APEX, "other-secret");
    const elsewhere = await tokens(await refresh(third.refresh_token));
    context = siteFor(APEX);
    const here = await tokens(await refresh(third.refresh_token));
    expect(here.refresh_token).not.toBe(elsewhere.refresh_token);
  });

  it("compares a presented resource after normalising it", async () => {
    const first = await exchange();
    const shouted = { resource: `https://ALICE.${BASE}:443/mcp` };
    const second = await tokens(
      await refresh(first.refresh_token, CLIENT_ID, shouted),
    );
    for (const resource of ["not a url", SECOND, `${RESOURCE}?x=1`, FRP]) {
      const refused = await refresh(second.refresh_token, CLIENT_ID, {
        resource,
      });
      await expectTokenError(refused, "invalid_grant");
    }
    expect((await grants())[0]?.revoked_at).toBeNull();
    await tokens(await refresh(second.refresh_token));
  });

  it("revokes the grant when a rotated token is reused after the grace window", async () => {
    const first = await exchange();
    const second = await tokens(await refresh(first.refresh_token));
    now += REFRESH_REUSE_GRACE_MS + 1;
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    expect((await grants())[0]?.revoked_at).toBe(now);
    expect(await refreshRows()).toHaveLength(0);
    const later = await refresh(second.refresh_token);
    await expectTokenError(later, "invalid_grant");
    expect(await admit(second.access_token)).toBeNull();
  });

  it("keeps a bounded number of refresh rows for a long-lived grant", async () => {
    let current = await exchange();
    for (let hour = 0; hour < 72; hour += 1) {
      now += HOUR;
      current = await tokens(await refresh(current.refresh_token));
    }
    expect((await refreshRows()).length).toBeLessThanOrEqual(26);
    expect((await grants())[0]?.revoked_at).toBeNull();
  }, 60_000);

  it("still detects reuse of a token rotated within the retention window", async () => {
    const first = await exchange();
    let current = await tokens(await refresh(first.refresh_token));
    for (let hour = 0; hour < 20; hour += 1) {
      now += HOUR;
      current = await tokens(await refresh(current.refresh_token));
    }
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    expect((await grants())[0]?.revoked_at).toBe(now);
    const later = await refresh(current.refresh_token);
    await expectTokenError(later, "invalid_grant");
  }, 60_000);

  it("rejects malformed codes and refresh tokens", async () => {
    await exchange();
    for (const malformed of [
      "bbmcpr_",
      "bbmcpr_short",
      `bbmcpr_${"a".repeat(44)}`,
      `bbmcpr_${"a".repeat(42)}!`,
      "a".repeat(50),
    ]) {
      await expectTokenError(await refresh(malformed), "invalid_grant");
      expect((await revokeRequest(malformed)).status).toBe(200);
    }
    const unreal = await tokenRequest(codeBody("bbmcpc_not-a-real-code"));
    await expectTokenError(unreal, "invalid_grant");
    expect((await grants())[0]?.revoked_at).toBeNull();
  });

  it("rejects unknown, expired and wrong-client refresh tokens", async () => {
    const first = await exchange();
    await expectTokenError(await refresh("bbmcpr_unknown"), "invalid_grant");
    const other = "https://other.example/client.json";
    const stolen = await refresh(first.refresh_token, other);
    await expectTokenError(stolen, "invalid_grant");
    const bare = { grant_type: "refresh_token", client_id: CLIENT_ID };
    await expectTokenError(await tokenRequest(bare), "invalid_request");
    now = T0 + REFRESH_TOKEN_TTL_MS;
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    expect((await grants())[0]?.revoked_at).toBeNull();
    now = T0 + REFRESH_TOKEN_TTL_MS - 1;
    await tokens(await refresh(first.refresh_token));
  });

  it("refuses to refresh a revoked grant", async () => {
    const first = await exchange();
    const grantId = (await grants())[0]?.id ?? "";
    expect(await oauth.revokeForUser(db, "bob", grantId)).toBe(false);
    expect(await oauth.revokeForUser(db, "alice", grantId)).toBe(true);
    expect(await oauth.revokeForUser(db, "alice", grantId)).toBe(false);
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    expect(await oauth.appsOf(context, "alice")).toEqual([]);
    expect(await admit(first.access_token)).toBeNull();
  });

  it("refuses to refresh once the server changes owner", async () => {
    const first = await exchange();
    await change("UPDATE servers SET user_id = 'bob' WHERE id = 'srv-alice'");
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    expect(await admit(first.access_token)).toBeNull();
  });
});

describe("revocation endpoint", () => {
  it("revokes the grant for a refresh token or a valid access token", async () => {
    const first = await exchange();
    const response = await revokeRequest(first.refresh_token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect((await grants())[0]?.revoked_at).not.toBeNull();

    now += 1000;
    const second = await exchange();
    expect((await revokeRequest(second.access_token)).status).toBe(200);
    const made = await grants();
    expect(made.every((grant) => grant.revoked_at !== null)).toBe(true);
    const refused = await refresh(second.refresh_token);
    await expectTokenError(refused, "invalid_grant");
  });

  it("answers 200 and revokes nothing for unknown or expired tokens", async () => {
    const first = await exchange();
    expect((await revokeRequest("garbage")).status).toBe(200);
    expect((await revokeRequest("bbmcpr_unknown")).status).toBe(200);
    expect((await revokeRequest(signed({}, "another-secret"))).status).toBe(
      200,
    );
    now = T0 + oauth.ACCESS_TOKEN_TTL_MS;
    expect((await revokeRequest(first.access_token)).status).toBe(200);
    expect((await grants())[0]?.revoked_at).toBeNull();
  });

  it("revokes a refresh token even when the relay has lost its signing secret", async () => {
    const first = await exchange();
    context = siteFor(APEX, null);
    expect((await revokeRequest(first.refresh_token)).status).toBe(200);
    expect((await grants())[0]?.revoked_at).toBe(now);
    expect(await refreshRows()).toHaveLength(0);
  });
});

describe("grant management", () => {
  it("lists a user's active grants across servers", async () => {
    await exchange();
    now += 1000;
    await exchange({ resource: SECOND });
    expect(await oauth.appsOf(context, "alice")).toMatchObject([
      {
        clientId: CLIENT_ID,
        clientName: "Claude",
        serverLabel: "alice2",
        address: `alice2.${BASE}`,
        scope: "bb",
        createdAt: T0 + 1000,
        lastUsedAt: null,
      },
      { serverLabel: "alice", address: `alice.${BASE}`, createdAt: T0 },
    ]);
    expect(await oauth.appsOf(context, "bob")).toEqual([]);
  });

  it("scopes the credential API to that credential's server", async () => {
    await exchange();
    const grantId = (await grants())[0]?.id ?? "";
    expect(await store.serverByCredential(db, "bbcred_wrong")).toBeNull();
    const second = await store.serverByCredential(db, "bbcred_two");
    const own = await store.serverByCredential(db, "bbcred_alice");
    if (second === null || own === null) throw new Error("no such server");
    expect(await oauth.grantsOfServer(db, second)).toEqual([]);
    expect(await oauth.grantsOfServer(db, own)).toMatchObject([
      { id: grantId, clientId: CLIENT_ID },
    ]);
    expect(await oauth.revokeForServer(db, second, grantId)).toBe(false);
    expect((await grants())[0]?.revoked_at).toBeNull();
    now += 1000;
    expect(await oauth.revokeForServer(db, own, grantId)).toBe(true);
    expect(await oauth.revokeForServer(db, own, grantId)).toBe(false);
    expect((await grants())[0]?.revoked_at).toBe(now);
    expect(await refreshRows()).toHaveLength(0);
  });
});

describe("MCP bearer authentication", () => {
  it("rejects tokens that do not belong to this server, user, resource or grant", async () => {
    await seedGrant();
    await seedGrant({ id: "grant-1-revoked", revoked_at: T0 });
    await seedGrant({ id: "grant-1-other-user", user_id: "bob" });
    await seedGrant({ id: "grant-1-other-server", server_id: "srv-alice-2" });
    const valid = signed();
    const [payload = "", signature = ""] = valid.slice(6).split(".");
    const widened = { ...claimsOf(valid), scope: "bb admin" };
    const forged = Buffer.from(JSON.stringify(widened)).toString("base64url");
    const flipped = signature.startsWith("A") ? "B" : "A";
    const invalid: Record<string, string> = {
      "another handle's resource": signed({
        resource: SECOND,
        serverId: "srv-alice-2",
      }),
      "mismatched resource": signed({ resource: SECOND }),
      "the other public origin": signed({ resource: FRP }),
      "another user": signed({ userId: "bob" }),
      "another server": signed({ serverId: "srv-alice-2" }),
      expired: signed({ expiresAt: T0 - 1 }),
      "expiring now": signed({ expiresAt: T0 }),
      "tampered signature": `bbmcp_${payload}.${flipped}${signature.slice(1)}`,
      "tampered payload": `bbmcp_${forged}.${signature}`,
      "wrong secret": signed({}, "another-secret"),
      "revoked grant": signed({ grantId: "grant-1-revoked" }),
      "missing grant": signed({ grantId: "grant-1-missing" }),
      "grant of another user": signed({ grantId: "grant-1-other-user" }),
      "grant of another server": signed({ grantId: "grant-1-other-server" }),
      "no recognised scope": signed({ scope: "admin" }),
      "another version": signed({ version: 2 }),
      garbage: "not-a-token",
      empty: "",
    };
    for (const [name, value] of Object.entries(invalid)) {
      expect(await admit(value), name).toBeNull();
    }
    expect(await admit(valid)).toEqual({
      grantId: "grant-1",
      scope: "bb",
      clientName: "Claude",
      expiresAt: claimsOf(valid).expiresAt,
    });
    expect(await admit(valid, FRP)).toBeNull();
    await seedGrant({ id: "grant-frp", resource: FRP });
    const viaFrp = signed({ grantId: "grant-frp", resource: FRP });
    expect(await admit(viaFrp, FRP)).toMatchObject({ grantId: "grant-frp" });
    expect(await admit(viaFrp)).toBeNull();
  });

  it("writes lastUsedAt only for a grant's first use", async () => {
    await seedGrant();
    const use = async () => {
      const token = signed({ expiresAt: now + 60_000 });
      expect(await admit(token)).not.toBeNull();
    };
    await use();
    await use();
    expect((await grants())[0]?.last_used_at).toBe(T0);
    now = T0 + 30_000 + 1;
    await use();
    now = T0 + 6 * HOUR;
    await use();
    expect((await grants())[0]?.last_used_at).toBe(T0);
  });

  it("forgets a server's codes, grants and refresh tokens when it is deleted", async () => {
    const first = await exchange();
    const pending = await authorize();
    expect(await admit(first.access_token)).not.toBeNull();
    const server = await serverOf("srv-alice");
    await store.deleteServer(db, "srv-alice");
    expect(await grants()).toHaveLength(0);
    expect(await refreshRows()).toHaveLength(0);
    expect(await codes()).toHaveLength(0);
    const { access_token: access } = first;
    expect(await oauth.admit(context, access, RESOURCE, server)).toBeNull();
    await expectTokenError(await refresh(first.refresh_token), "invalid_grant");
    const late = await tokenRequest(codeBody(pending));
    await expectTokenError(late, "invalid_grant");
    const problem = expect.stringContaining("invalid_target");
    expect(await consent()).toEqual({ problem });
  });

  it("says the relay is unconfigured instead of admitting anyone without a secret", async () => {
    await seedGrant();
    context = siteFor(APEX, null);
    expect(await admit(signed())).toBe("unconfigured");
    expect(await admit(signed({}, ""))).toBe("unconfigured");
  });
});
