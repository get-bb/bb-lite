import {
  type EventProjectionCommandMessage,
  type EventProjectionDelegationMessage,
  type EventProjectionExtensionMessage,
  type EventProjectionFileReadMessage,
  type EventProjectionImageGenerationMessage,
  type EventProjectionImageViewMessage,
  type EventProjectionMessage,
  type EventProjectionPlanStepsMessage,
  type EventProjectionSearchMessage,
  type EventProjectionToolCallMessage,
  type EventProjectionWebFetchMessage,
  type EventProjectionWebSearchMessage,
  type EventProjectionApprovalLifecycleStatus,
  type EventProjectionToolParsedIntent,
  type EventMeta,
  emptyEventProjection,
  extendMessageBounds,
  eventProjectionMessageThreadScopeFields,
  eventProjectionMessageTurnScopeFields,
  areThreadEventScopesEqual,
  type EventProjectionWorkflowMessage,
} from "./event-projection-types.js";
import type {
  JsonObject,
  ThreadEventItemPresentation,
  ThreadEventScope,
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
} from "@bb/domain";
import {
  type ExecutionOutputUpdate,
  type ProviderExecutionUpdate,
  type WebActivityLifecycleEvent,
  itemStatusToExecStatus,
} from "./item-lifecycle.js";
import { messageId } from "./timeline-format.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getVisibleTextBufferFullLength,
  getVisibleTextBufferFullText,
  getVisibleTextBufferText,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./text-projection.js";

export type ViewProviderExecutionMessage =
  | EventProjectionCommandMessage
  | EventProjectionToolCallMessage
  | EventProjectionDelegationMessage;

export type ViewWebActivityMessage =
  | EventProjectionWebSearchMessage
  | EventProjectionWebFetchMessage
  | EventProjectionImageGenerationMessage
  | EventProjectionImageViewMessage
  | EventProjectionFileReadMessage
  | EventProjectionSearchMessage
  | EventProjectionPlanStepsMessage
  | EventProjectionExtensionMessage;

export type ToolActivityCell =
  | ViewProviderExecutionMessage
  | ViewWebActivityMessage;

export type WebActivityKind = ViewWebActivityMessage["kind"];

interface ToolActivityCellStateOwner {
  messages: EventProjectionMessage[];
  toolActivity: {
    activeCell: ToolActivityCell | null;
    execHistoryCellIndexByCallId: Map<string, number>;
    finalizedExecCallIds: Set<string>;
    historyCells: ToolActivityCell[];
  };
}

type MaybeToolActivityCell =
  | EventProjectionMessage
  | ToolActivityCell
  | null
  | undefined;

export function isProviderExecutionMessage(
  message: MaybeToolActivityCell,
): message is ViewProviderExecutionMessage {
  return (
    message?.kind === "command" ||
    message?.kind === "tool-call" ||
    message?.kind === "delegation"
  );
}

export function isWebActivityMessage(
  cell: MaybeToolActivityCell,
): cell is ViewWebActivityMessage {
  return (
    cell?.kind === "web-search" ||
    cell?.kind === "web-fetch" ||
    cell?.kind === "image-generation" ||
    cell?.kind === "image-view" ||
    cell?.kind === "file-read" ||
    cell?.kind === "search" ||
    cell?.kind === "plan-steps" ||
    cell?.kind === "extension"
  );
}

export function findExecMessageInActiveCell(
  activeCell: ToolActivityCell | null,
  callId: string,
): ViewProviderExecutionMessage | null {
  if (!activeCell) return null;
  if (isProviderExecutionMessage(activeCell) && activeCell.callId === callId) {
    return activeCell;
  }
  return null;
}

export function findExecMessageInHistoryCells(
  state: ToolActivityCellStateOwner,
  callId: string,
): ViewProviderExecutionMessage | null {
  const historyIndex =
    state.toolActivity.execHistoryCellIndexByCallId.get(callId);
  if (historyIndex === undefined) return null;
  return findExecMessageInActiveCell(
    state.toolActivity.historyCells[historyIndex] ?? null,
    callId,
  );
}

