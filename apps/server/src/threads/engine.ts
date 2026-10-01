import {
  createStandaloneBuiltinCompactCommandInput,
  threadScope,
  type JsonValue,
  type PendingInteraction,
  type PendingInteractionResolution,
  type QueuedMessageWaitingOn,
  type QueuedMessageWaitingOnKind,
  type ThreadChangeKind,
  type ThreadChangeMetadata,
  type ThreadLifecycleEventType,
  type ThreadListEntry,
  type ThreadQueuedMessage,
  type ThreadRuntimeState,
} from "@bb/domain";
import type { RunnerThreadEvent } from "@bb/runner";
import type {
  CreateQueuedMessageRequest,
  CreateThreadRequest,
  ParentThreadInvalidErrorDetails,
  ReorderPinnedThreadRequest,
  ReorderQueuedMessageRequest,
  SendMessageRequest,
  SendMessageResponse,
  SendQueuedMessageMode,
  SetQueuedMessageGroupBoundaryRequest,
  ThreadResponse,
  UpdateQueuedMessageRequest,
  UpdateThreadRequest,
} from "@bb/server-contract";
import {
  getEnvironmentRow,
  threadSectionExists,
} from "../db/engine-lookups.js";
import {
  appendEvents,
  lastAssistantText,
  lastSystemErrorMessage,
  type StoredEvent,
} from "../db/events.js";
import { newId } from "../db/index.js";
import {
  deleteQueuedMessages,
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  parseQueuedWait,
  reorderQueuedMessage,
  setQueuedMessageGroupBoundary,
  setQueuedMessageWait,
  toThreadQueuedMessage,
  updateQueuedMessageContent,
  type QueueOrderOutcome,
} from "../db/queued-messages.js";
import {
  applyLifecycleEvent,
  getThread,
  listPinnedThreadEntries,
  patchThread,
  pinThread,
  reorderPinnedThread,
  threadActivity,
  toThreadResponse,
  type LifecycleOutcome,
  type ThreadPatch,
  type ThreadRow,
} from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import type { ThreadEngine } from "./api.js";
import {
  conflict,
  notWritable,
  Outbox,
  threadNotFound,
  ThreadSerial,
  type EngineContext,
  type ThreadRuntime,
} from "./core.js";
import { createThread, requireValidParent } from "./create.js";
import {
  dispatchMessage,
  drainQueue,
  sendQueuedMessageNow,
  type Delivery,
  type DispatchArgs,
} from "./dispatch.js";
import { resolveTurnExecution, stickyOverrides } from "./execution.js";
import { ingestThreadEvents } from "./ingest.js";
import {
  cancelPluginInteraction,
  cancelProviderInteraction,
  interruptInteractions,
  openPluginInteraction,
  registerProviderInteraction,
  resolveProviderInteraction,
  respondToInteraction,
  type InputWaiter,
  type PluginInputRequest,
  type PluginInputResult,
} from "./interactions.js";
import {
  archiveThreadTree,
  deleteThreadTree,
  onHostDisconnected,
  reconcileHost,
  recoverAfterRestart,
  resetContext,
  stopThread,
  sweep,
  unarchiveThread,
} from "./lifecycle.js";
import {
  notifyOwnershipChange,
  notifyParentBlocked,
  queueChildOutcome,
  type ChildOutcome,
  type NoticeBatch,
} from "./parent-notices.js";
import { beginProvisioning } from "./provisioning.js";
import { cancelToolCall, startToolCall } from "./tool-calls.js";

interface ThreadFailure {
  code: string;
  message: string;
  detail: string;
}

const SWEEP_INTERVAL_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

function toSendResponse(outcome: Delivery): SendMessageResponse {
  if (outcome.delivery === "sent") return { ok: true, delivery: "sent" };
  const queuedMessage = toThreadQueuedMessage(outcome.row);
  return { ok: true, delivery: "queued", queuedMessage };
}

function queueOrderRows(outcome: QueueOrderOutcome): ThreadQueuedMessage[] {
  switch (outcome.kind) {
    case "ok":
      return outcome.rows.map(toThreadQueuedMessage);
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "stale_neighbor":
      throw conflict("Queued message order changed");
    case "invalid_neighbor_order":
      throw conflict("Queued message order is invalid");
    case "invalid_sender":
      throw conflict(
        "Queued messages from different senders cannot be grouped",
      );
    case "invalid_execution_options":
      throw conflict(
        "Queued messages with different execution options cannot be grouped",
      );
  }
}

