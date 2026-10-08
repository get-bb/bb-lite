import { join } from "node:path";
import * as domain from "@bb/domain";
import {
  interactions as interactionOps,
  threads as threadOps,
  type ThreadWriteOp,
} from "@bb/plugin";
import type { RunnerThreadEvent } from "@bb/runner";
import type {
  CreateThreadRequest,
  SendMessageRequest,
  ThreadResponse,
} from "@bb/server-contract";
import type { PluginServerApi } from "@bb/plugin";
import type { ServerRunner } from "@bb/server-kit/context";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { findHost } from "@bb/server-kit/db/hosts";
import { lastOutput } from "@bb/server-kit/db/event-read";
import * as eventLog from "@bb/server-kit/db/events";
import * as queue from "@bb/server-kit/db/queued-messages";
import { findThreadListRow } from "@bb/server-kit/db/thread-read";
import * as store from "@bb/server-kit/db/threads";
import { ApiError, threadNotFound } from "@bb/server-kit/http/errors";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import { ThreadSerial } from "@bb/server-kit/threads/serial";
import * as core from "./core.js";
import { createThread } from "./create.js";
import * as dispatching from "./dispatch.js";
import { ingestThreadEvents } from "./ingest.js";
import * as interactions from "./interactions.js";
import * as lifecycle from "./lifecycle.js";
import * as mutations from "./mutations.js";
import * as notices from "./parent-notices.js";
import { beginProvisioning } from "./provisioning.js";
import {
  toThreadListEntries,
  toThreadResponse,
} from "@bb/server-kit/threads/thread-display";
import { cancelToolCall, startToolCall } from "./tool-calls.js";

