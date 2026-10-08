import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  environments as environmentKinds,
  machines as machineOps,
} from "@bb/plugin";
import type {
  CreateThreadRequest,
  UnmanagedBranchSpec,
} from "@bb/server-contract";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  getEnvironment,
  getEnvironmentResource,
  listEnvironments,
} from "@bb/server-kit/db/environments";
import { updateHost } from "@bb/server-kit/db/hosts";
import { getThread } from "@bb/server-kit/db/threads";
import { localRunnerFor } from "@bb/server-kit/runners/local";
import { createEchoAdapter } from "../../../plugins/provider-echo/runner/echo.js";
import * as helpers from "./helpers.js";
import { text } from "./thread-harness.js";

type Placement = CreateThreadRequest["environment"];

const SETUP = ".bb-env-setup.sh";
const TEARDOWN = ".bb-env-teardown.sh";
const GRACE_MS = 5 * 60_000;
const WAIT = { timeout: 15_000, interval: 20 };
const GIT_DIR = '"$(git rev-parse --git-common-dir)"';
const TITLE = "Build the widget";

async function createWorld(files: Record<string, string> = {}) {
  const server = await helpers.createTestServer({}, "echo");
  const { api, ctx } = server;
  const { db } = ctx;
  const { hostId } = ctx.config;
  const root = helpers.scratch();
  const repo = join(root, "repo");
  helpers.write(repo, { "README.md": "# demo\n", ...files });
  helpers.commitAll(repo);
  helpers.git(repo, "clone", "--quiet", "--bare", ".", "../origin.git");
  helpers.git(repo, "remote", "add", "origin", "../origin.git");
  helpers.git(repo, "fetch", "--quiet", "origin");
  const project = await helpers.createProject(server, "demo", repo);
  const spawn = async (environment: Placement, projectId = project.id) => {
    const input = text("cmd:pwd go");
    const request = { projectId, title: TITLE, input, environment };
    const origin = { origin: "app", providerId: "echo" } as const;
    const json = { ...request, ...origin, startedOnBehalfOf: null };
    return (await (await api.threads.$post({ json })).json()).id;
  };
  const reaches = (id: string, status: string) =>
    vi.waitFor(() => expect(getThread(db, id)?.status).toBe(status), WAIT);
  const environmentOf = (threadId: string) =>
    getEnvironment(db, getThread(db, threadId)?.environmentId ?? "");
  const stored = (threadId: string, type: string) =>
    db
      .all<{ data: string }>(
        `SELECT data FROM events WHERE thread_id = ? AND type = ?
         ORDER BY sequence`,
        threadId,
        type,
      )
      .map((event) => event.data);
  const say = (id: string, message: string) =>
    ctx.threads.send(id, { input: text(message), mode: "auto" });
  const baseBranch = { kind: "named", name: "origin/main" } as const;
  const workspace = { type: "managed-worktree", baseBranch } as const;
  const worktree = { type: "host", hostId, workspace } as const;
  const tools = { spawn, reaches, environmentOf, stored, say, worktree };
  return { ...server, db, hostId, root, repo, project, ...tools };
}

