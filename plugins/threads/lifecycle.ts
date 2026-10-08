import { threads } from "@bb/plugin";
import * as domain from "@bb/domain";
import { newId } from "@bb/server-kit/db/index";
import * as pending from "@bb/server-kit/db/pending-interactions";
import type { DeletedProject } from "@bb/server-kit/db/projects";
import { listThreadIdsWaitingOn } from "@bb/server-kit/db/queued-messages";
import * as store from "@bb/server-kit/db/threads";
import { ApiError, conflict } from "@bb/server-kit/http/errors";
import type { Outbox } from "./core.js";
import type { Engine } from "./engine.js";
import * as interactions from "./interactions.js";
import { flushDueNotices } from "./parent-notices.js";
import { cancelProvisioning } from "./provisioning.js";

type ThreadRow = store.ThreadRow;
type Interruption = NonNullable<domain.ChildThreadOutcome["interruption"]>;
type MembershipEvent = `thread.${"archived" | "unarchived" | "deleted"}`;

const MEMBERSHIP = {
  "thread.archived": threads.archived,
  "thread.unarchived": threads.unarchived,
  "thread.deleted": threads.deleted,
};

const ARCHIVE_UNDO_GRACE_MS = 30_000;
const STOPPED_REASON = "Thread stopped by user request";
const MANUAL_STOP: Interruption = { reason: "manual-stop" };
const RESTARTED: Interruption = { reason: "host-daemon-restarted" };
const CONNECTION_LOST = "host-connection-lost";
const CONTEXT_CLEARED_MESSAGE =
  "Earlier chat is hidden from the active timeline. Durable history and " +
  "workspace are unchanged.";

function appendInterrupted(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  interruption: Interruption,
) {
  const type = "system/thread/interrupted";
  engine.append(out, thread, [
    { type, scope: domain.threadScope(), ...interruption },
  ]);
}

function closeActiveTurn(engine: Engine, out: Outbox, thread: ThreadRow) {
  const { activeTurnId, providerThreadId } = thread;
  if (activeTurnId === null) return;
  const turn = { scope: domain.turnScope(activeTurnId), providerThreadId };
  const type = "turn/completed";
  engine.append(out, thread, [{ type, ...turn, status: "interrupted" }]);
  store.patchThread(engine.bb.db, thread.id, { activeTurnId: null }, false);
}

function requestStop(engine: Engine, threadId: string) {
  const thread = engine.requireThread(threadId);
  const runtime = engine.runtimeOf(threadId);
  const hostId = engine.hostOf(thread);
  if (thread.status === "stopping") return hostId;
  if (thread.status === "active") {
    engine.commit((out) => {
      appendInterrupted(engine, out, thread, MANUAL_STOP);
      engine.transition(out, threadId, "stop.requested");
    });
    runtime.cancelledStart = runtime.pendingStart;
    return hostId;
  }
  if (thread.status !== "starting") {
    engine.tell(thread, "release session", (runner) =>
      runner.releaseSession({ threadId }),
    );
    return null;
  }
  engine.commit((out) => {
    cancelProvisioning(engine, out, thread);
    appendInterrupted(engine, out, thread, MANUAL_STOP);
    interactions.interruptAll(engine, out, thread, STOPPED_REASON);
    engine.transition(out, threadId, "stop.requested");
    engine.transition(out, threadId, "stop.settled");
  });
  return null;
}

function finalizeStop(engine: Engine, threadId: string) {
  const thread = store.getThread(engine.bb.db, threadId);
  if (thread === undefined || thread.status !== "stopping") return;
  engine.commit((out) => {
    closeActiveTurn(engine, out, thread);
    interactions.interruptAll(engine, out, thread, STOPPED_REASON);
    engine.transition(out, threadId, "stop.settled");
    out.after(() => engine.scheduleDrain(threadId));
  });
}

export async function stopThread(
  engine: Engine,
  threadId: string,
): Promise<void> {
  const hostId = await engine.inThread(threadId, () =>
    requestStop(engine, threadId),
  );
  if (hostId === null) return;
  const interrupted = await engine
    .onHost(hostId, (runner) => runner.interruptTurn({ threadId }))
    .then(
      (result) => result.interrupted,
      () => false,
    );
  if (interrupted) return;
  await engine.inThread(threadId, () => finalizeStop(engine, threadId));
}