type ThreadRow = store.ThreadRow;
type Outbox = core.Outbox;
type DeleteConfirmation = { childThreadsConfirmed: boolean };

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
  private readonly serial = new ThreadSerial();
  private readonly runtimes = new Map<string, core.ThreadRuntime>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly disposers: (() => void)[] = [];

  constructor(readonly ctx: PluginServerApi) {}

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
    const out = new core.Outbox(this.ctx.realtime);
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
    return store.requireThread(this.ctx.db, threadId);
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
    if (row === undefined) throw threadNotFound();
    return row;
  }

  statusMetadata(threadId: string): domain.ThreadChangeMetadata {
    const [entry] = toThreadListEntries(this.ctx, [this.listed(threadId)]);
    const { projectId, status, runtime, activity } = entry;
    const { latestAttentionAt, updatedAt } = entry;
    const times = { latestAttentionAt, updatedAt };
    return { projectId, statusChange: { status, runtime, activity, ...times } };
  }

  announceStatus(threadId: string): void {
    if (store.getThread(this.ctx.db, threadId) === undefined) return;
    const metadata = this.statusMetadata(threadId);
    this.ctx.realtime.thread(threadId, ["status-changed"], metadata);
  }

  respond(threadId: string): ThreadResponse {
    return toThreadResponse(this.ctx, this.listed(threadId));
  }

  append(out: Outbox, thread: ThreadRow, events: RunnerThreadEvent[]): void {
    eventLog.appendEvents(this.ctx.db, thread, events, "server");
    const eventTypes = [...new Set(events.map((event) => event.type))];
    out.thread(thread.id, ["events-appended"], { eventTypes });
    out.after(() => this.announce(threadOps.appended, thread.id, eventTypes));
  }

  announce(
    event: typeof threadOps.appended,
    threadId: string,
    types: string[],
  ): void {
    this.ctx.emit(event, { threadId, types });
  }

  announceMessage(
    event:
      | typeof threadOps.messageQueued
      | typeof threadOps.messageDispatched
      | typeof threadOps.messageCancelled,
    threadId: string,
    queuedMessageId: string,
  ): void {
    this.ctx.emit(event, { threadId, queuedMessageId });
  }

  private emitStatus(thread: ThreadRow): void {
    const { db } = this.ctx;
    const response = this.respond(thread.id);
    if (thread.status === "active") {
      this.ctx.emit(threadOps.active, { thread: response });
    } else if (thread.status === "idle") {
      const text = lastOutput(db, thread.id);
      const payload = { thread: response, lastAssistantText: text };
      this.ctx.emit(threadOps.idle, payload);
    } else if (thread.status === "error") {
      const failure = eventLog.lastSystemError(db, thread.id);
      const error = failure?.message ?? null;
      this.ctx.emit(threadOps.failed, { thread: response, error, failure });
    }
  }

  transition(
    out: Outbox,
    threadId: string,
    type: domain.ThreadLifecycleEventType,
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
    const scope = domain.threadScope();
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
    from: readonly (domain.QueuedMessageWaitingOnKind | null)[],
    to: domain.QueuedMessageWaitingOn | null,
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

  assertWritable(thread: ThreadRow): void {
    const hostId = this.hostOf(thread);
    if (hostId !== null) assertHostUsable(this.ctx, hostId);
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

export function createThreadEngine(ctx: PluginServerApi) {
  const engine = new Engine(ctx);
  const kernel = ctx;
  const own = ctx;
  const direct =
    <Args extends unknown[], Result>(
      run: (engine: Engine, ...args: Args) => Result,
    ) =>
    (...args: Args) =>
      run(engine, ...args);
  const serialized =
    <Args extends unknown[], Result>(
      run: (
        engine: Engine,
        threadId: string,
        ...args: Args
      ) => Result | Promise<Result>,
    ) =>
    (threadId: string, ...args: Args) =>
      engine.inThread(threadId, () => run(engine, threadId, ...args));
  const writes =
    <Args extends unknown[], Result>(
      run: (threadId: string, ...args: Args) => Result,
    ) =>
    (threadId: string, ...args: Args) => {
      const thread = store.getThread(ctx.db, threadId);
      if (thread !== undefined) engine.assertWritable(thread);
      return run(threadId, ...args);
    };
  const create = direct(createThread);
  const send = writes(serialized(mutations.send));
  const stop = writes(direct(lifecycle.stopThread));
  const archive = writes(direct(lifecycle.archiveThreadTree));
  const unarchive = writes(serialized(lifecycle.unarchiveThread));
  const remove = writes(direct(lifecycle.deleteThreadTree));
  own.implement(threadOps.create, (request) => create(request));
  own.implement(threadOps.send, (input) => send(input.threadId, input.request));
  own.implement(threadOps.stop, ({ threadId }) => stop(threadId));
  own.implement(threadOps.archive, ({ threadId }) => archive(threadId));
  own.implement(threadOps.unarchive, ({ threadId }) => unarchive(threadId));
  own.implement(threadOps.delete, ({ threadId, ...confirmation }) =>
    remove(threadId, confirmation),
  );
  own.implement(threadOps.hold, () => null);
  own.implement(threadOps.release, ({ threadId }) => {
    engine.scheduleDrain(threadId);
  });
  own.implement(threadOps.storageLocation, ({ threadId }) => {
    const hostId = engine.hostOf(engine.requireThread(threadId));
    const root =
      hostId === null
        ? null
        : findHost(ctx.db, "id", hostId)?.threadStorageRoot;
    return root == null || hostId === null
      ? null
      : { hostId, path: join(root, threadId) };
  });
  own.implement(threadOps.addRow, (input, { caller }) => {
    const pluginId = caller.via.at(-1);
    if (pluginId === undefined) {
      throw new ApiError(400, "not_a_plugin", "Only a plugin can add a row");
    }
    return engine.inThread(input.threadId, () =>
      mutations.addPluginRow(engine, pluginId, input),
    );
  });
  const routed = <Args extends unknown[], Result>(
    op: ThreadWriteOp,
    run: (threadId: string, ...args: Args) => Result,
  ) => {
    own.implement(op, ({ threadId, args }) => run(threadId, ...(args as Args)));
    return (threadId: string, ...args: Args) =>
      kernel.call(op, { threadId, args }) as Promise<Awaited<Result>>;
  };
  return {
    start: () => engine.start(),
    close: () => engine.close(),
    settled: () => engine.settled(),
    sweep: direct(lifecycle.sweep),
    create: (request: CreateThreadRequest) =>
      kernel.call(threadOps.create, request),
    get: (threadId: string) => {
      const thread = store.getThread(ctx.db, threadId);
      const gone = thread === undefined || thread.deletedAt !== null;
      return gone ? null : engine.respond(threadId);
    },
    workspaceOf: (threadId: string) =>
      dispatching.sessionEnvironmentOf(engine, engine.requireThread(threadId)),
    send: (threadId: string, request: SendMessageRequest) =>
      kernel.call(threadOps.send, { threadId, request }),
    stop: (threadId: string) => kernel.call(threadOps.stop, { threadId }),
    compact: routed(threadOps.compact, writes(direct(mutations.compact))),
    clearContext: routed(
      threadOps.clearContext,
      writes(serialized(lifecycle.clearContext)),
    ),
    archive: (threadId: string) => kernel.call(threadOps.archive, { threadId }),
    unarchive: (threadId: string) =>
      kernel.call(threadOps.unarchive, { threadId }),
    delete: (threadId: string, confirmation: DeleteConfirmation) =>
      kernel.call(threadOps.delete, { threadId, ...confirmation }),
    releaseDeletedProject: direct(lifecycle.releaseDeletedProject),
    update: routed(threadOps.update, serialized(mutations.update)),
    pin: serialized(mutations.pin),
    unpin: serialized(mutations.unpin),
    reorderPinned: direct(mutations.reorderPinned),
    markRead: serialized(mutations.markRead),
    markUnread: serialized(mutations.markUnread),
    createQueuedMessage: routed(
      threadOps.queueMessage,
      writes(serialized(mutations.createQueuedMessage)),
    ),
    updateQueuedMessage: routed(
      threadOps.editQueuedMessage,
      writes(serialized(mutations.updateQueuedMessage)),
    ),
    deleteQueuedMessage: routed(
      threadOps.dropQueuedMessage,
      writes(serialized(mutations.deleteQueuedMessage)),
    ),
    sendQueuedMessageNow: routed(
      threadOps.sendQueuedMessage,
      writes(serialized(mutations.sendQueuedMessageNow)),
    ),
    resolveInteraction: routed(
      interactionOps.resolve,
      writes(serialized(interactions.resolveProviderInteraction)),
    ),
    respondToInteraction: routed(
      interactionOps.respond,
      writes(serialized(interactions.respondToInteraction)),
    ),
    cancelInteraction: routed(
      interactionOps.cancel,
      writes(serialized(interactions.cancelByUser)),
    ),
    requestInput: direct(interactions.requestInput),
  };
}

export type ThreadEngine = ReturnType<typeof createThreadEngine>;