export function findWebActivityInHistoryCells(
  state: ToolActivityCellStateOwner,
  args: { callId: string; itemKind?: WebActivityKind },
): ViewWebActivityMessage | null {
  for (
    let index = state.toolActivity.historyCells.length - 1;
    index >= 0;
    index -= 1
  ) {
    const cell = state.toolActivity.historyCells[index];
    if (!isWebActivityMessage(cell)) continue;
    if (cell.callId !== args.callId) continue;
    if (args.itemKind && cell.kind !== args.itemKind) continue;
    return cell;
  }
  return null;
}

export function interruptWebActivityMessage(
  message: ViewWebActivityMessage,
  completedAt: number | null,
): void {
  if (message.status === "pending") {
    message.status = "interrupted";
    message.completedAt = completedAt;
  }
}

export function flushActiveToolCell(state: ToolActivityCellStateOwner): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;
  const historyIndex = state.toolActivity.historyCells.length;
  state.toolActivity.historyCells.push(active);
  if (isProviderExecutionMessage(active)) {
    state.toolActivity.execHistoryCellIndexByCallId.set(
      active.callId,
      historyIndex,
    );
    if (active.status !== "pending") {
      state.toolActivity.finalizedExecCallIds.add(active.callId);
    }
  }
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}

type ExecStatus = EventProjectionToolCallMessage["status"];

type ApprovalStatus = EventProjectionApprovalLifecycleStatus | null;

interface RunningExecutionBase {
  callId: string;
  threadId: string;
  scope: ThreadEventScope;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  output: string;
  completedAt: number | null;
  status: ExecStatus;
  outputBuffer: VisibleTextBuffer;
  presentation?: ThreadEventItemPresentation;
}

interface PendingExecutionOutput {
  callId: string;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  output: string;
  status?: ExecStatus;
  outputBuffer: VisibleTextBuffer;
}

type BufferedExecutionOutput = RunningExecCall | PendingExecutionOutput;

interface RunningCommandExecution extends RunningExecutionBase {
  kind: "command";
  command: string;
  cwd: string | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
  exitCode: number | null;
  approvalStatus: ApprovalStatus;
}

interface RunningToolCallExecution extends RunningExecutionBase {
  kind: "tool-call";
  toolName: string | null;
  toolArgs: JsonObject | null;
  approvalStatus: ApprovalStatus;
}

interface RunningDelegationExecution extends RunningExecutionBase {
  kind: "delegation";
  toolName: string | null;
  childRef: string | null;
  background: boolean;
  subagentType?: string;
  description?: string;
  model?: string;
}

type RunningExecCall =
  | RunningCommandExecution
  | RunningToolCallExecution
  | RunningDelegationExecution;

type FieldsUpdate<TFields> = Partial<TFields> & { status?: ExecStatus };

export interface ToolActivityProjectionState {
  messages: EventProjectionMessage[];
  toolActivity: ToolActivityState;
}

interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  pendingOutputsByCallId: Map<string, PendingExecutionOutput>;
  activeCell: ToolActivityCell | null;
  historyCells: ToolActivityCell[];
  execHistoryCellIndexByCallId: Map<string, number>;
  finalizedExecCallIds: Set<string>;
  finalizedWebActivityCallIds: Set<string>;
}

export function createToolActivityState(): ToolActivityState {
  return {
    runningCallsById: new Map(),
    pendingOutputsByCallId: new Map(),
    activeCell: null,
    historyCells: [],
    execHistoryCellIndexByCallId: new Map(),
    finalizedExecCallIds: new Set(),
    finalizedWebActivityCallIds: new Set(),
  };
}

function mergeCallStatus(
  current: ExecStatus | undefined,
  incoming: ExecStatus | undefined,
): ExecStatus | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === "error") return "error";
  if (isTerminalToolCallStatus(current)) return current;
  return incoming;
}

