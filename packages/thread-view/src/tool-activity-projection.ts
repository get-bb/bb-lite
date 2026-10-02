import type {
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
  ThreadEventScope,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineRowStatus,
} from "@bb/server-contract";
import type { ProjectionState } from "./build-event-projection.js";
import {
  appendVisibleText,
  areThreadEventScopesEqual,
  createVisibleTextBuffer,
  extendMessageBounds,
  flushVisibleText,
  scopeForTurn,
  setVisibleText,
  type EventMeta,
  type ExecMessage,
  type ItemMessage,
  type VisibleTextBuffer,
  type WorkflowMessage,
} from "./event-projection-types.js";
import {
  itemStatusToExecStatus,
  type ExecLifecycleEvent,
  type ExecutionOutputUpdate,
  type ItemLifecycleEvent,
  type ProviderExecutionUpdate,
} from "./item-lifecycle.js";
import { messageId } from "./timeline-format.js";

type ToolActivityCell = ExecMessage | ItemMessage;

type Unnamed<TMessage> = TMessage extends { toolName: string }
  ? Omit<TMessage, "toolName"> & { toolName: string | null }
  : TMessage;

type RunningExecCall = Unnamed<ExecMessage> & {
  startedAt: number;
  outputBuffer: VisibleTextBuffer;
};

interface PendingExecutionOutput {
  callId: string;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  output: string;
  status?: TimelineRowStatus;
  outputBuffer: VisibleTextBuffer;
}

type BufferedExecutionOutput = RunningExecCall | PendingExecutionOutput;

type FieldsUpdate<TFields> = Partial<TFields> & { status?: TimelineRowStatus };

export interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  pendingOutputsByCallId: Map<string, PendingExecutionOutput>;
  activeCell: ToolActivityCell | null;
  flushedExecByCallId: Map<string, ExecMessage>;
  flushedItems: ItemMessage[];
  finalizedExecCallIds: Set<string>;
  finalizedItemKeys: Set<string>;
}

export function createToolActivityState(): ToolActivityState {
  return {
    runningCallsById: new Map(),
    pendingOutputsByCallId: new Map(),
    activeCell: null,
    flushedExecByCallId: new Map(),
    flushedItems: [],
    finalizedExecCallIds: new Set(),
    finalizedItemKeys: new Set(),
  };
}

function findActiveExecMessage(
  state: ProjectionState,
  callId: string,
): ExecMessage | null {
  const active = state.toolActivity.activeCell;
  return active?.kind === "exec" && active.callId === callId ? active : null;
}

function findFlushedItem(
  state: ProjectionState,
  callId: string,
  workKind?: ItemMessage["workKind"],
): ItemMessage | undefined {
  return state.toolActivity.flushedItems
    .filter(
      (item) =>
        item.callId === callId &&
        (workKind === undefined || item.workKind === workKind),
    )
    .pop();
}

export function flushActiveToolCell(state: ProjectionState): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;
  if (active.kind === "item") {
    state.toolActivity.flushedItems.push(active);
  } else {
    state.toolActivity.flushedExecByCallId.set(active.callId, active);
    if (active.status !== "pending") {
      state.toolActivity.finalizedExecCallIds.add(active.callId);
    }
  }
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}

function mergeCallStatus(
  current: TimelineRowStatus | undefined,
  incoming: TimelineRowStatus | undefined,
): TimelineRowStatus | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === "error") return "error";
  return isTerminalToolCallStatus(current) ? current : incoming;
}

export function mergeApprovalStatus(
  current: TimelineApprovalStatus,
  incoming: TimelineApprovalStatus | undefined,
  incomingStatus: TimelineRowStatus | undefined,
): TimelineApprovalStatus {
  if (incoming !== undefined) return incoming;
  return incomingStatus !== undefined ? null : current;
}

function hasSemanticIntent(intents: TimelineActivityIntent[]): boolean {
  return intents.some((intent) => intent.type !== "unknown");
}

function chooseActivityIntents(
  existing: TimelineActivityIntent[],
  incoming: TimelineActivityIntent[],
): TimelineActivityIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (!hasSemanticIntent(existing) && hasSemanticIntent(incoming)) {
    return incoming;
  }
  return incoming.length > existing.length ? incoming : existing;
}

