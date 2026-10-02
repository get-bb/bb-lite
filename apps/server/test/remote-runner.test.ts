import { once } from "node:events";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import {
  createEchoAdapter,
  joinServer,
  runRunner,
  type SubmitTurnArgs,
} from "@bb/runner";
import { expect, it, onTestFinished } from "vitest";
import { createTestServer, type TestServer } from "./helpers.js";

let turnCounter = 0;

async function until<T>(read: () => T): Promise<NonNullable<T>> {
  for (const deadline = Date.now() + 10_000; ;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function turn(threadId: string, text: string): SubmitTurnArgs {
  turnCounter += 1;
  const identity = { threadId, providerId: "echo" as const, cwd: tmpdir() };
  const blank = { providerThreadId: null, fork: null, instructions: "" };
  const extras = { dynamicTools: [], env: {}, skillDirs: [] };
  return {
    session: { ...identity, ...blank, ...extras },
    clientRequestId: encodeClientTurnRequestIdNumber({ value: turnCounter }),
    input: [{ type: "text", text, mentions: [] }],
    mode: { kind: "start" },
    options: {
      model: "echo-1",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      permissionEscalation: "ask",
      planMode: false,
      providerOptions: {},
    },
  };
}

async function startRelay(targetUrl: string) {
  const targetPort = Number(new URL(targetUrl).port);
  const sockets = new Set<net.Socket>();
  const relay = net.createServer((inbound) => {
    const outbound = net.connect(targetPort, "127.0.0.1");
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        inbound.destroy();
        outbound.destroy();
      });
    }
    inbound.pipe(outbound).pipe(inbound);
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const sever = () => sockets.forEach((socket) => socket.destroy());
  onTestFinished(() => {
    sever();
    relay.close();
  });
  const { port } = relay.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, sever };
}

async function enrollMachine(server: TestServer) {
  const { api, ctx } = server;
  const relay = await startRelay(server.url);
  const dataDir = fs.mkdtempSync(join(tmpdir(), "bb-remote-machine-"));
  const json = { machineProviderId: "manual", inputs: null };
  const { id: hostId } = await (await api.hosts.$post({ json })).json();
  const issued = `${relay.url}/api/v1/hosts/${hostId}/enrollment-command`;
  const { command } = (await (await fetch(issued)).json()) as {
    command: string;
  };
  const legacyMachineConfigPath = join(dataDir, "legacy-config.json");
  const legacy = JSON.stringify({ machineCredential: "bbcm_legacy" });
  fs.writeFileSync(legacyMachineConfigPath, legacy);
  const blob = command.split(" ").at(-1) ?? "";
  const headers = ["X-Extra=one=two"];
  const joined = { blob, dataDir, hostName: "laptop", headers };
  await joinServer({ ...joined, legacyMachineConfigPath });
  expect(fs.readFileSync(legacyMachineConfigPath, "utf8")).toBe(legacy);
  const logs: string[] = [];
  const run = async () => {
    const options = { dataDir, bbCliPath: "/opt/bb/bin/bb" };
    const adapters = [createEchoAdapter()];
    const log = (line: string) => void logs.push(line);
    const running = await runRunner({ ...options, adapters, log });
    onTestFinished(() => running.stop());
    return running;
  };
  onTestFinished(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connected = () => until(() => ctx.runners.isConnected(hostId));
  const row = () =>
    ctx.db.get<Record<string, unknown>>(
      "SELECT * FROM hosts WHERE id = ?",
      hostId,
    );
  const seen: { seq: number; types: string[] }[] = [];
  const gate = { hold: Promise.resolve() };
  ctx.runners.onEvent("thread.events", async (event, eventHostId) => {
    if (eventHostId !== hostId) return;
    seen.push({ seq: event.seq, types: event.events.map((e) => e.type) });
    await gate.hold;
  });
  const types = () => seen.flatMap((batch) => batch.types);
  const remote = () => ctx.runners.get(hostId);
  const tools = { run, connected, row, seen, gate, types, remote, logs };
  return { hostId, dataDir, relay, ...tools };
}

function expectConsecutive(seen: { seq: number }[]): void {
  const seqs = seen.map((batch) => batch.seq);
  expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
}

it("enrolls a machine and runs an echo turn over the socket", async () => {
  const server = await createTestServer();
  const machine = await enrollMachine(server);
  const file = join(machine.dataDir, "runner.json");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
    serverUrl: machine.relay.url,
    hostId: machine.hostId,
    headers: { "x-bb-connect-machine": "bbcm_legacy", "x-extra": "one=two" },
  });
  const running = await machine.run();
  await machine.connected();
  const info = await machine.remote().describe();
  expect(machine.row()).toMatchObject({
    phase: "active",
    platform: process.platform,
    lastInstanceId: info.instanceId,
    lastSeenAt: server.clock.now,
  });
  const started = await machine.remote().submitTurn(turn("thr_a", "hello"));
  expect(started).toMatchObject({ outcome: "started" });
  await until(() => machine.types().includes("turn/completed"));
  expectConsecutive(machine.seen);
  const lastSeq = machine.seen.at(-1)?.seq;
  await until(() => machine.row()?.lastEventSeq === lastSeq);

  const asAgent = async (method: string, path: string) =>
    (await fetch(`${running.cliProxyUrl}/api/v1${path}`, { method })).status;
  expect(await asAgent("GET", "/hosts")).toBe(200);
  expect(await asAgent("DELETE", `/hosts/${machine.hostId}`)).toBe(403);
  expect(server.ctx.runners.isConnected(machine.hostId)).toBe(true);
});