export class Engine implements ThreadEngine {
  readonly inputWaiters = new Map<string, InputWaiter>();
  readonly toolCalls = new Map<string, AbortController>();
  readonly noticeBatches = new Map<string, NoticeBatch>();
  private readonly serial = new ThreadSerial();
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly disposers: (() => void)[] = [];

  constructor(readonly ctx: EngineContext) {}

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

  commit<T>(work: (out: Outbox) => T): T {
    const out = new Outbox(this.ctx.hub);
    const result = this.ctx.db.transaction(() => work(out));
    out.flush();
    return result;
  }

  runtimeOf(threadId: string): ThreadRuntime {
    const existing = this.runtimes.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadRuntime = {
      provisioning: null,
      pendingStart: null,
      cancelledStart: null,
    };
    this.runtimes.set(threadId, created);
    return created;
  }

  forget(threadId: string): void {
    this.runtimes.delete(threadId);
  }

  hostOf(thread: ThreadRow): string | null {
    if (thread.environmentId === null) return null;
    return getEnvironmentRow(this.ctx.db, thread.environmentId)?.hostId ?? null;
  }

  private displayState(
    thread: ThreadRow,
    hostId: string | null,
  ): ThreadRuntimeState {
    const offline = hostId !== null && !this.ctx.runners.isConnected(hostId);
    const waiting = thread.status === "active" && offline;
    return { displayStatus: waiting ? "waiting-for-host" : thread.status };
  }

  statusMetadata(thread: ThreadRow): ThreadChangeMetadata {
    return {
      projectId: thread.projectId,
      statusChange: {
        status: thread.status,
        runtime: this.displayState(thread, this.hostOf(thread)),
        activity: threadActivity(this.ctx.db, thread.id),
        latestAttentionAt: thread.latestAttentionAt,
        updatedAt: thread.updatedAt,
      },
    };
  }

  announceStatus(threadId: string): void {
    const thread = getThread(this.ctx.db, threadId);
    if (thread === undefined) return;
    const metadata = this.statusMetadata(thread);
    this.ctx.hub.thread(threadId, ["status-changed"], metadata);
  }

  respond(thread: ThreadRow): ThreadResponse {
    const runtime = this.displayState(thread, this.hostOf(thread));
    return toThreadResponse(this.ctx.db, thread, runtime);
  }

  append(
    out: Outbox,
    thread: ThreadRow,
    events: RunnerThreadEvent[],
  ): StoredEvent[] {
    const stored = appendEvents(this.ctx.db, thread, events, "server");
    const eventTypes = [...new Set(events.map((event) => event.type))];
    out.thread(thread.id, ["events-appended"], { eventTypes });
    return stored;
  }

  private emitStatus(thread: ThreadRow): void {
    const { db, extensions } = this.ctx;
    const response = this.respond(thread);
    if (thread.status === "active") {
      extensions.emit("thread.active", { thread: response });
    } else if (thread.status === "idle") {
      const text = lastAssistantText(db, thread.id);
      extensions.emit("thread.idle", {
        thread: response,
        lastAssistantText: text,
      });
    } else if (thread.status === "error") {
      const error = lastSystemErrorMessage(db, thread.id);
      extensions.emit("thread.failed", { thread: response, error });
    }
  }

  transition(
    out: Outbox,
    threadId: string,
    type: ThreadLifecycleEventType,
  ): LifecycleOutcome {
    const outcome = applyLifecycleEvent(this.ctx.db, threadId, type);
    if (!outcome.applied) return outcome;
    const { thread } = outcome;
    out.thread(threadId, ["status-changed"], this.statusMetadata(thread));
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
    const lifecycle = stopping ? "stop.settled" : "run.failed";
    const outcome = this.transition(out, thread.id, lifecycle);
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
    const rows = listQueuedMessages(db, threadId).filter((row) =>
      from.includes(parseQueuedWait(row)?.kind ?? null),
    );
    if (rows.length === 0) return;
    setQueuedMessageWait(db, rows, to);
    out.thread(threadId, ["queue-changed"]);
  }

