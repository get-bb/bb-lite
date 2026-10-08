import { once } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { writePluginRow } from "../../../packages/server-kit/src/db/plugins.js";
import { createTestServer } from "../../../apps/server/test/helpers.js";
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
  const hub = (path: string, token: string, session: string) => {
    const user = { account_uuid: uuid(9), session_id: session };
    const metadata = { user_id: JSON.stringify(user) };
    const body = JSON.stringify({ model: "claude-opus-4", metadata });
    const custom = { "x-bb-account-pool-token": token, "x-custom": "dropped" };
    const sent = { "anthropic-version": "2023-06-01", "thread-id": session };
    const headers = { authorization: "Bearer local-login", ...custom, ...sent };
    const post = { method: "POST", headers, body };
    const init = path.endsWith("/models") ? { headers } : post;
    return fetch(`${url}${HUB_PATH}${path}`, init);
  };
  const token = async (providerId: string, variable: string) =>
    String((await env(providerId))[variable]);
  return { ...server, secretFile, writeSecret, env, cli, hub, token };
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
  const accounts = [stored(1, "claude"), stored(2, "claude")];
  const pool = await seed(await createTestServer(), upstream.url, accounts);
  const value = await pool.token("claude-code", "ANTHROPIC_AUTH_TOKEN");
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
  await pool.cli("routing", "codex", "--off");
  expect(await pool.env("codex")).toEqual({});
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
