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
import { WebSocket } from "ws";
import {
  createTestServer,
  TestSocket,
  type Json,
} from "../../server/test/helpers.js";

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
  const port = await freePort();
  const baseHost = `${BASE}:${port}`;
  const github = await fakeGithub();
  const relay = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: "worker.mjs",
        contents: bundle.outputFiles[0]?.text ?? "",
      },
    ],
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
  return { apex, origin, baseHost, github };
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

async function startLinkedServer() {
  const relay = await startRelay();
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
  const consent = await alice.visit(verificationUrl ?? "");
  expect(consent.text).toContain(userCode);
  const approval = { code: userCode, label: "bee", action: "approve" };
  const approved = await alice.visit(`${relay.apex}/link`, { form: approval });
  expect(approved.text).toContain("Connected");
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
  expect(ctx.plugins.publicUrl()).toBe(bee);
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
  const config = await alice.visit(`${bee}/api/v1/system/config`, zipped);
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

  const invite = await alice.visit(`${bee}/api/v1/user-invites`, { json: {} });
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
  expect(bo.jar.size).toBe(1);
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
  expect(headers.cookie ?? "").not.toContain("bbr_session");
  expect(headers["x-bb-via-tunnel"]).toBeUndefined();
  expect(headers["x-bb-gate-user-id"]).toMatch(/^ru_/u);
  expect([...alice.jar.keys()].sort()).toEqual(["bbr_session", "kept"]);
  const bo = await account(apex, "Bo");
  const peeked = await bo.visit(`${String(shared.url)}/page`);
  expect(peeked).toMatchObject({ status: 403, body: { code: "forbidden" } });

  const manual = { machineProviderId: "manual", inputs: null };
  const added = await alice.visit(`${bee}/api/v1/hosts`, { json: manual });
  const enrollment = `${bee}/api/v1/hosts/${String(added.body.id)}`;
  const command = await alice.visit(`${enrollment}/enrollment-command`);
  const [, blob = ""] = String(command.body.command).split("bb runner join ");
  const decoded = Buffer.from(blob, "base64url").toString();
  const join = JSON.parse(decoded) as { serverUrl: string; headers: Json };
  expect(join.serverUrl).toBe(bee);
  const machine = browser();
  const asMachine = { headers: join.headers };
  const listed = await machine.visit(`${bee}/api/v1/hosts`, asMachine);
  expect(listed.status, listed.text).toBe(200);
  const mutation = { method: "DELETE", ...asMachine };
  const removal = await machine.visit(enrollment, mutation);
  expect(removal).toMatchObject({ status: 403 });
  const impostor = { headers: { "x-bb-connect-machine": "bbcm_nope" } };
  expect((await machine.visit(`${bee}/api/v1/hosts`, impostor)).status).toBe(
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
  expect(ctx.plugins.publicUrl()).toBe(bee);

  await cli("logout", "--json");
  await vi.waitFor(async () => {
    const offline = await alice.visit(`${bee}/api/v1/auth/session`);
    expect(offline.status).toBe(503);
  });
});

it("signs people in with GitHub and only lets approved accounts link", async () => {
  const relay = await startRelay();
  const { apex } = relay;
  const login = await browser().visit(`${apex}/login?next=/link`);
  expect(login.text).toContain('href="/auth/github?next=%2Flink"');
  const forged = browser();
  await forged.visit(`${apex}/auth/github`);
  const replay = `${apex}/auth/github/callback?code=alice&state=st_guessed`;
  expect((await forged.visit(replay)).status).toBe(400);
  expect((await signIn(browser(), apex, "nobody")).status).toBe(502);
  const admin = await account(apex, "Alice");
  const guest = await account(apex, "Guest");
  const again = await account(apex, "Guest");
  expect((await again.visit(apex)).text).toContain("@guest");
  const start = { json: { clientName: "laptop" }, headers: { origin: "" } };
  const begun = await browser().visit(`${apex}/api/account/link/start`, start);
  const verificationUrl = String(begun.body.verificationUrl);
  expect((await guest.visit(verificationUrl)).status).toBe(403);
  const signedOut = await browser().visit(verificationUrl);
  expect(signedOut.headers.get("location")).toContain("/login?next=");
  const home = await admin.visit(apex);
  expect(home.text.match(/name="userId"/gu)).toHaveLength(1);
  const guestId = /name="userId" value="(ru_[a-z0-9]+)"/u.exec(home.text)?.[1];
  const grant = { userId: guestId, allow: "1" };
  const denied = await guest.visit(`${apex}/admin/hosting`, { form: grant });
  expect(denied.status).toBe(403);
  await admin.visit(`${apex}/admin/hosting`, { form: grant });
  expect((await guest.visit(verificationUrl)).status).toBe(200);
  const taken = { code: begun.body.userCode, label: "www", action: "approve" };
  const reserved = await guest.visit(`${apex}/link`, { form: taken });
  expect(reserved.status).toBe(400);
  const poll = { json: { deviceCode: begun.body.deviceCode } };
  const pending = await browser().visit(`${apex}/api/account/link/poll`, poll);
  expect(pending.body).toEqual({ status: "pending" });
  const bare = await startRelay({ GITHUB_CLIENT_SECRET: "" });
  const unset = await browser().visit(`${bare.apex}/auth/github`);
  expect(unset.status).toBe(503);
});
