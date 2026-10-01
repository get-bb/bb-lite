import {
  isApprovalPendingInteraction,
  isApprovalPendingInteractionResolution,
  isPluginExtensionInteractionResolution,
  isPluginExtensionPendingInteraction,
  isUserQuestionPendingInteraction,
  isUserQuestionPendingInteractionResolution,
  threadScope,
  toInteractionLifecycle,
  turnScope,
  type JsonValue,
  type PendingInteraction,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type ThreadEventItemPresentation,
} from "@bb/domain";
import {
  findProviderInteraction,
  getPendingInteraction,
  insertPendingInteraction,
  listActiveInteractions,
  settleInteraction,
  toPendingInteraction,
  type InteractionSettlement,
  type PendingInteractionRow,
} from "../db/pending-interactions.js";
import { getThread, type ThreadRow } from "../db/threads.js";
import { ApiError, hostUnavailable, invalidRequest } from "../http/errors.js";
import type { RunnerEventOf } from "../runners/registry.js";
import { conflict, threadNotFound, type Outbox } from "./core.js";
import type { Engine } from "./engine.js";

export interface PluginInputRequest {
  threadId: string;
  pluginId: string;
  rendererId: string;
  title: string;
  payload: JsonValue;
  presentation?: ThreadEventItemPresentation;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type PluginInputResult =
  | { outcome: "submitted"; value: JsonValue }
  | { outcome: "cancelled"; reason: string };

export interface InputWaiter {
  resolve(result: PluginInputResult): void;
  dispose(): void;
}

const ACTIVE = ["pending", "resolving"] as const;
const GONE_REASON = "The provider is no longer waiting for this interaction";

function announce(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  row: PendingInteractionRow,
): PendingInteraction {
  const interaction = toPendingInteraction(row);
  const scope = row.turnId === null ? threadScope() : turnScope(row.turnId);
  const lifecycle = toInteractionLifecycle(interaction);
  const type = "system/interaction/lifecycle";
  engine.append(out, thread, [{ type, scope, interaction: lifecycle }]);
  const active = listActiveInteractions(engine.ctx.db, thread.id);
  out.thread(thread.id, ["interactions-changed"], {
    hasPendingInteraction: active.length > 0,
    projectId: thread.projectId,
  });
  return interaction;
}

function settleWaiter(
  engine: Engine,
  interactionId: string,
  result: PluginInputResult,
): void {
  const waiter = engine.inputWaiters.get(interactionId);
  if (waiter === undefined) return;
  engine.inputWaiters.delete(interactionId);
  waiter.dispose();
  waiter.resolve(result);
}

function settle(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  id: string,
  from: readonly PendingInteractionRow["status"][],
  next: InteractionSettlement,
): PendingInteraction | null {
  const row = settleInteraction(engine.ctx.db, id, from, next);
  if (row === undefined) return null;
  const reason = next.statusReason ?? "thread-stopped";
  if (next.status === "interrupted") {
    out.after(() => settleWaiter(engine, id, { outcome: "cancelled", reason }));
  }
  return announce(engine, out, thread, row);
}

export function interruptInteractions(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  statusReason: string,
  scope: "all" | "provider" = "all",
): void {
  for (const row of listActiveInteractions(engine.ctx.db, thread.id)) {
    if (scope === "provider" && row.originKind !== "provider") continue;
    const next = { status: "interrupted" as const, statusReason };
    settle(engine, out, thread, row.id, ACTIVE, next);
  }
}

function denial(payload: PendingInteractionPayload) {
  if (payload.kind === "approval") return { decision: "deny" as const };
  if (payload.kind === "user_question") {
    return { kind: "user_answer" as const, answers: {} };
  }
  return { kind: "request_answer" as const, value: null };
}

export function registerProviderInteraction(
  engine: Engine,
  hostId: string,
  event: RunnerEventOf<"interaction.requested">,
): void {
  const { db, extensions, runners } = engine.ctx;
  const { threadId, requestId, payload } = event;
  const thread = getThread(db, threadId);
  if (findProviderInteraction(db, threadId, requestId) !== undefined) return;
  const busy = listActiveInteractions(db, threadId).length > 0;
  if (thread === undefined || thread.deletedAt !== null || busy) {
    const resolution = denial(payload);
    const refused = Promise.resolve().then(() =>
      runners
        .get(hostId)
        .resolveInteraction({ threadId, requestId, resolution }),
    );
    engine.background("refuse interaction", refused);
    return;
  }
  engine.commit((out) => {
    const row = insertPendingInteraction(db, {
      threadId,
      originKind: "provider",
      turnId: event.turnId ?? thread.activeTurnId,
      providerId: event.providerId,
      providerThreadId: event.providerThreadId,
      providerRequestId: requestId,
      pluginId: null,
      rendererId: null,
      expiresAt: null,
      payload,
    });
    const interaction = announce(engine, out, thread, row);
    out.after(() => {
      const response = engine.respond(thread);
      extensions.emit("interaction.pending", { thread: response, interaction });
      engine.notifyParentBlocked(thread, interaction);
    });
  });
}

export function cancelProviderInteraction(
  engine: Engine,
  event: RunnerEventOf<"interaction.cancelled">,
): void {
  const { db } = engine.ctx;
  const thread = getThread(db, event.threadId);
  const row = findProviderInteraction(db, event.threadId, event.requestId);
  if (thread === undefined || row === undefined) return;
  engine.commit((out) => {
    const next = { status: "interrupted" as const, statusReason: event.reason };
    settle(engine, out, thread, row.id, ACTIVE, next);
    out.after(() => engine.scheduleDrain(thread.id));
  });
}

function requireInteraction(engine: Engine, threadId: string, id: string) {
  const row = getPendingInteraction(engine.ctx.db, id);
  if (row === undefined || row.threadId !== threadId) {
    const message = "Pending interaction not found";
    throw new ApiError(404, "invalid_request", message);
  }
  return row;
}

function alreadySettled(row: PendingInteractionRow): ApiError {
  return conflict(`Pending interaction ${row.id} is already ${row.status}`);
}

function assertResolutionFits(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (isApprovalPendingInteraction(interaction)) {
    const { availableDecisions } = interaction.payload;
    if (
      isApprovalPendingInteractionResolution(resolution) &&
      availableDecisions.includes(resolution.decision)
    ) {
      return;
    }
    const allowed = availableDecisions.join(", ");
    throw invalidRequest(`This approval accepts a decision of: ${allowed}.`);
  }
  const fits = isUserQuestionPendingInteraction(interaction)
    ? isUserQuestionPendingInteractionResolution(resolution)
    : isPluginExtensionPendingInteraction(interaction) &&
      isPluginExtensionInteractionResolution(resolution);
  if (!fits) throw invalidRequest("The resolution does not fit this request.");
}

function finishResolution(
  engine: Engine,
  threadId: string,
  interactionId: string,
  delivered: boolean,
): void {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined) return;
  engine.commit((out) => {
    const next: InteractionSettlement = delivered
      ? { status: "resolved" }
      : { status: "interrupted", statusReason: GONE_REASON };
    settle(engine, out, thread, interactionId, ["resolving"], next);
    out.after(() => engine.scheduleDrain(threadId));
  });
}