function isTerminalToolCallStatus(
  status: TimelineRowStatus | undefined,
): boolean {
  return status !== undefined && status !== "pending";
}

function setBufferedExecutionOutput(
  target: BufferedExecutionOutput,
  text: string,
  showTrailingPartial: boolean,
): void {
  setVisibleText(target.outputBuffer, text, showTrailingPartial);
  target.output = target.outputBuffer.visible;
}

function createRunningExecCall(
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  scope: ThreadEventScope,
): RunningExecCall {
  const outputBuffer = createVisibleTextBuffer();
  setVisibleText(
    outputBuffer,
    incoming.output ?? "",
    isTerminalToolCallStatus(incoming.status),
  );
  const { callId } = incoming;
  const base = {
    id: messageId(threadId, incoming.workKind, callId),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope,
    ...(incoming.parentToolCallId
      ? { parentToolCallId: incoming.parentToolCallId }
      : {}),
    outputBuffer,
    kind: "exec" as const,
  };
  const status = incoming.status ?? "pending";
  const output = outputBuffer.visible;
  const completedAt = incoming.completedAt ?? null;
  const presented = incoming.presentation
    ? { presentation: incoming.presentation }
    : {};
  switch (incoming.workKind) {
    case "command":
      return {
        ...base,
        workKind: "command",
        status,
        callId,
        command: incoming.command ?? "",
        cwd: incoming.cwd ?? null,
        source: incoming.source ?? null,
        output,
        exitCode: incoming.exitCode ?? null,
        completedAt,
        approvalStatus: incoming.approvalStatus ?? null,
        activityIntents: incoming.activityIntents ?? [],
        ...presented,
      };
    case "tool":
      return {
        ...base,
        workKind: "tool",
        status,
        callId,
        toolName: incoming.toolName ?? null,
        toolArgs: incoming.toolArgs ?? null,
        output,
        completedAt,
        approvalStatus: incoming.approvalStatus ?? null,
        ...presented,
      };
    case "delegation":
      return {
        ...base,
        workKind: "delegation",
        status,
        callId,
        toolName: incoming.toolName ?? null,
        childRef: incoming.childRef ?? null,
        background: incoming.background ?? false,
        subagentType: incoming.subagentType,
        description: incoming.description,
        model: incoming.model,
        output,
        completedAt,
        children: [],
        ...presented,
      };
  }
}

type CommandFields = Pick<
  Extract<RunningExecCall, { workKind: "command" }>,
  | "approvalStatus"
  | "command"
  | "cwd"
  | "exitCode"
  | "activityIntents"
  | "source"
>;

function mergeCommandExecutionFields(
  target: CommandFields,
  incoming: FieldsUpdate<CommandFields>,
): void {
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  if (incoming.source && !target.source) target.source = incoming.source;
  if (incoming.command && incoming.command !== target.command) {
    target.command = incoming.command;
    target.activityIntents = incoming.activityIntents ?? [];
  } else {
    target.activityIntents = chooseActivityIntents(
      target.activityIntents,
      incoming.activityIntents ?? [],
    );
  }
  if (incoming.exitCode !== undefined) target.exitCode = incoming.exitCode;
  target.approvalStatus = mergeApprovalStatus(
    target.approvalStatus,
    incoming.approvalStatus,
    incoming.status,
  );
}

type ToolCallFields = Pick<
  Extract<RunningExecCall, { workKind: "tool" }>,
  "approvalStatus" | "toolArgs" | "toolName"
>;

function mergeToolCallExecutionFields(
  target: ToolCallFields,
  incoming: FieldsUpdate<ToolCallFields>,
): void {
  if (incoming.toolName && !target.toolName) {
    target.toolName = incoming.toolName;
  }
  if (incoming.toolArgs && !target.toolArgs) {
    target.toolArgs = incoming.toolArgs;
  }
  target.approvalStatus = mergeApprovalStatus(
    target.approvalStatus,
    incoming.approvalStatus,
    incoming.status,
  );
}

type DelegationFields = Pick<
  Extract<RunningExecCall, { workKind: "delegation" }>,
  | "background"
  | "childRef"
  | "description"
  | "model"
  | "subagentType"
  | "toolName"
>;