export function mergeApprovalStatus(
  current: ApprovalStatus,
  incoming: ApprovalStatus | undefined,
  incomingStatus: ExecStatus | undefined,
): ApprovalStatus {
  if (incoming !== undefined) return incoming;
  return incomingStatus !== undefined ? null : current;
}

function hasSemanticIntent(
  intents: EventProjectionToolParsedIntent[],
): boolean {
  return intents.some((intent) => intent.type !== "unknown");
}

function chooseParsedIntents(
  existing: EventProjectionToolParsedIntent[],
  incoming: EventProjectionToolParsedIntent[],
): EventProjectionToolParsedIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (!hasSemanticIntent(existing) && hasSemanticIntent(incoming)) {
    return incoming;
  }
  if (incoming.length > existing.length) return incoming;
  return existing;
}

function isTerminalToolCallStatus(status: ExecStatus | undefined): boolean {
  return status !== undefined && status !== "pending";
}

function syncBufferedExecutionOutput(target: BufferedExecutionOutput): void {
  target.output = getVisibleTextBufferText(target.outputBuffer) ?? "";
}

function setBufferedExecutionOutput(
  target: BufferedExecutionOutput,
  text: string,
  flushTrailingPartial: boolean,
): void {
  setVisibleTextBuffer(target.outputBuffer, text, flushTrailingPartial);
  syncBufferedExecutionOutput(target);
}

function createRunningExecCall(
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  scope: ThreadEventScope,
): RunningExecCall {
  const outputBuffer = createVisibleTextBuffer();
  if (incoming.output && incoming.output.length > 0) {
    setVisibleTextBuffer(
      outputBuffer,
      incoming.output,
      isTerminalToolCallStatus(incoming.status),
    );
  }
  const base: RunningExecutionBase = {
    callId: incoming.callId,
    threadId,
    scope,
    ...(incoming.parentToolCallId
      ? { parentToolCallId: incoming.parentToolCallId }
      : {}),
    ...(incoming.presentation ? { presentation: incoming.presentation } : {}),
    output: getVisibleTextBufferText(outputBuffer) ?? "",
    completedAt: incoming.completedAt ?? null,
    status: incoming.status ?? "pending",
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    outputBuffer,
  };
  switch (incoming.kind) {
    case "command":
      return {
        ...base,
        kind: "command",
        command: incoming.command ?? "",
        cwd: incoming.cwd ?? null,
        parsedIntents: incoming.parsedIntents ?? [],
        source: incoming.source ?? null,
        exitCode: incoming.exitCode ?? null,
        approvalStatus: incoming.approvalStatus ?? null,
      };
    case "tool-call":
      return {
        ...base,
        kind: "tool-call",
        toolName: incoming.toolName ?? null,
        toolArgs: incoming.toolArgs ?? null,
        approvalStatus: incoming.approvalStatus ?? null,
      };
    case "delegation":
      return {
        ...base,
        kind: "delegation",
        toolName: incoming.toolName ?? null,
        childRef: incoming.childRef ?? null,
        background: incoming.background ?? false,
        subagentType: incoming.subagentType,
        description: incoming.description,
        model: incoming.model,
      };
  }
}

type CommandFields = Pick<
  RunningCommandExecution,
  "approvalStatus" | "command" | "cwd" | "exitCode" | "parsedIntents" | "source"
>;