it("keeps a turn alive across a dropped socket without duplicates", async () => {
  const server = await createTestServer();
  const machine = await enrollMachine(server);
  await machine.run();
  await machine.connected();
  const { instanceId } = await machine.remote().describe();
  let release = (): void => {};
  const slow = "stream:12 pace:150 survive the gap";
  await machine.remote().submitTurn(turn("thr_gap", slow));
  await until(() => machine.types().includes("item/agentMessage/delta"));
  const acknowledgeable = machine.seen.length;
  machine.gate.hold = new Promise((resolve) => (release = resolve));
  await until(() => machine.seen.length > acknowledgeable);
  const deliveredBeforeDrop = machine.seen.length;
  const unanswered = machine.remote().snapshot();
  machine.relay.sever();
  const lost = { code: "unavailable", retryable: true };
  await expect(unanswered).rejects.toMatchObject(lost);
  await until(() => !server.ctx.runners.isConnected(machine.hostId));
  await machine.connected();
  expect(machine.row()?.lastEventSeq).toBeLessThan(deliveredBeforeDrop);
  const snapshot = await machine.remote().snapshot();
  expect(snapshot.sessions).toMatchObject([{ threadId: "thr_gap" }]);
  expect((await machine.remote().describe()).instanceId).toBe(instanceId);
  release();
  await until(() => machine.types().includes("turn/completed"));
  expect(machine.seen.length).toBeGreaterThan(deliveredBeforeDrop);
  expectConsecutive(machine.seen);
  const lastSeq = machine.seen.at(-1)?.seq;
  await until(() => machine.row()?.lastEventSeq === lastSeq);
});

it("sees a restarted runner as a new instance and replaces twins", async () => {
  const server = await createTestServer();
  const machine = await enrollMachine(server);
  const first = await machine.run();
  await machine.connected();
  const before = await machine.remote().describe();
  await machine.remote().submitTurn(turn("thr_held", "hold_turn"));
  await until(() => machine.types().includes("turn/started"));
  expect((await machine.remote().snapshot()).sessions).toHaveLength(1);
  await first.stop();
  await until(() => !server.ctx.runners.isConnected(machine.hostId));

  const second = await machine.run();
  await machine.connected();
  const after = await machine.remote().describe();
  expect(after.instanceId).not.toBe(before.instanceId);
  expect((await machine.remote().snapshot()).sessions).toEqual([]);
  const cursor = { lastInstanceId: after.instanceId, lastEventSeq: 0 };
  expect(machine.row()).toMatchObject(cursor);

  const twin = await machine.run();
  await second.stopped;
  await machine.connected();
  const winner = await until(() => machine.row()?.lastInstanceId);
  expect(winner).not.toBe(after.instanceId);
  await server.api.hosts[":id"].$delete({ param: { id: machine.hostId } });
  await twin.stopped;
  expect(machine.logs.join("\n")).toContain("replaced or removed");
});
