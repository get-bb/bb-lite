import { server as serverSlots } from "../../../packages/plugin/src/index.js";
import dns from "node:dns";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it, onTestFinished, vi } from "vitest";
import * as wire from "@bb/tunnel-contract";
import { WebSocket } from "ws";
import {
  createTestServer,
  TestSocket,
  type Json,
} from "../../server/test/helpers.js";
import { relayAccounts } from "../../tunnel/src/relay-accounts.js";
import { startTunnel } from "../../tunnel/src/tunnel.js";

type Init = { method?: string; json?: unknown; form?: Json; headers?: Json };
type CliReply = { exitCode: number; stdout: string; stderr: string };

const BASE = "relay.test";
const AVATARS = "https://avatars.example.test";
const WORKER = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const PEOPLE: Record<string, { id: number; email: string | null }> = {
  alice: { id: 1, email: "alice@example.test" },
  bo: { id: 2, email: "bo@example.test" },
  guest: { id: 3, email: null },
};

const BUILT = process.env.RELAY_BUILT === "1";
const FRP_BIN = process.env.FRP_BIN_DIR;
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

async function sourceWorker() {
  const bundle = await build({
    entryPoints: [WORKER],
    bundle: true,
    format: "esm",
    write: false,
    conditions: ["source"],
    external: ["cloudflare:workers"],
    target: "es2022",
    logLevel: "silent",
  });
  const contents = bundle.outputFiles[0]?.text ?? "";
  const worker = { type: "ESModule", path: "worker.mjs", contents } as const;
  return { modules: [worker] };
}

function builtWorker() {
  return {
    modules: true,
    modulesRoot: join(DIST, "server"),
    scriptPath: join(DIST, "server/index.js"),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }] as const,
    assets: {
      directory: join(DIST, "client"),
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
    },
  };
}

const lookup = dns.lookup.bind(dns) as (...args: unknown[]) => void;

function resolveRelayNamesLocally() {
  vi.spyOn(dns, "lookup").mockImplementation(((...args: unknown[]) => {
    const [hostname, options] = args;
    if (typeof hostname !== "string" || !hostname.endsWith(BASE)) {
      return lookup(...args);
    }
    const done = args.at(-1) as (...answer: unknown[]) => void;
    const all = typeof options === "object" && (options as Json).all === true;
    if (all) done(null, [{ address: "127.0.0.1", family: 4 }]);
    else done(null, "127.0.0.1", 4);
  }) as typeof dns.lookup);
  onTestFinished(() => void vi.restoreAllMocks());
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return port;
}

async function fakeGithub() {
  const github = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://github.test");
    const [, token = ""] = (request.headers.authorization ?? "").split(" ");
    const login = token.replace("token-", "");
    const person = PEOPLE[login];
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (pathname === "/login/oauth/access_token") {
      let sent = "";
      request.on("data", (chunk: Buffer) => (sent += chunk.toString()));
      request.on("end", () => {
        const { code, client_secret: secret } = JSON.parse(sent) as Json;
        const known = PEOPLE[String(code)] !== undefined;
        const granted = known && secret === "test-secret";
        reply(200, granted ? { access_token: `token-${String(code)}` } : {});
      });
      return;
    }
    if (person === undefined) return reply(401, {});
    const name = `${login[0]?.toUpperCase()}${login.slice(1)}`;
    if (pathname === "/user") {
      const avatar = `${AVATARS}/${login}.png`;
      return reply(200, { id: person.id, login, name, avatar_url: avatar });
    }
    const { email } = person;
    const emails =
      email === null ? [] : [{ email, primary: true, verified: true }];
    reply(pathname === "/user/emails" ? 200 : 404, emails);
  }).listen(0, "127.0.0.1");
  onTestFinished(() => void github.close());
  await once(github, "listening");
  return `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
}

async function startRelay(overrides: Record<string, string> = {}) {
  resolveRelayNamesLocally();
  const port = await freePort();
  const baseHost = `${BASE}:${port}`;
  const github = await fakeGithub();
  const relay = new Miniflare({
    ...(BUILT ? builtWorker() : await sourceWorker()),
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TUNNEL_DO: { className: "TunnelDO", useSQLite: true } },
    d1Databases: ["DB"],
    bindings: {
      BASE_DOMAIN: baseHost,
      HOSTING: "approved",
      ADMIN_LOGIN: "Alice",
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-secret",
      GITHUB_OAUTH_URL: github,
      GITHUB_API_URL: github,
      ...overrides,
    },
    host: "127.0.0.1",
    port,
  });
  onTestFinished(() => relay.dispose());
  await relay.ready;
  const database = await relay.getD1Database("DB");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    const statements = readFileSync(join(MIGRATIONS, file), "utf8").split(";");
    const prepared = statements.flatMap((statement) =>
      statement.trim() === "" ? [] : [database.prepare(statement)],
    );
    await database.batch(prepared);
  }
  const apex = `http://${baseHost}`;
  const origin = (name: string) => `http://${name}.${baseHost}`;
  const sweep = async () => void (await (await relay.getWorker()).scheduled());
  return { apex, origin, baseHost, github, database, sweep };
}