export function resolveProviderInteraction(
  engine: Engine,
  threadId: string,
  interactionId: string,
  resolution: PendingInteractionResolution,
): PendingInteraction {
  const { db, runners } = engine.ctx;
  const row = requireInteraction(engine, threadId, interactionId);
  const thread = getThread(db, threadId);
  if (thread === undefined) throw threadNotFound();
  if (row.status !== "pending") {
    const same = row.resolution === JSON.stringify(resolution);
    if (same && row.status !== "interrupted") return toPendingInteraction(row);
    throw alreadySettled(row);
  }
  const requestId = row.providerRequestId;
  if (row.originKind !== "provider" || requestId === null) {
    throw invalidRequest("Answer a plugin interaction with respond.");
  }
  assertResolutionFits(toPendingInteraction(row), resolution);
  const hostId = engine.hostOf(thread);
  if (hostId === null || !runners.isConnected(hostId)) throw hostUnavailable();
  const resolving = engine.commit((out) => {
    const next = { status: "resolving" as const, resolution };
    return settle(engine, out, thread, row.id, ["pending"], next);
  });
  if (resolving === null) throw alreadySettled(row);
  const delivered = Promise.resolve()
    .then(() =>
      runners
        .get(hostId)
        .resolveInteraction({ threadId, requestId, resolution }),
    )
    .then(
      (result) => result.delivered,
      () => false,
    )
    .then((accepted) =>
      engine.inThread(threadId, () =>
        finishResolution(engine, threadId, row.id, accepted),
      ),
    );
  engine.background("resolve interaction", delivered);
  return resolving;
}

