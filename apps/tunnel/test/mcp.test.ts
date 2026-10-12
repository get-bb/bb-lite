import { once } from "node:events";
import {
  createServer,
  request as send,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createGate } from "../src/gate.js";
import { relayAccounts } from "../src/relay-accounts.js";

const HOST = "bee.fly.bb.test";
const OWN = `http://${HOST}`;
const METADATA = `${OWN}/.well-known/oauth-protected-resource/mcp`;
const GRANT = { grantId: "grant-1", scope: "bb", clientName: "Chat é App" };
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const asked: Record<string, string>[] = [];
const servers: Server[] = [];
const state = { revoked: false, configured: true };
let gate: string;
let relayUrl: string;

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
  path: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<Visited> {
  const sent = { method, headers: { host: HOST, ...headers } };
  return new Promise((resolve, reject) => {
    const asking = send(`${gate}${path}`, sent, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const status = answer.statusCode ?? 0;
        resolve({ status, text, headers: answer.headers });
      });
    });
    asking.on("error", reject);
    asking.end();
  });
}

beforeAll(async () => {
  const relay = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        string
      >;
      asked.push(body);
      const known = body.label === "bee";
      const server = { id: "srv_1", label: "bee", ownerId: "ru_1" };
      const valid = body.oauth === "good" && body.resource === `${OWN}/mcp`;
      const answer: Record<string, unknown> = known
        ? { server, address: "http://bee.bb.test", user: null }
        : { server: null };
      if (known && body.oauth !== undefined) {
        answer.oauth = valid && !state.revoked ? GRANT : null;
        if (!state.configured) answer.oauthUnavailable = true;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  relayUrl = `http://127.0.0.1:${await listening(relay)}`;
  const upstream = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.end("from the server");
  });
  const made = createGate({
    baseHost: "fly.bb.test",
    secure: false,
    accounts: relayAccounts({ relayUrl, relaySecret: "gate", cacheMs: 200 }),
    upstream: { host: "127.0.0.1", port: await listening(upstream) },
    log: () => {},
  });
  gate = `http://127.0.0.1:${await listening(made.web)}`;
  const hooks = `http://127.0.0.1:${await listening(made.hooks)}/frp`;
  const user = { user: "bee", run_id: "run-1" };
  const content = { user, proxy_type: "http", subdomain: "bee" };
  const body = JSON.stringify({ op: "NewProxy", content });
  await fetch(hooks, { method: "POST", body });
});

afterAll(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

it("describes the MCP resource and challenges a caller without a token", async () => {
  const path = "/.well-known/oauth-protected-resource";
  const described = await visit(path, {}, "GET");
  expect(JSON.parse(described.text)).toMatchObject({
    resource: `${OWN}/mcp`,
    authorization_servers: [relayUrl],
    scopes_supported: ["bb"],
  });
  const bare = await visit("/mcp");
  expect(bare.status).toBe(401);
  expect(bare.headers["www-authenticate"]).toBe(
    `Bearer resource_metadata="${METADATA}", scope="bb"`,
  );
  const wrong = await visit("/mcp", { authorization: "Bearer bad" });
  expect(wrong.status).toBe(401);
  expect(wrong.headers["www-authenticate"]).toBe(
    `Bearer error="invalid_token", resource_metadata="${METADATA}", scope="bb"`,
  );
  const basic = await visit("/mcp", { authorization: "Basic abc" });
  expect(basic.headers["www-authenticate"]).not.toContain("invalid_token");
  expect(seen).toEqual([]);
});

it("forwards a valid token to the plugin path with only gate headers", async () => {
  const headers = {
    authorization: "Bearer good",
    cookie: "bbr_session=abc; theme=dark",
    "x-bb-gate-owner": "1",
    "x-bb-gate-oauth-grant": "forged",
    "x-bb-connect-machine": "bbmach_x",
  };
  const served = await visit("/mcp?x=1", headers);
  expect(served.text).toBe("from the server");
  const sent = seen.at(-1);
  expect(sent?.url).toBe("/api/v1/plugins/mcp/http/mcp?x=1");
  expect(sent?.headers).toMatchObject({
    "x-bb-gate-auth": "oauth",
    "x-bb-gate-oauth-scope": "bb",
    "x-bb-gate-oauth-grant": "grant-1",
    "x-bb-gate-oauth-client": "Chat ? App",
  });
  for (const name of ["authorization", "cookie", "x-bb-gate-owner"]) {
    expect(sent?.headers[name], name).toBeUndefined();
  }
  expect(sent?.headers["x-bb-connect-machine"]).toBeUndefined();
  expect(asked.at(-1)).toEqual({
    label: "bee",
    oauth: "good",
    resource: `${OWN}/mcp`,
  });
});

it("stops serving a revoked grant once the short cache runs out", async () => {
  const headers = { authorization: "Bearer good" };
  state.revoked = true;
  expect((await visit("/mcp", headers)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await visit("/mcp", headers)).status).toBe(401);
  state.revoked = false;
  state.configured = false;
  const other = { authorization: "Bearer other" };
  expect((await visit("/mcp", other)).status).toBe(503);
  state.configured = true;
});

it("refuses the plugin's local path for every visitor", async () => {
  const before = seen.length;
  const visitors: Record<string, string>[] = [
    {},
    { authorization: "Bearer good" },
    { cookie: "bbr_session=abc" },
    { "x-bb-connect-machine": "bbmach_x" },
  ];
  for (const path of [
    "/api/v1/plugins/mcp/http/mcp",
    "/api/v1/plugins/mcp/http/mcp/extra?x=1",
    "/API/v1/plugins/%6Dcp/http/mcp",
    "/api/v1/plugins/%256dcp/http/mcp",
    "/x/../api/v1//plugins/./mcp;v=1/http/mcp",
    "/api\\v1\\plugins\\mcp\\http\\mcp",
  ]) {
    for (const headers of visitors) {
      expect((await visit(path, headers)).status, path).toBe(404);
    }
  }
  expect(seen.length).toBe(before);
  const nobody = { host: "nobody.fly.bb.test", authorization: "Bearer good" };
  const missing = await visit("/mcp", nobody);
  expect(missing.status).toBe(404);
});

it("never takes a session cookie or a machine credential for a token", async () => {
  const before = seen.length;
  const wellKnown = "/.well-known/oauth-protected-resource";
  for (const path of [wellKnown, `${wellKnown}/mcp`]) {
    const described = await visit(path, {}, "GET");
    expect(described.status).toBe(200);
    expect(described.headers["cache-control"]).toBe("public, max-age=300");
    expect(JSON.parse(described.text)).toEqual({
      resource: `${OWN}/mcp`,
      authorization_servers: [relayUrl],
      scopes_supported: ["bb"],
      bearer_methods_supported: ["header"],
      resource_name: "bb",
    });
  }
  const challenge = `Bearer resource_metadata="${METADATA}", scope="bb"`;
  const callers: Record<string, string>[] = [
    { cookie: "bbr_session=anything" },
    { "x-bb-connect-machine": "bbmach_guess" },
  ];
  for (const headers of callers) {
    const refused = await visit("/mcp", headers);
    expect(refused.status).toBe(401);
    expect(refused.headers["www-authenticate"]).toBe(challenge);
    expect(refused.headers["cache-control"]).toBe("no-store");
  }
  expect(seen.length).toBe(before);
});
