import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { updateHost } from "../../../apps/server/src/db/hosts.js";
import { writePluginRow } from "../../../apps/server/src/db/plugins.js";
import { hashToken } from "../../../apps/server/src/runners/enrollment.js";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { startCliProxy } from "../../../packages/runner/src/remote/cli-proxy.js";
import { HUB_PATH } from "../src/contract.js";

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
interface Loose {
  [key: string]: Loose;
  [index: number]: Loose;
}
type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: object;
};
type Responder = (seen: Seen, response: ServerResponse) => unknown;
type Provider = "claude" | "codex";
type TestServer = Awaited<ReturnType<typeof createTestServer>>;

const LIMIT = "anthropic-ratelimit-unified";
const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const later = String(Math.round(Date.now() / 1_000) + 3_600);
const encode = (claims: object) => Buffer.from(JSON.stringify(claims));
const jwt = (claims: object) => `h.${encode(claims).toString("base64url")}.s`;
const parse = (text = ""): Loose => JSON.parse(text) as Loose;

function send(response: ServerResponse, reply: Reply = {}): void {
  const type = { "content-type": "application/json" };
  response.writeHead(reply.status ?? 200, { ...type, ...reply.headers });
  response.end(JSON.stringify(reply.body ?? { ok: true }));
}

