import { once } from "node:events";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEchoAdapter, joinServer, runRunner } from "@bb/runner";
import Database from "better-sqlite3";
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
const scratch = (): string => mkdtempSync(join(tmpdir(), "bb-connect-"));

async function startServer(linked = true) {
  const gate = await startFakeGate();
  vi.stubEnv("BB_CONNECT_BASE_URL", gate.apexUrl);
  onTestFinished(() => void vi.unstubAllEnvs());
  const server = await createTestServer();
  const { ctx, url } = server;
  ctx.config.port = Number(new URL(url).port);
  const file = join(ctx.config.dataDir, "connect.json");
  if (linked) writeFileSync(file, JSON.stringify(gate.link()));
  await ctx.plugins.reload("connect");
  const cli = async (...argv: string[]): Promise<CliReply> => {
    const body = JSON.stringify({ argv, cwd: tmpdir(), threadId: "thr_1" });
    const init = { method: "POST", headers: JSON_BODY, body };
    const response = await fetch(`${url}/api/v1/plugins/connect/cli`, init);
    return (await response.json()) as CliReply;
  };
  const status = async (): Promise<ConnectStatus> =>
    JSON.parse((await cli("status", "--json")).stdout) as ConnectStatus;
  const connected = () =>
    vi.waitFor(async () => expect((await status()).state).toBe("connected"));
  if (linked) await connected();
  return { ...server, gate, file, cli, status, connected };
}

it("serves gate-authenticated visitors through the tunnel", async () => {
  const { ctx, gate } = await startServer();
  expect(ctx.plugins.publicUrl()).toBe(gate.gateUrl);
  const ownerJson = { ...OWNER, ...JSON_BODY, origin: gate.gateUrl };
  const hostPath = `/api/v1/hosts/${ctx.config.hostId}`;
  const code = async (path: string, init: Parameters<typeof visit>[2] = {}) => {
    const { status, text } = await visit(gate, path, init);
    const body = JSON.parse(text || "{}") as { code?: string } | null;
    return [status, body?.code];
  };
  const listed = await visit(gate, "/api/v1/hosts", { headers: OWNER });
  expect(JSON.parse(listed.text)).toMatchObject([{ id: ctx.config.hostId }]);
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

it("gives an added machine a gate credential and revokes it on removal", async () => {
  const { api, ctx, gate } = await startServer();
  const { id } = await (await api.hosts.$post({ json: MANUAL })).json();
  const param = { id };
  const issued = async (): Promise<string> => {
    const enrollment = api.hosts[":id"]["enrollment-command"];
    const blob = (await (await enrollment.$get({ param })).json())?.command;
    return blob?.split(" ").at(-1) ?? "";
  };
  const blob = await issued();
  expect(await issued()).toBe(blob);
  const headers = { "x-bb-connect-machine": "bbcm_1" };
  const joining = { serverUrl: gate.gateUrl, hostId: id, headers };
  const decoded = Buffer.from(blob, "base64url").toString();
  expect(JSON.parse(decoded)).toMatchObject(joining);
  expect([...gate.machines]).toEqual([["bbcm_1", "machine_1"]]);
  const dataDir = scratch();
  await joinServer({ blob, dataDir, hostName: "laptop" });
  const options = { dataDir, bbCliPath: "/opt/bb/bin/bb", log: () => {} };
  const adapters = [createEchoAdapter()];
  const running = await runRunner({ ...options, adapters });
  onTestFinished(() => running.stop());
  await vi.waitFor(() => expect(ctx.runners.isConnected(id)).toBe(true));
  const columns = "SELECT name, connect_machine_id FROM hosts WHERE id = ?";
  const row = ctx.db.get(columns, id);
  expect(row).toEqual({ name: "laptop", connectMachineId: "machine_1" });
  expect(gate.calls).toContain("gate POST /internal/runner/join");
  expect((await api.hosts[":id"].$delete({ param })).status).toBe(200);
  expect(gate.revoked).toEqual(["machine_1"]);
});

it("imports a legacy credential, shares ports and signs out", async () => {
  const server = await startServer(false);
  const { ctx, gate, file, cli, status, connected } = server;
  expect((await cli("status")).stdout).toContain("Not signed in");
  const legacy = join(scratch(), "bb.db");
  const database = new Database(legacy);
  const { baseUrl, serverUrl, serverId, credential } = gate.link();
  const stored = JSON.stringify({ baseUrl, serverUrl, serverId, credential });
  database.exec("CREATE TABLE plugin_kv (plugin_id, key, value, updated_at)");
  database
    .prepare("INSERT INTO plugin_kv VALUES ('bb-account', 'credential', ?, 0)")
    .run(stored);
  database.close();
  const unconfirmed = await cli("import-legacy", "--db", legacy);
  expect([unconfirmed.exitCode, existsSync(file)]).toEqual([1, false]);
  expect(unconfirmed.stderr).toContain("STOP THE ORIGINAL bb SERVER FIRST");
  await cli("import-legacy", "--db", legacy, "--yes");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await connected();
  const target = http.createServer((_request, response) => {
    response.end("dev server");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  onTestFinished(() => void target.close());
  const { port } = target.address() as AddressInfo;
  const headers = { ...OWNER, host: `bee--${port}.gate.test` };
  const open = () => visit(gate, "/", { headers });
  expect(await open()).toMatchObject({ status: 404 });
  const exposed = await cli("expose", String(port), "--json");
  const share = { port, url: expect.stringContaining(`--${port}.`) };
  expect(JSON.parse(exposed.stdout)).toEqual(share);
  expect(await open()).toMatchObject({ status: 200, text: "dev server" });
  expect((await status()).shares).toEqual([share]);
  expect((await cli("expose", String(ctx.config.port))).exitCode).toBe(1);
  const thread = { threadId: "thr_1", projectId: "p", providerId: "echo" };
  const told = (hostId: string) =>
    ctx.plugins.instructionsFor({ ...thread, hostId });
  expect(await told(ctx.config.hostId)).toContain("bb connect expose");
  expect(await told("host_other")).not.toContain("bb connect expose");
  expect((await cli("expose", "8080")).stderr).toContain("another machine");
  expect((await cli("unexpose-all")).stdout).toBe("Revoked 1 shared ports.\n");
  expect(await open()).toMatchObject({ status: 404 });
  await cli("off");
  expect(await status()).toMatchObject({ paired: true, enabled: false });
  expect(ctx.plugins.publicUrl()).toBeNull();
  await cli("on");
  await connected();
  expect((await cli("logout")).stdout).toContain("Not signed in");
  expect(gate.calls).toContain("gate POST /api/connect/disconnect");
  expect([existsSync(file), (await status()).paired]).toEqual([false, false]);
});