  setTitle(out: Outbox, thread: ThreadRow, title: string | null): void {
    patchThread(this.ctx.db, thread.id, { title });
    const { projectId } = thread;
    out.thread(thread.id, ["title-changed"], { projectId });
  }

  renameSession(thread: ThreadRow, title: string): void {
    const { runners } = this.ctx;
    const hostId = this.hostOf(thread);
    if (hostId === null || !runners.isConnected(hostId)) return;
    const threadId = thread.id;
    const renamed = runners.get(hostId).renameSession({ threadId, title });
    this.background("rename session", renamed);
  }

  adoptTitle(threadId: string, title: string): void {
    const thread = getThread(this.ctx.db, threadId);
    if (thread === undefined || thread.title !== null) return;
    this.commit((out) => this.setTitle(out, thread, title));
    if (thread.providerThreadId !== null) this.renameSession(thread, title);
  }

  interruptRunnerTurn(thread: ThreadRow): void {
    const hostId = this.hostOf(thread);
    if (hostId === null) return;
    const threadId = thread.id;
    const interrupted = Promise.resolve().then(() =>
      this.ctx.runners.get(hostId).interruptTurn({ threadId }),
    );
    this.background("interrupt turn", interrupted);
  }

  scheduleDrain(threadId: string): void {
    this.later(threadId, "drain queue", () => drainQueue(this, threadId));
  }

  dispatch(threadId: string, args: DispatchArgs): Promise<Delivery> {
    return dispatchMessage(this, threadId, args);
  }

  beginProvisioning(thread: ThreadRow, args: DispatchArgs): void {
    beginProvisioning(this, thread, args);
  }

  resetContext(thread: ThreadRow): Promise<void> {
    return resetContext(this, thread);
  }

  interruptInteractions(
    out: Outbox,
    thread: ThreadRow,
    reason: string,
    scope: "all" | "provider" = "all",
  ): void {
    interruptInteractions(this, out, thread, reason, scope);
  }

  notifyParent(out: Outbox, child: ThreadRow, outcome: ChildOutcome): void {
    out.after(() => queueChildOutcome(this, child, outcome));
  }

  notifyParentBlocked(child: ThreadRow, interaction: PendingInteraction): void {
    notifyParentBlocked(this, child, interaction);
  }

  private requireThread(threadId: string): ThreadRow {
    const thread = getThread(this.ctx.db, threadId);
    if (thread === undefined || thread.deletedAt !== null) {
      throw threadNotFound();
    }
    return thread;
  }

  private requireQueueWritable(threadId: string): ThreadRow {
    const thread = this.requireThread(threadId);
    if (thread.archivedAt === null) return thread;
    throw notWritable(thread, "archived", "Thread is archived");
  }

  private senderOf(thread: ThreadRow, senderThreadId: string | undefined) {
    if (senderThreadId === undefined || senderThreadId === thread.id) {
      return null;
    }
    const sender = getThread(this.ctx.db, senderThreadId);
    if (sender !== undefined && sender.deletedAt === null) return sender.id;
    const reason = sender === undefined ? "not_found" : "deleted";
    const details: ParentThreadInvalidErrorDetails = {
      reason,
      subject: "sender",
    };
    const message = "Sender thread is invalid";
    throw new ApiError(400, "parent_thread_invalid", message, { details });
  }

