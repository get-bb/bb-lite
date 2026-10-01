import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type ChildThreadOutcome,
} from "@bb/domain";
import { getHostRow, recordHostInstance } from "../db/engine-lookups.js";
import { newId } from "../db/index.js";
import {
  hasTurnBoundInteraction,
  listActivePluginInteractions,
} from "../db/pending-interactions.js";
import { listThreadIdsWaitingOn } from "../db/queued-messages.js";
import {
  deleteThreadRow,
  getThread,
  listArchiveTree,
  listArchivedRunningThreads,
  listChildThreads,
  listLifecycleTree,
  listStartingWithoutEnvironment,
  listThreadsOnHost,
  listTombstonedThreads,
  patchThread,
  type ThreadRow,
} from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import { conflict, threadNotFound, type Outbox } from "./core.js";
import type { Engine } from "./engine.js";
import { cancelPluginInteraction } from "./interactions.js";
import { flushDueNotices } from "./parent-notices.js";
import { cancelProvisioning } from "./provisioning.js";

type Interruption = NonNullable<ChildThreadOutcome["interruption"]>;

const ARCHIVE_UNDO_GRACE_MS = 30_000;
const STOP_SETTLE_TIMEOUT_MS = 30_000;
const STOPPED_REASON = "Thread stopped by user request";
const MANUAL_STOP: Interruption = { reason: "manual-stop" };
const RUNNER_RESTARTED: Interruption = { reason: "host-daemon-restarted" };
const CONNECTION_LOST: Interruption = {
  reason: "host-daemon-restarted",
  cause: "host-connection-lost",
};
const CONTEXT_CLEARED_MESSAGE =
  "Earlier chat is hidden from the active timeline. Durable history and " +
  "workspace are unchanged.";

function requireLiveThread(engine: Engine, threadId: string): ThreadRow {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) throw threadNotFound();
  return thread;
}

function appendInterrupted(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  interruption: Interruption,
): void {
  const type = "system/thread/interrupted";
  engine.append(out, thread, [{ type, scope: threadScope(), ...interruption }]);
}

function closeActiveTurn(engine: Engine, out: Outbox, thread: ThreadRow) {
  const { activeTurnId, providerThreadId } = thread;
  if (activeTurnId === null) return;
  const turn = { scope: turnScope(activeTurnId), providerThreadId };
  const type = "turn/completed";
  engine.append(out, thread, [{ type, ...turn, status: "interrupted" }]);
  patchThread(engine.ctx.db, thread.id, { activeTurnId: null }, false);
}

function releaseSession(engine: Engine, thread: ThreadRow): void {
  const { runners } = engine.ctx;
  const hostId = engine.hostOf(thread);
  if (hostId === null || !runners.isConnected(hostId)) return;
  const released = runners.get(hostId).releaseSession({ threadId: thread.id });
  engine.background("release session", released);
}

function requestStop(engine: Engine, threadId: string): string | null {
  const thread = requireLiveThread(engine, threadId);
  const runtime = engine.runtimeOf(threadId);
  if (thread.status === "stopping") return engine.hostOf(thread);
  if (thread.status === "active") {
    engine.commit((out) => {
      appendInterrupted(engine, out, thread, MANUAL_STOP);
      engine.transition(out, threadId, "stop.requested");
    });
    runtime.cancelledStart = runtime.pendingStart;
    return engine.hostOf(thread);
  }
  if (thread.status !== "starting") {
    releaseSession(engine, thread);
    return null;
  }
  engine.commit((out) => {
    cancelProvisioning(engine, out, thread);
    appendInterrupted(engine, out, thread, MANUAL_STOP);
    engine.interruptInteractions(out, thread, STOPPED_REASON);
    engine.transition(out, threadId, "stop.requested");
    engine.transition(out, threadId, "stop.settled");
  });
  return null;
}

function finalizeStop(engine: Engine, threadId: string): void {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined || thread.status !== "stopping") return;
  engine.commit((out) => {
    closeActiveTurn(engine, out, thread);
    engine.interruptInteractions(out, thread, STOPPED_REASON);
    engine.transition(out, threadId, "stop.settled");
    out.after(() => engine.scheduleDrain(threadId));
  });
}

export async function stopThread(
  engine: Engine,
  threadId: string,
): Promise<void> {
  const { runners } = engine.ctx;
  const hostId = await engine.inThread(threadId, () =>
    requestStop(engine, threadId),
  );
  if (hostId === null) return;
  const interrupted = await Promise.resolve()
    .then(() => runners.get(hostId).interruptTurn({ threadId }))
    .then(
      (result) => result.interrupted,
      () => false,
    );
  if (interrupted) return;
  await engine.inThread(threadId, () => finalizeStop(engine, threadId));
}