function mergeCommandExecutionFields(
  target: CommandFields,
  incoming: FieldsUpdate<CommandFields>,
): void {
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  if (incoming.source && !target.source) target.source = incoming.source;
  if (incoming.command && incoming.command !== target.command) {
    target.command = incoming.command;
    target.parsedIntents = incoming.parsedIntents ?? [];
  } else {
    target.parsedIntents = chooseParsedIntents(
      target.parsedIntents,
      incoming.parsedIntents ?? [],
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
  RunningToolCallExecution,
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
  RunningDelegationExecution,
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

type ExecutionMergeTarget = RunningExecCall | ViewProviderExecutionMessage;

function mergeExecutionFields(
  target: ExecutionMergeTarget,
  incoming: RunningExecCall | ProviderExecutionUpdate,
): void {
  if (incoming.presentation) target.presentation = incoming.presentation;
  if (incoming.kind === "command" && target.kind === "command") {
    mergeCommandExecutionFields(target, incoming);
  } else if (incoming.kind === "tool-call" && target.kind === "tool-call") {
    mergeToolCallExecutionFields(target, incoming);
  } else if (incoming.kind === "delegation" && target.kind === "delegation") {
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
  existing: RunningExecCall | undefined,
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
): RunningExecCall {
  if (!existing) {
    const scopeFields = turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields();
    return createRunningExecCall(incoming, meta, threadId, scopeFields.scope);
  }
  mergeExecutionFields(existing, incoming);
  mergeExecutionCompletion(existing, incoming);
  if (!existing.parentToolCallId && incoming.parentToolCallId) {
    existing.parentToolCallId = incoming.parentToolCallId;
  }
  if (incoming.output && incoming.output.length > 0) {
    if (
      isTerminalToolCallStatus(incoming.status) ||
      incoming.output.length >=
        getVisibleTextBufferFullLength(existing.outputBuffer)
    ) {
      setBufferedExecutionOutput(
        existing,
        incoming.output,
        isTerminalToolCallStatus(incoming.status),
      );
    }
  }
  existing.threadId = threadId;
  existing.status =
    mergeCallStatus(existing.status, incoming.status) ?? "pending";
  extendMessageBounds(existing, meta.seq, meta.createdAt);
  return existing;
}

function applyExecutionOutputUpdate(
  target: BufferedExecutionOutput,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  if (appendOutput) {
    if (incoming.output.length > 0) {
      appendVisibleTextBuffer(target.outputBuffer, incoming.output);
      syncBufferedExecutionOutput(target);
    }
    return;
  }
  if (replaceOutput) {
    setBufferedExecutionOutput(
      target,
      incoming.output,
      isTerminalToolCallStatus(incoming.status),
    );
    return;
  }
  if (
    incoming.output.length >=
    getVisibleTextBufferFullLength(target.outputBuffer)
  ) {
    setBufferedExecutionOutput(target, incoming.output, true);
  }
}

function upsertPendingExecutionOutput(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  let pending = state.toolActivity.pendingOutputsByCallId.get(incoming.callId);
  if (!pending) {
    pending = {
      callId: incoming.callId,
      ...(incoming.parentToolCallId
        ? { parentToolCallId: incoming.parentToolCallId }
        : {}),
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
  state: ToolActivityProjectionState,
  call: RunningExecCall,
): void {
  const pending = state.toolActivity.pendingOutputsByCallId.get(call.callId);
  if (!pending) return;
  if (isTerminalToolCallStatus(call.status)) {
    flushVisibleTextBuffer(pending.outputBuffer);
    syncBufferedExecutionOutput(pending);
  }
  const pendingText = getVisibleTextBufferFullText(pending.outputBuffer);
  const callText = getVisibleTextBufferFullText(call.outputBuffer);
  if (pendingText.length > 0 && !callText.includes(pendingText)) {
    setBufferedExecutionOutput(
      call,
      pendingText.includes(callText)
        ? pendingText
        : `${pendingText}${callText}`,
      isTerminalToolCallStatus(call.status),
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
  if ("kind" in incoming) {
    if (target.kind !== incoming.kind) {
      throw new Error(
        `Cannot merge ${target.kind} with ${incoming.kind} for call ${incoming.callId}`,
      );
    }
    mergeExecutionFields(target, incoming);
    mergeExecutionCompletion(target, incoming);
  }
  target.status =
    mergeCallStatus(target.status, incoming.status) ?? target.status;
}

export function flushToolActivityBeforeNonToolMessage(
  state: ToolActivityProjectionState,
): void {
  flushActiveToolCell(state);
}

export function flushPendingToolActivityOutput(
  state: ToolActivityProjectionState,
): void {
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!flushVisibleTextBuffer(call.outputBuffer)) continue;
    syncBufferedExecutionOutput(call);
    const activeCall = findExecMessageInActiveCell(
      state.toolActivity.activeCell,
      call.callId,
    );
    if (activeCall) activeCall.output = call.output;
    const historyMatch = findExecMessageInHistoryCells(state, call.callId);
    if (historyMatch) historyMatch.output = call.output;
  }
}

export function interruptPendingToolActivity(
  state: ToolActivityProjectionState,
  args: { completedAt: number | null; turnIds?: ReadonlySet<string> } = {
    completedAt: null,
  },
): void {
  const { turnIds, completedAt } = args;
  const inScope = (scope: ThreadEventScope): boolean =>
    turnIds === undefined ||
    (scope.kind === "turn" && turnIds.has(scope.turnId));
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!inScope(call.scope)) continue;
    flushVisibleTextBuffer(call.outputBuffer);
    syncBufferedExecutionOutput(call);
    interruptPendingToolMessage(call, completedAt);
    const projected =
      findExecMessageInActiveCell(state.toolActivity.activeCell, call.callId) ??
      findExecMessageInHistoryCells(state, call.callId);
    if (projected) {
      mergeExecutionSummary(projected, call);
    } else {
      state.messages.push(createExecMessage(call));
    }
    state.toolActivity.runningCallsById.delete(call.callId);
  }
  const { activeCell, historyCells } = state.toolActivity;
  for (const message of [
    ...(activeCell ? [activeCell] : []),
    ...historyCells,
    ...state.messages,
  ]) {
    if (
      (isProviderExecutionMessage(message) || isWebActivityMessage(message)) &&
      inScope(message.scope)
    ) {
      interruptPendingToolMessage(message, completedAt);
    }
  }
}

function createExecMessage(
  call: RunningExecCall,
): ViewProviderExecutionMessage {
  const rowKindForId = call.kind === "tool-call" ? "tool" : call.kind;
  const base = {
    id: messageId(call.threadId, rowKindForId, call.callId),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    scope: call.scope,
    ...(call.parentToolCallId
      ? { parentToolCallId: call.parentToolCallId }
      : {}),
    ...(call.presentation ? { presentation: call.presentation } : {}),
    callId: call.callId,
    output: call.output,
    completedAt: call.completedAt,
    status: call.status,
  };
  if (call.kind === "command") {
    return {
      ...base,
      kind: "command",
      command: call.command,
      cwd: call.cwd,
      parsedIntents: call.parsedIntents,
      source: call.source,
      exitCode: call.exitCode,
      approvalStatus: call.approvalStatus,
    };
  }
  if (call.kind === "delegation") {
    return {
      ...base,
      kind: "delegation",
      toolName: call.toolName ?? "delegation",
      childRef: call.childRef,
      background: call.background,
      subagentType: call.subagentType,
      description: call.description,
      model: call.model,
      childProjection: emptyEventProjection(),
    };
  }
  return {
    ...base,
    kind: "tool-call",
    toolName: call.toolName ?? "tool",
    toolArgs: call.toolArgs,
    approvalStatus: call.approvalStatus,
  };
}

export function onExecBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ProviderExecutionUpdate,
): void {
  const call = upsertRunningExecCall(
    state.toolActivity.runningCallsById.get(incoming.callId),
    incoming,
    meta,
    threadId,
    turnId,
  );
  applyPendingExecutionOutput(state, call);
  state.toolActivity.runningCallsById.set(call.callId, call);
  const existingInActive = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    call.callId,
  );
  if (existingInActive) {
    mergeExecutionSummary(existingInActive, call);
    extendMessageBounds(existingInActive, call.sourceSeqEnd, call.createdAt);
    return;
  }
  flushActiveToolCell(state);
  state.toolActivity.activeCell = createExecMessage(call);
}

export function onExecOutput(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(
    incoming.callId,
  );
  if (existingRunning) {
    applyExecutionOutputUpdate(
      existingRunning,
      incoming,
      appendOutput,
      replaceOutput,
    );
  }
  const options = {
    appendOutput,
    replaceOutput,
    visibleOutput: existingRunning?.output,
  };
  const activeCall = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    incoming.callId,
  );
  const historyMatch = findExecMessageInHistoryCells(state, incoming.callId);
  for (const target of [existingRunning, activeCall, historyMatch]) {
    if (target) {
      mergeExecutionSummary(target, incoming, options);
      extendMessageBounds(target, meta.seq, meta.createdAt);
    }
  }
  if (!existingRunning && !activeCall && !historyMatch) {
    upsertPendingExecutionOutput(
      state,
      meta,
      incoming,
      appendOutput,
      replaceOutput,
    );
  }
}

export function onExecEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ProviderExecutionUpdate,
): void {
  const merged = upsertRunningExecCall(
    state.toolActivity.runningCallsById.get(incoming.callId),
    incoming,
    meta,
    threadId,
    turnId,
  );
  applyPendingExecutionOutput(state, merged);
  if (isTerminalToolCallStatus(merged.status)) {
    flushVisibleTextBuffer(merged.outputBuffer);
    syncBufferedExecutionOutput(merged);
  }
  state.toolActivity.runningCallsById.delete(incoming.callId);
  const existingInActive = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    incoming.callId,
  );
  if (
    !existingInActive &&
    state.toolActivity.finalizedExecCallIds.has(incoming.callId) &&
    merged.status !== "error"
  ) {
    return;
  }
  const projected =
    existingInActive ?? findExecMessageInHistoryCells(state, incoming.callId);
  if (projected) {
    mergeExecutionSummary(projected, merged, { visibleOutput: merged.output });
    extendMessageBounds(projected, merged.sourceSeqEnd, merged.createdAt);
    state.toolActivity.finalizedExecCallIds.add(incoming.callId);
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

function buildWebActivityKey(kind: WebActivityKind, callId: string): string {
  return `${kind}:${callId}`;
}

function settledStatus(
  payload: WebActivityLifecycleEvent,
): ViewWebActivityMessage["status"] {
  switch (payload.itemKind) {
    case "web-search":
    case "web-fetch":
    case "image-view":
      return "completed";
    case "image-generation":
    case "file-read":
    case "search":
    case "plan-steps":
    case "extension": {
      const status = itemStatusToExecStatus(payload.status);
      return status === "pending" ? "completed" : status;
    }
  }
}

function createWebActivityMessage(
  threadId: string,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
  status: ViewWebActivityMessage["status"],
): ViewWebActivityMessage {
  const base = {
    id: messageId(threadId, payload.itemKind, payload.callId),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields()),
    ...(payload.parentToolCallId
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
    ...(payload.presentation ? { presentation: payload.presentation } : {}),
    callId: payload.callId,
    completedAt: status === "pending" ? null : meta.createdAt,
  };
  switch (payload.itemKind) {
    case "web-search":
      return {
        ...base,
        kind: "web-search",
        queries: payload.queries,
        status: status === "error" ? "completed" : status,
      };
    case "image-view":
      return {
        ...base,
        kind: "image-view",
        path: payload.path,
        status: status === "error" ? "completed" : status,
      };
    case "image-generation":
      return {
        ...base,
        kind: "image-generation",
        prompt: payload.prompt,
        path: payload.path,
        error: payload.error,
        transparentBackground: payload.transparentBackground,
        status,
      };
    case "web-fetch":
      return {
        ...base,
        kind: "web-fetch",
        url: payload.url,
        prompt: payload.prompt,
        pattern: payload.pattern,
        status: status === "error" ? "completed" : status,
      };
    case "file-read":
      return {
        ...base,
        kind: "file-read",
        path: payload.path,
        cmd: payload.cmd,
        status,
      };
    case "search":
      return {
        ...base,
        kind: "search",
        mode: payload.mode,
        query: payload.query,
        path: payload.path,
        cmd: payload.cmd,
        status,
      };
    case "plan-steps":
      return {
        ...base,
        kind: "plan-steps",
        steps: payload.steps,
        explanation: payload.explanation,
        status,
      };
    case "extension":
      return {
        ...base,
        kind: "extension",
        extensionKind: payload.extensionKind,
        payload: payload.payload,
        presentation: payload.presentation,
        status,
      };
  }
}

function mergeWebActivityMessage(
  target: ViewWebActivityMessage,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const scopeFields = turnId
    ? eventProjectionMessageTurnScopeFields(turnId)
    : eventProjectionMessageThreadScopeFields();
  if (!areThreadEventScopesEqual(target.scope, scopeFields.scope)) {
    throw new Error(
      `Cannot merge ${target.kind} messages with different scopes for call ${payload.callId}`,
    );
  }
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, meta.seq);
  target.createdAt = Math.max(target.createdAt, meta.createdAt);
  if (!target.parentToolCallId && payload.parentToolCallId) {
    target.parentToolCallId = payload.parentToolCallId;
  }
  if (payload.presentation) target.presentation = payload.presentation;
  if (target.kind === "web-search" && payload.itemKind === "web-search") {
    target.queries = payload.queries;
    return;
  }
  if (target.kind === "web-fetch" && payload.itemKind === "web-fetch") {
    target.url = payload.url;
    target.prompt = payload.prompt;
    target.pattern = payload.pattern;
    return;
  }
  if (target.kind === "image-view" && payload.itemKind === "image-view") {
    target.path = payload.path;
    return;
  }
  if (
    target.kind === "image-generation" &&
    payload.itemKind === "image-generation"
  ) {
    target.prompt = payload.prompt;
    target.path = payload.path;
    target.error = payload.error;
    target.transparentBackground = payload.transparentBackground;
    return;
  }
  if (target.kind === "file-read" && payload.itemKind === "file-read") {
    target.path = payload.path;
    target.cmd = payload.cmd;
    return;
  }
  if (target.kind === "search" && payload.itemKind === "search") {
    target.mode = payload.mode;
    target.query = payload.query;
    target.path = payload.path;
    target.cmd = payload.cmd;
    return;
  }
  if (target.kind === "plan-steps" && payload.itemKind === "plan-steps") {
    target.steps = payload.steps;
    target.explanation = payload.explanation;
    return;
  }
  if (target.kind === "extension" && payload.itemKind === "extension") {
    target.extensionKind = payload.extensionKind;
    target.payload = payload.payload;
    target.presentation = payload.presentation;
  }
}

