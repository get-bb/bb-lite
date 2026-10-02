import {
  threadScope,
  type QueuedMessageWaitingOn,
  type QueuedMessageWaitingOnKind,
  type ThreadChangeMetadata,
  type ThreadLifecycleEventType,
} from "@bb/domain";
import type { RunnerThreadEvent } from "@bb/runner";
import type { ThreadResponse } from "@bb/server-contract";
import type { ServerContext, ServerRunner } from "../context.js";
import { getEnvironment } from "../db/environments.js";
import { lastOutput } from "../db/event-read.js";
import * as eventLog from "../db/events.js";
import * as queue from "../db/queued-messages.js";
import { findThreadListRow } from "../db/thread-read.js";
import * as store from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import { onProjectDeleted } from "../projects/remove.js";
import * as core from "./core.js";
import { createThread } from "./create.js";
import * as dispatching from "./dispatch.js";
import { ingestThreadEvents } from "./ingest.js";
import * as interactions from "./interactions.js";
import * as lifecycle from "./lifecycle.js";
import * as mutations from "./mutations.js";
import * as notices from "./parent-notices.js";
import { beginProvisioning } from "./provisioning.js";
import { toThreadListEntries, toThreadResponse } from "./thread-display.js";
import { cancelToolCall, startToolCall } from "./tool-calls.js";

type ThreadRow = store.ThreadRow;
type Outbox = core.Outbox;

interface ThreadFailure {
  code: string;
  message: string;
  detail: string;
}

const SWEEP_INTERVAL_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

export class Engine {
  readonly inputWaiters = new Map<string, interactions.InputWaiter>();
  readonly toolCalls = new Map<string, AbortController>();
  readonly noticeBatches = new Map<string, notices.NoticeBatch>();
  readonly deleting = new Set<string>();
  readonly hostInstances = new Map<string, string>();
  private readonly serial = new core.ThreadSerial();
  private readonly runtimes = new Map<string, core.ThreadRuntime>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly disposers: (() => void)[] = [];

  constructor(readonly ctx: ServerContext) {}

  inThread<T>(threadId: string, work: () => T | Promise<T>): Promise<T> {
    return this.serial.run(threadId, work);
  }