function browser() {
  const jar = new Map<string, string>();
  const visit = async (url: string, init: Init = {}) => {
    const { origin } = new URL(url);
    const body =
      init.form !== undefined
        ? new URLSearchParams(init.form as Record<string, string>)
        : init.json === undefined
          ? undefined
          : JSON.stringify(init.json);
    const method = init.method ?? (body === undefined ? "GET" : "POST");
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`);
    const headers: Record<string, string> = {
      ...(cookie.length > 0 ? { cookie: cookie.join("; ") } : {}),
      ...(method === "GET" ? {} : { origin }),
      ...(init.json === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init.headers as Record<string, string> | undefined),
    };
    const sent = { method, headers, body, redirect: "manual" as const };
    const response = await fetch(url, sent);
    for (const issued of response.headers.getSetCookie()) {
      const [pair = ""] = issued.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (/max-age=0/iu.test(issued)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    let parsed: Json = {};
    try {
      parsed = JSON.parse(text) as Json;
    } catch {}
    const { status } = response;
    return { status, text, body: parsed, headers: response.headers };
  };
  const cookies = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  return { visit, cookies, jar };
}

async function signIn(
  person: ReturnType<typeof browser>,
  apex: string,
  login: string,
) {
  const started = await person.visit(`${apex}/auth/github`);
  const authorize = new URL(started.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state");
  const callback = authorize.searchParams.get("redirect_uri");
  expect(authorize.searchParams.get("client_id")).toBe("test-client");
  return person.visit(`${callback}?code=${login}&state=${state}`);
}

async function account(apex: string, name: string) {
  const person = browser();
  const login = name.toLowerCase();
  const signedIn = await signIn(person, apex, login);
  expect(signedIn.status, signedIn.text).toBe(303);
  return { ...person, email: PEOPLE[login]?.email ?? null };
}

type Relay = Awaited<ReturnType<typeof startRelay>>;

async function startLinkedServer(
  overrides: Record<string, string> = {},
  prepare: (relay: Relay) => Promise<void> = async () => {},
) {
  const relay = await startRelay(overrides);
  await prepare(relay);
  vi.stubEnv("BB_CONNECT_BASE_URL", relay.apex);
  onTestFinished(() => void vi.unstubAllEnvs());
  const server = await createTestServer();
  const { ctx, url } = server;
  ctx.config.port = Number(new URL(url).port);
  await ctx.plugins.reload("connect");
  const cli = async (...argv: string[]): Promise<Json> => {
    const body = JSON.stringify({ argv, cwd: tmpdir(), threadId: "thr_1" });
    const headers = { "content-type": "application/json" };
    const init = { method: "POST", headers, body };
    const response = await fetch(`${url}/api/v1/plugins/connect/cli`, init);
    const reply = (await response.json()) as CliReply;
    expect(reply.exitCode, reply.stderr).toBe(0);
    return JSON.parse(reply.stdout) as Json;
  };
  const alice = await account(relay.apex, "Alice");
  const started = await cli("login", "--json");
  const { userCode, verificationUrl } = started.login as Record<string, string>;
  const dashboard = `${relay.apex}/api/dashboard`;
  const { search } = new URL(verificationUrl ?? "");
  const consent = await alice.visit(`${dashboard}/link${search}`);
  expect(consent.body).toMatchObject({ userCode, suggestedLabel: "alice" });
  const approval = { code: userCode, label: "bee", action: "approve" };
  const approved = await alice.visit(`${dashboard}/link`, { json: approval });
  expect(approved.body).toEqual({ url: relay.origin("bee") });
  await vi.waitFor(
    async () => expect((await cli("status", "--json")).state).toBe("connected"),
    { timeout: 10_000, interval: 200 },
  );
  const bee = relay.origin("bee");
  return { ...server, ...relay, cli, alice, bee };
}

async function echoServer() {
  const seen: IncomingMessage["headers"][] = [];
  const echo = createServer((request, response) => {
    seen.push(request.headers);
    response.setHeader("set-cookie", [
      "bbr_session=stolen; Path=/",
      `tossed=1; Domain=${BASE}; Path=/`,
      `spaced=1; Path=/; domain =${BASE}`,
      "first=1, second=2; Path=/",
      "__Host-bbr_account=stolen; Path=/",
      "kept=1; Path=/",
    ]);
    response.end("shared page");
  }).listen(0, "127.0.0.1");
  onTestFinished(() => void echo.close());
  await once(echo, "listening");
  return { seen, port: () => (echo.address() as AddressInfo).port };
}

it("links a server and lets invited relay accounts in", async () => {
  const linked = await startLinkedServer();
  const { alice, apex, bee, ctx } = linked;
  expect(ctx.kernel.pick(serverSlots.publicUrl)?.()).toBe(bee);
  const session = "/api/v1/auth/session";

  const stranger = browser();
  const refused = await stranger.visit(`${bee}${session}`);
  expect(refused).toMatchObject({
    status: 401,
    body: { code: "unauthenticated" },
  });
  const page = { headers: { accept: "text/html" } };
  const bounced = await stranger.visit(`${bee}/projects`, page);
  const next = encodeURIComponent(`${bee}/projects`);
  expect(bounced.status).toBe(302);
  expect(bounced.headers.get("location")).toBe(`${apex}/login?next=${next}`);

  const owner = await alice.visit(`${bee}${session}`);
  expect(owner.body.user).toMatchObject({ id: "usr_owner", role: "owner" });
  const again = await alice.visit(`${bee}${session}`);
  expect(again.body.user).toMatchObject({ avatarUrl: `${AVATARS}/alice.png` });
  const zipped = { headers: { "accept-encoding": "gzip" } };
  const config = await alice.visit(`${bee}/api/v1/server/config`, zipped);
  expect(config.headers.get("content-encoding")).toBe("gzip");
  expect(config.body).toMatchObject({ primaryHostId: ctx.config.hostId });

  const bo = await account(apex, "Bo");
  const waiting = await bo.visit(`${bee}${session}`);
  const avatarUrl = `${AVATARS}/bo.png`;
  const identity = { name: "Bo", email: bo.email, avatarUrl };
  expect(waiting.body).toEqual({ user: null, identity });
  expect((await bo.visit(`${bee}/api/v1/threads`)).status).toBe(401);
  const forged = { "x-bb-gate-owner": "1", "x-bb-via-tunnel": "1" };
  const disguised = await bo.visit(`${bee}${session}`, { headers: forged });
  expect(disguised.body).toEqual({ user: null, identity });

  const invite = await alice.visit(`${bee}/api/v1/users/invites`, { json: {} });
  expect(invite.status, invite.text).toBe(201);
  const inviteUrl = new URL(String(invite.body.url));
  expect(inviteUrl.origin).toBe(bee);
  const token = inviteUrl.searchParams.get("token");
  const accept = `${bee}/api/v1/auth/invites/${token}/accept`;
  const joined = await bo.visit(accept, { json: {} });
  expect(joined.body.user).toMatchObject({
    name: "Bo",
    email: bo.email,
    role: "member",
    hasPassword: false,
    avatarUrl,
  });
  expect([...bo.jar.keys()].sort()).toEqual(["bbr_account", "bbr_session"]);
  const member = await bo.visit(`${bee}${session}`);
  expect(member.body.user).toMatchObject({ name: "Bo" });
  const users = await bo.visit(`${bee}/api/v1/users`);
  expect(users.body).toMatchObject([{ id: "usr_owner" }, { name: "Bo" }]);
  const elsewhere = { headers: { origin: linked.origin("evil--8000") } };
  const crossSite = await bo.visit(accept, { json: {}, ...elsewhere });
  expect(crossSite).toMatchObject({
    status: 403,
    body: { code: "forbidden_origin" },
  });

  const socket = new WebSocket(`${bee.replace("http", "ws")}/ws`, {
    headers: { cookie: bo.cookies(), origin: bee },
  });
  onTestFinished(() => socket.terminate());
  const live = new TestSocket(socket);
  await once(socket, "open");
  await vi.waitFor(() => expect(live.presence.at(-1)?.users).toHaveLength(1));
  await live.subscribe({ kind: "system" });
  const renamed = await alice.visit(`${bee}/api/v1/users/usr_owner`, {
    method: "PATCH",
    json: { name: "Alice" },
  });
  expect(renamed.status, renamed.text).toBe(200);
  const changed = await live.next((message) => message.type === "changed");
  expect(changed).toMatchObject({
    entity: "system",
    changes: ["users-changed"],
  });
  live.send({ type: "ping" });
  await live.next((message) => message.type === "pong");
  socket.terminate();
  await vi.waitFor(() => expect(ctx.hub.presence()).toEqual([]));
});

it("keeps relay sessions away from servers and shares", async () => {
  const linked = await startLinkedServer();
  const { alice, apex, bee, cli, ctx } = linked;
  const echo = await echoServer();
  const shared = await cli("expose", String(echo.port()), "--json");
  expect(shared.url).toBe(linked.origin(`bee--${echo.port()}`));
  const visited = await alice.visit(`${String(shared.url)}/page`);
  expect(visited).toMatchObject({ status: 200, text: "shared page" });
  const [headers = {}] = echo.seen;
  expect(headers.cookie ?? "").not.toContain("bbr_");
  expect(headers["x-bb-via-tunnel"]).toBeUndefined();
  expect(headers["x-bb-gate-user-id"]).toMatch(/^ru_/u);
  expect([...alice.jar.keys()].sort()).toEqual([
    "bbr_account",
    "bbr_session",
    "kept",
  ]);
  const bo = await account(apex, "Bo");
  const peeked = await bo.visit(`${String(shared.url)}/page`);
  expect(peeked).toMatchObject({ status: 403, body: { code: "forbidden" } });

  const manual = { machineProviderId: "manual", inputs: null };
  const added = await alice.visit(`${bee}/api/v1/machines`, { json: manual });
  const enrollment = `${bee}/api/v1/machines/${String(added.body.id)}`;
  const command = await alice.visit(`${enrollment}/enrollment-command`);
  const [, blob = ""] = String(command.body.command).split("bb runner join ");
  const decoded = Buffer.from(blob, "base64url").toString();
  const join = JSON.parse(decoded) as { serverUrl: string; headers: Json };
  expect(join.serverUrl).toBe(bee);
  const machine = browser();
  const asMachine = { headers: join.headers };
  const listed = await machine.visit(`${bee}/api/v1/machines`, asMachine);
  expect(listed).toMatchObject({ status: 403, body: { code: "forbidden" } });
  expect(listed.text).toContain("Machine credentials");
  const mutation = { method: "DELETE", ...asMachine };
  const removal = await machine.visit(enrollment, mutation);
  expect(removal).toMatchObject({ status: 403 });
  const impostor = { headers: { "x-bb-connect-machine": "bbcm_nope" } };
  expect((await machine.visit(`${bee}/api/v1/machines`, impostor)).status).toBe(
    403,
  );

  const intruder = new WebSocket(`${bee.replace("http", "ws")}/__tunnel?v=1`, {
    headers: { authorization: "Bearer bbcred_wrong" },
  });
  intruder.on("error", () => {});
  const [, rejection] = (await once(intruder, "unexpected-response")) as [
    unknown,
    IncomingMessage,
  ];
  expect(rejection.statusCode).toBe(401);
  expect(ctx.kernel.pick(serverSlots.publicUrl)?.()).toBe(bee);

  await cli("logout", "--json");
  await vi.waitFor(async () => {
    const offline = await alice.visit(`${bee}/api/v1/auth/session`);
    expect(offline.status).toBe(503);
  });
});

it("signs people in with GitHub and only lets approved accounts link", async () => {
  const relay = await startRelay();
  const { apex } = relay;
  const dashboard = `${apex}/api/dashboard`;
  const forged = browser();
  await forged.visit(`${apex}/auth/github`);
  const replay = `${apex}/auth/github/callback?code=alice&state=st_guessed`;
  const replayed = await forged.visit(replay);
  expect(replayed.headers.get("location")).toBe("/login?error=expired");
  const unknown = await signIn(browser(), apex, "nobody");
  expect(unknown.headers.get("location")).toBe("/login?error=github");
  const admin = await account(apex, "Alice");
  const guest = await account(apex, "Guest");
  const again = await account(apex, "Guest");
  expect((await again.visit(dashboard)).body).toMatchObject({
    viewer: { login: "guest", admin: false, canHost: false },
    people: [],
  });
  const start = { json: { clientName: "laptop" }, headers: { origin: "" } };
  const begun = await browser().visit(`${apex}/api/account/link/start`, start);
  const { search } = new URL(String(begun.body.verificationUrl));
  const consent = `${dashboard}/link${search}`;
  expect((await guest.visit(consent)).status).toBe(403);
  expect((await browser().visit(consent)).status).toBe(401);
  const home = await admin.visit(dashboard);
  const people = home.body.people as Json[];
  const others = people.filter((person) => person.self === false);
  expect(others).toMatchObject([{ login: "guest", canHost: false }]);
  const grant = `${dashboard}/people/${String(others[0]?.id)}`;
  const allowed = { json: { canHost: true } };
  expect((await guest.visit(grant, allowed)).status).toBe(403);
  const elsewhere = { ...allowed, headers: { origin: "https://evil.test" } };
  expect((await admin.visit(grant, elsewhere)).status).toBe(403);
  expect((await admin.visit(grant, allowed)).status).toBe(200);
  expect((await guest.visit(consent)).body).toMatchObject({
    clientName: "laptop",
  });
  const taken = { code: begun.body.userCode, label: "www", action: "approve" };
  const reserved = await guest.visit(`${dashboard}/link`, { json: taken });
  expect(reserved.status).toBe(400);
  const poll = { json: { deviceCode: begun.body.deviceCode } };
  const pending = await browser().visit(`${apex}/api/account/link/poll`, poll);
  expect(pending.body).toEqual({ status: "pending" });
  const bare = await startRelay({ GITHUB_CLIENT_SECRET: "" });
  const unset = await browser().visit(`${bare.apex}/auth/github`);
  expect(unset.status).toBe(503);
});

it("tells a gate that holds the secret who a session and a credential are", async () => {
  const secret = "gate-secret";
  const relay = await startRelay({ GATE_SECRET: secret });
  const { alice, credential, address } = await rawLink(relay);
  const resolve = async (bearer: string, asked: Json, apex = relay.apex) => {
    const response = await fetch(`${apex}/api/gate/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ label: "raw", ...asked }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  expect((await resolve("guess", {})).status).toBe(404);
  expect((await resolve("", {})).status).toBe(404);
  const closed = await startRelay();
  expect((await resolve("", {}, closed.apex)).status).toBe(404);
  const server = { label: "raw", id: expect.stringMatching(/^srv_/u) };
  expect((await resolve(secret, {})).body).toMatchObject({
    server,
    address,
    user: null,
    linked: false,
    machineId: null,
  });
  const session = alice.jar.get("bbr_session");
  const known = await resolve(secret, { session, credential });
  expect(known.body).toMatchObject({
    server: { ownerId: (known.body.user as Json).id },
    user: { name: "Alice", email: alice.email },
    linked: true,
  });
  const wrong = { session: "bbrs_nope", credential: "bbcred_nope" };
  expect((await resolve(secret, wrong)).body).toMatchObject({
    user: null,
    linked: false,
  });
  expect((await resolve(secret, { label: "nobody" })).body).toEqual({
    server: null,
  });
});