function settleWebActivityMessage(
  target: ViewWebActivityMessage,
  meta: EventMeta,
  payload: WebActivityLifecycleEvent,
): void {
  const status = settledStatus(payload);
  if (
    target.kind === "web-search" ||
    target.kind === "web-fetch" ||
    target.kind === "image-view"
  ) {
    target.status = status === "error" ? "completed" : status;
  } else {
    target.status = status;
  }
  target.completedAt = meta.createdAt;
}

function resolveActiveWebActivity(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  payload: WebActivityLifecycleEvent,
): { activityKey: string; active: ViewWebActivityMessage | null } | null {
  const activityKey = buildWebActivityKey(payload.itemKind, payload.callId);
  if (state.toolActivity.finalizedWebActivityCallIds.has(activityKey)) {
    return null;
  }
  const active = state.toolActivity.activeCell;
  if (
    isWebActivityMessage(active) &&
    active.callId === payload.callId &&
    active.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(active, meta.createdAt);
    flushActiveToolCell(state);
  }
  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    return { activityKey, active };
  }
  return { activityKey, active: null };
}

export function onWebActivityBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const resolved = resolveActiveWebActivity(state, meta, payload);
  if (!resolved) return;
  if (resolved.active) {
    mergeWebActivityMessage(resolved.active, meta, turnId, payload);
    return;
  }
  flushActiveToolCell(state);
  state.toolActivity.activeCell = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    "pending",
  );
}

