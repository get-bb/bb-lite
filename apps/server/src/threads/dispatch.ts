import {
  flattenPromptInputGroups,
  isStandaloneBuiltinClearCommand,
  threadScope,
} from "@bb/domain";
import type * as domain from "@bb/domain";
import { RunnerError } from "@bb/runner";
import type * as runner from "@bb/runner";
import type { SendMessageRequest } from "@bb/server-contract";
import { getEnvironment } from "../db/environments.js";
import { isQueueAutoSendPaused } from "../db/events.js";
import { findHost } from "../db/hosts.js";
import { encodeJson, newId } from "../db/index.js";
import { hasTurnBoundInteraction } from "../db/pending-interactions.js";
import * as queue from "../db/queued-messages.js";
import { getThread, patchThread, type ThreadRow } from "../db/threads.js";
import { deliverAttachments } from "./attachments.js";
import * as core from "./core.js";
import type { Engine } from "./engine.js";
import * as execution from "./execution.js";
import { buildSessionSpec, type SessionEnvironment } from "./session-spec.js";

type QueuedMessageRow = queue.QueuedMessageRow;
type PromptInput = domain.PromptInput;

export type SendMode = SendMessageRequest["mode"];
type TurnKind = "start" | "steer" | "auto";

export interface OutboundMessage {
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  execution: execution.ExecutionTuple;
  senderThreadId: string | null;
  initiator: domain.ThreadTurnInitiator;
  systemNotice: domain.QueuedMessageSystemNotice | null;
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
  target: domain.TurnRequestTarget,
): runner.RunnerThreadEvent {
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
    execution: execution.recordedExecution(message.execution),
  };
}

export function consumeRows(
  engine: Engine,
  out: core.Outbox,
  thread: ThreadRow,
  rows: readonly QueuedMessageRow[],
): void {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  queue.deleteQueuedMessages(engine.ctx.db, ids);
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
      : getEnvironment(db, thread.environmentId);
  if (row === undefined) {
    const reason = "never_attached";
    throw core.environmentUnavailable({ reason, environmentStatus: null });
  }
  const path = row.status === "ready" ? environments.pathFor(row.id) : null;
  if (path === null) {
    const reason = row.status === "destroyed" ? "destroyed" : "provisioning";
    const details = { reason, environmentStatus: row.status } as const;
    throw core.environmentUnavailable(details);
  }
  return { id: row.id, hostId: row.hostId, path };
}

function hasReadyWorkspace(engine: Engine, thread: ThreadRow): boolean {
  const { environmentId } = thread;
  if (environmentId === null) return false;
  return getEnvironment(engine.ctx.db, environmentId)?.status === "ready";
}

