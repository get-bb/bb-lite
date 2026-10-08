import { server } from "@bb/plugin";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createTestServer,
  TestSocket,
} from "../../../apps/server/test/helpers.js";
import type { ConnectStatus } from "../src/contract.js";
import { startFakeGate, visit } from "./fake-gate.js";

type CliReply = { exitCode: number; stdout: string; stderr: string };

const OWNER = { cookie: "session=owner" };
const JSON_BODY = { "content-type": "application/json" };
const MANUAL = { machineProviderId: "manual", inputs: null };

async function startServer() {
  const gate = await startFakeGate();
  vi.stubEnv("BB_CONNECT_BASE_URL", gate.apexUrl);
  onTestFinished(() => void vi.unstubAllEnvs());
  const server = await createTestServer();
  const { ctx, url } = server;
  ctx.config.port = Number(new URL(url).port);
  const file = join(ctx.config.dataDir, "connect.json");
  writeFileSync(file, JSON.stringify(gate.link()));
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
  return { ...server, gate };
}

it("serves gate-authenticated visitors through the tunnel", async () => {
  const { ctx, gate } = await startServer();
  expect(ctx.kernel.pick(server.publicUrl)?.()).toBe(gate.gateUrl);
  const ownerJson = { ...OWNER, ...JSON_BODY, origin: gate.gateUrl };
  const hostPath = `/api/v1/hosts/${ctx.config.hostId}`;
  const code = async (path: string, init: Parameters<typeof visit>[2] = {}) => {
    const { status, text } = await visit(gate, path, init);
    const body = JSON.parse(text || "{}") as { code?: string } | null;
    return [status, body?.code];
  };
  const listed = await visit(gate, "/api/v1/hosts", { headers: OWNER });
  expect(JSON.parse(listed.text)).toMatchObject([{ id: ctx.config.hostId }]);
  const zipped = { ...OWNER, "accept-encoding": "gzip" };
  const config = await visit(gate, "/api/v1/system/config", {
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
  expect((await code("/api/v1/hosts", { headers: machine }))[0]).toBe(200);
  expect(await code(command, { headers: machine })).toEqual([403, "forbidden"]);
  expect(await code("/api/v1/hosts", asMachine)).toEqual([403, "forbidden"]);
  const removal = { method: "DELETE", headers: machine };
  expect(await code(hostPath, removal)).toEqual([403, "forbidden"]);
  const anonymous = await code("/install.sh", { headers: forged });
  expect(anonymous).toEqual([404, "not_found"]);
  expect(await code("/api/v1/hosts")).toEqual([401, undefined]);
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