async function rawLink(relay: { apex: string; origin(name: string): string }) {
  const alice = await account(relay.apex, "Alice");
  const api = `${relay.apex}/api/account/link`;
  const start = { json: { clientName: "raw" }, headers: { origin: "" } };
  const begun = await browser().visit(`${api}/start`, start);
  const approval = {
    code: begun.body.userCode,
    label: "raw",
    action: "approve",
  };
  await alice.visit(`${relay.apex}/api/dashboard/link`, { json: approval });
  const poll = { json: { deviceCode: begun.body.deviceCode } };
  const polled = await browser().visit(`${api}/poll`, poll);
  const credential = String(polled.body.credential);
  const address = relay.origin("raw");
  const dial = (answers: boolean) => {
    const url = `${address.replace("http", "ws")}/__tunnel?v=1`;
    const headers = { authorization: `Bearer ${credential}` };
    const tunnel = new WebSocket(url, { headers });
    onTestFinished(() => tunnel.terminate());
    tunnel.on("error", () => {});
    tunnel.on("message", (data: Buffer, isBinary) => {
      if (!isBinary || !answers) return;
      const frame = wire.decodeFrame(data);
      if (frame.type !== "open-http") return;
      const { streamId } = frame;
      const reply = Buffer.from(`served ${frame.path}`);
      const head = { status: 200, headers: [] };
      tunnel.send(wire.encodeFrame({ type: "resp-head", streamId, ...head }));
      const chunk = { type: "body-chunk", streamId, data: reply } as const;
      tunnel.send(wire.encodeFrame(chunk));
      tunnel.send(wire.encodeFrame({ type: "body-end", streamId }));
    });
    return tunnel;
  };
  return { alice, credential, address, dial };
}

