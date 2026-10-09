import { git, machineFiles } from "@bb/runner";
import { randomUUID } from "node:crypto";
import type { Environment } from "@bb/domain";
import {
  environments as environmentKinds,
  type EnvironmentBranch,
  type EnvironmentDefinition,
  type EnvironmentPlacement,
  threads,
} from "@bb/plugin";
import type { EnvironmentContext, PluginServerApi } from "@bb/plugin";
import type { ServerRunner } from "@bb/server-kit/context";
import * as store from "@bb/server-kit/db/environments";
import { findHost } from "@bb/server-kit/db/hosts";
import { getProjectSource, requireProject } from "@bb/server-kit/db/projects";
import { getAppSettings } from "@bb/server-kit/db/settings";
import { getThread, type ThreadRow } from "@bb/server-kit/db/threads";
import { errorMessage } from "@bb/server-kit/http/errors";
import { hostResponse } from "@bb/server-kit/runners/hosts";
import { ThreadSerial } from "@bb/server-kit/threads/serial";
import { createLifecycleScripts, notReady } from "./scripts.js";
import {
  step,
  type EnsureEnvironmentArgs as Job,
  type ThreadEnvironment,
} from "@bb/server-kit/environments/types";
import { defaultKinds, kindWorkspace } from "@bb/server-kit/environments/kinds";
import { requireEnvironment } from "@bb/server-kit/environments/workspace";

type Checkout = Extract<EnvironmentPlacement, { type: "checkout" }>;

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
const KIND_GONE =
  "The plugin that provides this kind of environment is not running.";
const NO_DEFAULT_KIND =
  "No running plugin provides a default environment for this project.";
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

