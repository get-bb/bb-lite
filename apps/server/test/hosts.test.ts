import { defaultAppSettings } from "@bb/domain";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { setAppSettings } from "../src/db/settings.js";
import { createTestServer, watchChanges, type TestServer } from "./helpers.js";

type Headers = Record<string, string>;
const JOIN_TOKEN_TTL_MS = 15 * 60_000;
const manual = { machineProviderId: "manual", inputs: null };

function throughGate(machineId: string): Headers {
  const gate = { "x-bb-via-tunnel": "1", "x-bb-gate-auth": "machine" };
  return { ...gate, "x-bb-gate-machine-id": machineId };
}

function decodeJoinCommand(command: string | undefined) {
  const [bb, runner, join, blob = ""] = (command ?? "").split(" ");
  expect([bb, runner, join]).toEqual(["bb", "runner", "join"]);
  const decoded = Buffer.from(blob, "base64url").toString();
  return JSON.parse(decoded) as Record<"serverUrl" | "joinToken", string>;
}

async function join({ url }: TestServer, token: string, gate: Headers = {}) {
  const headers = { authorization: `Bearer ${token}`, ...gate };
  const body = JSON.stringify({ hostName: "mini" });
  const init = { method: "POST", headers, body };
  const response = await fetch(`${url}/internal/runner/join`, init);
  const credential = (await response.json()) as { runnerToken?: string };
  return { status: response.status, token: String(credential.runnerToken) };
}

function dial({ url }: TestServer, token: string, gate: Headers = {}) {
  const headers = { authorization: `Bearer ${token}`, ...gate };
  const target = `${url.replace("http", "ws")}/internal/runner/ws`;
  const socket = new WebSocket(target, { headers });
  return new Promise<string>((resolve) => {
    socket.on("error", () => {});
    socket.on("open", () => socket.close(1000, "accepted"));
    socket.on("unexpected-response", (_request, response) =>
      resolve(`refused ${response.statusCode}`),
    );
    socket.on("close", (code, reason) => resolve(`closed ${code} ${reason}`));
  });
}

it("enrolls a machine with a single-use join token", async () => {
  const server = await createTestServer();
  const { api, clock, ctx, runner, url } = server;
  const changed = await watchChanges(server);
  const json = { ...manual, key: "launch-1" };
  const created = await (await api.hosts.$post({ json })).json();
  const pending = { status: "disconnected", machineProviderId: "manual" };
  const creating = { lifecycle: { phase: "creating" } };
  expect(created).toMatchObject({ ...pending, ...creating });
  await changed("host", "host-connected");
  const param = { id: created.id };
  expect(await (await api.hosts.$post({ json })).json()).toMatchObject(param);
  const visible = await (await api.hosts.$get({ query: {} })).json();
  expect(visible.map((host) => host.id)).toEqual([ctx.config.hostId]);
  const enrollment = api.hosts[":id"]["enrollment-command"];
  const command = await (await enrollment.$get({ param })).json();
  expect(command?.expiresAt).toBe(clock.now + JOIN_TOKEN_TTL_MS);
  const blob = decodeJoinCommand(command?.command);
  expect(blob).toMatchObject({ serverUrl: url, hostId: created.id });
  const m1 = throughGate("m1");
  const asMachine = async (method: string, path = "") => {
    const init = { method, headers: m1 };
    const target = `${url}/api/v1/hosts/${created.id}${path}`;
    return (await fetch(target, init)).status;
  };
  expect(await asMachine("GET", "/enrollment-command")).toBe(403);
  expect(await asMachine("DELETE")).toBe(403);
  expect((await join(server, "bbj_wrong")).status).toBe(401);
  const { token } = await join(server, blob.joinToken, m1);
  expect(token).toMatch(/^bbr_[\w-]{43}$/u);
  expect((await join(server, blob.joinToken)).status).toBe(401);
  expect(await (await enrollment.$get({ param })).json()).toBeNull();
  const stored = ctx.db.get("SELECT * FROM hosts WHERE id = ?", created.id);
  expect(stored).toMatchObject({ name: "mini", connectMachineId: "m1" });
  expect(JSON.stringify(stored)).not.toContain(token);
  const m2 = throughGate("m2");
  const strangers = [dial(server, "bbr_no"), dial(server, token, m2)];
  expect(await Promise.all(strangers)).toEqual(["refused 401", "refused 403"]);
  expect(await dial(server, token, m1)).toBe("closed 1000 accepted");
  expect(ctx.runners.isConnected(created.id)).toBe(false);
  ctx.runners.connect(created.id, () => runner.api);
  await changed("host", "host-connected");
  const enrolled = await (await api.hosts[":id"].$get({ param })).json();
  const active = { phase: "active", message: null };
  expect(enrolled).toMatchObject({ status: "connected", lifecycle: active });
});

it("expires join tokens, reissues them and revokes on removal", async () => {
  const server = await createTestServer();
  const { api, clock, ctx, runner } = server;
  const changed = await watchChanges(server);
  const { id } = await (await api.hosts.$post({ json: manual })).json();
  const param = { id };
  const enrollment = api.hosts[":id"]["enrollment-command"];
  const first = await (await enrollment.$get({ param })).json();
  clock.now += JOIN_TOKEN_TTL_MS;
  expect(await (await enrollment.$get({ param })).json()).toBeNull();
  const expired = decodeJoinCommand(first?.command).joinToken;
  expect((await join(server, expired)).status).toBe(401);
  const reconnect = api.hosts[":id"]["reconnect-commands"];
  expect((await reconnect.$post({ param })).status).toBe(409);
  ctx.runners.connect(id, () => runner.api);
  expect((await reconnect.$post({ param })).status).toBe(409);
  ctx.runners.disconnect(id);
  const publicUrl = "https://bee.example.test";
  const settings = { ...defaultAppSettings, machineServerUrl: `${publicUrl}/` };
  setAppSettings(ctx.db, settings);
  const reissued = await (await reconnect.$post({ param })).json();
  const blob = decodeJoinCommand(reissued.command);
  expect(blob.serverUrl).toBe(publicUrl);
  const { token } = await join(server, blob.joinToken);
  expect((await api.hosts[":id"].$delete({ param })).status).toBe(200);
  await changed("host", "host-disconnected");
  expect((await api.hosts[":id"].$get({ param })).status).toBe(404);
  expect(await dial(server, token)).toBe("refused 401");
});