  background(label: string, work: Promise<unknown>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.ctx.log.error("Thread engine work failed", { err: error, label });
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  later(threadId: string, label: string, work: () => unknown): void {
    this.background(label, this.inThread(threadId, work));
  }

  onHost<T>(
    hostId: string,
    call: (runner: ServerRunner) => Promise<T>,
  ): Promise<T> {
    return Promise.resolve().then(() => call(this.ctx.runners.get(hostId)));
  }

  commit<T>(work: (out: Outbox) => T): T {
    const out = new core.Outbox(this.ctx.hub);
    const result = this.ctx.db.transaction(() => work(out));
    out.flush((err) => this.ctx.log.error("Thread follow-up failed", { err }));
    return result;
  }

  runtimeOf(threadId: string): core.ThreadRuntime {
    const existing = this.runtimes.get(threadId);
    if (existing !== undefined) return existing;
    const empty = { provisioning: null, pendingStart: null };
    const created = { ...empty, cancelledStart: null };
    this.runtimes.set(threadId, created);
    return created;
  }

  forget(threadId: string): void {
    this.runtimes.delete(threadId);
  }

  requireThread(threadId: string): ThreadRow {
    const thread = store.getThread(this.ctx.db, threadId);
    if (thread !== undefined && thread.deletedAt === null) return thread;
    throw core.threadNotFound();
  }

  hostOf(thread: ThreadRow): string | null {
    const { environmentId } = thread;
    if (environmentId === null) return null;
    return getEnvironment(this.ctx.db, environmentId)?.hostId ?? null;
  }

  connectedHostOf(thread: ThreadRow): string | null {
    const hostId = this.hostOf(thread);
    const online = hostId !== null && this.ctx.runners.isConnected(hostId);
    return online ? hostId : null;
  }

  private listed(threadId: string) {
    const row = findThreadListRow(this.ctx.db, threadId);
    if (row === undefined) throw core.threadNotFound();
    return row;
  }

  statusMetadata(threadId: string): ThreadChangeMetadata {
    const [entry] = toThreadListEntries(this.ctx, [this.listed(threadId)]);
    const { projectId, status, runtime, activity } = entry;
    const { latestAttentionAt, updatedAt } = entry;
    const times = { latestAttentionAt, updatedAt };
    return { projectId, statusChange: { status, runtime, activity, ...times } };
  }

  announceStatus(threadId: string): void {
    if (store.getThread(this.ctx.db, threadId) === undefined) return;
    const metadata = this.statusMetadata(threadId);
    this.ctx.hub.thread(threadId, ["status-changed"], metadata);
  }

  respond(threadId: string): ThreadResponse {
    return toThreadResponse(this.ctx, this.listed(threadId));
  }

  append(out: Outbox, thread: ThreadRow, events: RunnerThreadEvent[]): void {
    eventLog.appendEvents(this.ctx.db, thread, events, "server");
    const eventTypes = [...new Set(events.map((event) => event.type))];
    out.thread(thread.id, ["events-appended"], { eventTypes });
  }

  private emitStatus(thread: ThreadRow): void {
    const { db, plugins } = this.ctx;
    const response = this.respond(thread.id);
    if (thread.status === "active") {
      plugins.emit("thread.active", { thread: response });
    } else if (thread.status === "idle") {
      const text = lastOutput(db, thread.id);
      const payload = { thread: response, lastAssistantText: text };
      plugins.emit("thread.idle", payload);
    } else if (thread.status === "error") {
      const error = eventLog.lastSystemErrorMessage(db, thread.id);
      plugins.emit("thread.failed", { thread: response, error });
    }
  }

  transition(
    out: Outbox,
    threadId: string,
    type: ThreadLifecycleEventType,
  ): store.LifecycleOutcome {
    const outcome = store.applyLifecycleEvent(this.ctx.db, threadId, type);
    if (!outcome.applied) return outcome;
    const { thread } = outcome;
    out.thread(threadId, ["status-changed"], this.statusMetadata(threadId));
    out.after(() => this.emitStatus(thread));
    return outcome;
  }

  failThread(
    out: Outbox,
    thread: ThreadRow,
    failure: ThreadFailure,
    failureContext?: string,
  ): void {
    const scope = threadScope();
    this.append(out, thread, [{ type: "system/error", scope, ...failure }]);
    const stopping = thread.status === "stopping";
    const settlement = stopping ? "stop.settled" : "run.failed";
    const outcome = this.transition(out, thread.id, settlement);
    if (!outcome.applied || stopping) return;
    const context = failureContext === undefined ? {} : { failureContext };
    this.notifyParent(out, outcome.thread, { status: "failed", ...context });
  }

  relabelWaits(
    out: Outbox,
    threadId: string,
    from: readonly (QueuedMessageWaitingOnKind | null)[],
    to: QueuedMessageWaitingOn | null,
  ): void {
    const { db } = this.ctx;
    const rows = queue
      .listQueuedMessages(db, threadId)
      .filter((row) => from.includes(queue.parseQueuedWait(row)?.kind ?? null));
    if (rows.length === 0) return;
    queue.setQueuedMessageWait(db, rows, to);
    out.thread(threadId, ["queue-changed"]);
  }

  setTitle(out: Outbox, thread: ThreadRow, title: string | null): void {
    store.patchThread(this.ctx.db, thread.id, { title });
    const { projectId } = thread;
    out.thread(thread.id, ["title-changed"], { projectId });
  }

  tell(
    thread: ThreadRow,
    label: string,
    call: (runner: ServerRunner, threadId: string) => Promise<unknown>,
  ): void {
    const hostId = this.connectedHostOf(thread);
    if (hostId === null) return;
    const told = this.onHost(hostId, (runner) => call(runner, thread.id));
    this.background(label, told);
  }

  renameSession(thread: ThreadRow, title: string): void {
    this.tell(thread, "rename session", (runner, threadId) =>
      runner.renameSession({ threadId, title }),
    );
  }

  adoptTitle(threadId: string, title: string): void {
    const thread = store.getThread(this.ctx.db, threadId);
    if (thread === undefined || thread.title !== null) return;
    this.commit((out) => this.setTitle(out, thread, title));
    if (thread.providerThreadId !== null) this.renameSession(thread, title);
  }

  scheduleDrain(threadId: string): void {
    this.later(threadId, "drain queue", () =>
      dispatching.drainQueue(this, threadId),
    );
  }

  beginProvisioning(thread: ThreadRow, args: dispatching.DispatchArgs): void {
    beginProvisioning(this, thread, args);
  }

  resetContext(thread: ThreadRow): Promise<void> {
    return lifecycle.resetContext(this, thread);
  }

  notifyParent(
    out: Outbox,
    child: ThreadRow,
    outcome: notices.ChildOutcome,
  ): void {
    out.after(() => notices.queueChildOutcome(this, child, outcome));
  }

  requireUnarchived(threadId: string): ThreadRow {
    const thread = this.requireThread(threadId);
    if (thread.archivedAt === null) return thread;
    throw core.notWritable(thread, "archived", "Thread is archived");
  }

  senderOf(thread: ThreadRow, senderThreadId: string | undefined) {
    if (senderThreadId === undefined || senderThreadId === thread.id) {
      return null;
    }
    const sender = store.getThread(this.ctx.db, senderThreadId);
    if (sender !== undefined && sender.deletedAt === null) return sender.id;
    const reason = sender === undefined ? "not_found" : "deleted";
    const details = { reason, subject: "sender" };
    const message = "Sender thread is invalid";
    throw new ApiError(400, "parent_thread_invalid", message, { details });
  }

  start(): void {
    const { runners } = this.ctx;
    this.disposers.push(
      runners.onEvent("thread.events", (event) =>
        this.inThread(event.threadId, () =>
          ingestThreadEvents(this, event.threadId, event.events),
        ),
      ),
      runners.onEvent("interaction.requested", (event, hostId) =>
        this.inThread(event.threadId, () =>
          interactions.registerProviderInteraction(this, hostId, event),
        ),
      ),
      runners.onEvent("interaction.cancelled", (event) =>
        this.inThread(event.threadId, () =>
          interactions.cancelProviderInteraction(this, event),
        ),
      ),
      runners.onEvent("toolCall.requested", (event, hostId) =>
        startToolCall(this, hostId, event),
      ),
      runners.onEvent("toolCall.cancelled", (event) =>
        cancelToolCall(this, event.requestId),
      ),
      runners.onConnected((hostId) => {
        const reconciled = lifecycle.reconcileHost(this, hostId);
        this.background("reconcile host", reconciled);
      }),
      runners.onDisconnected((hostId) =>
        lifecycle.onHostDisconnected(this, hostId),
      ),
    );
    lifecycle.recoverAfterRestart(this);
    const timer = setInterval(() => lifecycle.sweep(this), SWEEP_INTERVAL_MS);
    timer.unref();
    this.disposers.push(() => clearInterval(timer));
    lifecycle.sweep(this);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const batch of this.noticeBatches.values()) clearTimeout(batch.timer);
    this.noticeBatches.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.provisioning?.abort.abort();
    }
    for (const abort of this.toolCalls.values()) abort.abort();
    for (const [id, waiter] of this.inputWaiters) {
      waiter.dispose();
      waiter.resolve({ outcome: "cancelled", reason: "server-restarted" });
      this.inputWaiters.delete(id);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_GRACE_MS);
    });
    await Promise.race([this.settled(), grace]);
    clearTimeout(timer);
  }

  async settled(): Promise<void> {
    for (;;) {
      await this.serial.idle();
      if (this.pending.size === 0) return;
      await Promise.all(this.pending);
    }
  }
}

