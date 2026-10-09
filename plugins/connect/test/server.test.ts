import { server } from "@bb/plugin";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { createRunnerPlugins } from "@bb/runner";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import {
  createTestServer,
  FakeRunner,
  scratch,
  TestSocket,
} from "../../../apps/server/test/helpers.js";
import { writePluginRow } from "../../../packages/server-kit/src/db/plugins.js";
import { shareUrl } from "../src/account.js";
import connectRunner from "../src/runner.js";
import type { ConnectStatus } from "../src/contract.js";
import { startFakeGate, visit } from "./fake-gate.js";

type CliReply = { exitCode: number; stdout: string; stderr: string };

const OWNER = { cookie: "session=owner" };
const JSON_BODY = { "content-type": "application/json" };
const MANUAL = { machineProviderId: "manual", inputs: null };

async function startServer(stored?: string) {
  const gate = await startFakeGate();
  vi.stubEnv("BB_CONNECT_BASE_URL", gate.apexUrl);
  onTestFinished(() => void vi.unstubAllEnvs());
  const server = await createTestServer();
  const { ctx, url } = server;
  ctx.config.port = Number(new URL(url).port);
  const file = join(ctx.config.dataDir, "connect.json");
  writeFileSync(file, JSON.stringify(gate.link()));
  if (stored) writePluginRow(ctx.db, "plugin_kv", "connect", "shares", stored);
  await ctx.plugins.reload("connect");
  const cli = async (...argv: string[]): Promise<CliReply> => {
    const body = JSON.stringify({ argv, cwd: tmpdir(), threadId: "thr_1" });
    const init = { method: "POST", headers: JSON_BODY, body };
    const response = await fetch(`${url}/api/v1/plugins/connect/cli`, init);
    return (await response.json()) as CliReply;
  };
  const status = async (): Promise<ConnectStatus> =>
    JSON.parse((await cli("status", "--json")).stdout) as ConnectStatus;
  await vi.waitFor(async () =>
    expect((await status()).state).toBe("connected"),
  );
  return { ...server, gate, cli, status };
}

it("serves gate-authenticated visitors through the tunnel", async () => {
  const { ctx, gate } = await startServer();
  expect(ctx.kernel.pick(server.publicUrl)?.()).toBe(gate.gateUrl);
  const ownerJson = { ...OWNER, ...JSON_BODY, origin: gate.gateUrl };
  const hostPath = `/api/v1/machines/${ctx.config.hostId}`;
  const code = async (path: string, init: Parameters<typeof visit>[2] = {}) => {
    const { status, text } = await visit(gate, path, init);
    const body = JSON.parse(text || "{}") as { code?: string } | null;
    return [status, body?.code];
  };
  const listed = await visit(gate, "/api/v1/machines", { headers: OWNER });
  expect(JSON.parse(listed.text)).toMatchObject([{ id: ctx.config.hostId }]);
  const zipped = { ...OWNER, "accept-encoding": "gzip" };
  const config = await visit(gate, "/api/v1/server/config", {
    headers: zipped,
  });
  const { primaryHostId } = JSON.parse(config.text) as {
    primaryHostId: string;
  };
  expect([config.coding, primaryHostId]).toEqual(["gzip", ctx.config.hostId]);
  const body = JSON.stringify({ argv: ["status", "--json"] });
  const posted = { method: "POST", headers: ownerJson, body };
  const ran = await visit(gate, "/api/v1/plugins/connect/cli", posted);
  expect(ran).toMatchObject({ status: 200, chunked: true });
  const { stdout } = JSON.parse(ran.text) as CliReply;
  const reported = { state: "connected", url: gate.gateUrl, handle: "bee" };
  expect(JSON.parse(stdout)).toMatchObject(reported);
  gate.machines.set("bbcm_laptop", "machine_9");
  const forged = { "x-bb-gate-auth": "session", "x-bb-via-tunnel": "0" };
  const machine = { "x-bb-connect-machine": "bbcm_laptop", ...forged };
  const added = { method: "POST", body: JSON.stringify(MANUAL) };
  const asMachine = { ...added, headers: { ...machine, ...JSON_BODY } };
  const command = `${hostPath}/enrollment-command`;
  expect((await code(command, { headers: OWNER }))[0]).toBe(200);
  expect((await code("/api/v1/machines", { headers: machine }))[0]).toBe(403);
  expect(await code(command, { headers: machine })).toEqual([403, "forbidden"]);
  expect(await code("/api/v1/machines", asMachine)).toEqual([403, "forbidden"]);
  const removal = { method: "DELETE", headers: machine };
  expect(await code(hostPath, removal)).toEqual([403, "forbidden"]);
  const anonymous = await code("/install.sh", { headers: forged });
  expect(anonymous).toEqual([404, "not_found"]);
  expect(await code("/api/v1/machines")).toEqual([401, undefined]);
  const live = `${gate.gateUrl.replace("http", "ws")}/ws`;
  const socket = new WebSocket(live, { headers: OWNER });
  onTestFinished(() => socket.terminate());
  await once(socket, "open");
  const client = new TestSocket(socket);
  await client.subscribe({ kind: "host-list" });
  const rename = { headers: ownerJson, body: JSON.stringify({ name: "hive" }) };
  expect((await code(hostPath, { ...rename, method: "PATCH" }))[0]).toBe(200);
  const changed = await client.next((message) => message.type === "changed");
  expect(changed).toMatchObject({ entity: "host" });
});