function mergeDelegationExecutionFields(
  target: DelegationFields,
  incoming: Partial<DelegationFields>,
): void {
  if (incoming.toolName && !target.toolName) {
    target.toolName = incoming.toolName;
  }
  if (incoming.childRef && !target.childRef) {
    target.childRef = incoming.childRef;
  }
  if (incoming.background === true) target.background = true;
  if (incoming.subagentType && !target.subagentType) {
    target.subagentType = incoming.subagentType;
  }
  if (
    incoming.description &&
    (!target.description || incoming.childRef !== undefined)
  ) {
    target.description = incoming.description;
  }
  if (incoming.model && !target.model) target.model = incoming.model;
}

type ExecutionMergeTarget = RunningExecCall | ExecMessage;

function mergeExecutionFields(
  target: ExecutionMergeTarget,
  incoming: RunningExecCall | ProviderExecutionUpdate,
): void {
  if (incoming.presentation) target.presentation = incoming.presentation;
  if (incoming.workKind === "command" && target.workKind === "command") {
    mergeCommandExecutionFields(target, incoming);
  } else if (incoming.workKind === "tool" && target.workKind === "tool") {
    mergeToolCallExecutionFields(target, incoming);
  } else if (
    incoming.workKind === "delegation" &&
    target.workKind === "delegation"
  ) {
    mergeDelegationExecutionFields(target, incoming);
  }
}

function mergeExecutionCompletion(
  target: Pick<RunningExecCall, "completedAt" | "status">,
  incoming: Partial<Pick<RunningExecCall, "completedAt" | "status">>,
): void {
  if (incoming.completedAt === undefined || incoming.completedAt === null) {
    return;
  }
  if (target.status === "interrupted" && incoming.status !== "error") return;
  target.completedAt = incoming.completedAt;
}

function upsertRunningExecCall(
  state: ProjectionState,
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
): RunningExecCall {
  const existing = state.toolActivity.runningCallsById.get(incoming.callId);
  if (!existing) {
    return createRunningExecCall(
      incoming,
      meta,
      threadId,
      scopeForTurn(turnId),
    );
  }
  const terminal = isTerminalToolCallStatus(incoming.status);
  mergeExecutionFields(existing, incoming);
  mergeExecutionCompletion(existing, incoming);
  if (!existing.parentToolCallId && incoming.parentToolCallId) {
    existing.parentToolCallId = incoming.parentToolCallId;
  }
  if (
    incoming.output &&
    (terminal || incoming.output.length >= bufferedLength(existing))
  ) {
    setBufferedExecutionOutput(existing, incoming.output, terminal);
  }
  existing.threadId = threadId;
  existing.status =
    mergeCallStatus(existing.status, incoming.status) ?? "pending";
  extendMessageBounds(existing, meta.seq, meta.createdAt);
  return existing;
}

function bufferedLength(target: BufferedExecutionOutput): number {
  return (
    target.outputBuffer.visible.length + target.outputBuffer.pending.length
  );
}

function applyExecutionOutputUpdate(
  target: BufferedExecutionOutput,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  if (appendOutput) {
    appendVisibleText(target.outputBuffer, incoming.output);
    target.output = target.outputBuffer.visible;
  } else if (replaceOutput) {
    setBufferedExecutionOutput(
      target,
      incoming.output,
      isTerminalToolCallStatus(incoming.status),
    );
  } else if (incoming.output.length >= bufferedLength(target)) {
    setBufferedExecutionOutput(target, incoming.output, true);
  }
}

function upsertPendingExecutionOutput(
  state: ProjectionState,
  meta: EventMeta,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  let pending = state.toolActivity.pendingOutputsByCallId.get(incoming.callId);
  if (!pending) {
    pending = {
      callId: incoming.callId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      output: "",
      status: incoming.status,
      outputBuffer: createVisibleTextBuffer(),
    };
    state.toolActivity.pendingOutputsByCallId.set(incoming.callId, pending);
  }
  applyExecutionOutputUpdate(pending, incoming, appendOutput, replaceOutput);
  extendMessageBounds(pending, meta.seq, meta.createdAt);
  if (!pending.parentToolCallId && incoming.parentToolCallId) {
    pending.parentToolCallId = incoming.parentToolCallId;
  }
  pending.status = mergeCallStatus(pending.status, incoming.status);
}