it("rides through a dropped tunnel and closes a revoked one", async () => {
  const relay = await startRelay();
  const { alice, credential, address, dial } = await rawLink(relay);
  const first = dial(true);
  await once(first, "open");
  const served = await alice.visit(`${address}/a`);
  expect(served).toMatchObject({ status: 200, text: "served /a" });
  first.terminate();
  await vi.waitFor(async () => {
    const probe = alice.visit(`${address}/b`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = dial(true);
    await once(second, "open");
    expect(await probe).toMatchObject({ status: 200, text: "served /b" });
  });
  const stale = dial(true);
  await once(stale, "open");
  const closed = once(stale, "close");
  const revoke = { headers: { authorization: `Bearer ${credential}` } };
  const revoked = await browser().visit(
    `${relay.apex}/api/connect/disconnect`,
    { method: "POST", ...revoke },
  );
  expect(revoked.body).toEqual({ ok: true });
  expect((await closed)[1].toString()).toBe("link revoked");
  expect((await alice.visit(`${address}/c`)).status).toBe(503);
  const refused = dial(true);
  const [, rejection] = (await once(refused, "unexpected-response")) as [
    unknown,
    IncomingMessage,
  ];
  expect(rejection.statusCode).toBe(401);
});

it("serves through the new tunnel while a vanished one never closes", async () => {
  const relay = await startRelay({ GATE_DEADLINE_MS: "2000" });
  const { alice, address, dial } = await rawLink(relay);
  const vanished = dial(false);
  await once(vanished, "open");
  vanished.pause();
  onTestFinished(() => vanished.terminate());
  const live = dial(true);
  await once(live, "open");
  const served = await alice.visit(`${address}/a`);
  expect(served).toMatchObject({ status: 200, text: "served /a" });
  const again = dial(true);
  await once(again, "open");
  const moved = await alice.visit(`${address}/b`);
  expect(moved).toMatchObject({ status: 200, text: "served /b" });
});

it("answers within its deadline and keeps account pages on their own cookie", async () => {
  const relay = await startRelay({ GATE_DEADLINE_MS: "400" });
  const { alice, address, dial } = await rawLink(relay);
  const silent = dial(false);
  await once(silent, "open");
  const stalled = await alice.visit(`${address}/slow`);
  expect(stalled).toMatchObject({
    status: 504,
    body: {
      code: "gateway_timeout",
      message: expect.stringContaining("tunnel"),
    },
  });
  const shadowed = browser();
  const session = alice.jar.get("bbr_session") ?? "";
  shadowed.jar.set("bbr_session", session);
  const home = await shadowed.visit(`${relay.apex}/api/dashboard`);
  expect(home.status).toBe(401);
  expect((await shadowed.visit(`${address}/x`)).status).not.toBe(401);
  const mine = await alice.visit(`${relay.apex}/api/dashboard`);
  expect(mine.body.viewer).toMatchObject({ login: "alice" });
});

async function fakeFly() {
  const calls: string[] = [];
  const machine = {
    config: {} as Json,
    stopping: false,
    running: false,
    off: async () => {},
    on: async () => {},
  };
  const boot = async (env: Record<string, string>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    onTestFinished(() => void vi.unstubAllEnvs());
    const { ctx, url } = await createTestServer();
    ctx.config.port = Number(new URL(url).port);
    await ctx.plugins.reload("connect");
    const cli = async (verb: string) => {
      const body = JSON.stringify({ argv: [verb], cwd: tmpdir() });
      const headers = { "content-type": "application/json" };
      const init = { method: "POST", headers, body };
      await fetch(`${url}/api/v1/plugins/connect/cli`, init);
    };
    machine.running = true;
    machine.off = () => cli("off").then(() => void (machine.running = false));
    machine.on = () => cli("on").then(() => void (machine.running = true));
  };
  const fly = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://fly.test");
    const call = `${request.method} ${pathname}`;
    calls.push(call);
    let sent = "";
    request.on("data", (chunk: Buffer) => (sent += chunk.toString()));
    request.on("end", () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const work = async () => {
        if (request.headers.authorization !== "Bearer fly-token") {
          return reply(401, { error: "unauthorized" });
        }
        if (call === "POST /apps") return reply(201, { id: "app_1" });
        if (call.endsWith("/volumes")) return reply(200, { id: "vol_1" });
        if (call.endsWith("/machines")) {
          machine.config = (JSON.parse(sent) as { config: Json }).config;
          await boot(machine.config.env as Record<string, string>);
          return reply(200, { id: "mach_1" });
        }
        if (call.endsWith("/mach_1") && request.method === "GET") {
          return reply(200, { config: machine.config });
        }
        if (call.endsWith("/mach_1") && request.method === "POST") {
          machine.config = (JSON.parse(sent) as { config: Json }).config;
          if (machine.running) await machine.off().then(machine.on);
          else machine.stopping = true;
          return reply(200, { id: "mach_1" });
        }
        if (call.endsWith("/start") && machine.stopping) {
          machine.stopping = false;
          return reply(412, { error: "unable to start from 'stopping'" });
        }
        if (call.endsWith("/start")) await machine.on();
        else await machine.off();
        reply(request.method === "DELETE" ? 202 : 200, { ok: true });
      };
      work().catch((error: unknown) => reply(500, { error: String(error) }));
    });
  }).listen(0, "127.0.0.1");
  onTestFinished(() => void fly.close());
  await once(fly, "listening");
  const url = `http://127.0.0.1:${(fly.address() as AddressInfo).port}`;
  return { url, calls, machine };
}