it("runs a worktree thread, shares, retires and restores its workspace", async () => {
  const world = await createWorld({
    [SETUP]: 'echo "setting up $(basename "$PWD")"\n',
    [TEARDOWN]: `touch ${GIT_DIR}/torn-down\n`,
    ".bb/AGENTS.md": "Use pnpm.\n",
  });
  const { clock, ctx, db, repo, reaches, spawn, stored } = world;
  const first = await spawn(world.worktree);
  await reaches(first, "idle");
  const path = join(ctx.config.dataDir, "worktrees", `${first}-1`, "repo");
  const branchName = `bb/build-the-widget-${first}`;
  const shape = { isWorktree: true, mergeBaseBranch: "origin/main" };
  const ready = { status: "ready", path, branchName, managed: true };
  expect(world.environmentOf(first)).toMatchObject({ ...ready, ...shape });
  const transcript = stored(first, "system/thread-provisioning").join("\n");
  const steps = ["Creating worktree", "Created worktree", `Running ${SETUP}`];
  const outcome = ["setting up repo", `${SETUP} finished`];
  const used = [`Using workspace: ${path}`, `Using branch: ${branchName}`];
  const shown = [...steps, ...outcome, ...used];
  expect(shown.filter((line) => !transcript.includes(line))).toEqual([]);
  expect(stored(first, "item/completed").join()).toContain(`"cwd":"${path}"`);
  const [{ id: environmentId }] = listEnvironments(db);
  const instructions = ctx.environments.workspaceInstructions(environmentId);
  expect(await instructions).toBe("Use pnpm.");

  const second = await spawn({ type: "reuse", environmentId });
  await reaches(second, "idle");
  expect(getThread(db, second)?.environmentId).toBe(environmentId);
  expect(listEnvironments(db)).toHaveLength(1);

  const found = () => getEnvironment(db, environmentId);
  const retiresAt = (at: number | null) =>
    vi.waitFor(() => expect(found()?.lifecycle.retireAt).toBe(at), WAIT);
  await ctx.threads.archive(first);
  await ctx.threads.archive(second);
  await retiresAt(clock.now + GRACE_MS);
  await ctx.threads.unarchive(second);
  await retiresAt(null);
  await ctx.threads.archive(second);
  await retiresAt(clock.now + GRACE_MS);
  clock.now += GRACE_MS;
  await ctx.environments.sweep();
  const removed = { phase: "destroyed", teardown: { status: "removed" } };
  expect(found()).toMatchObject({ status: "destroyed", lifecycle: removed });
  const tornDown = existsSync(join(repo, ".git/torn-down"));
  expect([existsSync(path), tornDown]).toEqual([false, true]);

  await ctx.threads.unarchive(first);
  await world.say(first, "cmd:pwd again");
  await reaches(first, "idle");
  expect(found()).toMatchObject(ready);
  expect(helpers.git(path, "branch", "--show-current")).toBe(branchName);
  expect(stored(first, "turn/completed")).toHaveLength(2);
  expect(stored(first, "client/thread/start")).toHaveLength(1);
});

it("fails the thread when the setup script fails and retries in place", async () => {
  const flaky = "test -f .retried || { touch .retried; echo boom; exit 3; }\n";
  const world = await createWorld({ [SETUP]: flaky });
  const { db, reaches, stored } = world;
  const id = await world.spawn({ type: "project-default" });
  await reaches(id, "error");
  const [failed] = listEnvironments(db);
  const kind = { environmentProviderId: "git-worktree" };
  const base = { mergeBaseBranch: "origin/main" };
  expect(failed).toMatchObject({ status: "error", ...kind, ...base });
  expect(getThread(db, id)?.environmentId).toBeNull();
  const detail = "Setup script failed with exit code 3";
  expect(stored(id, "system/error").join()).toContain(detail);
  const transcript = stored(id, "system/thread-provisioning").join("\n");
  expect(transcript).toContain('"text":"boom"');
  expect(transcript).toContain(`${SETUP} failed`);

  await world.say(id, "cmd:pwd retry");
  await reaches(id, "idle");
  const retried = { id: failed.id, status: "ready" };
  expect(world.environmentOf(id)).toMatchObject(retried);
  expect(listEnvironments(db)).toHaveLength(1);

  const path = world.environmentOf(id)?.path ?? "";
  const param = { id: world.project.id };
  await world.api.projects[":id"].$delete({ param });
  await vi.waitFor(() => expect(existsSync(path)).toBe(false), WAIT);
});

it("attaches checkouts and switches branch only when clean and unshared", async () => {
  const world = await createWorld();
  const { ctx, hostId, repo, reaches, spawn, stored } = world;
  const plain = join(world.root, "plain");
  mkdirSync(plain);
  const { id: plainProjectId } = await helpers.createProject(
    world,
    "plain",
    plain,
  );
  const loose = await spawn({ type: "project-default" }, plainProjectId);
  await reaches(loose, "idle");
  const unmanaged = { environmentProviderId: "project-checkout" };
  const folder = { path: plain, isGitRepo: false, managed: false };
  expect(world.environmentOf(loose)).toMatchObject({ ...unmanaged, ...folder });

  const checkout = (branch: UnmanagedBranchSpec) => {
    const workspace = { type: "unmanaged", path: repo, branch } as const;
    return spawn({ type: "host", hostId, workspace });
  };
  const topic = await checkout({ kind: "new", baseBranch: "main" });
  await reaches(topic, "idle");
  const branchName = `bb/build-the-widget-${topic}`;
  const current = () => helpers.git(repo, "branch", "--show-current");
  expect(current()).toBe(branchName);
  const switched = { path: repo, branchName, isGitRepo: true };
  expect(world.environmentOf(topic)).toMatchObject(switched);

  const main = { kind: "existing", name: "main" } as const;
  const shared = await checkout(main);
  await reaches(shared, "error");
  const busy = "another thread is using this workspace";
  expect(stored(shared, "system/error").join()).toContain(busy);
  await ctx.threads.archive(topic);
  helpers.write(repo, { "README.md": "# edited\n" });
  const dirty = await checkout(main);
  await reaches(dirty, "error");
  expect(stored(dirty, "system/error").join()).toContain("uncommitted changes");
  expect(current()).toBe(branchName);
});

