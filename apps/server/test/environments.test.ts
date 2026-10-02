import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type {
  CreateThreadRequest,
  UnmanagedBranchSpec,
} from "@bb/server-contract";
import { expect, it, vi } from "vitest";
import { getEnvironment, listEnvironments } from "../src/db/environments.js";
import { getThread } from "../src/db/threads.js";
import * as helpers from "./helpers.js";
import { createThreadServer, text } from "./thread-harness.js";

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
    const unforked = { startedOnBehalfOf: null, originKind: null };
    const json = { ...request, ...origin, ...unforked };
    return (await (await api.threads.$post({ json })).json()).id;
  };
  const reaches = (id: string, status: string): Promise<void> =>
    vi.waitFor(() => expect(getThread(db, id)?.status).toBe(status), WAIT);
  const environmentOf = (threadId: string) =>
    getEnvironment(db, getThread(db, threadId)?.environmentId ?? "");
  const stored = (threadId: string, type: string): string[] =>
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

it("cancels a running setup script on stop and removes the worktree on delete", async () => {
  const slow = `echo $$ > ${GIT_DIR}/setup.pid\nsleep 60\n`;
  const world = await createWorld({ [SETUP]: slow });
  const { ctx, db, repo } = world;
  const id = await world.spawn(world.worktree);
  const pid = await vi.waitFor(() => {
    const written = readFileSync(join(repo, ".git/setup.pid"), "utf8");
    expect(Number(written)).toBeGreaterThan(0);
    return Number(written);
  }, WAIT);
  await ctx.threads.stop(id);
  expect(getThread(db, id)?.status).toBe("idle");
  const [owned] = listEnvironments(db);
  const status = () => getEnvironment(db, owned.id)?.status;
  await vi.waitFor(() => expect(status()).toBe("error"), WAIT);
  expect(() => process.kill(pid, 0)).toThrow();
  const path = getEnvironment(db, owned.id)?.path ?? "";
  expect(existsSync(join(path, "README.md"))).toBe(true);

  await ctx.threads.delete(id, { childThreadsConfirmed: true });
  await vi.waitFor(() => expect(status()).toBe("destroyed"), WAIT);
  expect(existsSync(path)).toBe(false);
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
  const current = (): string => helpers.git(repo, "branch", "--show-current");
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

it("waits for the machine, then retries a failing teardown a bounded number of times", async () => {
  const server = await createThreadServer();
  const { ctx, hostId, runner } = server;
  const baseBranch = { kind: "default" } as const;
  const workspace = { type: "managed-worktree", baseBranch } as const;
  const environment = { type: "host", hostId, workspace } as const;
  const id = await server.spawn({ environment });
  const environmentId = server.thread(id).environmentId ?? "";
  const lifecycle = () => getEnvironment(ctx.db, environmentId)?.lifecycle;
  ctx.runners.disconnect(hostId);
  await ctx.threads.delete(id, { childThreadsConfirmed: true });
  await ctx.environments.sweep();
  expect(lifecycle()).toMatchObject({ phase: "retiring", teardown: null });

  await server.reconnect();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failed = { status: "failed", attempt };
    await vi.waitFor(() => expect(lifecycle()?.teardown).toMatchObject(failed));
    server.clock.now += 60_000;
    await ctx.environments.sweep();
  }
  const abandoned = { retireAt: null, teardown: { attempt: 5 } };
  expect(lifecycle()).toMatchObject(abandoned);
  const skipped = { ran: false, exitCode: null, failure: null };
  const working = { runLifecycleScript: async () => skipped };
  Object.assign(runner.script, working, { removeWorktree: async () => {} });
  const removed = await server.http("DELETE", `/environments/${environmentId}`);
  expect(removed.status).toBe(200);
  expect(getEnvironment(ctx.db, environmentId)).toBeUndefined();
});