export function createEnvironments(bb: PluginServerApi) {
  const { db, realtime: hub, log, now, runners } = bb;
  const scripts = createLifecycleScripts(bb);
  const queue = new ThreadSerial();
  const retiring = new Set<string>();

  function patch(id: string, changes: store.EnvironmentPatch): Environment {
    store.updateEnvironment(db, id, changes);
    const moved = changes.status !== undefined;
    hub.environment(id, [moved ? "status-changed" : "metadata-changed"]);
    return requireEnvironment(bb, id);
  }

  function create(
    input: Omit<store.NewEnvironment, "workspaceProvisionType">,
  ): Environment {
    const kind = bb.find(environmentKinds.kind, input.environmentProviderId);
    const workspaceProvisionType = kindWorkspace(kind);
    const id = store.insertEnvironment(db, {
      ...input,
      workspaceProvisionType,
    });
    hub.environment(id, ["environment-created"]);
    return requireEnvironment(bb, id);
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

  function kindOf(found: Environment): EnvironmentDefinition | null {
    const id = found.environmentProviderId;
    return id === null ? null : bb.find(environmentKinds.kind, id);
  }

  async function createWith(
    kind: EnvironmentDefinition,
    found: Environment,
    job: Job,
    base: string | null,
  ) {
    const { hostId, projectId } = found;
    const threadId = job.thread.id;
    const thread = await bb.call(threads.get, { threadId }).catch(() => null);
    const host = findHost(db, "id", hostId);
    if (thread === null || host === undefined) {
      throw notReady("The thread or its machine no longer exists.");
    }
    const source = getProjectSource(db, projectId, { hostId });
    const { intent, onProgress } = job;
    const report: EnvironmentContext["report"] = (
      text,
      status = "started",
      at = {},
    ) => {
      const key = at.key ?? `environment-${randomUUID()}`;
      onProgress([step(key, text, status, at.startedAt ?? now())]);
    };
    const made = await kind.create({
      thread,
      project: requireProject(db, projectId),
      host: hostResponse(bb, host),
      checkoutPath: source?.path ?? null,
      branchName: found.branchName ?? branchNameFor(job.thread),
      restoring: found.branchName !== null,
      instanceKey: found.environmentProviderInstanceKey ?? found.id,
      baseBranch: found.mergeBaseBranch ?? base,
      inputs: intent.type === "provider" ? intent.inputs : null,
      machine: intent.type === "provider" ? intent.machine : null,
      resource: store.getEnvironmentResource(db, found.id),
      report,
      log: (text) => {
        const key = `environment-output-${randomUUID()}`;
        onProgress([{ type: "output", key, text, startedAt: now() }]);
      },
      signal: job.signal,
    });
    const moved = made.hostId === undefined ? {} : { hostId: made.hostId };
    const kept =
      made.resource === undefined
        ? {}
        : { resource: JSON.stringify(made.resource) };
    const named =
      made.branchName === undefined ? {} : { branchName: made.branchName };
    const based =
      made.mergeBaseBranch === undefined
        ? {}
        : { mergeBaseBranch: made.mergeBaseBranch };
    const changes = { ...moved, ...kept, ...named, ...based };
    store.updateEnvironment(db, found.id, changes);
    return { path: made.path, hostId: made.hostId ?? hostId };
  }

  async function materialize(
    found: Environment,
    job: Job,
    base: string | null,
  ) {
    const { id, projectId } = found;
    job.signal.throwIfAborted();
    patch(id, { status: "creating", statusMessage: null, ...IN_USE });
    const kind = kindOf(found);
    if (kind === null) throw notReady(KIND_GONE);
    const placed = await createWith(kind, found, job, base);
    const { path } = placed;
    patch(id, { path, status: "provisioning" });
    job.signal.throwIfAborted();
    await scripts.setup({ id, hostId: placed.hostId, projectId, path }, job);
    return path;
  }

  async function attach(found: Environment, runner: ServerRunner) {
    const { id, path } = found;
    if (path === null) throw notReady("Environment has no workspace.");
    const { exists, ...inspected } = await runner.call(git.inspect, { path });
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
      const found = requireEnvironment(bb, environmentId);
      const runner = runners.get(found.hostId);
      if (found.status === "ready" && found.path !== null) {
        if (found.lifecycle.retireAt !== null) patch(environmentId, IN_USE);
        return { environmentId, path: found.path };
      }
      try {
        const path = found.managed
          ? await materialize(found, job, base)
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
    branch: EnvironmentBranch,
  ) {
    if (store.hasOtherLiveThread(db, environmentId, thread.id)) {
      throw notReady(SHARED_CHECKOUT);
    }
    const wanted =
      branch.kind === "existing"
        ? { branchName: branch.name, createFrom: null }
        : { branchName: branchNameFor(thread), createFrom: branch.baseBranch };
    const runner = runners.get(hostId);
    const { branchName } = await runner.call(git.switchBranch, {
      path,
      ...wanted,
    });
    patch(environmentId, { branchName });
  }

  async function attachCheckout(
    job: Job,
    hostId: string,
    inputs: Checkout,
    environmentProviderId: string,
  ): Promise<ThreadEnvironment> {
    const { thread } = job;
    const { projectId } = thread;
    const path = inputs.path ?? sourcePathOf(projectId, hostId);
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
    const source = await runners.get(hostId).call(git.source, { path });
    const branched =
      (source.defaultBranch ?? source.originDefaultBranch) !== null;
    const personal = requireProject(db, projectId).kind === "personal";
    const usable = defaultKinds(bb, { personal }).find(
      (kind) => branched || kind.requires?.gitCheckout !== true,
    );
    if (usable === undefined) throw notReady(NO_DEFAULT_KIND);
    return usable.id;
  }

  async function ensureForThread(job: Job): Promise<ThreadEnvironment> {
    const { intent, thread } = job;
    if (intent.type === "reuse") {
      return prepare(requireEnvironment(bb, intent.environmentId), job);
    }
    const { hostId } = intent;
    const { id: ownerThreadId, projectId } = thread;
    const provided = intent.type === "provider";
    const inputs = provided ? intent.inputs : null;
    const environmentProviderId = provided
      ? intent.environmentProviderId
      : await defaultKind(projectId, hostId);
    const kind = bb.find(environmentKinds.kind, environmentProviderId);
    if (kind === null) throw notReady(KIND_GONE);
    const where = { threadId: ownerThreadId, projectId, hostId };
    const placed: EnvironmentPlacement = (await kind.place?.(
      inputs,
      where,
    )) ?? { type: "owned" };
    if (placed.type === "checkout") {
      const as = placed.kind ?? environmentProviderId;
      return attachCheckout(job, hostId, placed, as);
    }
    const key = placed.instanceKey ?? ownerThreadId;
    const base = placed.baseBranch ?? null;
    return owned(job, hostId, environmentProviderId, key, base);
  }

  function owned(
    job: Job,
    hostId: string,
    environmentProviderId: string,
    instanceKey: string,
    base: string | null,
  ): Promise<ThreadEnvironment> {
    const { id: ownerThreadId, projectId } = job.thread;
    const held = { ownerThreadId, instanceKey, path: null };
    const fresh = { projectId, hostId, environmentProviderId, ...held };
    const kept = store.findEnvironment(db, OWNED_BY, ownerThreadId);
    return prepare(kept ?? create(fresh), job, base);
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
    bb.emit(environmentKinds.destroyed, {
      environmentId: id,
      reason: "environment-destroyed",
    });
    try {
      if (found.managed && path !== null) {
        await scripts.teardown({ id, hostId, projectId, path });
        const kind = kindOf(found);
        if (kind === null) throw notReady(KIND_GONE);
        const resource = store.getEnvironmentResource(db, id);
        await kind.delete({ hostId, path, resource });
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
      const read = await runners
        .get(found.hostId)
        .call(machineFiles.read, file);
      if (read.contentEncoding !== "utf8") return null;
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