function settlePluginInteraction(
  engine: Engine,
  row: PendingInteractionRow,
  next: InteractionSettlement,
  result: PluginInputResult,
): PendingInteraction {
  const thread = getThread(engine.ctx.db, row.threadId);
  if (thread === undefined) throw threadNotFound();
  return engine.commit((out) => {
    const settled = settle(engine, out, thread, row.id, ACTIVE, next);
    if (settled === null) throw alreadySettled(row);
    out.after(() => settleWaiter(engine, row.id, result));
    return settled;
  });
}

export function respondToInteraction(
  engine: Engine,
  threadId: string,
  interactionId: string,
  value: JsonValue,
): PendingInteraction {
  const row = requireInteraction(engine, threadId, interactionId);
  if (row.originKind === "provider") {
    const resolution = { kind: "request_answer" as const, value };
    return resolveProviderInteraction(engine, threadId, row.id, resolution);
  }
  if (row.status !== "pending") throw alreadySettled(row);
  if (!engine.inputWaiters.has(row.id)) {
    const statusReason = "request-aborted";
    const next = { status: "interrupted" as const, statusReason };
    const result = { outcome: "cancelled" as const, reason: statusReason };
    settlePluginInteraction(engine, row, next, result);
    throw conflict("The plugin is no longer waiting for this interaction");
  }
  const next = {
    status: "resolved" as const,
    resolution: { kind: "plugin_submitted" },
  };
  const result = { outcome: "submitted" as const, value };
  return settlePluginInteraction(engine, row, next, result);
}

export function cancelPluginInteraction(
  engine: Engine,
  threadId: string,
  interactionId: string,
  reason: string,
): PendingInteraction {
  const row = requireInteraction(engine, threadId, interactionId);
  if (row.originKind !== "plugin") {
    const advice = "stop the turn instead";
    throw invalidRequest(`A provider's request cannot be cancelled; ${advice}`);
  }
  const next = { status: "interrupted" as const, statusReason: reason };
  const result = { outcome: "cancelled" as const, reason };
  return settlePluginInteraction(engine, row, next, result);
}

export function openPluginInteraction(
  engine: Engine,
  request: PluginInputRequest,
): { result: Promise<PluginInputResult> } {
  const { db, extensions, now } = engine.ctx;
  const { threadId, signal, timeoutMs } = request;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) throw threadNotFound();
  if (listActiveInteractions(db, threadId).length > 0) {
    throw conflict(`Thread ${threadId} is already awaiting user interaction`);
  }
  const { title, payload: data, presentation } = request;
  const row = engine.commit((out) => {
    const created = insertPendingInteraction(db, {
      threadId,
      originKind: "plugin",
      turnId: null,
      providerId: null,
      providerThreadId: null,
      providerRequestId: null,
      pluginId: request.pluginId,
      rendererId: request.rendererId,
      expiresAt: timeoutMs === undefined ? null : now() + timeoutMs,
      payload: { kind: "plugin", title, data, presentation },
    });
    const interaction = announce(engine, out, thread, created);
    const response = engine.respond(thread);
    out.after(() =>
      extensions.emit("interaction.pending", { thread: response, interaction }),
    );
    return created;
  });
  const cancel = (reason: string): void =>
    engine.later(threadId, "cancel plugin interaction", () => {
      const current = getPendingInteraction(db, row.id);
      if (current === undefined || current.status !== "pending") return;
      cancelPluginInteraction(engine, threadId, row.id, reason);
    });
  const result = new Promise<PluginInputResult>((resolve) => {
    const abort = (): void => cancel("request-aborted");
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => cancel("timeout"), timeoutMs);
    timer?.unref();
    signal?.addEventListener("abort", abort, { once: true });
    const dispose = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    engine.inputWaiters.set(row.id, { resolve, dispose });
    if (signal?.aborted) abort();
  });
  return { result };
}
