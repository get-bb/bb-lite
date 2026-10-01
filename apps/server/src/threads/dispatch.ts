import {
  flattenPromptInputGroups,
  isStandaloneBuiltinClearCommand,
  threadScope,
  type PromptInput,
  type QueuedMessageSystemNotice,
  type QueuedMessageWaitingOn,
  type ThreadCreateOrigin,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@bb/domain";
import {
  RunnerError,
  type RunnerThreadEvent,
  type SubmitTurnArgs,
  type SubmitTurnMode,
} from "@bb/runner";
import type { SendMessageRequest } from "@bb/server-contract";
import { getEnvironmentRow, getHostRow } from "../db/engine-lookups.js";
import { isQueueAutoSendPaused } from "../db/events.js";
import { encodeJson, newId } from "../db/index.js";
import { hasTurnBoundInteraction } from "../db/pending-interactions.js";
import {
  deleteQueuedMessages,
  groupStartingAt,
  insertQueuedMessage,
  listQueuedMessages,
  parseQueuedContent,
  parseQueuedNotice,
  parseQueuedWait,
  setQueuedMessageWait,
  type QueuedMessageRow,
} from "../db/queued-messages.js";
import {
  getThread,
  patchThread,
  type ThreadPatch,
  type ThreadRow,
} from "../db/threads.js";
import { ApiError } from "../http/errors.js";
import {
  conflict,
  environmentUnavailable,
  errorMessage,
  notWritable,
  threadNotFound,
  type Outbox,
} from "./core.js";
import type { Engine } from "./engine.js";
import {
  recordedExecution,
  toRunnerOptions,
  type ExecutionTuple,
} from "./execution.js";
import { buildSessionSpec, type SessionEnvironment } from "./session-spec.js";

export type SendMode = SendMessageRequest["mode"];
type TurnKind = "start" | "steer" | "auto";

export interface OutboundMessage {
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  execution: ExecutionTuple;
  senderThreadId: string | null;
  initiator: ThreadTurnInitiator;
  systemNotice: QueuedMessageSystemNotice | null;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  overrides: ThreadPatch;
}

export interface DispatchArgs {
  message: OutboundMessage;
  mode: SendMode;
  sendAt: number | null;
  rows: QueuedMessageRow[];
  sendNow: boolean;
}

export type Delivery =
  | { delivery: "sent" }
  | { delivery: "queued"; row: QueuedMessageRow };

const SENT: Delivery = { delivery: "sent" };
const MAX_DRAIN_ROUNDS = 20;
const FAILURE_REASON_MAX_LENGTH = 200;

function senderPrefix(senderThreadId: string): string {
  return `[bb message from thread:${senderThreadId}]\n\n`;
}

function attribute(input: PromptInput[], senderThreadId: string | null) {
  if (senderThreadId === null) return input;
  const prefix = senderPrefix(senderThreadId);
  const first = input.findIndex((part) => part.type === "text");
  if (first < 0) {
    return [{ type: "text" as const, text: prefix, mentions: [] }, ...input];
  }
  return input.map((part, index) => {
    if (index !== first || part.type !== "text") return part;
    const mentions = part.mentions.map((mention) => ({
      ...mention,
      start: mention.start + prefix.length,
      end: mention.end + prefix.length,
    }));
    return { ...part, text: prefix + part.text, mentions };
  });
}

export function attributedMessage(message: OutboundMessage): OutboundMessage {
  const { senderThreadId, inputGroups } = message;
  if (inputGroups === undefined) {
    return { ...message, input: attribute(message.input, senderThreadId) };
  }
  const groups = inputGroups.map((group) => attribute(group, senderThreadId));
  const input = flattenPromptInputGroups(groups);
  return { ...message, input, inputGroups: groups };
}

export function turnRequestEvent(
  message: OutboundMessage,
  requestId: string,
  target: TurnRequestTarget,
): RunnerThreadEvent {
  const starts = target.kind === "thread-start";
  const { systemNotice, inputGroups } = message;
  return {
    type: "client/turn/requested",
    scope: threadScope(),
    direction: "outbound",
    requestId,
    source: starts ? "spawn" : "tell",
    initiator: message.initiator,
    senderThreadId: message.senderThreadId,
    ...(systemNotice === null
      ? {}
      : {
          systemMessageKind: systemNotice.kind,
          systemMessageSubject: systemNotice.subject,
        }),
    input: message.input,
    ...(inputGroups === undefined ? {} : { inputGroups }),
    target,
    request: { method: starts ? "thread/start" : "turn/start", params: {} },
    execution: recordedExecution(message.execution),
  };
}

export function consumeRows(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  rows: readonly QueuedMessageRow[],
): void {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  deleteQueuedMessages(engine.ctx.db, ids);
  out.thread(thread.id, ["queue-changed"]);
}

export function sessionEnvironmentOf(
  engine: Engine,
  thread: ThreadRow,
): SessionEnvironment {
  const { db, environments } = engine.ctx;
  const row =
    thread.environmentId === null
      ? undefined
      : getEnvironmentRow(db, thread.environmentId);
  if (row === undefined) {
    const reason = "never_attached";
    throw environmentUnavailable({ reason, environmentStatus: null });
  }
  const path = row.status === "ready" ? environments.pathFor(row.id) : null;
  if (path === null) {
    const reason =
      row.status === "destroyed"
        ? "destroyed"
        : row.status === "error"
          ? "errored"
          : "provisioning";
    throw environmentUnavailable({ reason, environmentStatus: row.status });
  }
  return { id: row.id, hostId: row.hostId, path };
}

function currentWait(
  engine: Engine,
  thread: ThreadRow,
  args: DispatchArgs,
): QueuedMessageWaitingOn | null {
  const { db, now, runners } = engine.ctx;
  const { mode, sendAt, sendNow } = args;
  if (!sendNow && sendAt !== null && sendAt > now()) return { kind: "time" };
  if (thread.status === "stopping") return { kind: "stopping" };
  const active = thread.status === "active";
  if (active && mode === "start") {
    throw notWritable(thread, "already_active", "Thread is already active");
  }
  const environment =
    thread.environmentId === null
      ? undefined
      : getEnvironmentRow(db, thread.environmentId);
  if (
    environment !== undefined &&
    environment.status !== "destroyed" &&
    !runners.isConnected(environment.hostId)
  ) {
    const host = getHostRow(db, environment.hostId);
    const hostName = host?.name ?? environment.hostId;
    return { kind: "host-offline", hostName };
  }
  if (active && mode === "queue-if-active") return { kind: "thread-busy" };
  if (active && thread.activeTurnId === null) return { kind: "turn-starting" };
  if (thread.status === "starting") return { kind: "provisioning" };
  if (mode !== "start" && hasTurnBoundInteraction(db, thread.id)) {
    return { kind: "interaction" };
  }
  return null;
}

function recordWait(
  engine: Engine,
  thread: ThreadRow,
  args: DispatchArgs,
  waitingOn: QueuedMessageWaitingOn,
): QueuedMessageRow {
  const { db } = engine.ctx;
  const { message, rows, sendAt } = args;
  const [lead] = rows;
  if (lead !== undefined) {
    if (lead.waitingOn === encodeJson(waitingOn)) return lead;
    return engine.commit((out) => {
      setQueuedMessageWait(db, rows, waitingOn);
      out.thread(thread.id, ["queue-changed"]);
      return { ...lead, waitingOn: encodeJson(waitingOn) };
    });
  }
  return engine.commit((out) => {
    out.thread(thread.id, ["queue-changed"]);
    return insertQueuedMessage(db, {
      threadId: thread.id,
      content: message.input,
      senderThreadId: message.senderThreadId,
      origin: message.origin,
      originPluginId: message.originPluginId,
      systemNotice: message.systemNotice,
      ...message.execution,
      waitingOn,
      sendAt,
    });
  });
}

function settleRejectedTurn(
  engine: Engine,
  threadId: string,
  requestId: string,
  kind: TurnKind,
  error: unknown,
): void {
  const runtime = engine.runtimeOf(threadId);
  if (runtime.pendingStart === requestId) runtime.pendingStart = null;
  if (runtime.cancelledStart === requestId) runtime.cancelledStart = null;
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return;
  const reason = error instanceof RunnerError ? error.code : "failed";
  const message = errorMessage(error);
  engine.commit((out) => {
    const rejection = { scope: threadScope(), requestId, reason, message };
    engine.append(out, thread, [
      { type: "client/turn/rejected", ...rejection },
    ]);
    if (kind !== "start" || reason === "competing_turn") return;
    engine.failThread(out, thread, {
      code: "thread_command_failed",
      message: "Command turn.submit failed",
      detail: message,
    });
  });
}

export function submitToRunner(
  engine: Engine,
  hostId: string,
  args: SubmitTurnArgs,
): void {
  const { threadId } = args.session;
  const requestId = args.clientRequestId;
  const { kind } = args.mode;
  const { db, runners } = engine.ctx;
  if (kind === "start") engine.runtimeOf(threadId).pendingStart = requestId;
  const accepted = Promise.resolve()
    .then(() => runners.get(hostId).submitTurn(args))
    .then(
      ({ providerThreadId }) =>
        engine.inThread(threadId, () => {
          const thread = getThread(db, threadId);
          if (thread === undefined) return;
          if (thread.providerThreadId === providerThreadId) return;
          patchThread(db, threadId, { providerThreadId }, false);
        }),
      (error: unknown) =>
        engine.inThread(threadId, () =>
          settleRejectedTurn(engine, threadId, requestId, kind, error),
        ),
    );
  engine.background("submit turn", accepted);
}

async function submitTurn(
  engine: Engine,
  thread: ThreadRow,
  args: DispatchArgs,
): Promise<void> {
  const { ctx } = engine;
  const { mode } = args;
  const joins = thread.status === "active";
  if (thread.status === "error" && mode === "steer") {
    throw notWritable(thread, "errored", "Thread is not active");
  }
  const environment = sessionEnvironmentOf(engine, thread);
  const message = attributedMessage(args.message);
  const { execution, initiator, input } = message;
  const session = await buildSessionSpec(
    ctx,
    thread,
    environment,
    execution.model,
  );
  const requestId = newId("creq");
  const expectedTurnId = thread.activeTurnId;
  const steers = joins && mode !== "auto" && expectedTurnId !== null;
  const runnerMode: SubmitTurnMode = !joins
    ? { kind: "start" }
    : steers
      ? { kind: "steer", expectedTurnId }
      : { kind: "auto" };
  const target: TurnRequestTarget = joins
    ? { kind: steers ? "steer" : "auto", expectedTurnId }
    : { kind: "new-turn" };
  engine.commit((out) => {
    consumeRows(engine, out, thread, args.rows);
    engine.append(out, thread, [turnRequestEvent(message, requestId, target)]);
    patchThread(
      ctx.db,
      thread.id,
      { ...execution, ...message.overrides },
      false,
    );
    if (!joins) engine.transition(out, thread.id, "run.started");
    const options = toRunnerOptions(execution, initiator, input);
    const turn = { session, clientRequestId: requestId, input, options };
    out.after(() =>
      submitToRunner(engine, environment.hostId, { ...turn, mode: runnerMode }),
    );
  });
}

export async function dispatchMessage(
  engine: Engine,
  threadId: string,
  args: DispatchArgs,
): Promise<Delivery> {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined) throw threadNotFound();
  if (thread.deletedAt !== null) {
    throw notWritable(thread, "deleted", "Thread is deleted");
  }
  if (thread.archivedAt !== null) {
    throw notWritable(thread, "archived", "Thread is archived");
  }
  const waitingOn = currentWait(engine, thread, args);
  if (waitingOn !== null) {
    const row = recordWait(engine, thread, args, waitingOn);
    return { delivery: "queued", row };
  }
  if (thread.status === "pending" || thread.environmentId === null) {
    engine.beginProvisioning(thread, args);
    return SENT;
  }
  const settled = thread.status !== "active";
  if (settled && isStandaloneBuiltinClearCommand(args.message.input)) {
    engine.commit((out) => consumeRows(engine, out, thread, args.rows));
    await engine.resetContext(thread);
    return SENT;
  }
  await submitTurn(engine, thread, args);
  return SENT;
}

