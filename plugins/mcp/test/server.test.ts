import { createPluginHarness } from "@bb/plugin/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { connect, type ConnectStatus } from "bb-plugin-connect/contract.js";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { mcp } from "../contract.js";
import { createMcp } from "../server.js";

const LINK = {
  baseUrl: "https://getbb.test",
  serverUrl: "https://ada.getbb.test/",
  credential: "cred-1",
};
const GRANT = {
  id: "grant_1",
  clientId: "client_1",
  clientName: "ChatGPT",
  scope: "bb",
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
};
const JSON_BODY = { "content-type": "application/json" };
const VIA = { "x-bb-via-tunnel": "1" };
const OAUTH = {
  ...VIA,
  "x-bb-gate-auth": "oauth",
  "x-bb-gate-oauth-scope": "bb",
  "x-bb-gate-oauth-grant": "grant_1",
  "x-bb-gate-oauth-client": "ChatGPT",
};
const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

function connectStatus(url: string | null): ConnectStatus {
  return {
    state: url === null ? "disconnected" : "connected",
    paired: url !== null,
    enabled: true,
    handle: url === null ? null : "ada",
    url,
    lastError: null,
    nextRetryAt: null,
    login: null,
    shares: [],
  };
}

type Reply = { status: number; body: unknown };

async function setup(options: { linked?: boolean; reply?: Reply } = {}) {
  const { linked = true, reply = { status: 200, body: { grants: [GRANT] } } } =
    options;
  const harness = createPluginHarness();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  harness.stub(connect.status, () =>
    connectStatus(linked ? "https://ada.getbb.test" : null),
  );
  await harness.load("connect", (bb) => {
    bb.add(connect.link, () => (linked ? LINK : null));
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(reply.body, { status: reply.status });
  };
  const loaded = await harness.load("mcp", createMcp({ fetch }));
  return { harness, requests, loaded };
}

describe("bb mcp commands", () => {
  it("reports the remote and local addresses", async () => {
    const { harness, loaded } = await setup();
    expect(await harness.kernel.call(mcp.status, {})).toEqual({
      remoteUrl: "https://ada.getbb.test/mcp",
      localUrl: "http://127.0.0.1:0/api/v1/plugins/mcp/http/mcp",
      remoteProblem: null,
    });
    expect([...loaded.routes.keys()]).toEqual([
      "POST /mcp",
      "GET /mcp",
      "DELETE /mcp",
    ]);
    expect([...loaded.routes.values()].map(({ auth }) => auth)).toEqual([
      "none",
      "none",
      "none",
    ]);
  });

  it("says why there is no remote address without bb connect", async () => {
    const { harness } = await setup({ linked: false });
    const status = await harness.kernel.call(mcp.status, {});
    expect(status.remoteUrl).toBeNull();
    expect(status.remoteProblem).toContain("bb connect");
    await expect(harness.kernel.call(mcp.clients, {})).rejects.toMatchObject({
      reason: "not_signed_in",
    });
  });

  it("lists the connected apps from the relay with the link credential", async () => {
    const { harness, requests } = await setup();
    expect(await harness.kernel.call(mcp.clients, {})).toEqual([GRANT]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://ada.getbb.test/api/connect/mcp/grants",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer cred-1" },
    });
  });

  it("revokes a grant and reports an unknown one", async () => {
    const revoked = { status: 200, body: { revoked: true } };
    const { harness, requests } = await setup({ reply: revoked });
    const input = { grantId: "grant_1" };
    expect(await harness.kernel.call(mcp.revoke, input)).toEqual({
      revoked: true,
      grantId: "grant_1",
    });
    expect(requests[0]?.url).toBe(
      "https://ada.getbb.test/api/connect/mcp/grants/revoke",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify(input),
    });
    const missing = { status: 200, body: { revoked: false } };
    const other = await setup({ reply: missing });
    await expect(
      other.harness.kernel.call(mcp.revoke, input),
    ).rejects.toMatchObject({ reason: "unknown_grant" });
  });

  it("explains a refused credential and a failing relay", async () => {
    const refused = await setup({ reply: { status: 401, body: {} } });
    await expect(
      refused.harness.kernel.call(mcp.clients, {}),
    ).rejects.toMatchObject({ reason: "not_signed_in" });
    const broken = await setup({ reply: { status: 502, body: {} } });
    await expect(
      broken.harness.kernel.call(mcp.clients, {}),
    ).rejects.toMatchObject({ reason: "account_request_failed" });
  });
});

async function startServer() {
  const server = await createTestServer();
  const { ctx, url } = server;
  ctx.config.port = Number(new URL(url).port);
  await ctx.plugins.reload("mcp");
  const endpoint = `${url}/api/v1/plugins/mcp/http/mcp`;
  const post = async (headers: Record<string, string>) => {
    const init = { method: "POST", headers: { ...JSON_BODY, ...headers } };
    return (await fetch(endpoint, { ...init, body: PING })).status;
  };
  const client = async (headers: Record<string, string>) => {
    const info = { name: "test-client", version: "1.0.0" };
    const connected = new Client(info, { capabilities: {} });
    const requestInit = { headers };
    const target = new URL(endpoint);
    await connected.connect(
      new StreamableHTTPClientTransport(target, { requestInit }),
    );
    onTestFinished(() => connected.close());
    return connected;
  };
  return { url, endpoint, post, client };
}

describe("the MCP endpoint on a running server", () => {
  it("serves an app on the server's own machine and an app the gate vouches for", async () => {
    const { client } = await startServer();
    for (const headers of [{}, OAUTH]) {
      const connected = await client(headers);
      const { tools } = await connected.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["search", "read", "run"]);
    }
  });

  it("refuses everyone else", async () => {
    const { url, post } = await startServer();
    expect(await post({ origin: new URL(url).origin })).toBe(403);
    expect(await post({ origin: "https://evil.example" })).toBe(403);
    const { [VIA_NAME]: _marker, ...forged } = OAUTH;
    expect(await post(forged)).toBe(403);
    expect(await post({ ...VIA, "x-bb-gate-auth": "session" })).toBe(403);
    const visitor = { "x-bb-gate-user-id": "ru_owner", "x-bb-gate-owner": "1" };
    const session = { ...VIA, ...visitor, "x-bb-gate-auth": "session" };
    expect(await post(session)).toBe(403);
    expect(await post({ ...session, "x-bb-gate-oauth-scope": "bb" })).toBe(403);
    expect(await post({ ...OAUTH, "x-bb-gate-oauth-scope": "openid" })).toBe(
      403,
    );
    expect(await post({ ...OAUTH, "x-bb-via-tunnel": "guess" })).toBe(404);
    expect(await post(VIA)).toBe(404);
  });

  it("answers bb mcp status and refuses bb mcp clients without bb connect", async () => {
    const { url, endpoint } = await startServer();
    const cli = async (...argv: string[]) => {
      const body = JSON.stringify({ argv, cwd: tmpdir() });
      const init = { method: "POST", headers: JSON_BODY, body };
      const response = await fetch(`${url}/api/v1/plugins/mcp/cli`, init);
      return (await response.json()) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
    };
    const status = await cli("status", "--json");
    expect(JSON.parse(status.stdout)).toMatchObject({
      remoteUrl: null,
      localUrl: endpoint,
    });
    expect((await cli("status")).stdout).toContain(`Local:  ${endpoint}`);
    const clients = await cli("clients");
    expect(clients.exitCode).not.toBe(0);
    expect(clients.stderr).toContain("not connected to a bb account");
  });
});

const VIA_NAME = "x-bb-via-tunnel";
