import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
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
import { parseDockerfile } from "../modal-client.js";

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
  const images: { appName: string; dockerfile: string }[] = [];
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
    async ensureImage({ appName, dockerfile, log }) {
      images.push({ appName, dockerfile });
      log?.("Step 1/1 : RUN true");
      if (dockerfile.includes("broken")) throw new Error("build failed");
      return "im-standard";
    },
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
  return {
    server,
    scope,
    log,
    created,
    running,
    images,
    home,
    plugin,
    configure,
  };
}

it("needs configuration until the Modal token is set", async () => {
  const { scope, plugin, configure } = await modalWorld();
  expect(await plugin()).toMatchObject({ status: "needs-configuration" });
  expect(await scope.call(modal.account, {})).toEqual({
    available: false,
    message: "Set tokenId and tokenSecret in the plugin's settings.",
  });
  const inspect = modal.account.doors.cli;
  const missing = { available: false, message: "" };
  expect(inspect?.exitCode?.(missing, {})).toBe(1);
  expect(inspect?.exitCode?.({ ...missing, available: true }, {})).toBe(0);
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

async function startThread(server: helpers.TestServer) {
  const repo = join(helpers.scratch(), "repo");
  helpers.write(repo, { "README.md": "# demo\n" });
  helpers.commitAll(repo);
  const project = await helpers.createProject(server, "demo", repo);
  const machine = { type: "existing", hostId: server.ctx.config.hostId };
  const response = await server.api.threads.$post({
    json: {
      projectId: project.id,
      input: text("hi"),
      environment: {
        type: "provider",
        environmentProviderId: "modal-sandbox",
        machine: { ...machine, type: "existing" },
        inputs: {},
      },
      origin: "app",
      providerId: "echo",
      startedOnBehalfOf: null,
    },
  });
  const { id } = await response.json();
  await vi.waitFor(
    () => expect(getThread(server.ctx.db, id)?.status).toBe("idle"),
    WAIT,
  );
  const environmentId = getThread(server.ctx.db, id)?.environmentId ?? "";
  return getEnvironment(server.ctx.db, environmentId)?.hostId ?? "";
}

it("builds the image and runs, execs in and stops a debug sandbox", async () => {
  const { server, scope, created, images, home, configure } =
    await modalWorld();
  await configure();
  expect(await scope.call(modal.createImage, {})).toEqual({
    imageId: "im-standard",
    logs: "Step 1/1 : RUN true\n",
  });
  const { dockerfile } = await scope.call(modal.image, {});
  expect(images).toEqual([{ appName: "bb-sandboxes", dockerfile }]);
  writeFileSync(join(home, "Dockerfile"), "FROM broken:1\nRUN true\n");
  const set = await server.send(`/plugins/${PLUGIN}/cli`, {
    argv: ["image", "set", "--file", "Dockerfile"],
    cwd: home,
  });
  expect(await set.json()).toMatchObject({ exitCode: 0 });
  await expect(scope.call(modal.createImage, {})).rejects.toThrow(
    "Step 1/1 : RUN true\nbuild failed",
  );
  expect(images.at(-1)?.dockerfile).toBe("FROM broken:1\nRUN true\n");
  writeFileSync(join(home, "Dockerfile"), dockerfile);
  const reset = await server.send(`/plugins/${PLUGIN}/cli`, {
    argv: ["image", "set", "--file", "Dockerfile"],
    cwd: home,
  });
  expect(await reset.json()).toMatchObject({ exitCode: 0 });
  const run = await scope.call(modal.createSandbox, {});
  expect(run).toMatchObject({ sandboxId: "sb-1", imageId: "im-standard" });
  expect(created[0]?.tags).toMatchObject({ bbDebug: "true" });
  const command = ["sh", "-lc", "echo hi"];
  expect(
    await scope.call(modal.createSandboxCommand, {
      sandboxId: "sb-1",
      command,
    }),
  ).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  expect(await scope.call(modal.deleteSandbox, { sandboxId: "sb-1" })).toEqual({
    sandboxId: "sb-1",
  });
  await expect(
    scope.call(modal.createSandboxCommand, { sandboxId: "sb-1", command }),
  ).rejects.toThrow("Debug sandbox has stopped or expired");
});

it("reads image set --file from the CLI's directory and exits with exec's code", async () => {
  const { server, scope, home } = await modalWorld();
  writeFileSync(join(home, "Dockerfile"), "FROM alpine:3\nRUN true\n");
  const response = await server.send(`/plugins/${PLUGIN}/cli`, {
    argv: ["image", "set", "--file", "Dockerfile"],
    cwd: home,
  });
  const set: unknown = JSON.parse((await response.text()).trim());
  expect(set).toMatchObject({ exitCode: 0 });
  expect(await scope.call(modal.image, {})).toEqual({
    dockerfile: "FROM alpine:3\nRUN true\n",
    customized: true,
  });
  const door = modal.createSandboxCommand.doors.cli;
  const failed = { exitCode: 3, stdout: "", stderr: "no\n" };
  const input = { sandboxId: "sb-1", command: ["false"] };
  expect(door?.exitCode?.(failed, input)).toBe(3);
  expect(door?.print?.(failed, input)).toBe("no\nExit code 3\n");
});

it("terminates a sandbox left running after its machine was suspended", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1, 0, 0, 59) });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { server, scope, log, running, configure } = await modalWorld();
  await configure();
  const hostId = await startThread(server);
  await scope.call(machines.suspend, { hostId });
  running.add("sb-1");
  await vi.waitFor(
    () =>
      expect(log.filter((line) => line === "terminate sb-1")).toHaveLength(2),
    WAIT,
  );
});

it("reads a Dockerfile as a registry image and build commands", () => {
  const dockerfile =
    "FROM node:22\n# note\nRUN apt-get update \\\n  && true\nUSER node\n";
  expect(parseDockerfile(dockerfile)).toMatchObject({
    reference: "node:22",
    commands: ["RUN apt-get update    && true", "USER node"],
  });
  expect(() => parseDockerfile("FROM a\nCOPY . .")).toThrow(
    "requires one FROM",
  );
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
