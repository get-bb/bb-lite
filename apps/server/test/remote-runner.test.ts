import { once } from "node:events";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { joinServer, runRunner, type SubmitTurnArgs } from "@bb/runner";
import { createEchoAdapter } from "../../../plugins/provider-echo/runner/echo.js";
import { machines } from "@bb/plugin";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestServer, type TestServer } from "./helpers.js";

let turnCounter = 0;

async function until<T>(read: () => T) {
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
  const blank = { providerThreadId: null, instructions: "" };
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
  const run = async () => {
    const options = { dataDir, bbCliPath: "/opt/bb/bin/bb", log: () => {} };
    const adapters = [createEchoAdapter()];
    const running = await runRunner({ ...options, adapters });
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
  const tools = { run, connected, row, seen, gate, types, remote };
  return { hostId, dataDir, relay, ...tools };
}

function expectConsecutive(seen: { seq: number }[]) {
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
  await machine.run();
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
});

it("keeps a turn alive across a dropped socket without duplicates", async () => {
  const server = await createTestServer();
  const machine = await enrollMachine(server);
  await machine.run();
  await machine.connected();
  const { instanceId } = await machine.remote().describe();
  let release = () => {};
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

it("ships a plugin's runner part to a machine and calls it there", async () => {
  const server = await createTestServer();
  const { ctx } = server;
  const machine = await enrollMachine(server);
  await machine.run();
  await machine.connected();
  const fixture = new URL("./fixtures/machine-plugin", import.meta.url);
  const plugins = [{ path: fixture.pathname }];
  const configFile = join(ctx.config.dataDir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ plugins }));
  await ctx.plugins.reload();
  const providers = async () => {
    const listed = await machine.remote().listProviders();
    return listed.map(({ providerId }) => providerId);
  };
  const settled = async (wanted: string[]) => {
    for (const deadline = Date.now() + 10_000; ;) {
      const found = await providers();
      if (JSON.stringify(found) === JSON.stringify(wanted)) return found;
      if (Date.now() > deadline) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  expect(await settled(["echo", "probe"])).toEqual(["echo", "probe"]);
  const signals: unknown[] = [];
  const listener = ctx.kernel.scope("listener", "installed");
  listener.on(machines.signaled, (signal) => void signals.push(signal));
  const asked = await server.send("/ops/machine-probe.where", {
    hostId: machine.hostId,
  });
  await vi.waitFor(() =>
    expect(signals).toEqual([
      {
        hostId: machine.hostId,
        pluginId: "machine-probe",
        name: "summed",
        payload: { sum: 5 },
      },
    ]),
  );
  const cached = join(machine.dataDir, "plugins", "machine-probe");
  expect(await asked.json()).toEqual({
    ok: true,
    result: { dataDir: cached, sum: 5 },
  });
  await ctx.plugins.setEnabled("machine-probe", false);
  expect(await settled(["echo"])).toEqual(["echo"]);
  const gone = await server.send("/ops/machine-probe.where", {
    hostId: machine.hostId,
  });
  expect(gone.status).toBe(501);
});