function nextEligibleGroup(
  engine: Engine,
  thread: ThreadRow,
): QueuedMessageRow[] | null {
  const { db, now, runners } = engine.ctx;
  const rows = listQueuedMessages(db, thread.id);
  if (rows.length === 0) return null;
  const paused = isQueueAutoSendPaused(db, thread.id);
  const idle = thread.status === "idle" || thread.status === "pending";
  const joinable = thread.status === "active" && thread.activeTurnId !== null;
  const hostId = engine.hostOf(thread);
  const eligible = (row: QueuedMessageRow): boolean => {
    if (row.failureReason !== null) return false;
    const kind = parseQueuedWait(row)?.kind ?? null;
    const turnBound = kind === null || kind === "thread-busy";
    const ordinary = turnBound || kind === "turn-starting";
    if (ordinary && paused && row.systemNotice === null) return false;
    switch (kind) {
      case "turn-starting":
        return idle || joinable;
      case "time":
        return row.sendAt !== null && row.sendAt <= now();
      case "host-offline":
        return hostId !== null && runners.isConnected(hostId);
      case "interaction":
        return !hasTurnBoundInteraction(db, thread.id);
      case "provisioning":
        return false;
      default:
        return idle;
    }
  };
  for (let index = 0; index < rows.length;) {
    const group = groupStartingAt(rows, index);
    if (group.every(eligible)) return group;
    index += group.length;
  }
  return null;
}