function applyPendingExecutionOutput(
  state: ProjectionState,
  call: RunningExecCall,
): void {
  const pending = state.toolActivity.pendingOutputsByCallId.get(call.callId);
  if (!pending) return;
  const terminal = isTerminalToolCallStatus(call.status);
  if (terminal) flushVisibleText(pending.outputBuffer);
  const pendingText =
    pending.outputBuffer.visible + pending.outputBuffer.pending;
  const callText = call.outputBuffer.visible + call.outputBuffer.pending;
  if (pendingText.length > 0 && !callText.includes(pendingText)) {
    setBufferedExecutionOutput(
      call,
      pendingText.includes(callText)
        ? pendingText
        : `${pendingText}${callText}`,
      terminal,
    );
  }
  call.sourceSeqStart = Math.min(call.sourceSeqStart, pending.sourceSeqStart);
  call.startedAt = Math.min(call.startedAt, pending.startedAt);
  extendMessageBounds(call, pending.sourceSeqEnd, pending.createdAt);
  if (!call.parentToolCallId && pending.parentToolCallId) {
    call.parentToolCallId = pending.parentToolCallId;
  }
  call.status = mergeCallStatus(call.status, pending.status) ?? call.status;
  state.toolActivity.pendingOutputsByCallId.delete(call.callId);
}

function interruptPendingToolMessage(
  message: ToolActivityCell | RunningExecCall,
  completedAt: number | null,
): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";
  message.completedAt = completedAt;
  if ("output" in message && !message.output) {
    message.output = "Tool execution interrupted";
  }
}

const EXEC_KIND_LABELS = {
  command: "command",
  tool: "tool-call",
  delegation: "delegation",
};

function mergeExecutionSummary(
  target: ExecutionMergeTarget,
  incoming: RunningExecCall | ProviderExecutionUpdate | ExecutionOutputUpdate,
  options: {
    appendOutput?: boolean;
    replaceOutput?: boolean;
    visibleOutput?: string;
  } = {},
): void {
  const { appendOutput, replaceOutput, visibleOutput } = options;
  if (visibleOutput !== undefined) {
    target.output = visibleOutput;
  } else if (incoming.output && incoming.output.length > 0) {
    if (appendOutput) {
      target.output = `${target.output}${incoming.output}`;
    } else if (
      replaceOutput ||
      incoming.output.length >= target.output.length
    ) {
      target.output = incoming.output;
    }
  }
  if ("workKind" in incoming) {
    if (target.workKind !== incoming.workKind) {
      throw new Error(
        `Cannot merge ${EXEC_KIND_LABELS[target.workKind]} with ${EXEC_KIND_LABELS[incoming.workKind]} for call ${incoming.callId}`,
      );
    }
    mergeExecutionFields(target, incoming);
    mergeExecutionCompletion(target, incoming);
  }
  target.status =
    mergeCallStatus(target.status, incoming.status) ?? target.status;
}

export function flushPendingToolActivityOutput(state: ProjectionState): void {
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!flushVisibleText(call.outputBuffer)) continue;
    call.output = call.outputBuffer.visible;
    const activeCall = findActiveExecMessage(state, call.callId);
    if (activeCall) activeCall.output = call.output;
    const flushed = state.toolActivity.flushedExecByCallId.get(call.callId);
    if (flushed) flushed.output = call.output;
  }
}

export function interruptPendingToolActivity(
  state: ProjectionState,
  completedAt: number | null,
  turnId?: string,
): void {
  const inScope = (scope: ThreadEventScope): boolean =>
    turnId === undefined || (scope.kind === "turn" && scope.turnId === turnId);
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!inScope(call.scope)) continue;
    flushVisibleText(call.outputBuffer);
    call.output = call.outputBuffer.visible;
    interruptPendingToolMessage(call, completedAt);
    const projected =
      findActiveExecMessage(state, call.callId) ??
      state.toolActivity.flushedExecByCallId.get(call.callId);
    if (projected) {
      mergeExecutionSummary(projected, call);
    } else {
      state.messages.push(createExecMessage(call));
    }
    state.toolActivity.runningCallsById.delete(call.callId);
  }
  const { activeCell } = state.toolActivity;
  for (const message of [
    ...(activeCell ? [activeCell] : []),
    ...state.messages,
  ]) {
    if (
      (message.kind === "exec" || message.kind === "item") &&
      inScope(message.scope)
    ) {
      interruptPendingToolMessage(message, completedAt);
    }
  }
}

