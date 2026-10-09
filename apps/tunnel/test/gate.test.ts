import { once } from "node:events";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bbAccounts, signEntry } from "../src/bb-accounts.js";
import { createGate } from "../src/gate.js";

const SESSION = "better-auth.session_token";
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const servers: Server[] = [];
let gate: string;
let accountPort: number;
let hooks: string;

async function listening(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

interface Visited {
  status: number;
  text: string;
  headers: IncomingHttpHeaders;
}

function visit(
  name: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
  } = {},
): Promise<Visited> {
  const host = init.host ?? `${name}.fly.bb.test`;
  const headers = { ...init.headers, host };
  const { method = "GET", body } = init;
  return new Promise((resolve, reject) => {
    const sent = request(`${gate}${path}`, { method, headers }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const status = answer.statusCode ?? 0;
        resolve({ status, text, headers: answer.headers });
      });
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

function hook(op: string, content: object) {
  const body = JSON.stringify({ op, content });
  return fetch(hooks, { method: "POST", body }).then((reply) => reply.json());
}

beforeAll(async () => {
  const account = createServer((asked, response) => {
    const { cookie = "", authorization = "" } = asked.headers;
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (asked.url === "/api/account/me") {
      if (authorization !== "Bearer bbcred_bee") return reply(401, {});
      return reply(200, { serverLabel: "bee" });
    }
    if (cookie === `${SESSION}=owner`) {
      return reply(200, { servers: [{ handle: "bee" }] });
    }
    if (cookie === `${SESSION}=stranger`) return reply(200, { servers: [] });
    reply(401, { error: "unauthorized" });
  });
  accountPort = await listening(account);
  const upstream = createServer((asked, response) => {
    seen.push({ url: asked.url ?? "", headers: asked.headers });
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": [`${SESSION}=stolen; Path=/`, "kept=1; Path=/"],
    });
    response.end("from the server");
  });
  const upstreamPort = await listening(upstream);
  const made = createGate({
    baseHost: "fly.bb.test",
    secure: false,
    accounts: bbAccounts({
      accountUrl: `http://127.0.0.1:${accountPort}`,
      serverBase: `bb.test:${accountPort}`,
      secureCookies: false,
      resolveServerHost: () => `127.0.0.1:${accountPort}`,
      ownerCredentialHeader: "x-test-owner",
      ownerCredentialCookie: "test-owner",
      entryKey: "entry-key",
    }),
    upstream: { host: "127.0.0.1", port: upstreamPort },
    hostLabels: { "bee-direct.test": "bee" },
    log: () => {},
  });
  gate = `http://127.0.0.1:${await listening(made.web)}`;
  hooks = `http://127.0.0.1:${await listening(made.hooks)}/frp`;
});

