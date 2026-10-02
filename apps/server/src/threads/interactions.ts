import * as domain from "@bb/domain";
import type {
  InputRequest,
  InputResult as PluginInputResult,
} from "@bb/plugin";
import * as pending from "../db/pending-interactions.js";
import { getThread, type ThreadRow } from "../db/threads.js";
import { ApiError, hostUnavailable, invalidRequest } from "../http/errors.js";
import type { RunnerEventOf } from "../runners/registry.js";
import { conflict, threadNotFound, type Outbox } from "./core.js";
import type { Engine } from "./engine.js";
import { notifyParentBlocked } from "./parent-notices.js";

type PendingInteraction = domain.PendingInteraction;
type PendingInteractionRow = pending.PendingInteractionRow;
type InteractionSettlement = pending.InteractionSettlement;

export interface PluginInputRequest {
  threadId: string;
  pluginId: string;
  rendererId: string;
  title: string;
  payload: domain.JsonValue;
  presentation?: domain.ThreadEventItemPresentation;
  signal?: AbortSignal;
  describeSubmission?: InputRequest["describeSubmission"];
}

export interface InputWaiter {
  resolve(result: PluginInputResult): void;
  dispose(): void;
  describeSubmission?: InputRequest["describeSubmission"];
}

const ACTIVE = ["pending", "resolving"] as const;
const GONE_REASON = "The provider is no longer waiting for this interaction";

function announce(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  row: PendingInteractionRow,
): PendingInteraction {
  const interaction = pending.toPendingInteraction(row);
  const scope =
    row.turnId === null ? domain.threadScope() : domain.turnScope(row.turnId);
  const lifecycle = domain.toInteractionLifecycle(interaction);
  const type = "system/interaction/lifecycle";
  engine.append(out, thread, [{ type, scope, interaction: lifecycle }]);
  const active = pending.listActiveInteractions(engine.ctx.db, thread.id);
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
  answer?: PluginInputResult,
): PendingInteraction | null {
  const row = pending.settleInteraction(engine.ctx.db, id, from, next);
  if (row === undefined) return null;
  const reason = next.statusReason ?? "thread-stopped";
  const cancelled = { outcome: "cancelled" as const, reason };
  const result = answer ?? cancelled;
  if (next.status !== "resolving") {
    out.after(() => settleWaiter(engine, id, result));
  }
  return announce(engine, out, thread, row);
}

export function interruptAll(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  statusReason: string,
): void {
  const next = { status: "interrupted" as const, statusReason };
  for (const row of pending.listActiveInteractions(engine.ctx.db, thread.id)) {
    settle(engine, out, thread, row.id, ACTIVE, next);
  }
}

function denial(payload: domain.PendingInteractionPayload) {
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
  const { db, plugins } = engine.ctx;
  const { threadId, requestId, payload } = event;
  const thread = getThread(db, threadId);
  const active = pending.listActiveInteractions(db, threadId);
  if (active.some((row) => row.providerRequestId === requestId)) return;
  const known = pending.findProviderInteraction(db, threadId, requestId);
  const busy = active.length > 0 || known !== undefined;
  if (thread === undefined || thread.deletedAt !== null || busy) {
    const resolution = denial(payload);
    const refused = engine.onHost(hostId, (runner) =>
      runner.resolveInteraction({ threadId, requestId, resolution }),
    );
    engine.background("refuse interaction", refused);
    return;
  }
  engine.commit((out) => {
    const row = pending.insertPendingInteraction(db, {
      threadId,
      originKind: "provider",
      turnId: event.turnId ?? thread.activeTurnId,
      providerId: event.providerId,
      providerThreadId: event.providerThreadId,
      providerRequestId: requestId,
      payload,
    });
    const interaction = announce(engine, out, thread, row);
    out.after(() => {
      const response = engine.respond(thread.id);
      plugins.emit("interaction.pending", { thread: response, interaction });
      notifyParentBlocked(engine, thread, interaction);
    });
  });
}

export function cancelProviderInteraction(
  engine: Engine,
  event: RunnerEventOf<"interaction.cancelled">,
): void {
  const { db } = engine.ctx;
  const thread = getThread(db, event.threadId);
  const row = pending.findProviderInteraction(
    db,
    event.threadId,
    event.requestId,
  );
  if (thread === undefined || row === undefined) return;
  engine.commit((out) => {
    const next = { status: "interrupted" as const, statusReason: event.reason };
    settle(engine, out, thread, row.id, ACTIVE, next);
    out.after(() => engine.scheduleDrain(thread.id));
  });
}