it("creates a hosted server, puts it to sleep and wakes it on a visit", async () => {
  const fly = await fakeFly();
  const relay = await startRelay({
    FLY_API_URL: fly.url,
    FLY_API_TOKEN: "fly-token",
    FLY_ORG: "bb-next",
    FLY_IMAGE: "registry.test/bb:1",
    HOSTED_IDLE_HOURS: "0.000001",
    HOSTED_DELETE_DAYS: "0.00000001",
  });
  const { apex, database } = relay;
  const cloud = relay.origin("cloud");
  const session = `${cloud}/api/v1/auth/session`;
  const page = { headers: { accept: "text/html" } };
  const row = () =>
    database
      .prepare("SELECT * FROM servers WHERE label = 'cloud'")
      .first<Json>();
  const alice = await account(apex, "Alice");
  const bo = await account(apex, "Bo");
  const dashboard = `${apex}/api/dashboard`;
  const hosted = async (person = alice) =>
    (await person.visit(dashboard)).body as {
      hosting: Json;
      servers: Json[];
    };
  expect((await hosted()).hosting).toMatchObject({ canCreate: true });
  expect((await hosted(bo)).hosting).toMatchObject({ canCreate: false });
  const wanted = { json: { label: "cloud" } };
  const refused = await bo.visit(`${dashboard}/servers`, wanted);
  expect(refused.status).toBe(403);

  const created = await alice.visit(`${dashboard}/servers`, wanted);
  expect(created.status, created.text).toBe(200);
  expect(created.body).toEqual({ url: cloud });
  const app = String((await row())?.hosted_app);
  expect(app).toMatch(/^bb-next-[a-z0-9]{12}$/u);
  expect(fly.calls).toEqual([
    "POST /apps",
    `POST /apps/${app}/volumes`,
    `POST /apps/${app}/machines`,
  ]);
  expect(fly.machine.config).toMatchObject({
    image: "registry.test/bb:1",
    guest: { cpu_kind: "shared", cpus: 4, memory_mb: 8192 },
    mounts: [{ volume: "vol_1", path: "/data" }],
    env: { BB_CONNECT_BASE_URL: apex },
  });
  await vi.waitFor(
    async () => {
      const owner = await alice.visit(session);
      expect(owner.body.user).toMatchObject({ id: "usr_owner", role: "owner" });
    },
    { timeout: 10_000, interval: 200 },
  );
  const other = { json: { label: "other" } };
  const second = await alice.visit(`${dashboard}/servers`, other);
  expect(second.status).toBe(409);

  const env = fly.machine.config.env as Record<string, string>;
  const { credential } = JSON.parse(env.BB_CONNECT_LINK ?? "{}") as Json;
  await database.prepare("UPDATE servers SET active_at = 1").run();
  const busy = { headers: { authorization: `Bearer ${String(credential)}` } };
  const noted = await browser().visit(`${apex}/api/connect/activity`, {
    method: "POST",
    ...busy,
  });
  expect(noted.body).toEqual({ ok: true });
  expect(Number((await row())?.active_at)).toBeGreaterThan(1);

  const [listed] = (await hosted()).servers;
  expect(listed).toMatchObject({
    label: "cloud",
    hosted: true,
    state: "running",
    version: "1",
    update: null,
  });
  const server = `${dashboard}/servers/${String(listed?.id)}`;
  const act = (action: string, person = alice) =>
    person.visit(`${server}/${action}`, { json: {} });
  expect((await act("sleep", bo)).status).toBe(404);
  expect((await act("sleep")).status).toBe(200);
  expect(fly.calls.at(-1)).toBe(`POST /apps/${app}/machines/mach_1/stop`);
  expect(await alice.visit(session)).toMatchObject({
    status: 503,
    body: { code: "server_asleep" },
  });
  const knocked = await bo.visit(`${cloud}/`, page);
  expect(knocked.status).toBe(503);
  expect(knocked.text).toContain("starts again when its owner opens it");
  expect(fly.calls.at(-1)).toContain("/stop");

  fly.machine.stopping = true;
  const woken = await alice.visit(`${cloud}/`, page);
  expect(woken.status).toBe(503);
  expect(woken.text).toContain("Starting your bb server");
  await vi.waitFor(async () => {
    expect(fly.calls.at(-1)).toContain("/start");
    expect((await row())?.wake_at).toBeNull();
  });
  expect((await alice.visit(`${cloud}/`, page)).status).toBe(503);
  await vi.waitFor(
    async () => expect((await alice.visit(session)).status).toBe(200),
    { timeout: 10_000, interval: 200 },
  );
  expect(fly.calls.at(-1)).toBe(`POST /apps/${app}/machines/mach_1/start`);

  const publish = (image: string) =>
    database
      .prepare("INSERT OR REPLACE INTO settings VALUES ('hosted_image', ?)")
      .bind(image)
      .run();
  expect((await hosted()).servers).toMatchObject([{ update: null }]);
  await publish("registry.test/bb:2");
  expect((await hosted()).servers).toMatchObject([{ update: "2" }]);
  expect((await act("update")).status).toBe(200);
  expect(fly.calls.slice(-2)).toEqual([
    `GET /apps/${app}/machines/mach_1`,
    `POST /apps/${app}/machines/mach_1`,
  ]);
  expect(fly.machine.config).toMatchObject({
    image: "registry.test/bb:2",
    mounts: [{ volume: "vol_1", path: "/data" }],
    env,
  });
  expect((await row())?.hosted_image).toBe("registry.test/bb:2");
  expect((await alice.visit(session)).status).toBe(200);

  await relay.sweep();
  expect(fly.calls.at(-1)).toContain("/stop");
  expect((await row())?.hosted_state).toBe("stopped");
  await publish("registry.test/bb:3");
  expect((await alice.visit(`${cloud}/`, page)).status).toBe(503);
  await vi.waitFor(async () => {
    expect(fly.calls.at(-1)).toContain("/start");
    expect((await row())?.wake_at).toBeNull();
  });
  expect(fly.machine.config.image).toBe("registry.test/bb:3");
  expect((await alice.visit(`${cloud}/`, page)).status).toBe(503);
  await vi.waitFor(
    async () => expect((await alice.visit(session)).status).toBe(200),
    { timeout: 10_000, interval: 200 },
  );
  expect(fly.calls.filter((call) => call.endsWith("/mach_1"))).toHaveLength(4);

  await relay.sweep();
  expect((await row())?.hosted_state).toBe("stopped");
  await relay.sweep();
  expect(fly.calls.at(-1)).toBe(`DELETE /apps/${app}`);
  expect(await row()).toBeNull();
  expect((await alice.visit(`${cloud}/`, page)).status).toBe(404);
});