async function startOrigin() {
  const big = Buffer.alloc(3 * 1024 * 1024 + 7, "b");
  const origin = createServer((request, response) => {
    if (request.url === "/big") return void response.end(big);
    void buffer(request).then((body) => {
      const { host, origin: from } = request.headers;
      const seen = { method: request.method, body: body.toString(), host };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...seen, origin: from }));
    });
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  onTestFinished(() => void origin.close());
  return { port: (origin.address() as AddressInfo).port, big };
}

it("shares a port of another machine through its runner", async () => {
  const { ctx, gate, cli, send, status } = await startServer("[1]");
  const created = await send("/machines", MANUAL);
  const { id } = (await created.json()) as { id: string };
  const machine = createRunnerPlugins({ dataDir: scratch(), sink: () => {} });
  onTestFinished(() => machine.dispose());
  machine.load({ id: "connect", entry: connectRunner });
  const remote = new FakeRunner();
  remote.script.callOp = (sent: { name: string; input: unknown }) =>
    machine.callOp(sent.name, sent.input);
  ctx.runners.connect(id, () => remote.api);
  const { port, big } = await startOrigin();
  const shared = await cli("expose", String(port), "--host", id, "--json");
  const url = shareUrl(gate.link(), port);
  expect(JSON.parse(shared.stdout)).toEqual({ hostId: id, port, url });
  const legacy = { hostId: ctx.config.hostId, port: 1 };
  const local = { ...legacy, url: shareUrl(gate.link(), 1) };
  expect((await status()).shares).toEqual([local, { hostId: id, port, url }]);
  const target = { ...OWNER, "x-bb-tunnel-target": String(port) };
  const origin = { ...target, origin: url, ...JSON_BODY };
  const posted = { method: "POST", headers: origin, body: "hi" };
  const echoed = await visit(gate, "/echo?q=1", posted);
  expect(echoed.status).toBe(201);
  expect(JSON.parse(echoed.text)).toEqual({
    method: "POST",
    body: "hi",
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
  });
  const large = await visit(gate, "/big", { headers: target });
  expect([large.status, large.text.length]).toEqual([200, big.byteLength]);
  const relayed = remote.calls.filter(({ method }) => method === "callOp");
  expect(relayed.length).toBeGreaterThan(4);
  const taken = await cli("expose", String(port));
  expect(taken.exitCode).not.toBe(0);
  expect(taken.stderr).toContain("already shared from machine");
  ctx.runners.disconnect(id);
  const offline = await visit(gate, "/", { headers: target });
  expect(offline.status).toBe(502);
  expect(offline.text).toContain("offline");
  const revoked = await cli("unexpose", String(port), "--json");
  expect(JSON.parse(revoked.stdout)).toEqual({ removed: 1 });
  expect((await visit(gate, "/", { headers: target })).status).toBe(404);
});