afterAll(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

it("lets only a server's own credential and address register", async () => {
  const user = { user: "bee", run_id: "run-1" };
  const login = (credential: string) =>
    hook("Login", { user: "bee", metas: { credential } });
  expect(await login("bbcred_other")).toMatchObject({ reject: true });
  expect(await login("bbcred_bee")).toMatchObject({ reject: false });
  const offline = await visit("bee", "/", {
    headers: { cookie: `${SESSION}=owner` },
  });
  expect(offline.status).toBe(503);
  const proxy = { user, proxy_type: "http" };
  const foreign = { ...proxy, subdomain: "other" };
  expect(await hook("NewProxy", foreign)).toMatchObject({ reject: true });
  const own = { ...proxy, subdomain: "bee" };
  expect(await hook("NewProxy", own)).toMatchObject({ reject: false });
});

it("serves the owner and sends everyone else to sign in", async () => {
  const page = { accept: "text/html" };
  const bounced = await visit("bee", "/threads?x=1", { headers: page });
  expect(bounced.status).toBe(302);
  const returnTo = encodeURIComponent("http://bee.fly.bb.test/threads?x=1");
  expect(bounced.headers.location).toBe(
    `http://127.0.0.1:${accountPort}/dashboard?returnTo=${returnTo}`,
  );
  expect((await visit("bee", "/api/v1/threads")).status).toBe(401);
  const stranger = { cookie: `${SESSION}=stranger` };
  expect((await visit("bee", "/", { headers: stranger })).status).toBe(403);
  const before = seen.length;
  const forged = { "x-bb-gate-auth": "session", "x-bb-tunnel-target": "22" };
  expect((await visit("bee", "/", { headers: forged })).status).toBe(401);
  expect(seen.length).toBe(before);

  const owner = await visit("bee", "/api/v1/threads", {
    method: "POST",
    headers: {
      cookie: `${SESSION}=owner; theme=dark`,
      origin: "http://bee.fly.bb.test",
      "x-bb-frp-token": "guess",
      ...forged,
    },
    body: "{}",
  });
  expect(owner.text).toBe("from the server");
  expect(owner.headers["set-cookie"]).toEqual(["kept=1; Path=/"]);
  expect(seen.at(-1)?.headers).toMatchObject({
    cookie: "theme=dark",
    host: "bee.fly.bb.test",
    origin: `http://bee.bb.test:${accountPort}`,
    "x-bb-gate-auth": "session",
  });
  expect(seen.at(-1)?.headers["x-bb-frp-token"]).toBeUndefined();
  expect(seen.at(-1)?.headers["x-bb-tunnel-target"]).toBeUndefined();

  await visit("bee", "/api/v1/threads", {
    method: "POST",
    headers: { cookie: `${SESSION}=owner`, origin: "http://evil.test" },
    body: "{}",
  });
  expect(seen.at(-1)?.headers.origin).toBe("http://evil.test");
});

it("admits a caller that holds the server's credential, when switched on", async () => {
  const before = seen.length;
  const guess = { "x-test-owner": "bbcred_other" };
  expect(
    (await visit("bee", "/api/v1/threads", { headers: guess })).status,
  ).toBe(403);
  expect(seen.length).toBe(before);
  const held = { "x-test-owner": "bbcred_bee" };
  const owner = await visit("bee", "/api/v1/threads", { headers: held });
  expect(owner.status).toBe(200);
  expect(seen.at(-1)?.headers["x-bb-gate-auth"]).toBe("session");
  expect(seen.at(-1)?.headers["x-test-owner"]).toBeUndefined();
  const byCookie = { cookie: "test-owner=bbcred_bee; theme=dark" };
  const direct = await visit("bee", "/api/v1/threads", {
    headers: { ...byCookie, origin: "http://bee-direct.test" },
    host: "bee-direct.test",
  });
  expect(direct.status).toBe(200);
  expect(seen.at(-1)?.headers).toMatchObject({
    cookie: "theme=dark",
    host: "bee.fly.bb.test",
    origin: `http://bee.bb.test:${accountPort}`,
  });
});

it("turns a signed entry link into a session for that server only", async () => {
  const soon = Date.now() + 60_000;
  const enter = (token: string, name = "bee") =>
    visit(name, `/__gate/enter?token=${token}`);
  const forged = signEntry("another-key", "enter", "bee", soon);
  const stale = signEntry("entry-key", "enter", "bee", Date.now() - 1);
  const elsewhere = signEntry("entry-key", "enter", "other", soon);
  for (const token of [forged, stale, elsewhere, "nonsense"]) {
    expect((await enter(token)).status).toBe(403);
  }
  const entered = await enter(signEntry("entry-key", "enter", "bee", soon));
  expect(entered.status).toBe(302);
  expect(entered.headers.location).toBe("/");
  const [issued = ""] = entered.headers["set-cookie"] ?? [];
  expect(issued).toMatch(
    /^bb-gate-entry=\d+\.[0-9a-f]{64}; Path=\/; HttpOnly/u,
  );
  const [pair = ""] = issued.split(";");
  const before = seen.length;
  const inside = await visit("bee", "/api/v1/threads", {
    headers: { cookie: `${pair}; theme=dark` },
  });
  expect(inside.status).toBe(200);
  expect(seen.length).toBe(before + 1);
  expect(seen.at(-1)?.headers).toMatchObject({
    cookie: "theme=dark",
    "x-bb-gate-auth": "session",
  });
  const reused = { cookie: pair.replace("bb-gate-entry=", "bb-gate-entry=9") };
  expect(
    (await visit("bee", "/api/v1/threads", { headers: reused })).status,
  ).toBe(401);
});

it("marks a share's port and keeps machines and internals out", async () => {
  const owner = { cookie: `${SESSION}=owner` };
  await visit("bee--8000", "/page", { headers: owner });
  expect(seen.at(-1)?.headers).toMatchObject({
    host: "bee.fly.bb.test",
    "x-bb-tunnel-target": "8000",
  });
  const before = seen.length;
  const internal = await visit("bee", "/internal/hosts", { headers: owner });
  const machine = await visit("bee", "/api/v1/hosts", {
    headers: { "x-bb-connect-machine": "bbcm_1" },
  });
  const hidden = await visit("bee", "/__tunnel", { headers: owner });
  expect([internal.status, machine.status, hidden.status]).toEqual([
    403, 403, 404,
  ]);
  expect(seen.length).toBe(before);
});

it("serves the install files to anyone, as downloads", async () => {
  const script = await visit("bee", "/install.sh");
  expect(script.status).toBe(200);
  expect(script.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(script.headers["content-security-policy"]).toBe("sandbox");
  expect(seen.at(-1)?.headers["x-bb-gate-auth"]).toBeUndefined();
  const archive = await visit("bee", "/install/bb-app.tgz");
  expect(archive.headers["content-disposition"]).toContain("bb-app.tgz");
  expect((await visit("bee--8000", "/install.sh")).status).toBe(404);
});