function interruptThread(
  engine: Engine,
  threadId: string,
  interruption: Interruption,
) {
  const thread = store.getThread(engine.bb.db, threadId);
  const running = ["starting", "active", "stopping"];
  if (thread === undefined || !running.includes(thread.status)) return;
  const runtime = engine.runtimeOf(threadId);
  runtime.provisioning?.abort.abort();
  runtime.provisioning = null;
  const stopping = thread.status === "stopping";
  const lost = interruption.cause === CONNECTION_LOST;
  const cause = lost ? "Connection to host was lost" : "Host daemon restarted";
  const reason = `${cause} while awaiting user interaction`;
  engine.commit((out) => {
    closeActiveTurn(engine, out, thread);
    appendInterrupted(engine, out, thread, interruption);
    interactions.interruptAll(engine, out, thread, reason);
    const settlement = stopping ? "stop.settled" : "run.failed";
    const outcome = engine.transition(out, threadId, settlement);
    if (!outcome.applied || stopping) return;
    const status = "interrupted";
    engine.notifyParent(out, outcome.thread, { status, interruption });
  });
}

function changeMembership(
  engine: Engine,
  thread: ThreadRow,
  patch: store.ThreadPatch,
  change: domain.ThreadChangeKind,
  event: MembershipEvent,
) {
  const { db } = engine.bb;
  const { id, projectId } = thread;
  engine.commit((out) => {
    store.patchThread(db, id, patch);
    out.thread(id, [change], { projectId });
    out.project(projectId, ["threads-changed"]);
    out.after(() => {
      engine.bb.emit(MEMBERSHIP[event], { thread: engine.respond(id) });
    });
  });
}