  start(): void {
    const { runners } = this.ctx;
    this.disposers.push(
      runners.onEvent("thread.events", (event, hostId) =>
        this.inThread(event.threadId, () =>
          ingestThreadEvents(this, hostId, event.threadId, event.events),
        ),
      ),
      runners.onEvent("interaction.requested", (event, hostId) =>
        this.inThread(event.threadId, () =>
          registerProviderInteraction(this, hostId, event),
        ),
      ),
      runners.onEvent("interaction.cancelled", (event) =>
        this.inThread(event.threadId, () =>
          cancelProviderInteraction(this, event),
        ),
      ),
      runners.onEvent("toolCall.requested", (event, hostId) =>
        startToolCall(this, hostId, event),
      ),
      runners.onEvent("toolCall.cancelled", (event) =>
        cancelToolCall(this, event.requestId),
      ),
      runners.onConnected((hostId) =>
        this.background("reconcile host", reconcileHost(this, hostId)),
      ),
      runners.onDisconnected((hostId) => onHostDisconnected(this, hostId)),
    );
    recoverAfterRestart(this);
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
    this.disposers.push(() => clearInterval(timer));
    this.sweep();
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

  sweep(): void {
    sweep(this);
  }

  create(request: CreateThreadRequest): Promise<ThreadResponse> {
    return createThread(this, request);
  }

  send(
    threadId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.inThread(threadId, async () => {
      const thread = this.requireThread(threadId);
      const senderThreadId = this.senderOf(thread, request.senderThreadId);
      const authored = senderThreadId === null;
      const outcome = await this.dispatch(threadId, {
        message: {
          input: request.input,
          execution: resolveTurnExecution(this.ctx.db, thread, request),
          senderThreadId,
          initiator: authored ? "user" : "agent",
          systemNotice: null,
          origin: null,
          originPluginId: null,
          overrides: authored ? stickyOverrides(request) : {},
        },
        mode: request.mode,
        sendAt: request.sendAt ?? null,
        rows: [],
        sendNow: false,
      });
      return toSendResponse(outcome);
    });
  }

  stop(threadId: string): Promise<void> {
    return stopThread(this, threadId);
  }

  async compact(threadId: string): Promise<void> {
    const thread = this.requireThread(threadId);
    if (thread.status !== "idle" && thread.status !== "error") {
      const state = "the thread is idle or errored";
      throw conflict(`Context can only be compacted while ${state}`);
    }
    const input = createStandaloneBuiltinCompactCommandInput();
    await this.send(threadId, { input, mode: "start" });
  }

  clearContext(threadId: string): Promise<void> {
    return this.inThread(threadId, () =>
      resetContext(this, this.requireThread(threadId)),
    );
  }

  archive(threadId: string): Promise<string[]> {
    return archiveThreadTree(this, threadId);
  }

  unarchive(threadId: string): Promise<void> {
    return this.inThread(threadId, () => unarchiveThread(this, threadId));
  }

  delete(
    threadId: string,
    options: { childThreadsConfirmed: boolean },
  ): Promise<void> {
    return deleteThreadTree(this, threadId, options.childThreadsConfirmed);
  }

  update(
    threadId: string,
    patch: UpdateThreadRequest,
  ): Promise<ThreadResponse> {
    return this.inThread(threadId, () => {
      const { db } = this.ctx;
      const thread = this.requireThread(threadId);
      const { parentThreadId, sectionId, title, visibility } = patch;
      if (parentThreadId != null)
        requireValidParent(db, parentThreadId, thread);
      if (sectionId != null && !threadSectionExists(db, sectionId)) {
        const message = "Thread section not found";
        throw new ApiError(404, "thread_section_not_found", message);
      }
      const fields: ThreadPatch = {};
      const changes = new Set<ThreadChangeKind>();
      const previousParentId = thread.parentThreadId;
      const reparented =
        parentThreadId !== undefined && parentThreadId !== previousParentId;
      if (title !== undefined) fields.title = title;
      if (sectionId !== undefined) fields.sectionId = sectionId;
      if (visibility !== undefined) fields.visibility = visibility;
      if (patch.model !== undefined) fields.modelOverride = patch.model;
      if (patch.reasoningLevel !== undefined) {
        fields.reasoningLevelOverride = patch.reasoningLevel;
      }
      if (Object.keys(fields).length > 0) changes.add("title-changed");
      if (reparented) {
        fields.parentThreadId = parentThreadId;
        changes.add("parent-changed");
        const released = parentThreadId === null && sectionId === undefined;
        const previous =
          previousParentId === null
            ? undefined
            : getThread(db, previousParentId);
        if (released) fields.sectionId = previous?.sectionId ?? null;
      }
      const updated = this.commit((out) => {
        const next = patchThread(db, threadId, fields) ?? thread;
        const { projectId } = thread;
        if (changes.size > 0) out.thread(threadId, [...changes], { projectId });
        if (reparented) this.recordReparenting(out, next, previousParentId);
        return next;
      });
      const renamed = title != null && title !== thread.title;
      if (renamed) this.renameSession(updated, title);
      return this.respond(updated);
    });
  }

  private recordReparenting(
    out: Outbox,
    thread: ThreadRow,
    previousParentThreadId: string | null,
  ): void {
    const { db } = this.ctx;
    const nextParentThreadId = thread.parentThreadId;
    const titleOf = (id: string | null): string | null => {
      const parent = id === null ? undefined : getThread(db, id);
      return parent?.title ?? parent?.titleFallback ?? null;
    };
    const action =
      previousParentThreadId === null
        ? "assign"
        : nextParentThreadId === null
          ? "release"
          : "transfer";
    const messages = {
      assign: "Thread assigned to parent",
      release: "Thread released from parent",
      transfer: "Thread transferred to new parent",
    };
    this.append(out, thread, [
      {
        type: "system/operation",
        scope: threadScope(),
        operation: "ownership_change",
        operationId: newId("evt"),
        status: "completed",
        message: messages[action],
        metadata: {
          action,
          previousParentThreadId,
          previousParentThreadTitle: titleOf(previousParentThreadId),
          nextParentThreadId,
          nextParentThreadTitle: titleOf(nextParentThreadId),
        },
      },
    ]);
    out.after(() =>
      notifyOwnershipChange(this, thread, previousParentThreadId),
    );
  }

  private patchAndAnnounce(
    threadId: string,
    change: ThreadChangeKind,
    patch: (thread: ThreadRow) => ThreadRow | undefined,
  ): Promise<ThreadResponse> {
    return this.inThread(threadId, () => {
      const thread = this.requireThread(threadId);
      const updated = this.commit((out) => {
        const { projectId } = thread;
        out.thread(threadId, [change], { projectId });
        return patch(thread) ?? thread;
      });
      return this.respond(updated);
    });
  }

  pin(threadId: string): Promise<ThreadResponse> {
    return this.patchAndAnnounce(threadId, "pin-state-changed", () =>
      pinThread(this.ctx.db, threadId),
    );
  }

  unpin(threadId: string): Promise<ThreadResponse> {
    const cleared = { pinnedAt: null, pinSortKey: null };
    return this.patchAndAnnounce(threadId, "pin-state-changed", () =>
      patchThread(this.ctx.db, threadId, cleared),
    );
  }

  async reorderPinned(
    threadId: string,
    request: ReorderPinnedThreadRequest,
  ): Promise<ThreadListEntry[]> {
    const { db, hub } = this.ctx;
    const { projectId } = this.requireThread(threadId);
    const { previousThreadId, nextThreadId } = request;
    const outcome = reorderPinnedThread(
      db,
      threadId,
      previousThreadId,
      nextThreadId,
    );
    if (outcome === "not_pinned") throw conflict("Thread is not pinned");
    if (outcome !== "reordered") throw conflict("Pinned thread order changed");
    hub.thread(threadId, ["pin-state-changed"], { projectId });
    return listPinnedThreadEntries(db, (thread, hostId) =>
      this.displayState(thread, hostId),
    );
  }

  markRead(threadId: string): Promise<ThreadResponse> {
    const lastReadAt = this.ctx.now();
    return this.patchAndAnnounce(threadId, "read-state-changed", () =>
      patchThread(this.ctx.db, threadId, { lastReadAt }),
    );
  }

  markUnread(threadId: string): Promise<ThreadResponse> {
    return this.patchAndAnnounce(threadId, "read-state-changed", () =>
      patchThread(this.ctx.db, threadId, { lastReadAt: null }),
    );
  }

  createQueuedMessage(
    threadId: string,
    request: CreateQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage> {
    return this.inThread(threadId, () => {
      const { db } = this.ctx;
      const thread = this.requireQueueWritable(threadId);
      const stopping = thread.status === "stopping";
      const row = this.commit((out) => {
        out.thread(threadId, ["queue-changed"]);
        return insertQueuedMessage(db, {
          threadId,
          content: request.input,
          senderThreadId: this.senderOf(thread, request.senderThreadId),
          origin: null,
          originPluginId: null,
          systemNotice: null,
          ...resolveTurnExecution(db, thread, request),
          waitingOn: { kind: stopping ? "stopping" : "thread-busy" },
          sendAt: null,
        });
      });
      if (thread.status === "idle") this.scheduleDrain(threadId);
      return toThreadQueuedMessage(row);
    });
  }

  private requireQueuedMessage(threadId: string, queuedMessageId: string) {
    const row = getQueuedMessage(this.ctx.db, threadId, queuedMessageId);
    if (row !== undefined) return row;
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  updateQueuedMessage(
    threadId: string,
    queuedMessageId: string,
    request: UpdateQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage> {
    return this.inThread(threadId, () => {
      this.requireQueueWritable(threadId);
      const row = this.requireQueuedMessage(threadId, queuedMessageId);
      if (row.updatedAt !== request.expectedUpdatedAt) {
        throw conflict("Queued message changed since editing began");
      }
      if (row.systemNotice !== null) {
        throw conflict("System notices cannot be edited");
      }
      updateQueuedMessageContent(this.ctx.db, row, request.input);
      this.ctx.hub.thread(threadId, ["queue-changed"]);
      const updated = this.requireQueuedMessage(threadId, queuedMessageId);
      return toThreadQueuedMessage(updated);
    });
  }

  deleteQueuedMessage(threadId: string, queuedMessageId: string) {
    return this.inThread(threadId, () => {
      this.requireQueuedMessage(threadId, queuedMessageId);
      deleteQueuedMessages(this.ctx.db, [queuedMessageId]);
      this.ctx.hub.thread(threadId, ["queue-changed"]);
    });
  }

  private reorderQueue(threadId: string, reorder: () => QueueOrderOutcome) {
    return this.inThread(threadId, () => {
      this.requireQueueWritable(threadId);
      const rows = queueOrderRows(reorder());
      this.ctx.hub.thread(threadId, ["queue-changed"]);
      return rows;
    });
  }

  reorderQueuedMessage(
    threadId: string,
    id: string,
    request: ReorderQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage[]> {
    return this.reorderQueue(threadId, () =>
      reorderQueuedMessage(this.ctx.db, {
        threadId,
        id,
        previousId: request.previousQueuedMessageId,
        nextId: request.nextQueuedMessageId,
        boundaryId: request.groupBoundaryQueuedMessageId,
      }),
    );
  }

  setQueuedMessageGroupBoundary(
    threadId: string,
    request: SetQueuedMessageGroupBoundaryRequest,
  ): Promise<ThreadQueuedMessage[]> {
    return this.reorderQueue(threadId, () =>
      setQueuedMessageGroupBoundary(
        this.ctx.db,
        threadId,
        request.groupBoundaryQueuedMessageId,
        request.expectedGroupedPrefixQueuedMessageIds,
      ),
    );
  }

  sendQueuedMessageNow(
    threadId: string,
    queuedMessageId: string,
    mode: SendQueuedMessageMode,
  ): Promise<SendMessageResponse> {
    return this.inThread(threadId, async () => {
      this.requireQueueWritable(threadId);
      const outcome = sendQueuedMessageNow(
        this,
        threadId,
        queuedMessageId,
        mode,
      );
      return toSendResponse(await outcome);
    });
  }

  resolveInteraction(
    threadId: string,
    interactionId: string,
    resolution: PendingInteractionResolution,
  ): Promise<PendingInteraction> {
    return this.inThread(threadId, () =>
      resolveProviderInteraction(this, threadId, interactionId, resolution),
    );
  }

  respondToInteraction(
    threadId: string,
    interactionId: string,
    value: JsonValue,
  ): Promise<PendingInteraction> {
    return this.inThread(threadId, () =>
      respondToInteraction(this, threadId, interactionId, value),
    );
  }

  cancelInteraction(
    threadId: string,
    interactionId: string,
  ): Promise<PendingInteraction> {
    return this.inThread(threadId, () =>
      cancelPluginInteraction(this, threadId, interactionId, "user"),
    );
  }

  async requestInput(request: PluginInputRequest): Promise<PluginInputResult> {
    if (request.signal?.aborted) {
      return { outcome: "cancelled", reason: "request-aborted" };
    }
    const opened = await this.inThread(request.threadId, () =>
      openPluginInteraction(this, request),
    );
    return opened.result;
  }
}
