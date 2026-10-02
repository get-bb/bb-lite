import type { Environment } from "@bb/domain";
import type { z } from "zod";
import type { ServerContext, ServerRunner } from "../context.js";
import * as store from "../db/environments.js";
import { getProjectSource, type DeletedProject } from "../db/projects.js";
import { getAppSettings } from "../db/settings.js";
import { getThread, type ThreadRow } from "../db/threads.js";
import {
  checkoutInputsSchema,
  worktreeInputsSchema,
} from "../providers/environment-providers.js";
import { closeTerminalsFor } from "../terminals/sessions.js";
import { errorMessage } from "../http/errors.js";
import { ThreadSerial } from "../threads/core.js";
import { createLifecycleScripts, notReady, step } from "./scripts.js";
import type {
  EnsureEnvironmentArgs as Job,
  ThreadEnvironment,
} from "./types.js";
import { requireEnvironment } from "./workspace.js";

type CheckoutInputs = z.infer<typeof checkoutInputsSchema>;
type CheckoutBranch = NonNullable<CheckoutInputs["branch"]>;

const RETIRE_GRACE_MS = 5 * 60_000;
const TEARDOWN_RETRY_MS = 60_000;
const MAX_TEARDOWN_ATTEMPTS = 5;
const SWEEP_INTERVAL_MS = 10_000;
const BRANCH_SLUG_MAX_LENGTH = 48;
const INSTRUCTIONS_FILE = ".bb/AGENTS.md";
const INSTRUCTIONS_MAX_LENGTH = 32_000;
const AT_PATH = "e.project_id = ? AND e.host_id = ? AND e.path = ?";
const OWNED_BY = "e.owner_thread_id = ?";
const IN_USE = {
  retireAt: null,
  teardownStatus: null,
  teardownAttempt: 0,
  teardownMessage: null,
} as const;
const NO_CHECKOUT = "This project has no checkout on the chosen machine.";
const SHARED_CHECKOUT =
  "Cannot checkout branch while another thread is using this workspace";

export function managedBranchName(prefix: string, thread: ThreadRow): string {
  const slug = (thread.title ?? thread.titleFallback ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-/u, "")
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(/-$/u, "");
  return slug === "" ? prefix + thread.id : `${prefix}${slug}-${thread.id}`;
}

export type Environments = ReturnType<typeof createEnvironments>;