function createExecMessage(call: RunningExecCall): ExecMessage {
  const { outputBuffer, ...draft } = call;
  const id = messageId(call.threadId, call.workKind, call.callId);
  if (draft.workKind === "command") return { ...draft, id };
  if (draft.workKind === "tool") {
    return { ...draft, id, toolName: draft.toolName ?? "tool" };
  }
  const toolName = draft.toolName ?? "delegation";
  return { ...draft, id, toolName, children: [] };
}

function onExecBegin(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ProviderExecutionUpdate,
): void {
  const call = upsertRunningExecCall(state, incoming, meta, threadId, turnId);
  applyPendingExecutionOutput(state, call);
  state.toolActivity.runningCallsById.set(call.callId, call);
  const existingInActive = findActiveExecMessage(state, call.callId);
  if (existingInActive) {
    mergeExecutionSummary(existingInActive, call);
    extendMessageBounds(existingInActive, call.sourceSeqEnd, call.createdAt);
    return;
  }
  flushActiveToolCell(state);
  state.toolActivity.activeCell = createExecMessage(call);
}

function onExecOutput(
  state: ProjectionState,
  meta: EventMeta,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  const { callId } = incoming;
  const running = state.toolActivity.runningCallsById.get(callId);
  if (running) {
    applyExecutionOutputUpdate(running, incoming, appendOutput, replaceOutput);
  }
  const options = {
    appendOutput,
    replaceOutput,
    visibleOutput: running?.output,
  };
  const targets = [
    running,
    findActiveExecMessage(state, callId),
    state.toolActivity.flushedExecByCallId.get(callId),
  ].filter((target) => target !== undefined && target !== null);
  for (const target of targets) {
    mergeExecutionSummary(target, incoming, options);
    extendMessageBounds(target, meta.seq, meta.createdAt);
  }
  if (targets.length === 0) {
    upsertPendingExecutionOutput(
      state,
      meta,
      incoming,
      appendOutput,
      replaceOutput,
    );
  }
}

function onExecEnd(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ProviderExecutionUpdate,
): void {
  const { callId } = incoming;
  const merged = upsertRunningExecCall(state, incoming, meta, threadId, turnId);
  applyPendingExecutionOutput(state, merged);
  if (isTerminalToolCallStatus(merged.status)) {
    flushVisibleText(merged.outputBuffer);
    merged.output = merged.outputBuffer.visible;
  }
  state.toolActivity.runningCallsById.delete(callId);
  const existingInActive = findActiveExecMessage(state, callId);
  if (
    !existingInActive &&
    state.toolActivity.finalizedExecCallIds.has(callId) &&
    merged.status !== "error"
  ) {
    return;
  }
  const projected =
    existingInActive ?? state.toolActivity.flushedExecByCallId.get(callId);
  if (projected) {
    mergeExecutionSummary(projected, merged, { visibleOutput: merged.output });
    extendMessageBounds(projected, merged.sourceSeqEnd, merged.createdAt);
    state.toolActivity.finalizedExecCallIds.add(callId);
    if (existingInActive) flushActiveToolCell(state);
    return;
  }
  flushActiveToolCell(state);
  const execMessage = createExecMessage(merged);
  execMessage.status =
    mergeCallStatus(execMessage.status, incoming.status) ?? execMessage.status;
  state.toolActivity.activeCell = execMessage;
  flushActiveToolCell(state);
}

export function applyExecLifecycleEvent(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  lifecycle: ExecLifecycleEvent,
): void {
  if (lifecycle.kind === "output") {
    onExecOutput(
      state,
      meta,
      lifecycle.output,
      lifecycle.appendOutput,
      lifecycle.replaceOutput,
    );
  } else if (lifecycle.kind === "begin") {
    onExecBegin(state, meta, threadId, turnId, lifecycle.call);
  } else {
    onExecEnd(state, meta, threadId, turnId, lifecycle.call);
  }
}

function createItemMessage(
  threadId: string,
  meta: EventMeta,
  turnId: string | undefined,
  event: ItemLifecycleEvent,
  idKey: string,
): ItemMessage {
  return {
    id: messageId(threadId, event.row.workKind, idKey),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: scopeForTurn(turnId),
    ...(event.parentToolCallId
      ? { parentToolCallId: event.parentToolCallId }
      : {}),
    kind: "item",
    ...event.row,
  };
}