async function fakeUpstream(respond: Responder) {
  const seen: Seen[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const { url: path = "", headers } = request;
    seen.push({ path, headers, body });
    if (path.includes("usage")) return send(response, { status: 404 });
    await respond({ path, headers, body }, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const at = (path: string) =>
    seen.filter((call) => call.path.startsWith(path));
  const tokens = (path: string) =>
    at(path).map((call) => call.headers.authorization?.slice(-1));
  return { url: `http://127.0.0.1:${port}`, at, tokens };
}

function planned() {
  const plan = new Map<string, Reply>();
  const respond: Responder = (seen, response) =>
    send(response, plan.get(seen.headers.authorization ?? ""));
  return { plan, respond };
}

function stored(n: number, provider: Provider) {
  const identity = { id: uuid(n), provider, kind: "oauth", label: `acct-${n}` };
  const codex = provider === "codex" ? { codexAccountId: `chatgpt-${n}` } : {};
  const owner = { email: `user${n}@example.com`, subscriptionType: "max" };
  const accountUuid = provider === "claude" ? uuid(n + 4) : null;
  const order = { enabled: true, priority: n, createdAt: 1 };
  const usage = { rateLimitTier: null, lastUsedAt: null, lastUsedHostId: null };
  return { ...identity, ...codex, ...owner, accountUuid, ...order, ...usage };
}

async function seed(server: TestServer, upstream: string, accounts: object[]) {
  const { ctx, url } = server;
  const dataDir = join(ctx.config.dataDir, "plugins", "account-pool");
  const secrets = join(dataDir, "secrets", "accounts");
  fs.mkdirSync(secrets, { recursive: true });
  const secretFile = (n: number) => join(secrets, `account-${uuid(n)}.json`);
  const writeSecret = (n: number, lifetimeMs = 3_600_000) => {
    const tokens = { accessToken: `access-${n}`, refreshToken: `refresh-${n}` };
    const expiresAt = Date.now() + lifetimeMs;
    const secret = { kind: "oauth", ...tokens, expiresAt };
    fs.writeFileSync(secretFile(n), JSON.stringify(secret));
  };
  for (const n of [1, 2, 3, 4]) writeSecret(n);
  const put = (key: string, value: unknown) => {
    const text = JSON.stringify(value);
    writePluginRow(ctx.db, "plugin_kv", "account-pool", key, text);
  };
  put("accounts:v1", accounts);
  put("routing.codex", true);
  put("routed:thr_old", { hostId: "host_gone", routedAt: 1 });
  put("config", {
    anthropicUpstreamBaseUrl: upstream,
    codexUpstreamBaseUrl: `${upstream}/backend-api/codex`,
    claudeTokenUrl: `${upstream}/v1/oauth/token`,
    codexAuthBaseUrl: `${upstream}/auth`,
    switchThreshold: 0.98,
    parentMode: "proxy",
  });
  await ctx.plugins.reload("account-pool");
  const env = async (providerId: string, hostId = ctx.config.hostId) => {
    const scope = { threadId: "thr_1", projectId: "proj_1" };
    const thread = { ...scope, hostId, providerId };
    const entries = await ctx.plugins.contributedEnv(providerId, thread);
    return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
  };
  const cli = async (...argv: string[]) => {
    const init = { method: "POST", body: JSON.stringify({ argv, cwd: "/" }) };
    const target = `${url}/api/v1/plugins/account-pool/cli`;
    const result = parse(await (await fetch(target, init)).text());
    const json = argv.includes("--json") ? parse(String(result.stdout)) : {};
    return { exitCode: Number(result.exitCode), json: json as Loose };
  };
  const hub = (path: string, token: string, session: string, base = url) => {
    const user = { account_uuid: uuid(9), session_id: session };
    const metadata = { user_id: JSON.stringify(user) };
    const body = JSON.stringify({ model: "claude-opus-4", metadata });
    const custom = { "x-bb-account-pool-token": token, "x-custom": "dropped" };
    const sent = { "anthropic-version": "2023-06-01", "thread-id": session };
    const headers = { authorization: "Bearer local-login", ...custom, ...sent };
    const post = { method: "POST", headers, body };
    const init = path.endsWith("/models") ? { headers } : post;
    return fetch(`${base}${HUB_PATH}${path}`, init);
  };
  const token = async (providerId: string, variable: string) =>
    String((await env(providerId))[variable]);
  return { ...server, secrets, secretFile, writeSecret, env, cli, hub, token };
}

it("forwards Claude messages for stored accounts and streams SSE unbuffered", async () => {
  let finish = (): void => {};
  const held = new Promise<void>((resolve) => (finish = resolve));
  const upstream = await fakeUpstream(async (_seen, response) => {
    const stream = { "content-type": "text/event-stream; charset=utf-8" };
    response.writeHead(200, { ...stream, [`${LIMIT}-5h-utilization`]: "0.25" });
    response.write("event: message_start\ndata: {}\n\n");
    await held;
    response.end("event: message_stop\ndata: {}\n\n");
  });
  const server = await createTestServer();
  const { hostId, dataDir } = server.ctx.config;
  const value = "t".repeat(43);
  const legacyToken = {
    hostId,
    value,
    mintedAt: 5,
    lastUsedAt: null,
    previous: [],
  };
  const tokenDir = join(dataDir, "plugins/account-pool/secrets/accounts");
  fs.mkdirSync(tokenDir, { recursive: true });
  const tokenFile = join(tokenDir, `hub-token-${hostId}.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(legacyToken));
  const accounts = [stored(1, "claude"), stored(2, "claude")];
  const pool = await seed(server, upstream.url, accounts);
  expect(await pool.env("claude-code")).toEqual({
    ANTHROPIC_BASE_URL: { serverPath: HUB_PATH },
    ANTHROPIC_AUTH_TOKEN: value,
    ANTHROPIC_CUSTOM_HEADERS: `x-bb-account-pool-token: ${value}`,
    ENABLE_TOOL_SEARCH: "true",
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  });
  const refused = await pool.hub("/v1/messages", "wrong", "s1");
  const denial = parse(await refused.text()).error;
  expect(refused.status).toBe(401);
  expect(denial).toMatchObject({ type: "authentication_error" });
  const headers = { authorization: `Bearer ${value}` };
  const target = `${pool.url}${HUB_PATH}/v1/messages?beta=true`;
  const response = await fetch(target, { method: "POST", headers, body: "{}" });
  const reader = response.body?.getReader();
  const read = async () => Buffer.from((await reader?.read())?.value ?? []);
  expect(response.status).toBe(200);
  expect(String(await read())).toBe("event: message_start\ndata: {}\n\n");
  finish();
  expect(String(await read())).toContain("message_stop");
  expect((await pool.hub("/v1/messages", value, "s1")).status).toBe(200);
  const [streamed, posted] = upstream.at("/v1/messages");
  expect(streamed?.path).toBe("/v1/messages?beta=true");
  const forwarded = { authorization: "Bearer access-1" };
  const version = { "anthropic-version": "2023-06-01" };
  expect(posted?.headers).toMatchObject({ ...forwarded, ...version });
  expect(posted?.headers).not.toHaveProperty("x-custom");
  expect(posted?.headers).not.toHaveProperty("x-bb-account-pool-token");
  const user = parse(String(parse(posted?.body).metadata?.user_id));
  expect(user).toEqual({ account_uuid: uuid(5), session_id: "s1" });
  const hello = await fetch(`${pool.url}${HUB_PATH}/api/hello`, {
    method: "HEAD",
  });
  expect(hello.status).toBe(200);
});

it("switches at the usage threshold, keeps sessions sticky and reports exhaustion", async () => {
  const { plan, respond } = planned();
  const upstream = await fakeUpstream(respond);
  const accounts = [stored(1, "claude"), stored(2, "claude")];
  const pool = await seed(await createTestServer(), upstream.url, accounts);
  const token = await pool.token("claude-code", "ANTHROPIC_AUTH_TOKEN");
  const ask = async (...sessions: string[]) => {
    for (const session of sessions) {
      const answer = await pool.hub("/v1/messages", token, session);
      expect(answer.status).toBe(200);
    }
    return upstream.tokens("/v1/messages").join("");
  };
  await ask("s1");
  expect((await pool.cli("account", "disable", uuid(1))).exitCode).toBe(0);
  await ask("s2");
  const enabled = await pool.cli("account", "enable", uuid(1), "--json");
  expect(enabled.json).toMatchObject({ ok: true, account: { enabled: true } });
  expect(await ask("s1", "s2", "s3")).toBe("12122");
  const reset = (window: string) => ({ [`${LIMIT}-${window}-reset`]: later });
  const nearLimit = { [`${LIMIT}-5h-utilization`]: "0.99", ...reset("5h") };
  plan.set("Bearer access-2", { headers: nearLimit });
  expect(await ask("s2", "s2")).toBe("1212221");
  const rejected = { [`${LIMIT}-7d-status`]: "rejected", ...reset("7d") };
  plan.set("Bearer access-1", { status: 429, headers: rejected });
  const exhausted = await pool.hub("/v1/messages", token, "s2");
  const refusal = parse(await exhausted.text()).error;
  expect(exhausted.status).toBe(429);
  expect(refusal).toMatchObject({ type: "rate_limit_error" });
  expect(Number(exhausted.headers.get("retry-after"))).toBeGreaterThan(3_000);
  const listed = (await pool.cli("account", "list", "--json")).json.accounts;
  const spent = { status: "exhausted" };
  const weekly = [{ key: "7d", status: "rejected" }];
  expect(listed?.[0]).toMatchObject({ id: uuid(1), ...spent, windows: weekly });
  const fiveHour = [{ key: "5h", utilization: 0.99 }];
  expect(listed?.[1]).toMatchObject({
    id: uuid(2),
    ...spent,
    windows: fiveHour,
  });
  const raised = await pool.cli("config", "set", "switchThreshold", "1");
  expect(raised.exitCode).toBe(0);
  const status = (await pool.cli("status", "--json")).json;
  const routing = { claude: true, codex: true };
  const config = { switchThreshold: 1 };
  expect(status).toMatchObject({ route: HUB_PATH, routing, config });
  expect(status.accounts).toMatchObject([spent, { status: "ready" }]);
  expect(JSON.stringify(status)).not.toContain("access-");
});

it("routes Codex responses with ChatGPT headers and rotates on a usage-limit 429", async () => {
  const { plan, respond } = planned();
  const upstream = await fakeUpstream(respond);
  const accounts = [stored(3, "codex"), stored(4, "codex")];
  const pool = await seed(await createTestServer(), upstream.url, accounts);
  const env = await pool.env("codex");
  const token = String(env.CODEX_POOL_AUTH_TOKEN);
  expect(token).toMatch(/^[\w-]{43}$/u);
  expect(env.CODEX_OPENAI_BASE_URL).toEqual({ serverPath: `${HUB_PATH}/v1` });
  expect(await pool.env("claude-code")).toEqual({});
  const limit = {
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "3600",
    "x-codex-primary-window-minutes": "300",
  };
  plan.set("Bearer access-3", { status: 429, headers: limit });
  for (const path of ["/v1/responses", "/v1/responses", "/v1/models"]) {
    expect((await pool.hub(path, token, "t1")).status).toBe(200);
  }
  const calls = upstream.at("/backend-api/codex/");
  expect(upstream.tokens("/backend-api/codex/").join("")).toBe("3444");
  expect(calls[2]?.path).toBe("/backend-api/codex/responses");
  expect(calls[3]?.path).toBe("/backend-api/codex/models");
  const identity = { "chatgpt-account-id": "chatgpt-4", "thread-id": "t1" };
  expect(calls[1]?.headers).toMatchObject(identity);
  expect(calls[1]?.headers).not.toHaveProperty("x-custom");
  const listed = (await pool.cli("account", "list", "--json")).json.accounts;
  const window = { key: "primary", minutes: 300, utilization: 1 };
  expect(listed?.[0]).toMatchObject({ status: "exhausted", windows: [window] });
  expect((await pool.hub("/v1/responses", "", "t1")).status).toBe(401);
});

it("refreshes an expiring token once and marks an account whose refresh is refused", async () => {
  const upstream = await fakeUpstream(async (seen, response) => {
    if (!seen.path.endsWith("/oauth/token")) return send(response);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const known = String(parse(seen.body).refresh_token) === "refresh-1";
    if (!known) return send(response, { status: 400 });
    const rotated = { access_token: "access-9", refresh_token: "rotated" };
    send(response, { body: { ...rotated, expires_in: 3_600 } });
  });
  const accounts = [stored(1, "claude"), stored(2, "claude")];
  const pool = await seed(await createTestServer(), upstream.url, accounts);
  const token = await pool.token("claude-code", "ANTHROPIC_AUTH_TOKEN");
  await vi.waitFor(() =>
    expect(upstream.at("/api/oauth/usage")).toHaveLength(2),
  );
  pool.writeSecret(1, 60_000);
  pool.writeSecret(2, 60_000);
  const sessions = ["s1", "s2", "s3"];
  const answers = await Promise.all(
    sessions.map((session) => pool.hub("/v1/messages", token, session)),
  );
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  expect(upstream.tokens("/v1/messages").join("")).toBe("999");
  const refreshes = upstream
    .at("/v1/oauth/token")
    .map((call) => parse(call.body));
  const grant = { grant_type: "refresh_token", refresh_token: "refresh-1" };
  expect(refreshes).toEqual([{ ...grant, client_id: expect.any(String) }]);
  const secret = parse(fs.readFileSync(pool.secretFile(1), "utf8"));
  const fresh = { accessToken: "access-9", refreshToken: "rotated" };
  expect(secret).toMatchObject(fresh);
  expect(fs.statSync(pool.secretFile(1)).mode & 0o777).toBe(0o600);
  await pool.cli("account", "disable", uuid(1));
  expect((await pool.hub("/v1/messages", token, "s1")).status).toBe(429);
  const listed = (await pool.cli("account", "list", "--json")).json.accounts;
  const error = "OAuth refresh failed with HTTP 400.";
  expect(listed?.[1]).toMatchObject({ id: uuid(2), status: "error", error });
});

it("fails over on upstream errors and retries a rejected token after one forced refresh", async () => {
  const { plan, respond } = planned();
  const upstream = await fakeUpstream(respond);
  const accounts = [stored(1, "claude"), stored(2, "claude")];
  const pool = await seed(await createTestServer(), upstream.url, accounts);
  const token = await pool.token("claude-code", "ANTHROPIC_AUTH_TOKEN");
  const ask = async () => (await pool.hub("/v1/messages", token, "s1")).status;
  plan.set("Bearer access-1", { status: 529 });
  expect(await ask()).toBe(200);
  plan.set("Bearer access-2", { status: 503 });
  expect(await ask()).toBe(529);
  expect(upstream.tokens("/v1/messages").join("")).toBe("1221");
  const fresh = { access_token: "access-7", refresh_token: "r" };
  plan.set("", { body: { ...fresh, expires_in: 3_600 } });
  plan.set("Bearer access-2", { status: 401 });
  expect(await ask()).toBe(200);
  expect(upstream.tokens("/v1/messages").join("")).toBe("122127");
  expect(upstream.at("/v1/oauth/token")).toHaveLength(1);
});

it("contributes nothing without routing or a usable account and serves remote machines through the runner proxy", async () => {
  const upstream = await fakeUpstream((_seen, response) => send(response));
  const server = await createTestServer();
  const status = () =>
    server.ctx.plugins.list().find(({ id }) => id === "account-pool")?.status;
  expect(status()).toBe("needs-configuration");
  const accounts = [stored(1, "claude"), stored(3, "codex")];
  const pool = await seed(server, upstream.url, accounts);
  expect(status()).toBe("running");
  const json = { machineProviderId: "manual", inputs: null };
  const { id: hostId } = await (await server.api.hosts.$post({ json })).json();
  updateHost(server.ctx.db, hostId, { tokenHash: hashToken("bbr_remote") });
  const remote = await pool.env("claude-code", hostId);
  const local = await pool.token("claude-code", "ANTHROPIC_AUTH_TOKEN");
  const token = String(remote.ANTHROPIC_AUTH_TOKEN);
  expect(remote.ANTHROPIC_BASE_URL).toEqual({ serverPath: HUB_PATH });
  expect(token).not.toBe(local);
  const credentials = { headers: {}, runnerToken: "bbr_remote" };
  const proxy = await startCliProxy({ serverUrl: pool.url, ...credentials });
  onTestFinished(() => proxy.close());
  const proxied = await pool.hub("/v1/messages", token, "s1", proxy.url);
  expect(proxied.status).toBe(200);
  expect(upstream.tokens("/v1/messages")).toEqual(["1"]);
  const anonymous = await fetch(`${pool.url}${HUB_PATH}/v1/models`);
  expect(anonymous.status).toBe(401);
  await pool.cli("routing", "claude", "--off");
  fs.rmSync(pool.secretFile(3));
  expect(await pool.env("claude-code")).toEqual({});
  expect(await pool.env("codex")).toEqual({});
});

it("adds accounts through the Codex device flow and the Claude code flow", async () => {
  const claims = { chatgpt_account_id: "acct-9" };
  const identity = { "https://api.openai.com/auth": claims };
  const idToken = jwt({ email: "dev@example.com", ...identity });
  const accessToken = jwt({ exp: 4_000_000_000 });
  const device = { device_auth_id: "dev", user_code: "ABCD-1234" };
  const grant = { authorization_code: "grant", code_verifier: "verifier" };
  const codexTokens = { access_token: accessToken, id_token: idToken };
  const claudeTokens = { access_token: "claude-access", expires_in: 3_600 };
  const profile = { uuid: uuid(7), display_name: "Ada", has_claude_max: true };
  const replies: Record<string, Reply[]> = {
    "/auth/api/accounts/deviceauth/usercode": [
      { body: { ...device, interval: "0.05" } },
    ],
    "/auth/api/accounts/deviceauth/token": [{ status: 403 }, { body: grant }],
    "/auth/oauth/token": [{ body: { ...codexTokens, refresh_token: "r" } }],
    "/v1/oauth/token": [{ body: { ...claudeTokens, refresh_token: "r" } }],
    "/api/oauth/profile": [{ body: { account: profile } }],
  };
  const upstream = await fakeUpstream((seen, response) =>
    send(response, replies[seen.path]?.shift()),
  );
  const pool = await seed(await createTestServer(), upstream.url, []);
  const begin = async (provider: Provider) => {
    const flags = ["--provider", provider, "--login", "--json"];
    return (await pool.cli("account", "add", ...flags)).json.login ?? {};
  };
  const started = await begin("codex");
  expect(started.url).toBe(`${upstream.url}/auth/codex/device`);
  expect(started.device).toEqual({ userCode: "ABCD-1234", intervalMs: 50 });
  const session = ["--session", String(started.sessionId), "--json"];
  const polled = await pool.cli("account", "login-poll", ...session);
  const codex = { provider: "codex", codexAccountId: "acct-9" };
  const owner = { email: "dev@example.com" };
  expect(polled.json.account).toMatchObject({ ...codex, ...owner });
  const [exchange] = upstream.at("/auth/oauth/token");
  expect(exchange?.body).toContain("grant_type=authorization_code&code=grant");
  const browser = await begin("claude");
  const query = new URL(String(browser.url)).searchParams;
  const pasted = ["--code", `the-code#${query.get("state")}`];
  const finish = ["--session", String(browser.sessionId), ...pasted, "--json"];
  const completed = await pool.cli("account", "login-complete", ...finish);
  const ada = { label: "Ada", accountUuid: uuid(7), subscriptionType: "max" };
  expect(completed.json.account).toMatchObject({ provider: "claude", ...ada });
  const sent = parse(upstream.at("/v1/oauth/token")[0]?.body);
  const verifier = createHash("sha256").update(String(sent.code_verifier));
  expect(sent.code).toBe("the-code");
  expect(verifier.digest("base64url")).toBe(query.get("code_challenge"));
  const home = fs.mkdtempSync(join(pool.ctx.config.dataDir, "home-"));
  const realHome = process.env.HOME;
  onTestFinished(() => void (process.env.HOME = realHome));
  process.env.HOME = home;
  fs.mkdirSync(join(home, ".codex"));
  const login = { access_token: accessToken, refresh_token: "r2" };
  const auth = { tokens: { ...login, account_id: "acct-home" } };
  fs.writeFileSync(join(home, ".codex/auth.json"), JSON.stringify(auth));
  const source = ["--provider", "codex", "--import", "--json"];
  const imported = (await pool.cli("account", "add", ...source)).json.account;
  expect(imported).toMatchObject({
    codexAccountId: "acct-home",
    kind: "oauth",
  });
  const key = ["--provider", "claude", "--api-key", "sk-test", "--json"];
  expect((await pool.cli("account", "add", ...key)).exitCode).toBe(0);
  const added = fs
    .readdirSync(pool.secrets)
    .filter((name) => /^account-(?!0{8}-0000-4000)/u.test(name));
  const modes = added.map((name) => fs.statSync(join(pool.secrets, name)).mode);
  expect(modes.map((mode) => mode & 0o777)).toEqual(Array(4).fill(0o600));
});