function dispatchRows(
  engine: Engine,
  threadId: string,
  rows: QueuedMessageRow[],
  mode: SendMode,
  sendNow: boolean,
): Promise<Delivery> {
  const [lead] = rows;
  const groups = rows.map(parseQueuedContent);
  const systemNotice = parseQueuedNotice(lead);
  const { model, reasoningLevel, permissionMode, serviceTier } = lead;
  const message: OutboundMessage = {
    input: flattenPromptInputGroups(groups),
    ...(groups.length > 1 ? { inputGroups: groups } : {}),
    execution: { model, reasoningLevel, permissionMode, serviceTier },
    senderThreadId: lead.senderThreadId,
    initiator:
      systemNotice !== null
        ? "system"
        : lead.senderThreadId === null
          ? "user"
          : "agent",
    systemNotice,
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    overrides: {},
  };
  const { sendAt } = lead;
  return dispatchMessage(engine, threadId, {
    message,
    mode,
    sendAt,
    rows,
    sendNow,
  });
}

function recordDrainFailure(
  engine: Engine,
  row: QueuedMessageRow,
  error: unknown,
): void {
  const { db, log } = engine.ctx;
  const { threadId } = row;
  log.warn("Queued message dispatch failed", { err: error, threadId });
  db.run(
    "UPDATE queued_thread_messages SET failure_reason = ? WHERE id = ?",
    errorMessage(error).slice(0, FAILURE_REASON_MAX_LENGTH) || "failed",
    row.id,
  );
  engine.ctx.hub.thread(threadId, ["queue-changed"]);
}