it("gives personal threads a scratch workspace and removes it on request", async () => {
  const world = await createWorld();
  const { api, ctx, db } = world;
  const id = await world.spawn(
    { type: "project-default" },
    PERSONAL_PROJECT_ID,
  );
  await world.reaches(id, "idle");
  const path = join(ctx.config.dataDir, "workspaces", id);
  const personal = { environmentProviderId: "personal-workspace" };
  const scratch = { status: "ready", path, managed: true, isGitRepo: false };
  const [{ id: environmentId }] = listEnvironments(db);
  expect(world.environmentOf(id)).toMatchObject({ ...personal, ...scratch });
  expect(existsSync(path)).toBe(true);

  const remove = async (): Promise<number> => {
    const param = { id: environmentId };
    return (await api.environments[":id"].$delete({ param })).status;
  };
  expect(await remove()).toBe(409);
  await ctx.threads.archive(id);
  expect(await remove()).toBe(200);
  const left = [getEnvironment(db, environmentId)?.status, existsSync(path)];
  expect(left).toEqual(["destroyed", false]);
});

it("runs a thread in an environment kind a plugin contributed", async () => {
  const world = await createWorld();
  const { ctx, db, hostId, reaches, root } = world;
  const made: string[] = [];
  const removed: string[] = [];
  const plugin = ctx.kernel.scope("scratch-dirs", "installed");
  plugin.add(environmentKinds.kind, {
    id: "scratch-dir",
    displayName: "Scratch directory",
    async create({ thread, host, checkoutPath, branchName }) {
      const path = join(root, `scratch-${thread.id}`);
      mkdirSync(path);
      made.push(`${host.id} ${checkoutPath} ${branchName}`);
      return { path };
    },
    async delete({ path }) {
      rmSync(path, { recursive: true });
      removed.push(path);
    },
  });
  const listed = await world.api.system["environment-providers"].$get({
    query: { projectId: world.project.id },
  });
  const { providers } = await listed.json();
  expect(providers.map(({ id, pluginId }) => [id, pluginId])).toContainEqual([
    "scratch-dir",
    "scratch-dirs",
  ]);
  const machine = { type: "existing", hostId } as const;
  const kind = { environmentProviderId: "scratch-dir", machine };
  const id = await world.spawn({ type: "provider", ...kind, inputs: null });
  await reaches(id, "idle");
  const path = join(root, `scratch-${id}`);
  const ready = { status: "ready", path, managed: true };
  expect(world.environmentOf(id)).toMatchObject({
    ...ready,
    environmentProviderId: "scratch-dir",
  });
  expect(made).toEqual([`${hostId} ${world.repo} bb/build-the-widget-${id}`]);
  expect(world.stored(id, "item/completed").join()).toContain(path);
  const environmentId = getThread(db, id)?.environmentId ?? "";
  await ctx.threads.delete(id, { childThreadsConfirmed: true });
  await ctx.environments.remove(environmentId).catch(() => {});
  await vi.waitFor(() => expect(removed).toEqual([path]), WAIT);
  expect(existsSync(path)).toBe(false);
  const unknown = { ...kind, environmentProviderId: "nope" };
  const refused = await world.api.threads.$post({
    json: {
      projectId: world.project.id,
      input: text("hi"),
      environment: { type: "provider", ...unknown, inputs: null },
      origin: "app",
      providerId: "echo",
      startedOnBehalfOf: null,
    },
  });
  expect(refused.status).toBe(400);
});

it("lets a plugin replace a built-in environment kind", async () => {
  const world = await createWorld();
  const { ctx, reaches, root } = world;
  const plugin = ctx.kernel.scope("copy-on-write", "installed");
  plugin.add(environmentKinds.kind, {
    id: "git-worktree",
    displayName: "Copy-on-write clone",
    async create({ thread }) {
      const path = join(root, `cow-${thread.id}`);
      mkdirSync(path);
      return { path };
    },
    async delete({ path }) {
      rmSync(path, { recursive: true });
    },
  });
  const replaced = await world.spawn({ type: "project-default" });
  await reaches(replaced, "idle");
  expect(world.environmentOf(replaced)).toMatchObject({
    environmentProviderId: "git-worktree",
    path: join(root, `cow-${replaced}`),
    status: "ready",
  });
  plugin.dispose();
  const restored = await world.spawn(world.worktree);
  await reaches(restored, "idle");
  const builtin = join(
    ctx.config.dataDir,
    "worktrees",
    `${restored}-1`,
    "repo",
  );
  expect(world.environmentOf(restored)).toMatchObject({ path: builtin });
});