function archiveOne(engine: Engine, threadId: string) {
  const thread = store.getThread(engine.bb.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return false;
  if (thread.archivedAt !== null) return false;
  const archived = { archivedAt: engine.bb.now() };
  const change = "archived-changed";
  changeMembership(engine, thread, archived, change, "thread.archived");
  return true;
}

export async function archiveThreadTree(
  engine: Engine,
  threadId: string,
): Promise<string[]> {
  const root = engine.requireThread(threadId);
  const archivedThreadIds: string[] = [];
  for (const { id } of store.listArchiveTree(engine.bb.db, root)) {
    const archived = await engine.inThread(id, () => archiveOne(engine, id));
    if (archived) archivedThreadIds.push(id);
  }
  return archivedThreadIds;
}

export function unarchiveThread(engine: Engine, threadId: string): void {
  const thread = engine.requireThread(threadId);
  if (thread.archivedAt === null) return;
  const restored = { archivedAt: null };
  const change = "archived-changed";
  changeMembership(engine, thread, restored, change, "thread.unarchived");
  engine.scheduleDrain(threadId);
}

async function finalizeDeletion(engine: Engine, threadId: string) {
  const { db, runners } = engine.bb;
  const thread = store.getThread(db, threadId);
  if (thread === undefined || thread.deletedAt === null) return;
  const hostId = engine.hostOf(thread);
  if (hostId !== null && thread.storageDeletedAt === null) {
    if (!runners.isConnected(hostId)) return;
    const runner = runners.get(hostId);
    if (thread.status === "active" || thread.status === "stopping") {
      await runner.interruptTurn({ threadId }).catch(() => undefined);
    }
    await runner.deleteThreadStorage({ threadId });
    store.patchThread(db, threadId, { storageDeletedAt: db.now() }, false);
  }
  await engine.inThread(threadId, () => {
    engine.bb.emit(threads.retired, { threadId, reason: "thread-deleted" });
    store.deleteThreadRow(db, threadId);
    engine.forget(threadId);
  });
}

function retryDeletions(engine: Engine) {
  for (const { id } of store.listTombstonedThreads(engine.bb.db)) {
    if (engine.deleting.has(id)) continue;
    engine.deleting.add(id);
    const finalized = finalizeDeletion(engine, id).finally(() =>
      engine.deleting.delete(id),
    );
    engine.background("delete thread storage", finalized);
  }
}

function tombstone(engine: Engine, threadId: string) {
  const thread = store.getThread(engine.bb.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const runtime = engine.runtimeOf(threadId);
  runtime.provisioning?.abort.abort();
  runtime.provisioning = null;
  engine.commit((out) =>
    interactions.interruptAll(engine, out, thread, "thread-deleted"),
  );
  const deleted = { deletedAt: engine.bb.now() };
  changeMembership(engine, thread, deleted, "thread-deleted", "thread.deleted");
  retryDeletions(engine);
}

export async function deleteThreadTree(
  engine: Engine,
  threadId: string,
  { childThreadsConfirmed }: { childThreadsConfirmed: boolean },
): Promise<void> {
  const { db } = engine.bb;
  const root = engine.requireThread(threadId);
  const children = store.listChildThreads(db, root.id);
  if (!childThreadsConfirmed && children.length > 0) {
    throw new ApiError(
      409,
      "child_threads_confirmation_required",
      "This thread has child threads. Confirm to delete it; the child " +
        "threads are kept.",
    );
  }
  await engine.inThread(root.id, () => tombstone(engine, root.id));
}

export function releaseDeletedProject(
  engine: Engine,
  { threadIds, environments }: DeletedProject,
): void {
  const { runners } = engine.bb;
  const hostIds = new Set(environments.map(({ hostId }) => hostId));
  const online = [...hostIds].filter((hostId) => runners.isConnected(hostId));
  for (const threadId of threadIds) {
    engine.runtimeOf(threadId).provisioning?.abort.abort();
    engine.forget(threadId);
    for (const hostId of online) {
      const removed = runners.get(hostId).deleteThreadStorage({ threadId });
      engine.background("delete project thread storage", removed);
    }
  }
}

export function clearContext(engine: Engine, threadId: string) {
  return resetContext(engine, engine.requireThread(threadId));
}

export async function resetContext(
  engine: Engine,
  thread: ThreadRow,
): Promise<void> {
  const { db, runners } = engine.bb;
  if (thread.status !== "idle" && thread.status !== "error") {
    const state = "the thread is idle or failed";
    throw conflict(`Context can only be cleared when ${state}`);
  }
  if (pending.hasTurnBoundInteraction(db, thread.id)) {
    throw new ApiError(
      409,
      "awaiting_user_interaction",
      "Resolve the pending interaction before clearing context",
    );
  }
  const hostId = engine.connectedHostOf(thread);
  if (hostId !== null) {
    await runners.get(hostId).releaseSession({ threadId: thread.id });
  }
  engine.commit((out) => {
    const operation = {
      operation: domain.THREAD_CONTEXT_CLEAR_OPERATION,
      operationId: newId("evt"),
      status: "completed",
      message: CONTEXT_CLEARED_MESSAGE,
    };
    const type = "system/operation";
    engine.append(out, thread, [
      { type, scope: domain.threadScope(), ...operation },
    ]);
    store.patchThread(db, thread.id, { providerThreadId: null }, false);
    const metadata = engine.statusMetadata(thread.id);
    out.thread(thread.id, ["history-rewritten", "status-changed"], metadata);
    out.after(() => engine.scheduleDrain(thread.id));
  });
}

export async function reconcileHost(
  engine: Engine,
  hostId: string,
): Promise<void> {
  const { db, runners } = engine.bb;
  const runner = runners.get(hostId);
  const [info, snapshot] = await Promise.all([
    runner.describe(),
    runner.snapshot(),
  ]);
  const previous = engine.hostInstances.get(hostId);
  const restarted = previous !== undefined && previous !== info.instanceId;
  engine.hostInstances.set(hostId, info.instanceId);
  const live = snapshot.sessions
    .filter((session) => session.activeTurnId !== null)
    .map((session) => session.threadId);
  const lost: Interruption = { ...RESTARTED, cause: CONNECTION_LOST };
  const affected = store.listThreadsOnHost(db, hostId, "active", "stopping");
  for (const { id } of affected) {
    engine.later(id, "reconcile thread", () => {
      if (!restarted && live.includes(id)) engine.announceStatus(id);
      else interruptThread(engine, id, restarted ? RESTARTED : lost);
    });
  }
  for (const threadId of listThreadIdsWaitingOn(db, "host-offline")) {
    engine.scheduleDrain(threadId);
  }
  retryDeletions(engine);
}

export function onHostDisconnected(engine: Engine, hostId: string): void {
  const active = store.listThreadsOnHost(engine.bb.db, hostId, "active");
  for (const { id } of active) engine.announceStatus(id);
}

export function recoverAfterRestart(engine: Engine): void {
  const { db } = engine.bb;
  const { localHostId } = engine.bb.runners;
  for (const { threadId, id } of pending.listActivePluginInteractions(db)) {
    engine.later(threadId, "interrupt plugin interaction", () => {
      const reason = "server-restarted";
      interactions.cancelPluginInteraction(engine, threadId, id, reason);
    });
  }
  const interrupted = [
    ...store.listThreadsOnHost(db, localHostId, "active", "stopping"),
    ...store.listStartingThreads(db),
  ];
  for (const { id } of interrupted) {
    engine.later(id, "restart recovery", () =>
      interruptThread(engine, id, RESTARTED),
    );
  }
}

export function sweep(engine: Engine): void {
  const { db, now } = engine.bb;
  const time = now();
  flushDueNotices(engine, time);
  const expired = time - ARCHIVE_UNDO_GRACE_MS;
  for (const { id, status } of store.listExpiredArchives(db, expired)) {
    engine.bb.emit(threads.retired, {
      threadId: id,
      reason: "thread-archived",
    });
    if (status !== "starting" && status !== "active") continue;
    engine.background("stop archived thread", stopThread(engine, id));
  }
  for (const threadId of listThreadIdsWaitingOn(db, "time", time)) {
    engine.scheduleDrain(threadId);
  }
  retryDeletions(engine);
}