function requireInteraction(engine: Engine, threadId: string, id: string) {
  const row = pending.getPendingInteraction(engine.ctx.db, id);
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
  resolution: domain.PendingInteractionResolution,
): void {
  if (domain.isApprovalPendingInteraction(interaction)) {
    const { availableDecisions } = interaction.payload;
    if (
      domain.isApprovalPendingInteractionResolution(resolution) &&
      availableDecisions.includes(resolution.decision)
    ) {
      return;
    }
    const allowed = availableDecisions.join(", ");
    throw invalidRequest(`This approval accepts a decision of: ${allowed}.`);
  }
  const fits = domain.isUserQuestionPendingInteraction(interaction)
    ? domain.isUserQuestionPendingInteractionResolution(resolution)
    : domain.isPluginExtensionPendingInteraction(interaction) &&
      domain.isPluginExtensionInteractionResolution(resolution);
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
  resolution: domain.PendingInteractionResolution,
): PendingInteraction {
  const { db } = engine.ctx;
  const row = requireInteraction(engine, threadId, interactionId);
  const thread = getThread(db, threadId);
  if (thread === undefined) throw threadNotFound();
  if (row.status !== "pending") {
    const same = row.resolution === JSON.stringify(resolution);
    if (same && row.status !== "interrupted")
      return pending.toPendingInteraction(row);
    throw alreadySettled(row);
  }
  const requestId = row.providerRequestId;
  if (row.originKind !== "provider" || requestId === null) {
    throw invalidRequest("Answer a plugin interaction with respond.");
  }
  assertResolutionFits(pending.toPendingInteraction(row), resolution);
  const hostId = engine.connectedHostOf(thread);
  if (hostId === null) throw hostUnavailable();
  const resolving = engine.commit((out) => {
    const next = { status: "resolving" as const, resolution };
    return settle(engine, out, thread, row.id, ["pending"], next);
  });
  if (resolving === null) throw alreadySettled(row);
  const delivered = engine
    .onHost(hostId, (runner) =>
      runner.resolveInteraction({ threadId, requestId, resolution }),
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
    const settled = settle(engine, out, thread, row.id, ACTIVE, next, result);
    if (settled === null) throw alreadySettled(row);
    return settled;
  });
}

function describeSubmission(
  engine: Engine,
  interactionId: string,
  value: domain.JsonValue,
): domain.PluginInteractionDescription | undefined {
  const describe = engine.inputWaiters.get(interactionId)?.describeSubmission;
  try {
    const described = describe?.(value);
    return domain.pluginInteractionDescriptionSchema.safeParse(described).data;
  } catch {
    return undefined;
  }
}

export function respondToInteraction(
  engine: Engine,
  threadId: string,
  interactionId: string,
  value: domain.JsonValue,
): PendingInteraction {
  const row = requireInteraction(engine, threadId, interactionId);
  if (row.originKind === "provider") {
    const resolution = { kind: "request_answer" as const, value };
    return resolveProviderInteraction(engine, threadId, row.id, resolution);
  }
  if (row.status !== "pending") throw alreadySettled(row);
  const description = describeSubmission(engine, row.id, value);
  const next = {
    status: "resolved" as const,
    resolution: { kind: "plugin_submitted", description },
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

function openPluginInteraction(
  engine: Engine,
  request: PluginInputRequest,
): { result: Promise<PluginInputResult> } {
  const { db, plugins } = engine.ctx;
  const { threadId, signal } = request;
  const thread = getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) throw threadNotFound();
  if (pending.listActiveInteractions(db, threadId).length > 0) {
    throw conflict(`Thread ${threadId} is already awaiting user interaction`);
  }
  const { title, payload: data, presentation } = request;
  const row = engine.commit((out) => {
    const created = pending.insertPendingInteraction(db, {
      threadId,
      originKind: "plugin",
      pluginId: request.pluginId,
      rendererId: request.rendererId,
      payload: { kind: "plugin", title, data, presentation },
    });
    const interaction = announce(engine, out, thread, created);
    const response = engine.respond(thread.id);
    out.after(() =>
      plugins.emit("interaction.pending", { thread: response, interaction }),
    );
    return created;
  });
  const cancel = (reason: string): void =>
    engine.later(threadId, "cancel plugin interaction", () => {
      const current = pending.getPendingInteraction(db, row.id);
      if (current === undefined || current.status !== "pending") return;
      cancelPluginInteraction(engine, threadId, row.id, reason);
    });
  const { describeSubmission } = request;
  const result = new Promise<PluginInputResult>((resolve) => {
    const abort = (): void => {
      const reason: unknown = signal?.reason;
      const expired = reason instanceof Error && reason.name === "TimeoutError";
      cancel(expired ? "timeout" : "request-aborted");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const dispose = (): void => signal?.removeEventListener("abort", abort);
    engine.inputWaiters.set(row.id, { resolve, dispose, describeSubmission });
    if (signal?.aborted) abort();
  });
  return { result };
}

export function cancelByUser(engine: Engine, threadId: string, id: string) {
  return cancelPluginInteraction(engine, threadId, id, "user");
}

export async function requestInput(
  engine: Engine,
  request: PluginInputRequest,
): Promise<PluginInputResult> {
  if (request.signal?.aborted) {
    return { outcome: "cancelled", reason: "request-aborted" };
  }
  const opened = await engine.inThread(request.threadId, () =>
    openPluginInteraction(engine, request),
  );
  return opened.result;
}