export async function drainQueue(
  engine: Engine,
  threadId: string,
): Promise<void> {
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    const thread = getThread(engine.ctx.db, threadId);
    if (thread === undefined || thread.status === "stopping") return;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const group = nextEligibleGroup(engine, thread);
    if (group === null) return;
    try {
      const mode = "auto";
      const outcome = await dispatchRows(engine, threadId, group, mode, false);
      if (outcome.delivery === "queued") return;
    } catch (error) {
      recordDrainFailure(engine, group[0], error);
      return;
    }
  }
}

function describeWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    default:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessageNow(
  engine: Engine,
  threadId: string,
  queuedMessageId: string,
  mode: "auto" | "steer",
): Promise<Delivery> {
  const { db } = engine.ctx;
  if (hasTurnBoundInteraction(db, threadId)) {
    throw new ApiError(
      409,
      "awaiting_user_interaction",
      "Thread is awaiting user interaction. Resolve the pending " +
        "interaction before sending another prompt.",
    );
  }
  const rows = listQueuedMessages(db, threadId);
  const index = rows.findIndex((row) => row.id === queuedMessageId);
  if (index < 0) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  db.run(
    "UPDATE queued_thread_messages SET failure_reason = NULL WHERE id = ?",
    queuedMessageId,
  );
  if (index > 0 && rows[index - 1].groupWithNext === 1) {
    db.run(
      "UPDATE queued_thread_messages SET group_with_next = 0 WHERE id IN (?, ?)",
      queuedMessageId,
      rows[index - 1].id,
    );
  }
  const group = groupStartingAt(listQueuedMessages(db, threadId), index);
  const outcome = await dispatchRows(engine, threadId, group, mode, true);
  if (outcome.delivery === "sent" || mode === "steer") return outcome;
  const waitingOn = parseQueuedWait(outcome.row);
  if (waitingOn?.kind === "stopping") return outcome;
  const reason = describeWait(waitingOn);
  throw conflict(`This message cannot be sent yet: ${reason}.`);
}