export function createThreadEngine(ctx: ServerContext) {
  const engine = new Engine(ctx);
  const direct =
    <Args extends unknown[], Result>(
      run: (engine: Engine, ...args: Args) => Result,
    ) =>
    (...args: Args): Result =>
      run(engine, ...args);
  const serialized =
    <Args extends unknown[], Result>(
      run: (
        engine: Engine,
        threadId: string,
        ...args: Args
      ) => Result | Promise<Result>,
    ) =>
    (threadId: string, ...args: Args): Promise<Result> =>
      engine.inThread(threadId, () => run(engine, threadId, ...args));
  return {
    start: () => engine.start(),
    close: () => engine.close(),
    settled: () => engine.settled(),
    sweep: direct(lifecycle.sweep),
    create: direct(createThread),
    get: (threadId: string) => {
      const thread = store.getThread(ctx.db, threadId);
      const gone = thread === undefined || thread.deletedAt !== null;
      return gone ? null : engine.respond(threadId);
    },
    workspaceOf: (threadId: string) =>
      dispatching.sessionEnvironmentOf(engine, engine.requireThread(threadId)),
    send: serialized(mutations.send),
    stop: direct(lifecycle.stopThread),
    compact: direct(mutations.compact),
    clearContext: serialized(lifecycle.clearContext),
    archive: direct(lifecycle.archiveThreadTree),
    unarchive: serialized(lifecycle.unarchiveThread),
    delete: direct(lifecycle.deleteThreadTree),
    releaseDeletedProject: direct(lifecycle.releaseDeletedProject),
    update: serialized(mutations.update),
    pin: serialized(mutations.pin),
    unpin: serialized(mutations.unpin),
    reorderPinned: direct(mutations.reorderPinned),
    markRead: serialized(mutations.markRead),
    markUnread: serialized(mutations.markUnread),
    createQueuedMessage: serialized(mutations.createQueuedMessage),
    updateQueuedMessage: serialized(mutations.updateQueuedMessage),
    deleteQueuedMessage: serialized(mutations.deleteQueuedMessage),
    reorderQueuedMessage: serialized(mutations.reorderQueuedMessage),
    setQueuedMessageGroupBoundary: serialized(mutations.setQueueGroupBoundary),
    sendQueuedMessageNow: serialized(mutations.sendQueuedMessageNow),
    resolveInteraction: serialized(interactions.resolveProviderInteraction),
    respondToInteraction: serialized(interactions.respondToInteraction),
    cancelInteraction: serialized(interactions.cancelByUser),
    requestInput: direct(interactions.requestInput),
  };
}

export type ThreadEngine = ReturnType<typeof createThreadEngine>;

onProjectDeleted.push((ctx, deleted) =>
  ctx.threads.releaseDeletedProject(deleted),
);