export function onWebActivityEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const resolved = resolveActiveWebActivity(state, meta, payload);
  if (!resolved) return;
  const { activityKey, active } = resolved;
  if (active) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    settleWebActivityMessage(active, meta, payload);
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }
  flushActiveToolCell(state);
  const conflictingHistoryMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
  });
  if (
    conflictingHistoryMatch &&
    conflictingHistoryMatch.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(conflictingHistoryMatch, meta.createdAt);
  }
  const historyMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
    itemKind: payload.itemKind,
  });
  if (historyMatch) {
    mergeWebActivityMessage(historyMatch, meta, turnId, payload);
    settleWebActivityMessage(historyMatch, meta, payload);
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }
  const completedMessage = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    settledStatus(payload),
  );
  completedMessage.id = messageId(
    threadId,
    completedMessage.kind,
    `${payload.callId}:${meta.seq}`,
  );
  state.messages.push(completedMessage);
  state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
}

export interface BackgroundTaskProjectionState {
  messages: EventProjectionMessage[];
  backgroundTasksByItemId: Map<string, EventProjectionWorkflowMessage>;
}

interface BackgroundTaskLifecycleEvent {
  kind: "begin" | "update" | "end";
  item: ThreadEventBackgroundTaskItem;
}

export function parseBackgroundTaskLifecycleEvent(
  decoded: ThreadEvent,
): BackgroundTaskLifecycleEvent | null {
  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "backgroundTask"
  ) {
    return {
      kind: decoded.type === "item/started" ? "begin" : "end",
      item: decoded.item,
    };
  }
  if (decoded.type === "item/backgroundTask/progress") {
    return { kind: "update", item: decoded.item };
  }
  if (decoded.type === "item/backgroundTask/completed") {
    return { kind: "end", item: decoded.item };
  }
  return null;
}

