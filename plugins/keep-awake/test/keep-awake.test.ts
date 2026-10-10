import { EventEmitter } from "node:events";
import { createRunnerPlugins, type RunnerEvent } from "@bb/runner";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";
import { createKeepAwakeRunner } from "../runner.js";

type Sent = { name: string; input: { enabled: boolean } };

async function keepAwakeServer() {
  const server = await createTestServer();
  const hostId = server.ctx.config.hostId;
  const sent: boolean[] = [];
  server.runner.script.callOp = async (op) => {
    const { name, input } = op as Sent;
    if (name !== "keep-awake.updateMachine") return null;
    sent.push(input.enabled);
    return { enabled: input.enabled, supported: true };
  };
  const cli = async (...argv: string[]) => {
    const response = await server.send("/plugins/keep-awake/cli", { argv });
    return (await response.json()) as { exitCode: number; stdout: string };
  };
  return { ...server, hostId, sent, cli };
}

it("turns keep awake on and off on the machine from the CLI", async () => {
  const { cli, sent, hostId, send } = await keepAwakeServer();
  const last = (enabled: boolean) =>
    vi.waitFor(() => expect(sent.at(-1)).toBe(enabled));
  await vi.waitFor(() => expect(sent).toEqual([false]), { timeout: 5_000 });

  expect((await cli("enable")).stdout).toBe("Keep Awake enabled");
  await last(true);
  expect((await cli("status")).stdout).toBe("Enabled\nHosts: all");

  expect((await cli("hosts", "other-host")).stdout).toBe("other-host");
  await last(false);
  const mixed = await cli("hosts", "all", hostId);
  expect(mixed.exitCode).not.toBe(0);

  const response = await send("/ops/keep-awake.updateConfiguration", {
    enabled: true,
    selection: { mode: "selected", hostIds: [hostId, hostId] },
  });
  const { result } = (await response.json()) as {
    result: { selection: unknown; hosts: { id: string; status: string }[] };
  };
  expect(result.selection).toEqual({ mode: "selected", hostIds: [hostId] });
  expect(result.hosts).toContainEqual(
    expect.objectContaining({ id: hostId, status: "connected" }),
  );
  await last(true);
  expect(JSON.parse((await cli("disable", "--json")).stdout)).toEqual({
    enabled: false,
    selection: { mode: "selected", hostIds: [hostId] },
  });
});

class FakeChild extends EventEmitter {
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}

function machineRunner(platform: NodeJS.Platform) {
  const spawned: { command: string; args: string[]; child: FakeChild }[] = [];
  const signals: RunnerEvent[] = [];
  const runners = createRunnerPlugins({
    dataDir: scratch(),
    sink: (event) => void signals.push(event),
  });
  onTestFinished(() => runners.dispose());
  const entry = createKeepAwakeRunner({
    pid: 4242,
    platform,
    now: Date.now,
    spawn(command, args) {
      const child = new FakeChild();
      spawned.push({ command, args, child });
      return child;
    },
  });
  runners.load({ id: "keep-awake", entry });
  const update = (enabled: boolean) =>
    runners.callOp("keep-awake.updateMachine", { enabled });
  return { spawned, signals, update };
}

it("holds caffeinate on a Mac, restarts it and stops it", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const { spawned, signals, update } = machineRunner("darwin");
  expect(await update(true)).toEqual({ enabled: true, supported: true });
  expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
    ["/usr/bin/caffeinate", "-i", "-w", "4242"],
  ]);
  expect(await update(true)).toEqual({ enabled: true, supported: true });
  expect(spawned).toHaveLength(1);

  spawned[0]?.child.emit("exit");
  expect(signals).toContainEqual(
    expect.objectContaining({ pluginId: "keep-awake", name: "exited" }),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(spawned).toHaveLength(2);

  expect(await update(false)).toEqual({ enabled: false, supported: true });
  expect(spawned[1]?.child.killed).toEqual(["SIGTERM"]);
});

it("does nothing on a machine that is not macOS or Windows", async () => {
  const { spawned, update } = machineRunner("linux");
  expect(await update(true)).toEqual({ enabled: false, supported: false });
  expect(spawned).toEqual([]);
  const windows = machineRunner("win32");
  await windows.update(true);
  expect(windows.spawned[0]?.command).toBe("powershell.exe");
  expect(windows.spawned[0]?.args.at(-1)).toContain("Wait-Process -Id 4242");
});