it.runIf(BUILT)("serves the app from the deployed bundle", async () => {
  const linked = await startLinkedServer();
  const { alice, apex, bee } = linked;
  const page = { headers: { accept: "text/html" } };
  const login = await browser().visit(`${apex}/login?next=/link`, page);
  expect(login.status).toBe(200);
  expect(login.text).toContain("Continue with GitHub");
  expect(login.text).toContain('href="/auth/github?next=%2Flink"');
  const stylesheet = /href="(\/assets\/[^"]+\.css)"/u.exec(login.text)?.[1];
  const styles = await browser().visit(`${apex}${stylesheet}`);
  expect(styles.headers.get("content-type")).toContain("text/css");
  const elsewhere = await alice.visit(`${bee}${stylesheet}`);
  expect(elsewhere.headers.get("content-type") ?? "").not.toContain("text/css");
  const signedOut = await browser().visit(apex, page);
  expect(signedOut.headers.get("location")).toBe("/login");
  const home = await alice.visit(apex, page);
  expect(home.status).toBe(200);
  expect(home.text).toContain("Alice");
  expect(home.text).toContain("Linked from");
  const begun = await browser().visit(`${apex}/api/account/link/start`, {
    json: { clientName: "laptop" },
    headers: { origin: "" },
  });
  const consent = await alice.visit(String(begun.body.verificationUrl), page);
  expect(consent.text).toContain(String(begun.body.userCode));
  const missing = await alice.visit(`${apex}/nowhere`, page);
  expect(missing.status).toBe(404);
});