export function interruptThread(
  engine: Engine,
  threadId: string,
  interruption: Interruption,
): void {
  const thread = getThread(engine.ctx.db, threadId);
  const running = ["starting", "active", "stopping"];
  if (thread === undefined || !running.includes(thread.status)) return;
  const runtime = engine.runtimeOf(threadId);
  runtime.provisioning?.abort.abort();
  runtime.provisioning = null;
  const stopping = thread.status === "stopping";
  const lost = interruption.cause === "host-connection-lost";
  engine.commit((out) => {
    closeActiveTurn(engine, out, thread);
    appendInterrupted(engine, out, thread, interruption);
    engine.interruptInteractions(
      out,
      thread,
      lost
        ? "Connection to host was lost while awaiting user interaction"
        : "Host daemon restarted while awaiting user interaction",
      "provider",
    );
    const lifecycle = stopping ? "stop.settled" : "run.failed";
    const outcome = engine.transition(out, threadId, lifecycle);
    if (!outcome.applied || stopping) return;
    const status = "interrupted";
    engine.notifyParent(out, outcome.thread, { status, interruption });
  });
}

function archiveOne(engine: Engine, threadId: string): boolean {
  const { db, environments, extensions, now } = engine.ctx;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return false;
  if (thread.archivedAt !== null) return false;
  const { projectId } = thread;
  engine.commit((out) => {
    const archived = patchThread(db, threadId, { archivedAt: now() }) ?? thread;
    out.thread(threadId, ["archived-changed"], { projectId });
    out.project(projectId, ["threads-changed"]);
    out.after(() => {
      extensions.emit("thread.archived", { thread: engine.respond(archived) });
      environments.onThreadDetached(threadId);
    });
  });
  if (thread.status === "idle" || thread.status === "error") {
    releaseSession(engine, thread);
  }
  return true;
}

export async function archiveThreadTree(
  engine: Engine,
  threadId: string,
): Promise<string[]> {
  const root = requireLiveThread(engine, threadId);
  const archivedThreadIds: string[] = [];
  for (const { id } of listArchiveTree(engine.ctx.db, root)) {
    const archived = await engine.inThread(id, () => archiveOne(engine, id));
    if (archived) archivedThreadIds.push(id);
  }
  return archivedThreadIds;
}

export function unarchiveThread(engine: Engine, threadId: string): void {
  const { db, environments, extensions } = engine.ctx;
  const thread = requireLiveThread(engine, threadId);
  if (thread.archivedAt === null) return;
  const ownerId = thread.lifecycleOwnerThreadId;
  const owner = ownerId === null ? undefined : getThread(db, ownerId);
  if (owner !== undefined && owner.archivedAt !== null) {
    throw conflict("Lifecycle owner must be unarchived first");
  }
  const { projectId } = thread;
  engine.commit((out) => {
    const restored = patchThread(db, threadId, { archivedAt: null }) ?? thread;
    out.thread(threadId, ["archived-changed"], { projectId });
    out.project(projectId, ["threads-changed"]);
    out.after(() => {
      const response = engine.respond(restored);
      extensions.emit("thread.unarchived", { thread: response });
      environments.onThreadDetached(threadId);
      engine.scheduleDrain(threadId);
    });
  });
}

export async function finalizeDeletion(
  engine: Engine,
  threadId: string,
): Promise<void> {
  const { db, runners } = engine.ctx;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt === null) return;
  const hostId = engine.hostOf(thread);
  if (hostId !== null && thread.storageDeletedAt === null) {
    if (!runners.isConnected(hostId)) return;
    const runner = runners.get(hostId);
    if (thread.status === "active" || thread.status === "stopping") {
      await runner.interruptTurn({ threadId }).catch(() => undefined);
    }
    await runner.deleteThreadStorage({ threadId });
    patchThread(db, threadId, { storageDeletedAt: db.now() }, false);
  }
  await engine.inThread(threadId, () => {
    deleteThreadRow(db, threadId);
    engine.forget(threadId);
  });
}

function tombstone(engine: Engine, threadId: string): void {
  const { db, environments, extensions, now } = engine.ctx;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const runtime = engine.runtimeOf(threadId);
  runtime.provisioning?.abort.abort();
  runtime.provisioning = null;
  const { projectId } = thread;
  engine.commit((out) => {
    engine.interruptInteractions(out, thread, "thread-deleted");
    const deleted = patchThread(db, threadId, { deletedAt: now() }) ?? thread;
    out.thread(threadId, ["thread-deleted"], { projectId });
    out.project(projectId, ["threads-changed"]);
    out.after(() => {
      extensions.emit("thread.deleted", { thread: engine.respond(deleted) });
      environments.onThreadDetached(threadId);
      const finalized = finalizeDeletion(engine, threadId);
      engine.background("delete thread storage", finalized);
    });
  });
}

export async function deleteThreadTree(
  engine: Engine,
  threadId: string,
  childThreadsConfirmed: boolean,
): Promise<void> {
  const { db } = engine.ctx;
  const root = requireLiveThread(engine, threadId);
  if (!childThreadsConfirmed && listChildThreads(db, root.id).length > 0) {
    throw new ApiError(
      409,
      "child_threads_confirmation_required",
      "This thread has child threads. Confirm to delete it; the child " +
        "threads are kept.",
    );
  }
  for (const { id } of listLifecycleTree(db, root)) {
    await engine.inThread(id, () => tombstone(engine, id));
  }
}

