import { join } from "node:path";
import * as domain from "@bb/domain";
import {
  interactions as interactionOps,
  threads as threadOps,
} from "@bb/plugin";
import type { RunnerThreadEvent } from "@bb/runner";
import type { ThreadResponse } from "@bb/server-contract";
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

  constructor(readonly bb: PluginServerApi) {}

  inThread<T>(threadId: string, work: () => T | Promise<T>): Promise<T> {
    return this.serial.run(threadId, work);
  }

  background(label: string, work: Promise<unknown>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.bb.log.error("Thread engine work failed", { err: error, label });
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
    return Promise.resolve().then(() => call(this.bb.runners.get(hostId)));
  }

  commit<T>(work: (out: Outbox) => T): T {
    const out = new core.Outbox(this.bb.realtime);
    const result = this.bb.db.transaction(() => work(out));
    out.flush((err) => this.bb.log.error("Thread follow-up failed", { err }));
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
    return store.requireThread(this.bb.db, threadId);
  }

  hostOf(thread: ThreadRow): string | null {
    const { environmentId } = thread;
    if (environmentId === null) return null;
    return getEnvironment(this.bb.db, environmentId)?.hostId ?? null;
  }

  connectedHostOf(thread: ThreadRow): string | null {
    const hostId = this.hostOf(thread);
    const online = hostId !== null && this.bb.runners.isConnected(hostId);
    return online ? hostId : null;
  }

  private listed(threadId: string) {
    const row = findThreadListRow(this.bb.db, threadId);
    if (row === undefined) throw threadNotFound();
    return row;
  }

  statusMetadata(threadId: string): domain.ThreadChangeMetadata {
    const [entry] = toThreadListEntries(this.bb, [this.listed(threadId)]);
    const { projectId, status, runtime, activity } = entry;
    const { latestAttentionAt, updatedAt } = entry;
    const times = { latestAttentionAt, updatedAt };
    return { projectId, statusChange: { status, runtime, activity, ...times } };
  }

  announceStatus(threadId: string): void {
    if (store.getThread(this.bb.db, threadId) === undefined) return;
    const metadata = this.statusMetadata(threadId);
    this.bb.realtime.thread(threadId, ["status-changed"], metadata);
  }

  respond(threadId: string): ThreadResponse {
    return toThreadResponse(this.bb, this.listed(threadId));
  }

  append(out: Outbox, thread: ThreadRow, events: RunnerThreadEvent[]): void {
    eventLog.appendEvents(this.bb.db, thread, events, "server");
    const eventTypes = [...new Set(events.map((event) => event.type))];
    out.thread(thread.id, ["events-appended"], { eventTypes });
    out.after(() => this.announce(threadOps.appended, thread.id, eventTypes));
  }

  announce(
    event: typeof threadOps.appended,
    threadId: string,
    types: string[],
  ): void {
    this.bb.emit(event, { threadId, types });
  }

  announceMessage(
    event:
      | typeof threadOps.messageQueued
      | typeof threadOps.messageDispatched
      | typeof threadOps.messageDeleted,
    threadId: string,
    queuedMessageId: string,
  ): void {
    this.bb.emit(event, { threadId, queuedMessageId });
  }

  private emitStatus(thread: ThreadRow): void {
    const { db } = this.bb;
    const response = this.respond(thread.id);
    if (thread.status === "active") {
      this.bb.emit(threadOps.active, { thread: response });
    } else if (thread.status === "idle") {
      const text = lastOutput(db, thread.id);
      const payload = { thread: response, lastAssistantText: text };
      this.bb.emit(threadOps.idle, payload);
    } else if (thread.status === "error") {
      const failure = eventLog.lastSystemError(db, thread.id);
      const error = failure?.message ?? null;
      this.bb.emit(threadOps.failed, { thread: response, error, failure });
    }
  }

  transition(
    out: Outbox,
    threadId: string,
    type: domain.ThreadLifecycleEventType,
  ): store.LifecycleOutcome {
    const outcome = store.applyLifecycleEvent(this.bb.db, threadId, type);
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
    const { db } = this.bb;
    const rows = queue
      .listQueuedMessages(db, threadId)
      .filter((row) => from.includes(queue.parseQueuedWait(row)?.kind ?? null));
    if (rows.length === 0) return;
    queue.setQueuedMessageWait(db, rows, to);
    out.thread(threadId, ["queue-changed"]);
  }

  setTitle(out: Outbox, thread: ThreadRow, title: string | null): void {
    store.patchThread(this.bb.db, thread.id, { title });
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
    const thread = store.getThread(this.bb.db, threadId);
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
    if (hostId !== null) assertHostUsable(this.bb, hostId);
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
    const sender = store.getThread(this.bb.db, senderThreadId);
    if (sender !== undefined && sender.deletedAt === null) return sender.id;
    const reason = sender === undefined ? "not_found" : "deleted";
    const details = { reason, subject: "sender" };
    const message = "Sender thread is invalid";
    throw new ApiError(400, "parent_thread_invalid", message, { details });
  }

  start(): void {
    const { runners } = this.bb;
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

export function createThreadEngine(bb: PluginServerApi) {
  const engine = new Engine(bb);
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
      const thread = store.getThread(bb.db, threadId);
      if (thread !== undefined) engine.assertWritable(thread);
      return run(threadId, ...args);
    };
  const create = direct(createThread);
  const send = writes(serialized(mutations.send));
  const stop = writes(direct(lifecycle.stopThread));
  const archive = writes(direct(lifecycle.archiveThreadTree));
  const unarchive = writes(serialized(lifecycle.unarchiveThread));
  const remove = writes(direct(lifecycle.deleteThreadTree));
  bb.implement(threadOps.create, (request) => create(request));
  bb.implement(threadOps.send, ({ threadId, ...request }) =>
    send(threadId, request),
  );
  bb.implement(threadOps.stop, ({ threadId }) => stop(threadId));
  bb.implement(threadOps.archive, async ({ threadId }) => {
    const archivedThreadIds = await archive(threadId);
    return { ok: true as const, archivedThreadIds };
  });
  bb.implement(threadOps.unarchive, ({ threadId }) => unarchive(threadId));
  bb.implement(threadOps.delete, ({ threadId, ...confirmation }) =>
    remove(threadId, confirmation),
  );
  bb.implement(threadOps.hold, () => null);
  bb.implement(threadOps.release, ({ threadId }) => {
    engine.scheduleDrain(threadId);
  });
  bb.implement(threadOps.storageLocation, ({ threadId }) => {
    const hostId = engine.hostOf(engine.requireThread(threadId));
    const root =
      hostId === null ? null : findHost(bb.db, "id", hostId)?.threadStorageRoot;
    return root == null || hostId === null
      ? null
      : { hostId, path: join(root, threadId) };
  });
  bb.implement(threadOps.addRow, (input, { caller }) => {
    const pluginId = caller.via.at(-1);
    if (pluginId === undefined) {
      throw new ApiError(400, "not_a_plugin", "Only a plugin can add a row");
    }
    return engine.inThread(input.threadId, () =>
      mutations.addPluginRow(engine, pluginId, input),
    );
  });
  const update = serialized(mutations.update);
  const compact = writes(direct(mutations.compact));
  const clearContext = writes(serialized(lifecycle.clearContext));
  const queue = writes(serialized(mutations.createQueuedMessage));
  const requeue = writes(serialized(mutations.updateQueuedMessage));
  const unqueue = writes(serialized(mutations.deleteQueuedMessage));
  const sendQueued = writes(serialized(mutations.sendQueuedMessageNow));
  const resolve = writes(serialized(interactions.resolveProviderInteraction));
  const respond = writes(serialized(interactions.respondToInteraction));
  const cancel = writes(serialized(interactions.cancelByUser));
  const pin = serialized(mutations.pin);
  const unpin = serialized(mutations.unpin);
  const markRead = serialized(mutations.markRead);
  const markUnread = serialized(mutations.markUnread);
  bb.implement(threadOps.update, ({ threadId, ...patch }) =>
    update(threadId, patch),
  );
  bb.implement(threadOps.compact, ({ threadId }) => compact(threadId));
  bb.implement(threadOps.clearContext, ({ threadId }) =>
    clearContext(threadId),
  );
  bb.implement(threadOps.pin, ({ threadId }) => pin(threadId));
  bb.implement(threadOps.unpin, ({ threadId }) => unpin(threadId));
  bb.implement(threadOps.reorderPinned, ({ threadId, ...request }) =>
    mutations.reorderPinned(engine, threadId, request),
  );
  bb.implement(threadOps.markRead, ({ threadId }) => markRead(threadId));
  bb.implement(threadOps.markUnread, ({ threadId }) => markUnread(threadId));
  bb.implement(threadOps.createQueuedMessage, ({ threadId, ...request }) =>
    queue(threadId, request),
  );
  bb.implement(threadOps.updateQueuedMessage, (input) => {
    const { threadId, queuedMessageId, ...request } = input;
    return requeue(threadId, queuedMessageId, request);
  });
  bb.implement(threadOps.deleteQueuedMessage, (input) =>
    unqueue(input.threadId, input.queuedMessageId),
  );
  bb.implement(threadOps.sendQueuedMessage, (input) =>
    sendQueued(input.threadId, input.queuedMessageId, input.mode),
  );
  bb.implement(interactionOps.resolve, (input) =>
    resolve(input.threadId, input.interactionId, input.resolution),
  );
  bb.implement(interactionOps.respond, (input) => {
    const { threadId, interactionId, value } = input;
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > domain.PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES) {
      const message = "Interaction response exceeds 64 KiB";
      throw new ApiError(413, "invalid_request", message);
    }
    return respond(threadId, interactionId, value);
  });
  bb.implement(interactionOps.cancel, (input) =>
    cancel(input.threadId, input.interactionId),
  );
  bb.implement(interactionOps.ask, (request, { caller }) => {
    const { threadId, rendererId, title, payload, timeoutMs } = request;
    const timeout =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const limits = [request.signal, timeout];
    const signal = AbortSignal.any(
      limits.filter((limit) => limit !== undefined),
    );
    const presentation = domain.threadEventItemPresentationSchema.safeParse(
      request.presentation,
    ).data;
    const { describeSubmission } = request;
    const form = { threadId, rendererId, title, payload, presentation };
    const pluginId = caller.via.at(-1) ?? "core";
    const origin = { pluginId, signal, describeSubmission };
    return interactions.requestInput(engine, { ...form, ...origin });
  });
  return {
    start: () => engine.start(),
    close: () => engine.close(),
    settled: () => engine.settled(),
    sweep: direct(lifecycle.sweep),
    workspaceOf: (threadId: string) =>
      dispatching.sessionEnvironmentOf(engine, engine.requireThread(threadId)),
    releaseDeletedProject: direct(lifecycle.releaseDeletedProject),
  };
}

export type ThreadEngine = ReturnType<typeof createThreadEngine>;
