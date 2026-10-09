import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { machines } from "@bb/plugin";
import { expect, it, onTestFinished, vi } from "vitest";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { updateHost } from "@bb/server-kit/db/hosts";
import { getThread } from "@bb/server-kit/db/threads";
import { localRunnerFor } from "@bb/server-kit/runners/local";
import { createEchoAdapter } from "../../provider-echo/runner/echo.js";
import * as helpers from "../../../apps/server/test/helpers.js";
import { text } from "../../../apps/server/test/thread-harness.js";
import { modal } from "../contract.js";
import type { ModalClient, ModalSandboxSpec } from "../modal-api.js";

const WAIT = { timeout: 10_000 };
const PLUGIN = "environment-modal-sandbox";

async function modalWorld() {
  const server = await helpers.createTestServer({}, "echo");
  const { ctx } = server;
  const scope = ctx.kernel.scope("fake-modal", "installed");
  const home = helpers.scratch();
  const log: string[] = [];
  const created: ModalSandboxSpec[] = [];
  const running = new Set<string>();
  const joinPendingHost = async () => {
    const hosts = ctx.db.all<{ id: string }>(
      "SELECT id FROM hosts WHERE machine_provider_id = 'modal-sandbox'",
    );
    const host = hosts.find((entry) => !ctx.runners.isConnected(entry.id));
    if (host === undefined) throw new Error("no machine waits to join");
    updateHost(ctx.db, host.id, { phase: "active" });
    const local = localRunnerFor(ctx.config, {
      adapters: [createEchoAdapter()],
    });
    onTestFinished(local.shutdown);
    ctx.runners.connect(host.id, local.connect);
  };
  const client: ModalClient = {
    accountIdentity: async () => "workspace-1",
    ensureImage: async () => "im-standard",
    async create(spec) {
      created.push(spec);
      const id = `sb-${created.length}`;
      running.add(id);
      log.push(`create ${id} from ${spec.imageId}`);
      return id;
    },
    running: async (id) => running.has(id),
    async exec(id, command) {
      const script = command.at(-1) ?? "";
      if (script.startsWith("nohup ")) {
        log.push(`join ${id}`);
        await joinPendingHost();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const env = { ...process.env, HOME: home };
      const { stdout } = await promisify(exec)(script, { env });
      return { exitCode: 0, stdout, stderr: "" };
    },
    async snapshot(id) {
      log.push(`snapshot ${id}`);
      return `im-snap-${id}`;
    },
    async terminate(id) {
      running.delete(id);
      log.push(`terminate ${id}`);
    },
    async deleteSnapshot(imageId) {
      log.push(`delete ${imageId}`);
    },
  };
  scope.add(modal.api, { connect: () => client });
  const plugin = async () => {
    const all = await server.read<{
      plugins: { id: string; status: string }[];
    }>("/plugins");
    return all.plugins.find((entry) => entry.id === PLUGIN);
  };
  const configure = () =>
    server.send(
      `/plugins/${PLUGIN}/settings`,
      { values: { tokenId: "ak-1", tokenSecret: "as-1" } },
      "PUT",
    );
  return { server, scope, log, created, home, plugin, configure };
}

it("needs configuration until the Modal token is set", async () => {
  const { scope, plugin, configure } = await modalWorld();
  expect(await plugin()).toMatchObject({ status: "needs-configuration" });
  expect(await scope.call(modal.account, {})).toEqual({
    available: false,
    message: "Set tokenId and tokenSecret in the plugin's settings.",
  });
  expect((await configure()).status).toBe(200);
  await vi.waitFor(
    async () => expect(await plugin()).toMatchObject({ status: "running" }),
    WAIT,
  );
  expect(await scope.call(modal.account, {})).toEqual({
    available: true,
    message: "Connected to Modal (bb-sandboxes)",
  });
});

it("runs a thread in a Modal sandbox and snapshots, restores and deletes it", async () => {
  const { server, scope, log, created, home, configure } = await modalWorld();
  const { ctx } = server;
  await configure();
  await scope.call(modal.updateLaunchOptions, {
    presets: [{ name: "Large", cpu: 4, memoryMiB: 8192 }],
    images: [
      { name: "Default", source: "dockerfile", dockerfile: "FROM node" },
    ],
  });
  const repo = join(helpers.scratch(), "repo");
  helpers.write(repo, { "README.md": "# demo\n" });
  helpers.commitAll(repo);
  const project = await helpers.createProject(server, "demo", repo);
  const machine = { type: "existing", hostId: ctx.config.hostId } as const;
  const environment = {
    type: "provider",
    environmentProviderId: "modal-sandbox",
    machine,
    inputs: { preset: "Large" },
  } as const;
  const response = await server.api.threads.$post({
    json: {
      projectId: project.id,
      input: text("hi"),
      environment,
      origin: "app",
      providerId: "echo",
      startedOnBehalfOf: null,
    },
  });
  const { id } = await response.json();
  await vi.waitFor(
    () => expect(getThread(ctx.db, id)?.status).toBe("idle"),
    WAIT,
  );
  const placed = getEnvironment(
    ctx.db,
    getThread(ctx.db, id)?.environmentId ?? "",
  );
  const hostId = placed?.hostId ?? "";
  expect(placed?.path).toBe(join(home, "workspace"));
  expect(created[0]).toMatchObject({ cpu: 4, memoryMiB: 8192 });
  const inspected = await scope.call(modal.machine, { hostId });
  expect(inspected.summary).toContain("Sandbox: sb-1 (running)");

  await scope.call(machines.suspend, { hostId });
  expect((await scope.call(modal.machine, { hostId })).resource).toMatchObject({
    sandboxId: null,
    snapshotImageId: "im-snap-sb-1",
  });
  ctx.runners.disconnect(hostId);
  await scope.call(machines.resume, { hostId });
  await ctx.threads.delete(id, { childThreadsConfirmed: true });
  await vi.waitFor(
    () =>
      expect(log).toEqual([
        "create sb-1 from im-standard",
        "join sb-1",
        "snapshot sb-1",
        "terminate sb-1",
        "create sb-2 from im-snap-sb-1",
        "join sb-2",
        "terminate sb-2",
        "delete im-snap-sb-1",
      ]),
    WAIT,
  );
});