it("lets a plugin kind create its own machine, take inputs and keep state", async () => {
  const world = await createWorld();
  const { ctx, db, hostId, reaches, root } = world;
  const plugin = ctx.kernel.scope("sandboxes", "installed");
  const seen: string[] = [];
  plugin.on(machineOps.connected, ({ hostId: id }) => void seen.push(id));
  const lifecycle: string[] = [];
  plugin.add(machineOps.provider, {
    id: "sandbox",
    displayName: "Sandbox",
    suspend: ({ resource }) =>
      void lifecycle.push(`suspend ${String(resource)}`),
    resume: ({ resource }) => void lifecycle.push(`resume ${String(resource)}`),
  });
  const removed: unknown[] = [];
  plugin.add(environmentKinds.kind, {
    id: "sandbox",
    displayName: "Sandbox",
    validate: (inputs) =>
      (inputs as { size?: string } | null)?.size === "huge"
        ? "That size is not offered"
        : null,
    async create({ thread, inputs, resource, report }) {
      report("Starting a sandbox");
      const enrolled = await plugin.call(machineOps.enroll, {
        name: `Sandbox for ${thread.id}`,
        providerId: "sandbox",
        resource: "box-1",
      });
      expect(enrolled.command).toContain("bb runner join");
      updateHost(db, enrolled.hostId, { phase: "active" });
      const local = localRunnerFor(ctx.config, {
        adapters: [createEchoAdapter()],
      });
      onTestFinished(local.shutdown);
      const waiting = plugin.call(machineOps.waitConnected, {
        hostId: enrolled.hostId,
      });
      ctx.runners.connect(enrolled.hostId, local.connect);
      expect(await waiting).toBe(true);
      const path = join(root, `sandbox-${thread.id}`);
      mkdirSync(path);
      const kept = { inputs, previous: resource, box: "box-1" };
      return { path, hostId: enrolled.hostId, resource: kept };
    },
    async delete(target) {
      removed.push(target.resource);
      await plugin.call(machineOps.delete, { hostId: target.hostId });
    },
  });
  const machine = { type: "existing", hostId } as const;
  const kind = { environmentProviderId: "sandbox", machine };
  const huge = await world.api.threads.$post({
    json: {
      projectId: world.project.id,
      input: text("hi"),
      environment: { type: "provider", ...kind, inputs: { size: "huge" } },
      origin: "app",
      providerId: "echo",
      startedOnBehalfOf: null,
    },
  });
  expect(huge.status).toBe(400);
  const inputs = { size: "small" };
  const id = await world.spawn({ type: "provider", ...kind, inputs });
  await reaches(id, "idle");
  const environment = world.environmentOf(id);
  const sandboxHost = environment?.hostId ?? "";
  expect(sandboxHost).not.toBe(hostId);
  expect(seen).toEqual([sandboxHost]);
  expect(environment).toMatchObject({ status: "ready", managed: true });
  const stored = { inputs, previous: null, box: "box-1" };
  expect(getEnvironmentResource(db, environment?.id ?? "")).toEqual(stored);
  expect(world.stored(id, "system/thread-provisioning").join()).toContain(
    "Starting a sandbox",
  );
  const got = await plugin.call(environmentKinds.get, {
    environmentId: environment?.id ?? "",
  });
  expect(got?.hostId).toBe(sandboxHost);
  const hosts = await plugin.call(machineOps.list, {});
  const listed = hosts.find((host) => host.id === sandboxHost);
  expect(listed).toMatchObject({ machineProviderId: "sandbox" });
  await plugin.call(machineOps.suspend, { hostId: sandboxHost });
  const suspended = (await plugin.call(machineOps.list, {})).find(
    (host) => host.id === sandboxHost,
  );
  expect(suspended?.lifecycle.phase).toBe("suspended");
  await plugin.call(machineOps.resume, { hostId: sandboxHost });
  expect(lifecycle).toEqual(["suspend box-1", "resume box-1"]);
  await ctx.threads.delete(id, { childThreadsConfirmed: true });
  await ctx.environments.remove(environment?.id ?? "").catch(() => {});
  await vi.waitFor(() => expect(removed).toEqual([stored]), WAIT);
  const left = (await plugin.call(machineOps.list, {})).map((host) => host.id);
  expect(left).not.toContain(sandboxHost);
});