function applyBackgroundTaskItem(
  message: EventProjectionWorkflowMessage,
  lifecycle: BackgroundTaskLifecycleEvent,
  meta: EventMeta,
): void {
  const item = lifecycle.item;
  message.familyId = item.familyId ?? null;
  message.taskType = item.taskType;
  message.workflowName = item.workflowName ?? null;
  message.description = item.description;
  message.status = itemStatusToExecStatus(item.status);
  message.taskStatus = item.taskStatus;
  message.skipTranscript = item.skipTranscript;
  message.workflow = item.workflow ?? null;
  message.usage = item.usage ?? null;
  message.summary = item.summary ?? null;
  message.error = item.error ?? null;
  if (lifecycle.kind === "end" && message.completedAt === null) {
    message.completedAt = meta.createdAt;
  }
}

export function upsertBackgroundTaskMessage(
  state: BackgroundTaskProjectionState,
  meta: EventMeta,
  decoded: ThreadEvent,
): boolean {
  const lifecycle = parseBackgroundTaskLifecycleEvent(decoded);
  if (!lifecycle) return false;
  const existing = state.backgroundTasksByItemId.get(lifecycle.item.id);
  if (existing) {
    applyBackgroundTaskItem(existing, lifecycle, meta);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    return true;
  }
  const message: EventProjectionWorkflowMessage = {
    kind: "workflow",
    id: lifecycle.item.id,
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    startedAt: meta.createdAt,
    ...(lifecycle.item.parentToolCallId
      ? { parentToolCallId: lifecycle.item.parentToolCallId }
      : {}),
    ...(lifecycle.item.presentation
      ? { presentation: lifecycle.item.presentation }
      : {}),
    itemId: lifecycle.item.id,
    familyId: lifecycle.item.familyId ?? null,
    taskType: lifecycle.item.taskType,
    workflowName: lifecycle.item.workflowName ?? null,
    description: lifecycle.item.description,
    model: null,
    status: itemStatusToExecStatus(lifecycle.item.status),
    taskStatus: lifecycle.item.taskStatus,
    skipTranscript: lifecycle.item.skipTranscript,
    workflow: lifecycle.item.workflow ?? null,
    usage: lifecycle.item.usage ?? null,
    summary: lifecycle.item.summary ?? null,
    error: lifecycle.item.error ?? null,
    completedAt: lifecycle.kind === "end" ? meta.createdAt : null,
  };
  state.backgroundTasksByItemId.set(lifecycle.item.id, message);
  state.messages.push(message);
  return true;
}