function currentWait(
  engine: Engine,
  thread: ThreadRow,
  args: DispatchArgs,
): domain.QueuedMessageWaitingOn | null {
  const { db, now, runners } = engine.ctx;
  const { mode, sendAt, sendNow } = args;
  if (!sendNow && sendAt !== null && sendAt > now()) return { kind: "time" };
  if (thread.status === "stopping") return { kind: "stopping" };
  const active = thread.status === "active";
  if (active && mode === "start") {
    throw core.notWritable(
      thread,
      "already_active",
      "Thread is already active",
    );
  }
  const environment =
    thread.environmentId === null
      ? undefined
      : getEnvironment(db, thread.environmentId);
  if (environment !== undefined && !runners.isConnected(environment.hostId)) {
    const host = findHost(db, "id", environment.hostId);
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
  waitingOn: domain.QueuedMessageWaitingOn,
): QueuedMessageRow {
  const { db } = engine.ctx;
  const { message, rows, sendAt } = args;
  const [lead] = rows;
  const encoded = encodeJson(waitingOn);
  if (lead?.waitingOn === encoded) return lead;
  return engine.commit((out) => {
    out.thread(thread.id, ["queue-changed"]);
    if (lead !== undefined) {
      queue.setQueuedMessageWait(db, rows, waitingOn);
      return { ...lead, waitingOn: encoded };
    }
    return queue.insertQueuedMessage(db, {
      threadId: thread.id,
      content: message.input,
      senderThreadId: message.senderThreadId,
      origin: null,
      originPluginId: null,
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
  const message = core.errorMessage(error);
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
  thread: ThreadRow,
  hostId: string,
  args: runner.SubmitTurnArgs,
): void {
  const { id: threadId } = thread;
  const requestId = args.clientRequestId;
  const { kind } = args.mode;
  const { db } = engine.ctx;
  if (kind === "start") engine.runtimeOf(threadId).pendingStart = requestId;
  const accepted = engine
    .onHost(hostId, async (runner) => {
      const target = { hostId, runner, thread };
      const input = await deliverAttachments(engine.ctx, target, args.input);
      return runner.submitTurn({ ...args, input });
    })
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
    throw core.notWritable(thread, "errored", "Thread is not active");
  }
  const environment = sessionEnvironmentOf(engine, thread);
  const message = attributedMessage(args.message);
  const { execution: tuple, input } = message;
  const session = await buildSessionSpec(ctx, thread, environment);
  const requestId = newId("creq");
  const expectedTurnId = thread.activeTurnId;
  const steers = joins && mode !== "auto" && expectedTurnId !== null;
  const runnerMode: runner.SubmitTurnMode = !joins
    ? { kind: "start" }
    : steers
      ? { kind: "steer", expectedTurnId }
      : { kind: "auto" };
  const target: domain.TurnRequestTarget = joins
    ? { kind: steers ? "steer" : "auto", expectedTurnId }
    : { kind: "new-turn" };
  engine.commit((out) => {
    consumeRows(engine, out, thread, args.rows);
    engine.append(out, thread, [turnRequestEvent(message, requestId, target)]);
    patchThread(ctx.db, thread.id, tuple, false);
    if (!joins) engine.transition(out, thread.id, "run.started");
    const options = execution.toRunnerOptions(
      ctx.db,
      thread.providerId,
      message,
    );
    const turn = { session, clientRequestId: requestId, input, options };
    const submit = { ...turn, mode: runnerMode };
    out.after(() => submitToRunner(engine, thread, environment.hostId, submit));
  });
}

export async function dispatchMessage(
  engine: Engine,
  threadId: string,
  args: DispatchArgs,
): Promise<Delivery> {
  const thread = getThread(engine.ctx.db, threadId);
  if (thread === undefined) throw core.threadNotFound();
  if (thread.deletedAt !== null) {
    throw core.notWritable(thread, "deleted", "Thread is deleted");
  }
  if (thread.archivedAt !== null) {
    throw core.notWritable(thread, "archived", "Thread is archived");
  }
  const waitingOn = currentWait(engine, thread, args);
  if (waitingOn !== null) {
    const row = recordWait(engine, thread, args, waitingOn);
    return { delivery: "queued", row };
  }
  const settled = thread.status !== "active";
  const unprepared = settled && !hasReadyWorkspace(engine, thread);
  if (thread.status === "pending" || unprepared) {
    engine.beginProvisioning(thread, args);
    return SENT;
  }
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
  const rows = queue.listQueuedMessages(db, thread.id);
  if (rows.length === 0) return null;
  const paused = isQueueAutoSendPaused(db, thread.id);
  const idle = thread.status === "idle" || thread.status === "pending";
  const joinable = thread.status === "active" && thread.activeTurnId !== null;
  const hostId = engine.hostOf(thread);
  const eligible = (row: QueuedMessageRow): boolean => {
    if (row.failureReason !== null) return false;
    const kind = queue.parseQueuedWait(row)?.kind ?? null;
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
    const group = queue.groupStartingAt(rows, index);
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
  const groups = rows.map(queue.parseQueuedContent);
  const systemNotice = queue.parseQueuedNotice(lead);
  const { model, reasoningLevel, permissionMode, serviceTier } = lead;
  const message: OutboundMessage = {
    input: flattenPromptInputGroups(groups),
    ...(groups.length > 1 ? { inputGroups: groups } : {}),
    execution: { model, reasoningLevel, permissionMode, serviceTier },
    senderThreadId: lead.senderThreadId,
    initiator: queue.queuedInitiator(lead),
    systemNotice,
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
    core.errorMessage(error).slice(0, FAILURE_REASON_MAX_LENGTH) || "failed",
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

export async function sendQueuedMessageNow(
  engine: Engine,
  threadId: string,
  queuedMessageId: string,
  mode: "auto" | "steer",
): Promise<Delivery> {
  const { db } = engine.ctx;
  const rows = queue.listQueuedMessages(db, threadId);
  const index = rows.findIndex((row) => row.id === queuedMessageId);
  if (index < 0) throw queue.queuedMessageNotFound();
  db.run(
    "UPDATE queued_thread_messages SET failure_reason = NULL WHERE id = ?",
    queuedMessageId,
  );
  const group = queue.groupStartingAt(rows, index);
  const outcome = await dispatchRows(engine, threadId, group, mode, true);
  if (outcome.delivery === "sent" || mode === "steer") return outcome;
  const kind = queue.parseQueuedWait(outcome.row)?.kind ?? "thread-busy";
  if (kind === "stopping") return outcome;
  throw core.conflict(`This message cannot be sent yet: it waits on ${kind}.`);
}
