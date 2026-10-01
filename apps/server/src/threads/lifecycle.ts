import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type ChildThreadOutcome,
  type ThreadChangeKind,
} from "@bb/domain";
import { getHostRow, recordHostInstance } from "../db/engine-lookups.js";
import { newId } from "../db/index.js";
import * as pending from "../db/pending-interactions.js";
import { listThreadIdsWaitingOn } from "../db/queued-messages.js";
import * as store from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import { conflict, type Outbox } from "./core.js";
import type { Engine } from "./engine.js";
import * as interactions from "./interactions.js";
import { flushDueNotices } from "./parent-notices.js";
import { cancelProvisioning } from "./provisioning.js";

type ThreadRow = store.ThreadRow;
type Interruption = NonNullable<ChildThreadOutcome["interruption"]>;
type MembershipEvent = `thread.${"archived" | "unarchived" | "deleted"}`;

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
  store.patchThread(engine.ctx.db, thread.id, { activeTurnId: null }, false);
}

function requestStop(engine: Engine, threadId: string): string | null {
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
  const online = engine.connectedHostOf(thread);
  if (thread.status === "starting") {
    engine.commit((out) => {
      cancelProvisioning(engine, out, thread);
      appendInterrupted(engine, out, thread, MANUAL_STOP);
      interactions.interruptAll(engine, out, thread, STOPPED_REASON);
      engine.transition(out, threadId, "stop.requested");
      engine.transition(out, threadId, "stop.settled");
    });
  } else if (online !== null) {
    const released = engine.onHost(online, (runner) =>
      runner.releaseSession({ threadId }),
    );
    engine.background("release session", released);
  }
  return null;
}

function finalizeStop(engine: Engine, threadId: string): void {
  const thread = store.getThread(engine.ctx.db, threadId);
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
): void {
  const thread = store.getThread(engine.ctx.db, threadId);
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
    interactions.interruptAll(engine, out, thread, reason, "provider");
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
  change: ThreadChangeKind,
  event: MembershipEvent,
): void {
  const { db, environments, extensions } = engine.ctx;
  const { id, projectId } = thread;
  engine.commit((out) => {
    const changed = store.patchThread(db, id, patch);
    out.thread(id, [change], { projectId });
    out.project(projectId, ["threads-changed"]);
    out.after(() => {
      extensions.emit(event, { thread: engine.respond(changed) });
      environments.onThreadDetached(id);
    });
  });
}

function archiveOne(engine: Engine, threadId: string): boolean {
  const thread = store.getThread(engine.ctx.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return false;
  if (thread.archivedAt !== null) return false;
  const archived = { archivedAt: engine.ctx.now() };
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
  for (const { id } of store.listArchiveTree(engine.ctx.db, root)) {
    const archived = await engine.inThread(id, () => archiveOne(engine, id));
    if (archived) archivedThreadIds.push(id);
  }
  return archivedThreadIds;
}

export function unarchiveThread(engine: Engine, threadId: string): void {
  const thread = engine.requireThread(threadId);
  if (thread.archivedAt === null) return;
  const ownerId = thread.lifecycleOwnerThreadId;
  const owner =
    ownerId === null ? undefined : store.getThread(engine.ctx.db, ownerId);
  if (owner !== undefined && owner.archivedAt !== null) {
    throw conflict("Lifecycle owner must be unarchived first");
  }
  const restored = { archivedAt: null };
  const change = "archived-changed";
  changeMembership(engine, thread, restored, change, "thread.unarchived");
  engine.scheduleDrain(threadId);
}

async function finalizeDeletion(
  engine: Engine,
  threadId: string,
): Promise<void> {
  const { db, runners } = engine.ctx;
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
    store.deleteThreadRow(db, threadId);
    engine.forget(threadId);
  });
}

function retryDeletions(engine: Engine): void {
  for (const { id } of store.listTombstonedThreads(engine.ctx.db)) {
    if (engine.deleting.has(id)) continue;
    engine.deleting.add(id);
    const finalized = finalizeDeletion(engine, id).finally(() =>
      engine.deleting.delete(id),
    );
    engine.background("delete thread storage", finalized);
  }
}

function tombstone(engine: Engine, threadId: string): void {
  const thread = store.getThread(engine.ctx.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const runtime = engine.runtimeOf(threadId);
  runtime.provisioning?.abort.abort();
  runtime.provisioning = null;
  engine.commit((out) =>
    interactions.interruptAll(engine, out, thread, "thread-deleted"),
  );
  const deleted = { deletedAt: engine.ctx.now() };
  changeMembership(engine, thread, deleted, "thread-deleted", "thread.deleted");
  retryDeletions(engine);
}

export async function deleteThreadTree(
  engine: Engine,
  threadId: string,
  { childThreadsConfirmed }: { childThreadsConfirmed: boolean },
): Promise<void> {
  const { db } = engine.ctx;
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
  for (const { id } of store.listLifecycleTree(db, root)) {
    await engine.inThread(id, () => tombstone(engine, id));
  }
}

export function clearContext(engine: Engine, threadId: string) {
  return resetContext(engine, engine.requireThread(threadId));
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
      operation: THREAD_CONTEXT_CLEAR_OPERATION,
      operationId: newId("evt"),
      status: "completed",
      message: CONTEXT_CLEARED_MESSAGE,
    };
    const type = "system/operation";
    engine.append(out, thread, [{ type, scope: threadScope(), ...operation }]);
    store.patchThread(db, thread.id, { providerThreadId: null }, false);
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
  const active = store.listThreadsOnHost(engine.ctx.db, hostId, "active");
  for (const { id } of active) engine.announceStatus(id);
}

export function recoverAfterRestart(engine: Engine): void {
  const { db } = engine.ctx;
  const { localHostId } = engine.ctx.runners;
  for (const { threadId, id } of pending.listActivePluginInteractions(db)) {
    engine.later(threadId, "interrupt plugin interaction", () => {
      const reason = "server-restarted";
      interactions.cancelPluginInteraction(engine, threadId, id, reason);
    });
  }
  const running = ["starting", "active", "stopping"] as const;
  const interrupted = [
    ...store.listThreadsOnHost(db, localHostId, ...running),
    ...store.listStartingWithoutEnvironment(db),
  ];
  for (const { id } of interrupted) {
    engine.later(id, "restart recovery", () =>
      interruptThread(engine, id, RESTARTED),
    );
  }
}

export function sweep(engine: Engine): void {
  const { db, now } = engine.ctx;
  const time = now();
  flushDueNotices(engine, time);
  const expired = time - ARCHIVE_UNDO_GRACE_MS;
  for (const thread of store.listArchivedRunningThreads(db, expired)) {
    engine.background("stop archived thread", stopThread(engine, thread.id));
  }
  for (const threadId of listThreadIdsWaitingOn(db, "time", time)) {
    engine.scheduleDrain(threadId);
  }
  retryDeletions(engine);
}