export async function resetContext(
  engine: Engine,
  thread: ThreadRow,
): Promise<void> {
  const { db, runners } = engine.ctx;
  if (thread.status !== "idle" && thread.status !== "error") {
    const state = "the thread is idle or failed";
    throw conflict(`Context can only be cleared when ${state}`);
  }
  if (hasTurnBoundInteraction(db, thread.id)) {
    throw new ApiError(
      409,
      "awaiting_user_interaction",
      "Resolve the pending interaction before clearing context",
    );
  }
  const hostId = engine.hostOf(thread);
  if (hostId !== null && runners.isConnected(hostId)) {
    await runners.get(hostId).releaseSession({ threadId: thread.id });
  }
  engine.commit((out) => {
    const operation = {
      operation: THREAD_CONTEXT_CLEAR_OPERATION,
      operationId: newId("evt"),
      status: "completed",
      message: CONTEXT_CLEARED_MESSAGE,
    };
    const type = "system/operation";
    engine.append(out, thread, [{ type, scope: threadScope(), ...operation }]);
    patchThread(db, thread.id, { providerThreadId: null }, false);
    const metadata = engine.statusMetadata(thread);
    out.thread(thread.id, ["history-rewritten", "status-changed"], metadata);
    out.after(() => engine.scheduleDrain(thread.id));
  });
}

export async function reconcileHost(
  engine: Engine,
  hostId: string,
): Promise<void> {
  const { db, runners } = engine.ctx;
  const runner = runners.get(hostId);
  const [info, snapshot] = await Promise.all([
    runner.describe(),
    runner.snapshot(),
  ]);
  const previous = getHostRow(db, hostId)?.lastInstanceId ?? null;
  const restarted = previous !== null && previous !== info.instanceId;
  recordHostInstance(db, hostId, info.instanceId);
  const live = new Set(
    snapshot.sessions
      .filter((session) => session.activeTurnId !== null)
      .map((session) => session.threadId),
  );
  const interruption = restarted ? RUNNER_RESTARTED : CONNECTION_LOST;
  for (const thread of listThreadsOnHost(db, hostId, ["active", "stopping"])) {
    engine.later(thread.id, "reconcile thread", () => {
      if (restarted || !live.has(thread.id)) {
        interruptThread(engine, thread.id, interruption);
      } else {
        engine.announceStatus(thread.id);
      }
    });
  }
  for (const threadId of listThreadIdsWaitingOn(db, "host-offline")) {
    engine.scheduleDrain(threadId);
  }
  for (const thread of listTombstonedThreads(db)) {
    const finalized = finalizeDeletion(engine, thread.id);
    engine.background("delete thread storage", finalized);
  }
}

export function onHostDisconnected(engine: Engine, hostId: string): void {
  const { db } = engine.ctx;
  const hostName = getHostRow(db, hostId)?.name ?? hostId;
  for (const thread of listThreadsOnHost(db, hostId, ["active"])) {
    engine.later(thread.id, "host disconnected", () => {
      engine.commit((out) => {
        const waiting = [null, "thread-busy", "turn-starting"] as const;
        const offline = { kind: "host-offline" as const, hostName };
        engine.relabelWaits(out, thread.id, waiting, offline);
      });
      engine.announceStatus(thread.id);
    });
  }
}

export function recoverAfterRestart(engine: Engine): void {
  const { db } = engine.ctx;
  const { localHostId } = engine.ctx.runners;
  for (const row of listActivePluginInteractions(db)) {
    const { threadId, id } = row;
    engine.later(threadId, "interrupt plugin interaction", () => {
      cancelPluginInteraction(engine, threadId, id, "server-restarted");
    });
  }
  const interrupted = [
    ...listThreadsOnHost(db, localHostId, ["starting", "active", "stopping"]),
    ...listStartingWithoutEnvironment(db),
  ];
  for (const thread of interrupted) {
    engine.later(thread.id, "restart recovery", () =>
      interruptThread(engine, thread.id, RUNNER_RESTARTED),
    );
  }
}

export function sweep(engine: Engine): void {
  const { db, now } = engine.ctx;
  const time = now();
  flushDueNotices(engine, time);
  const expired = time - ARCHIVE_UNDO_GRACE_MS;
  for (const thread of listArchivedRunningThreads(db, expired)) {
    engine.background("stop archived thread", stopThread(engine, thread.id));
  }
  for (const threadId of listThreadIdsWaitingOn(db, "time", time)) {
    engine.scheduleDrain(threadId);
  }
  for (const thread of listTombstonedThreads(db)) {
    const finalized = finalizeDeletion(engine, thread.id);
    engine.background("delete thread storage", finalized);
  }
  const stuck = db.all<{ id: string }>(
    "SELECT id FROM threads WHERE status = 'stopping' AND updated_at <= ?",
    time - STOP_SETTLE_TIMEOUT_MS,
  );
  for (const { id } of stuck) {
    engine.later(id, "settle stuck stop", () => finalizeStop(engine, id));
  }
}