export function createEnvironments(ctx: ServerContext) {
  const { db, hub, log, now, runners } = ctx;
  const scripts = createLifecycleScripts(ctx);
  const queue = new ThreadSerial();
  const retiring = new Set<string>();

  function patch(id: string, changes: store.EnvironmentPatch): Environment {
    store.updateEnvironment(db, id, changes);
    const moved = changes.status !== undefined;
    hub.environment(id, [moved ? "status-changed" : "metadata-changed"]);
    return requireEnvironment(ctx, id);
  }

  function create(input: store.NewEnvironment): Environment {
    const id = store.insertEnvironment(db, input);
    hub.environment(id, ["environment-created"]);
    return requireEnvironment(ctx, id);
  }

  function discard(id: string) {
    db.run("DELETE FROM environments WHERE id = ?", id);
    hub.environment(id, ["environment-deleted"]);
  }

  function sourcePathOf(projectId: string, hostId: string) {
    const source = getProjectSource(db, projectId, { hostId });
    if (source !== undefined) return source.path;
    throw notReady(NO_CHECKOUT);
  }

  function branchNameFor(thread: ThreadRow) {
    return managedBranchName(getAppSettings(db).managedBranchPrefix, thread);
  }

  async function addWorktree(
    found: Environment,
    runner: ServerRunner,
    job: Job,
    base: string | null,
  ) {
    const { onProgress, thread } = job;
    const sourcePath = sourcePathOf(found.projectId, found.hostId);
    const branchName = found.branchName ?? branchNameFor(thread);
    if (found.branchName !== null) {
      const selectedBranch = branchName;
      const query = { path: sourcePath, selectedBranch, limit: 1 };
      const kept = (await runner.listBranches(query)).selectedBranch;
      if (kept?.kind !== "local") {
        const gone = `Branch ${branchName} no longer exists`;
        throw notReady(`${gone}, so its worktree cannot be restored.`);
      }
    }
    const startedAt = now();
    const creating = "Creating worktree";
    onProgress([step("git-worktree-started", creating, "started", startedAt)]);
    const key = found.environmentProviderInstanceKey ?? found.id;
    const baseBranch = found.mergeBaseBranch ?? base;
    const worktree = { sourcePath, key, branchName, baseBranch };
    const made = await runner.createWorktree(worktree);
    const created = "Created worktree";
    const done = "completed";
    const entries = [step("git-worktree-completed", created, done, startedAt)];
    if (made.worktreeInclude !== null) {
      const { copied, skipped } = made.worktreeInclude;
      const kept = skipped === 0 ? "" : `, skipped ${skipped}`;
      const text = `Copied ${copied} file(s) from .worktreeinclude${kept}`;
      entries.push(step("worktree-include-completed", text, done, now()));
    }
    onProgress(entries);
    patch(found.id, { branchName, mergeBaseBranch: made.mergeBaseBranch });
    return made.path;
  }

  async function materialize(
    found: Environment,
    runner: ServerRunner,
    job: Job,
    base: string | null,
  ) {
    const { id, hostId, projectId } = found;
    job.signal.throwIfAborted();
    patch(id, { status: "creating", statusMessage: null, ...IN_USE });
    const key = found.environmentProviderInstanceKey ?? id;
    const path =
      found.environmentProviderId === "git-worktree"
        ? await addWorktree(found, runner, job, base)
        : (await runner.ensurePersonalWorkspace({ key })).path;
    patch(id, { path, status: "provisioning" });
    job.signal.throwIfAborted();
    await scripts.setup({ id, hostId, projectId, path }, job);
    return path;
  }

  async function attach(found: Environment, runner: ServerRunner) {
    const { id, path } = found;
    if (path === null) throw notReady("Environment has no workspace.");
    const { exists, ...inspected } = await runner.inspectPath({ path });
    if (!exists) throw notReady(`Directory does not exist: ${path}`);
    const { branchName, defaultBranch, isGitRepo, isWorktree } = inspected;
    const observed = { branchName, defaultBranch, isGitRepo, isWorktree };
    patch(id, { ...observed, statusMessage: null, ...IN_USE });
    return path;
  }

  function prepare(
    target: Environment,
    job: Job,
    base: string | null = null,
  ): Promise<ThreadEnvironment> {
    const { id: environmentId } = target;
    return queue.run(environmentId, async () => {
      const found = requireEnvironment(ctx, environmentId);
      const runner = runners.get(found.hostId);
      if (found.status === "ready" && found.path !== null) {
        if (found.lifecycle.retireAt !== null) patch(environmentId, IN_USE);
        return { environmentId, path: found.path };
      }
      try {
        const path = found.managed
          ? await materialize(found, runner, job, base)
          : await attach(found, runner);
        patch(environmentId, { status: "ready" });
        return { environmentId, path };
      } catch (error) {
        const statusMessage = job.signal.aborted
          ? "Workspace setup was cancelled"
          : errorMessage(error);
        patch(environmentId, { status: "error", statusMessage });
        throw error;
      }
    });
  }

  async function switchBranch(
    { environmentId, path }: ThreadEnvironment,
    hostId: string,
    thread: ThreadRow,
    branch: CheckoutBranch,
  ) {
    if (store.hasOtherLiveThread(db, environmentId, thread.id)) {
      throw notReady(SHARED_CHECKOUT);
    }
    const wanted =
      branch.kind === "existing"
        ? { branchName: branch.name, createFrom: null }
        : { branchName: branchNameFor(thread), createFrom: branch.baseBranch };
    const runner = runners.get(hostId);
    const { branchName } = await runner.switchBranch({ path, ...wanted });
    patch(environmentId, { branchName });
  }

  async function attachCheckout(
    job: Job,
    hostId: string,
    inputs: CheckoutInputs,
  ): Promise<ThreadEnvironment> {
    const { thread } = job;
    const { projectId } = thread;
    const path = inputs.path ?? sourcePathOf(projectId, hostId);
    const environmentProviderId = "project-checkout";
    const unowned = { ownerThreadId: null, instanceKey: null };
    const fresh = {
      projectId,
      hostId,
      path,
      environmentProviderId,
      ...unowned,
    };
    const existing = store.findEnvironment(
      db,
      AT_PATH,
      projectId,
      hostId,
      path,
    );
    const target = existing ?? create(fresh);
    const prepared = await prepare(target, job).catch((error: unknown) => {
      if (existing === undefined) discard(target.id);
      throw error;
    });
    const { branch } = inputs;
    if (branch === undefined || target.managed) return prepared;
    await queue.run(target.id, () =>
      switchBranch(prepared, hostId, thread, branch),
    );
    return prepared;
  }

  async function defaultKind(projectId: string, hostId: string) {
    const path = sourcePathOf(projectId, hostId);
    const source = await runners.get(hostId).inspectGitSource({ path });
    const base = source.defaultBranch ?? source.originDefaultBranch;
    return base === null ? "project-checkout" : "git-worktree";
  }

  async function ensureForThread(job: Job): Promise<ThreadEnvironment> {
    const { intent, thread } = job;
    if (intent.type === "reuse") {
      return prepare(requireEnvironment(ctx, intent.environmentId), job);
    }
    const { hostId } = intent;
    const { id: ownerThreadId, projectId } = thread;
    const provided = intent.type === "provider";
    const inputs = provided ? intent.inputs : null;
    const environmentProviderId = provided
      ? intent.environmentProviderId
      : await defaultKind(projectId, hostId);
    if (environmentProviderId === "project-checkout") {
      const checkout = checkoutInputsSchema.parse(inputs ?? {});
      return attachCheckout(job, hostId, checkout);
    }
    const worktree =
      environmentProviderId === "git-worktree"
        ? worktreeInputsSchema.parse(inputs ?? undefined)
        : null;
    if (worktree !== null && "kind" in worktree) {
      return attachCheckout(job, hostId, { path: worktree.path });
    }
    const personal = worktree === null;
    const instanceKey = personal ? ownerThreadId : `${ownerThreadId}-1`;
    const owned = { ownerThreadId, instanceKey, path: null };
    const fresh = { projectId, hostId, environmentProviderId, ...owned };
    const target =
      store.findEnvironment(db, OWNED_BY, ownerThreadId) ?? create(fresh);
    const branch = worktree?.branch;
    return prepare(target, job, branch?.kind === "named" ? branch.name : null);
  }

  function refresh(found: Environment): Environment {
    const { retireAt, teardown } = found.lifecycle;
    if (store.environmentUse(db, found.id).live > 0) {
      const unmarked = retireAt === null && teardown === null;
      return unmarked ? found : patch(found.id, IN_USE);
    }
    if (retireAt !== null || teardown?.status === "failed") return found;
    return patch(found.id, { retireAt: now() + RETIRE_GRACE_MS });
  }

  function due({ hostId, lifecycle }: Environment) {
    const { retireAt } = lifecycle;
    const expired = retireAt !== null && retireAt <= now();
    return expired && runners.isConnected(hostId);
  }

  async function teardown(id: string, forced: boolean) {
    const found = store.getEnvironment(db, id);
    if (found === undefined || found.status === "destroyed") return;
    if (!forced && !due(refresh(found))) return;
    const { hostId, path, projectId } = found;
    const teardownAttempt = (found.lifecycle.teardown?.attempt ?? 0) + 1;
    const running = { teardownStatus: "running", teardownAttempt } as const;
    patch(id, { status: "error", teardownMessage: null, ...running });
    closeTerminalsFor(ctx, "environment_id", id, "environment-destroyed");
    try {
      if (found.managed && path !== null) {
        await scripts.teardown({ id, hostId, projectId, path });
        await runners.get(hostId).removeWorktree({ path });
      }
      const removed = { teardownStatus: "removed", retireAt: null } as const;
      patch(id, { status: "destroyed", ...removed });
    } catch (error) {
      const retries = teardownAttempt < MAX_TEARDOWN_ATTEMPTS;
      const retireAt = retries ? now() + TEARDOWN_RETRY_MS : null;
      const teardownMessage = errorMessage(error);
      patch(id, { teardownStatus: "failed", teardownMessage, retireAt });
      if (forced) throw error;
      log.warn("Environment teardown failed", { err: error, id });
    }
  }

  async function sweep() {
    const removals = store.listRetirableEnvironmentIds(db).flatMap((id) => {
      const found = store.getEnvironment(db, id);
      const idle = found !== undefined && !retiring.has(id);
      if (!idle || !due(refresh(found))) return [];
      retiring.add(id);
      const removal = queue.run(id, () => teardown(id, false));
      return [removal.finally(() => retiring.delete(id))];
    });
    await Promise.all(removals);
  }

  function sweepSoon() {
    sweep().catch((err: unknown) => {
      log.error("Environment sweep failed", { err });
    });
  }

  function onThreadDetached(threadId: string) {
    const thread = getThread(db, threadId);
    const attachedId = thread?.environmentId ?? null;
    const found =
      attachedId === null
        ? store.findEnvironment(db, OWNED_BY, threadId)
        : store.getEnvironment(db, attachedId);
    const orphaned =
      found?.managed === true &&
      found.status !== "destroyed" &&
      thread?.deletedAt != null &&
      store.environmentUse(db, found.id).attached === 0;
    if (orphaned) patch(found.id, { retireAt: now() });
    setImmediate(sweepSoon);
  }

  async function remove(environmentId: string) {
    await queue.run(environmentId, () => teardown(environmentId, true));
    const attached = "SELECT 1 FROM threads WHERE environment_id = ?";
    if (db.get(attached, environmentId) === undefined) discard(environmentId);
  }

  async function workspaceInstructions(environmentId: string) {
    const found = store.getEnvironment(db, environmentId);
    if (found === undefined || found.path === null) return null;
    const file = { path: INSTRUCTIONS_FILE, rootPath: found.path };
    try {
      const read = await runners.get(found.hostId).readFile(file);
      if ("notModified" in read || read.contentEncoding !== "utf8") return null;
      return read.content.trim().slice(0, INSTRUCTIONS_MAX_LENGTH) || null;
    } catch {
      return null;
    }
  }

  function start() {
    const timer = setInterval(sweepSoon, SWEEP_INTERVAL_MS);
    timer.unref();
    const unsubscribe = runners.onConnected(sweepSoon);
    sweepSoon();
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }

  return {
    ensureForThread,
    pathFor: (id: string) => store.getEnvironment(db, id)?.path ?? null,
    workspaceInstructions,
    onThreadDetached,
    remove,
    sweep,
    start,
  };
}

export async function removeProjectWorkspaces(
  { log, runners }: ServerContext,
  { environments }: DeletedProject,
): Promise<void> {
  for (const { hostId, path, providerOwnsPath } of environments) {
    const removable = providerOwnsPath === 1 && runners.isConnected(hostId);
    if (path === null || !removable) continue;
    const removed = runners.get(hostId).removeWorktree({ path });
    await removed.catch((err: unknown) => {
      log.warn("Could not remove a deleted project's workspace", { err, path });
    });
  }
}