it.skipIf(FRP_BIN === undefined)(
  "serves a linked server through frp and the gate on Fly",
  async () => {
    const [web, frp, vhost, hooks] = await Promise.all(
      [1, 2, 3, 4].map(() => freePort()),
    );
    const bin = FRP_BIN ?? "";
    vi.stubEnv("BB_CONNECT_FRP", `tcp://127.0.0.1:${frp}`);
    vi.stubEnv("BB_CONNECT_FRPC", join(bin, "frpc"));
    const secret = "gate-secret";
    const linked = await startLinkedServer(
      { GATE_SECRET: secret },
      async (relay) => {
        const tunnel = await startTunnel({
          baseHost: `fly.${BASE}:${web}`,
          secure: false,
          accounts: relayAccounts({
            relayUrl: relay.apex,
            relaySecret: secret,
          }),
          frps: join(bin, "frps"),
          bindHost: "127.0.0.1",
          ports: { web, frp, vhost, hooks },
          logLevel: "warn",
          log: () => {},
        });
        onTestFinished(() => tunnel.close());
      },
    );
    const { alice, apex, ctx } = linked;
    const bee = `http://bee.fly.${BASE}:${web}`;
    const session = "/api/v1/auth/session";

    await vi.waitFor(
      async () => {
        const owner = await alice.visit(`${bee}${session}`);
        expect(owner.status, owner.text).toBe(200);
        expect(owner.body.user).toMatchObject({ id: "usr_owner" });
      },
      { timeout: 15_000, interval: 200 },
    );
    expect(ctx.kernel.pick(serverSlots.publicUrl)?.()).toBe(linked.bee);

    const stranger = browser();
    const refused = await stranger.visit(`${bee}${session}`);
    expect(refused).toMatchObject({
      status: 401,
      body: { code: "unauthenticated" },
    });
    const page = { headers: { accept: "text/html" } };
    const bounced = await stranger.visit(`${bee}/projects`, page);
    const next = encodeURIComponent(`${bee}/projects`);
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toBe(`${apex}/login?next=${next}`);
    const home = await alice.visit(`${bee}/`, page);
    expect(home.status, home.text).toBe(200);

    const bo = await account(apex, "Bo");
    const forged = { "x-bb-gate-owner": "1", "x-bb-via-tunnel": "1" };
    const disguised = await bo.visit(`${bee}${session}`, { headers: forged });
    expect(disguised.body).toMatchObject({
      user: null,
      identity: { name: "Bo" },
    });
    const invite = await alice.visit(`${bee}/api/v1/users/invites`, {
      json: {},
    });
    expect(invite.status, invite.text).toBe(201);
    const elsewhere = { headers: { origin: linked.origin("evil") } };
    const crossSite = await alice.visit(`${bee}/api/v1/users/invites`, {
      json: {},
      ...elsewhere,
    });
    expect(crossSite).toMatchObject({
      status: 403,
      body: { code: "forbidden_origin" },
    });
    const large = await alice.visit(`${bee}/api/v1/server/config`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(large.headers.get("content-encoding")).toBe("gzip");
    expect(large.body).toMatchObject({ primaryHostId: ctx.config.hostId });

    const socket = new WebSocket(`${bee.replace("http", "ws")}/ws`, {
      headers: { cookie: alice.cookies(), origin: bee },
    });
    onTestFinished(() => socket.terminate());
    const live = new TestSocket(socket);
    await once(socket, "open");
    live.send({ type: "ping" });
    await live.next((message) => message.type === "pong");
    socket.terminate();

    await linked.cli("logout", "--json");
    await vi.waitFor(async () => {
      const offline = await alice.visit(`${bee}${session}`);
      expect(offline.status).toBe(503);
    });
  },
  60_000,
);