function mergeItemMessage(
  target: ItemMessage,
  meta: EventMeta,
  turnId: string | undefined,
  event: ItemLifecycleEvent,
): void {
  if (!areThreadEventScopesEqual(target.scope, scopeForTurn(turnId))) {
    throw new Error(
      `Cannot merge ${target.workKind} messages with different scopes for call ${event.row.callId}`,
    );
  }
  extendMessageBounds(target, meta.seq, meta.createdAt);
  if (!target.parentToolCallId && event.parentToolCallId) {
    target.parentToolCallId = event.parentToolCallId;
  }
  const { status, completedAt, ...fields } = event.row;
  Object.assign(target, event.kind === "end" ? event.row : fields);
}

export function applyItemLifecycleEvent(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  event: ItemLifecycleEvent,
): void {
  const { workKind, callId } = event.row;
  const key = `${workKind}:${callId}`;
  if (state.toolActivity.finalizedItemKeys.has(key)) return;
  let active = state.toolActivity.activeCell;
  if (active?.kind !== "item" || active.callId !== callId) {
    active = null;
  } else if (active.workKind !== workKind) {
    interruptPendingToolMessage(active, meta.createdAt);
    flushActiveToolCell(state);
    active = null;
  }
  if (active) {
    mergeItemMessage(active, meta, turnId, event);
    if (event.kind === "begin") return;
    flushActiveToolCell(state);
    state.toolActivity.finalizedItemKeys.add(key);
    return;
  }
  flushActiveToolCell(state);
  if (event.kind === "begin") {
    state.toolActivity.activeCell = createItemMessage(
      threadId,
      meta,
      turnId,
      event,
      callId,
    );
    return;
  }
  const conflicting = findFlushedItem(state, callId);
  if (conflicting && conflicting.workKind !== workKind) {
    interruptPendingToolMessage(conflicting, meta.createdAt);
  }
  const flushed = findFlushedItem(state, callId, workKind);
  if (flushed) {
    mergeItemMessage(flushed, meta, turnId, event);
  } else {
    state.messages.push(
      createItemMessage(threadId, meta, turnId, event, `${callId}:${meta.seq}`),
    );
  }
  state.toolActivity.finalizedItemKeys.add(key);
}

interface BackgroundTaskLifecycleEvent {
  ended: boolean;
  item: ThreadEventBackgroundTaskItem;
}

export function parseBackgroundTaskLifecycleEvent(
  decoded: ThreadEvent,
): BackgroundTaskLifecycleEvent | null {
  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "backgroundTask"
  ) {
    return { ended: decoded.type === "item/completed", item: decoded.item };
  }
  if (decoded.type === "item/backgroundTask/progress") {
    return { ended: false, item: decoded.item };
  }
  if (decoded.type === "item/backgroundTask/completed") {
    return { ended: true, item: decoded.item };
  }
  return null;
}

function backgroundTaskFields(item: ThreadEventBackgroundTaskItem) {
  return {
    familyId: item.familyId ?? null,
    taskType: item.taskType,
    workflowName: item.workflowName ?? null,
    description: item.description,
    status: itemStatusToExecStatus(item.status),
    taskStatus: item.taskStatus,
    skipTranscript: item.skipTranscript,
    workflow: item.workflow ?? null,
    usage: item.usage ?? null,
    summary: item.summary ?? null,
    error: item.error ?? null,
  };
}

export function upsertBackgroundTaskMessage(
  state: ProjectionState,
  meta: EventMeta,
  decoded: ThreadEvent,
  { ended, item }: BackgroundTaskLifecycleEvent,
): void {
  const existing = state.backgroundTasksByItemId.get(item.id);
  if (existing) {
    Object.assign(existing, backgroundTaskFields(item));
    if (ended) existing.completedAt ??= meta.createdAt;
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    return;
  }
  const message: WorkflowMessage = {
    kind: "workflow",
    id: item.id,
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    startedAt: meta.createdAt,
    ...(item.parentToolCallId
      ? { parentToolCallId: item.parentToolCallId }
      : {}),
    ...(item.presentation ? { presentation: item.presentation } : {}),
    itemId: item.id,
    ...backgroundTaskFields(item),
    model: null,
    completedAt: ended ? meta.createdAt : null,
  };
  state.backgroundTasksByItemId.set(item.id, message);
  state.messages.push(message);
}
