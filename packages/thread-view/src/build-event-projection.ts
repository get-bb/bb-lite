import {
  type ThreadEvent,
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  LOCAL_WORKFLOW_TASK_TYPE,
  requireThreadEventScopeTurnId,
} from "@bb/domain";
import {
  type BuildEventProjectionMessagesOptions,
  type EventProjectionMessage,
  type EventMeta,
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
  emptyEventProjection,
  type BuildEventProjectionOptions,
  type EventProjectionWorkflowMessage,
  type EventProjection,
} from "./event-projection-types.js";
import {
  flushBufferedAssistantMessages,
  flushBufferedAssistantMessagesForTurn,
  type AssistantStreamProjectionState,
  createReasoningProjectionState,
  finalizeOpenReasoningLifecycles,
  type ReasoningProjectionState,
  buildProjectionActiveThinking,
  projectAssistantAndReasoningEvent,
} from "./text-projection.js";
import {
  finalizeOperationMessage,
  interruptOperationMessage,
  parseOperationMessage,
  parseErrorMessage,
} from "./parse-operation-message.js";
import {
  flushActiveToolCell,
  createToolActivityState,
  flushPendingToolActivityOutput,
  interruptPendingToolActivity,
  type BackgroundTaskProjectionState,
  parseBackgroundTaskLifecycleEvent,
  upsertBackgroundTaskMessage,
  flushToolActivityBeforeNonToolMessage,
  onExecBegin,
  onExecEnd,
  onExecOutput,
  onWebActivityBegin,
  onWebActivityEnd,
} from "./tool-activity-projection.js";
import {
  createOperationProjectionState,
  flushPendingFileEditOutput,
  interruptOpenCompactions,
  type CompactionTurnFinalizationStatus,
  type OperationProjectionState,
  finalizeOpenCompactionsForTurn,
  onCompactionBegin,
  onCompactionEnd,
  upsertFileEdit,
  upsertLifecycleMessage,
} from "./operation-projection.js";
import {
  shouldPreservePendingMessages,
  buildAcceptedClientRequestById,
  EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
  type AcceptedClientRequest,
  parseAcceptedSteersFromClientRequest,
  parseRejectedUsersFromClientRequest,
  parseUsersFromClientRequest,
  parseProviderUserMessage,
} from "./user-message-parsing.js";
import {
  parseCompactionLifecycleEvent,
  parseExecLifecycleEvent,
  parseToolCallLifecycleEvent,
  parseFileEditFromItemEvent,
  parseWebActivityLifecycleEvent,
  shouldSuppressLowValueToolCall,
} from "./item-lifecycle.js";
import {
  normalizeEventProjection,
  sortEventProjectionMessagesBySource,
  applyProjectionTurnMessageDetail,
  groupEventProjectionTurns,
  getOrderedThreadEvents,
  type ThreadEventWithMeta,
} from "./group-event-projection-turns.js";
import { getMessageStartedAt } from "./timeline-format.js";
export type { ThreadEventWithMeta } from "./group-event-projection-turns.js";

export interface CompactionTurnFinalization {
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}

export interface PendingDelegationTurnLink {
  callId: string;
  parentTurnId: string;
}

export interface ProjectionState
  extends
    AssistantStreamProjectionState,
    OperationProjectionState,
    ReasoningProjectionState,
    BackgroundTaskProjectionState {
  seenUserKeys: Set<string>;
  openTurnIds: Set<string>;
  closedTurnIds: Set<string>;
  interruptedTurnCompletedAtById: Map<string, number>;
  threadInterruptedAt: number | null;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
  delegationParentToolCallIdsByTurnId: Map<string, string>;
  suppressedAcceptedRootParentToolCallIdsByTurnId: Map<string, string>;
  pendingDelegationTurnLinksByProviderThreadId: Map<
    string,
    PendingDelegationTurnLink[]
  >;
  delegatedTurnLinkCallIds: Set<string>;
}

export function createProjectionState(): ProjectionState {
  const messages: EventProjectionMessage[] = [];
  return {
    ...createOperationProjectionState(messages),
    seenUserKeys: new Set(),
    openTurnIds: new Set(),
    closedTurnIds: new Set(),
    interruptedTurnCompletedAtById: new Map(),
    threadInterruptedAt: null,
    openAssistantMessagesByKey: new Map(),
    assistantTextBuffersByKey: new Map(),
    visibleAssistantMessageKeys: new Set(),
    finalizedAssistantMessageKeys: new Set(),
    ...createReasoningProjectionState(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    delegationParentToolCallIdsByTurnId: new Map(),
    suppressedAcceptedRootParentToolCallIdsByTurnId: new Map(),
    pendingDelegationTurnLinksByProviderThreadId: new Map(),
    delegatedTurnLinkCallIds: new Set(),
    toolActivity: createToolActivityState(),
    backgroundTasksByItemId: new Map(),
  };
}

export function onTurnCompleted(
  state: ProjectionState,
  meta: EventMeta,
  turnId: string,
  status: Extract<ThreadEvent, { type: "turn/completed" }>["status"],
): void {
  state.closedTurnIds.add(turnId);
  state.openTurnIds.delete(turnId);
  if (status === "interrupted") {
    state.interruptedTurnCompletedAtById.set(turnId, meta.createdAt);
  }
  finalizeOpenReasoningLifecycles(
    state,
    meta,
    status === "completed" ? "completed" : "interrupted",
    turnId,
  );
}

export function onThreadInterrupted(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
): void {
  state.threadInterruptedAt = meta.createdAt;
  interruptOpenCompactions({ state, meta, threadId });
  for (const turnId of state.openTurnIds) {
    state.interruptedTurnCompletedAtById.set(turnId, meta.createdAt);
    state.closedTurnIds.add(turnId);
  }
  state.openTurnIds.clear();
  finalizeOpenReasoningLifecycles(state, meta, "interrupted");
}

export function flushProjectionBufferedOutputs(
  state: ProjectionState,
  turnId?: string,
): void {
  if (turnId === undefined) {
    flushBufferedAssistantMessages(state);
  } else {
    flushBufferedAssistantMessagesForTurn(state, turnId);
  }
  flushPendingToolActivityOutput(state);
  flushPendingFileEditOutput(state);
}

function finalizePendingMessages(
  state: ProjectionState,
  options: BuildEventProjectionMessagesOptions,
): void {
  if (shouldPreservePendingMessages(options.threadStatus)) {
    flushActiveToolCell(state);
    return;
  }
  flushPendingToolActivityOutput(state);
  flushPendingFileEditOutput(state);
  interruptPendingToolActivity(state, {
    completedAt: state.threadInterruptedAt,
  });
  for (const fileEdits of state.fileEditsByCallId.values()) {
    for (const fileEdit of fileEdits) {
      if (fileEdit.status === "pending") fileEdit.status = "interrupted";
    }
  }
  if (options.threadStatus !== undefined) flushBufferedAssistantMessages(state);
  for (const message of state.messages) {
    if (message.kind !== "operation") continue;
    if (
      options.threadStatus === "idle" &&
      message.opType === "compaction" &&
      message.scope.kind === "turn" &&
      state.closedTurnIds.has(message.scope.turnId)
    ) {
      continue;
    }
    finalizeOperationMessage(message, options);
  }
  flushActiveToolCell(state);
}

function finalizeInterruptedTurnPendingMessages(state: ProjectionState): void {
  for (const [turnId, completedAt] of state.interruptedTurnCompletedAtById) {
    interruptPendingToolActivity(state, {
      completedAt,
      turnIds: new Set([turnId]),
    });
  }
  for (const message of state.messages) {
    if (
      message.scope.kind !== "turn" ||
      !state.interruptedTurnCompletedAtById.has(message.scope.turnId)
    ) {
      continue;
    }
    if (message.kind === "operation") {
      interruptOperationMessage(message);
    } else if (
      (message.kind === "file-edit" ||
        message.kind === "permission-grant-lifecycle" ||
        message.kind === "user-question-lifecycle" ||
        message.kind === "plugin-form-lifecycle") &&
      message.status === "pending"
    ) {
      message.status = "interrupted";
      if (message.kind === "plugin-form-lifecycle") {
        message.lifecycle = "cancelled";
      } else if (message.kind !== "file-edit") {
        message.lifecycle = "interrupted";
      }
    }
  }
}

export function finalizeProjectionState(
  state: ProjectionState,
  options: BuildEventProjectionMessagesOptions,
): void {
  finalizeInterruptedTurnPendingMessages(state);
  finalizePendingMessages(state, options);
}

type ProjectedUserMessage = Extract<EventProjectionMessage, { kind: "user" }>;

interface ClientTurnRequestedWithMeta {
  event: Extract<ThreadEvent, { type: "client/turn/requested" }>;
  meta: ThreadEventWithMeta["meta"];
}

type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

function selectActiveWorkflowMessages(
  messages: readonly EventProjectionMessage[],
): EventProjectionWorkflowMessage[] {
  const running: EventProjectionWorkflowMessage[] = [];
  for (const message of messages) {
    if (
      message.kind !== "workflow" ||
      message.taskType !== LOCAL_WORKFLOW_TASK_TYPE ||
      message.status !== "pending" ||
      message.skipTranscript
    ) {
      continue;
    }
    running.push(message);
  }
  return running.sort(
    (a, b) => getMessageStartedAt(b) - getMessageStartedAt(a),
  );
}

type EventProjectionCallMessage = Extract<
  EventProjectionMessage,
  { callId: string }
>;

function buildCallMessageById(
  messages: readonly EventProjectionMessage[],
): ReadonlyMap<string, EventProjectionCallMessage> {
  const byId = new Map<string, EventProjectionCallMessage>();
  for (const message of messages) {
    if ("callId" in message) byId.set(message.callId, message);
  }
  return byId;
}

function isDirectBackgroundTaskForCurrentAgent(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): boolean {
  if (!message.parentToolCallId) return true;
  const spawningCall = callMessageById.get(message.parentToolCallId);
  return spawningCall ? spawningCall.parentToolCallId === undefined : true;
}

function getBackgroundAgentModel(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): string | null {
  if (
    !isBackgroundAgentTaskType(message.taskType) ||
    !message.parentToolCallId
  ) {
    return null;
  }
  const spawningCall = callMessageById.get(message.parentToolCallId);
  return spawningCall?.kind === "delegation"
    ? (spawningCall.model ?? null)
    : null;
}

function getBackgroundTaskFamilyId(
  message: EventProjectionWorkflowMessage,
): string {
  if (message.familyId !== null) return `family:${message.familyId}`;
  const itemId = message.itemId;
  const generationMatch = /#(\d+)$/.exec(itemId);
  if (!generationMatch) return itemId;
  const generation = Number(generationMatch[1]);
  return Number.isSafeInteger(generation) && generation > 1
    ? itemId.slice(0, -generationMatch[0].length)
    : itemId;
}

function enrichBackgroundAgentModels(
  messages: readonly EventProjectionMessage[],
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): void {
  const modelByTaskFamilyId = new Map<string, string>();
  for (const message of messages) {
    if (
      message.kind !== "workflow" ||
      !isBackgroundAgentTaskType(message.taskType)
    ) {
      continue;
    }
    const taskFamilyId = getBackgroundTaskFamilyId(message);
    const model =
      getBackgroundAgentModel(message, callMessageById) ??
      message.model ??
      modelByTaskFamilyId.get(taskFamilyId) ??
      null;
    message.model = model;
    if (model !== null) modelByTaskFamilyId.set(taskFamilyId, model);
  }
}

function getRootSpawningCallId(
  message: EventProjectionWorkflowMessage,
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): string | undefined {
  let callId = message.parentToolCallId;
  const visited = new Set<string>();
  while (callId && !visited.has(callId)) {
    visited.add(callId);
    const call = callMessageById.get(callId);
    if (!call?.parentToolCallId) return callId;
    callId = call.parentToolCallId;
  }
  return undefined;
}

function selectActiveBackgroundCommandMessages(
  messages: readonly EventProjectionMessage[],
  callMessageById: ReadonlyMap<string, EventProjectionCallMessage>,
): EventProjectionWorkflowMessage[] {
  const representedRootCallIds = new Set<string>();
  for (const message of messages) {
    if (
      message.kind === "workflow" &&
      message.status === "pending" &&
      !message.skipTranscript &&
      message.parentToolCallId &&
      isDirectBackgroundTaskForCurrentAgent(message, callMessageById)
    ) {
      representedRootCallIds.add(message.parentToolCallId);
    }
  }
  const running: EventProjectionWorkflowMessage[] = [];
  for (const message of messages) {
    const isDirect =
      message.kind === "workflow" &&
      isDirectBackgroundTaskForCurrentAgent(message, callMessageById);
    const rootSpawningCallId =
      message.kind === "workflow"
        ? getRootSpawningCallId(message, callMessageById)
        : undefined;
    const isRepresentedByActiveParent =
      !isDirect &&
      rootSpawningCallId !== undefined &&
      representedRootCallIds.has(rootSpawningCallId);
    if (
      message.kind !== "workflow" ||
      message.taskType === LOCAL_WORKFLOW_TASK_TYPE ||
      message.status !== "pending" ||
      message.skipTranscript ||
      isRepresentedByActiveParent ||
      (!isDirect && !isBackgroundCommandTaskType(message.taskType))
    ) {
      continue;
    }
    running.push(message);
  }
  return running.sort(
    (a, b) => getMessageStartedAt(b) - getMessageStartedAt(a),
  );
}

function buildClientTurnRequestById(
  events: ThreadEventWithMeta[],
): Map<string, ClientTurnRequestedWithMeta> {
  const requestById = new Map<string, ClientTurnRequestedWithMeta>();
  for (const eventWithMeta of events) {
    if (eventWithMeta.event.type !== "client/turn/requested") continue;
    requestById.set(eventWithMeta.event.requestId, {
      event: eventWithMeta.event,
      meta: eventWithMeta.meta,
    });
  }
  return requestById;
}

function buildRejectedClientRequestIds(
  events: ThreadEventWithMeta[],
): ReadonlySet<string> {
  const requestIds = new Set<string>();
  for (const { event } of events) {
    if (event.type === "client/turn/rejected") requestIds.add(event.requestId);
  }
  return requestIds;
}

function buildSelectedStartedTurnIds(
  events: ThreadEventWithMeta[],
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "turn/started") continue;
    turnIds.add(requireThreadEventScopeTurnId(event));
  }
  return turnIds;
}

function buildAcceptedRootClientTurnIds(
  events: ThreadEventWithMeta[],
  clientRequestById: ReadonlyMap<string, ClientTurnRequestedWithMeta>,
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "turn/input/accepted") continue;
    const request = clientRequestById.get(event.clientRequestId);
    if (
      request?.event.target.kind !== "new-turn" &&
      request?.event.target.kind !== "thread-start"
    ) {
      continue;
    }
    turnIds.add(requireThreadEventScopeTurnId(event));
  }
  return turnIds;
}

function canUseAcceptedClientRequestForVisibleProjection(
  acceptedClientRequest: AcceptedClientRequest,
  decoded: ClientTurnRequestedEvent,
  selectedStartedTurnIds: ReadonlySet<string>,
): boolean {
  switch (decoded.target.kind) {
    case "auto":
    case "steer":
      if (decoded.target.expectedTurnId === null) return true;
      if (acceptedClientRequest.turnId === decoded.target.expectedTurnId) {
        return true;
      }
      return selectedStartedTurnIds.has(acceptedClientRequest.turnId);
    case "new-turn":
    case "thread-start":
      return true;
  }
}

function appendProjectedUserMessage(
  state: ProjectionState,
  projectedClientUser: ProjectedUserMessage,
): void {
  const key = projectedClientUser.id;
  if (state.seenUserKeys.has(key)) return;
  state.seenUserKeys.add(key);
  flushToolActivityBeforeNonToolMessage(state);
  state.messages.push(projectedClientUser);
}

function getDelegationChildRef(decoded: ThreadEvent): string | undefined {
  return (decoded.type === "item/started" ||
    decoded.type === "item/completed" ||
    decoded.type === "item/delegation/progress" ||
    decoded.type === "item/delegation/completed") &&
    decoded.item.type === "delegation"
    ? decoded.item.childRef
    : undefined;
}

function enqueuePendingDelegationTurnLink(
  state: ProjectionState,
  providerThreadId: string | undefined,
  parentTurnId: string | undefined,
  callId: string,
): void {
  if (!providerThreadId || !parentTurnId) return;
  if (state.delegatedTurnLinkCallIds.has(callId)) return;
  const pendingLinks =
    state.pendingDelegationTurnLinksByProviderThreadId.get(providerThreadId) ??
    [];
  const link: PendingDelegationTurnLink = { callId, parentTurnId };
  pendingLinks.push(link);
  state.pendingDelegationTurnLinksByProviderThreadId.set(
    providerThreadId,
    pendingLinks,
  );
  state.delegatedTurnLinkCallIds.add(callId);
}

function consumePendingDelegationTurnLink(
  state: ProjectionState,
  providerThreadId: string | undefined,
  turnId: string,
): string | undefined {
  if (!providerThreadId) return undefined;
  if (state.delegationParentToolCallIdsByTurnId.has(turnId)) {
    return state.delegationParentToolCallIdsByTurnId.get(turnId);
  }
  const pendingLinks =
    state.pendingDelegationTurnLinksByProviderThreadId.get(providerThreadId);
  if (!pendingLinks || pendingLinks.length === 0) return undefined;
  while (pendingLinks.length > 0) {
    const pendingLink = pendingLinks.shift();
    if (!pendingLink || pendingLink.parentTurnId === turnId) continue;
    if (pendingLinks.length === 0) {
      state.pendingDelegationTurnLinksByProviderThreadId.delete(
        providerThreadId,
      );
    }
    state.delegationParentToolCallIdsByTurnId.set(turnId, pendingLink.callId);
    return pendingLink.callId;
  }
  state.pendingDelegationTurnLinksByProviderThreadId.delete(providerThreadId);
  return undefined;
}

function getCompactionTurnFinalization(
  decoded: ThreadEvent,
): CompactionTurnFinalization | undefined {
  if (decoded.type === "provider/error") {
    return { status: "error", detail: decoded.detail ?? decoded.message };
  }
  if (
    decoded.type === "provider/warning" &&
    decoded.category === "compaction-skipped"
  ) {
    return { status: "completed", detail: decoded.details ?? decoded.summary };
  }
  if (decoded.type === "turn/completed" && decoded.status === "failed") {
    return { status: "error", detail: decoded.error?.message };
  }
  if (decoded.type === "turn/completed" && decoded.status === "interrupted") {
    return { status: "interrupted", detail: decoded.error?.message };
  }
  return undefined;
}

function applyExecLifecycleEvent(
  state: ProjectionState,
  meta: ThreadEventWithMeta["meta"],
  decoded: ThreadEvent,
  turnId: string | undefined,
  lifecycle: NonNullable<ReturnType<typeof parseExecLifecycleEvent>>,
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
    onExecBegin(state, meta, decoded.threadId, turnId, lifecycle.call);
  } else {
    onExecEnd(state, meta, decoded.threadId, turnId, lifecycle.call);
  }
}

function buildFlatProjectionData(
  orderedEvents: ThreadEventWithMeta[],
  options: BuildEventProjectionOptions,
  includeActiveThinking: boolean,
): Pick<EventProjection, "state"> & { messages: EventProjectionMessage[] } {
  const state = createProjectionState();
  const acceptedClientRequestById = buildAcceptedClientRequestById({
    context:
      options.acceptedClientRequestContext ??
      EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    events: orderedEvents,
  });
  const clientRequestById = buildClientTurnRequestById(orderedEvents);
  const rejectedClientRequestIds = buildRejectedClientRequestIds(orderedEvents);
  const selectedStartedTurnIds = buildSelectedStartedTurnIds(orderedEvents);
  const acceptedRootClientTurnIds = buildAcceptedRootClientTurnIds(
    orderedEvents,
    clientRequestById,
  );
  for (const { event: decoded, meta } of orderedEvents) {
    const eventTurnId = getEventTurnId(decoded);
    const eventProviderThreadId = getEventProviderThreadId(decoded);
    const isAcceptedRootClientTurn =
      typeof eventTurnId === "string" &&
      acceptedRootClientTurnIds.has(eventTurnId);
    const decodedEventParentToolCallId = getEventParentToolCallId(decoded);
    if (
      decoded.type === "turn/started" &&
      isAcceptedRootClientTurn &&
      decodedEventParentToolCallId
    ) {
      state.suppressedAcceptedRootParentToolCallIdsByTurnId.set(
        eventTurnId,
        decodedEventParentToolCallId,
      );
    }
    const explicitEventParentToolCallId =
      decodedEventParentToolCallId &&
      (!isAcceptedRootClientTurn ||
        typeof eventTurnId !== "string" ||
        state.suppressedAcceptedRootParentToolCallIdsByTurnId.get(
          eventTurnId,
        ) !== decodedEventParentToolCallId)
        ? decodedEventParentToolCallId
        : undefined;
    if (decoded.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId(decoded);
      if (isAcceptedRootClientTurn) {
        state.delegationParentToolCallIdsByTurnId.delete(turnId);
      } else {
        const pendingParentToolCallId = consumePendingDelegationTurnLink(
          state,
          eventProviderThreadId,
          turnId,
        );
        if (explicitEventParentToolCallId) {
          state.delegationParentToolCallIdsByTurnId.set(
            turnId,
            explicitEventParentToolCallId,
          );
        } else if (pendingParentToolCallId) {
          state.delegationParentToolCallIdsByTurnId.set(
            turnId,
            pendingParentToolCallId,
          );
        }
      }
      state.openTurnIds.add(turnId);
    }
    const eventParentToolCallId = isAcceptedRootClientTurn
      ? explicitEventParentToolCallId
      : (explicitEventParentToolCallId ??
        (eventTurnId
          ? state.delegationParentToolCallIdsByTurnId.get(eventTurnId)
          : undefined) ??
        (eventProviderThreadId
          ? state.delegationParentToolCallIdsByProviderThreadId.get(
              eventProviderThreadId,
            )
          : undefined));
    const compactionTurnFinalization = getCompactionTurnFinalization(decoded);
    if (compactionTurnFinalization) {
      const settledPendingCompaction = finalizeOpenCompactionsForTurn({
        state,
        meta,
        threadId: decoded.threadId,
        turnId: eventTurnId,
        status: compactionTurnFinalization.status,
        detail: compactionTurnFinalization.detail,
      });
      if (settledPendingCompaction && decoded.type === "provider/warning") {
        continue;
      }
    }
    if (decoded.type === "turn/completed") {
      const completedTurnId = requireThreadEventScopeTurnId(decoded);
      onTurnCompleted(state, meta, completedTurnId, decoded.status);
      flushProjectionBufferedOutputs(state, completedTurnId);
    } else if (decoded.type === "system/thread/interrupted") {
      onThreadInterrupted(state, meta, decoded.threadId);
      flushProjectionBufferedOutputs(state);
    }
    if (decoded.type === "turn/input/accepted") {
      const clientRequest = clientRequestById.get(decoded.clientRequestId);
      const acceptedClientRequest = acceptedClientRequestById.get(
        decoded.clientRequestId,
      );
      const acceptedSteers =
        clientRequest && acceptedClientRequest
          ? parseAcceptedSteersFromClientRequest({
              acceptedClientRequest,
              decoded: clientRequest.event,
              meta: clientRequest.meta,
              options,
            })
          : [];
      for (const acceptedSteer of acceptedSteers) {
        appendProjectedUserMessage(state, acceptedSteer);
      }
      continue;
    }
    if (decoded.type === "client/turn/rejected") {
      const clientRequest = clientRequestById.get(decoded.requestId);
      if (clientRequest) {
        for (const rejectedMessage of parseRejectedUsersFromClientRequest({
          decoded: clientRequest.event,
          meta,
          options,
        })) {
          appendProjectedUserMessage(state, rejectedMessage);
        }
      }
      continue;
    }
    if (
      decoded.type === "client/turn/requested" &&
      rejectedClientRequestIds.has(decoded.requestId)
    ) {
      continue;
    }
    const acceptedClientRequest =
      decoded.type === "client/turn/requested"
        ? acceptedClientRequestById.get(decoded.requestId)
        : undefined;
    const visibleProjectionAcceptedClientRequest =
      acceptedClientRequest &&
      decoded.type === "client/turn/requested" &&
      canUseAcceptedClientRequestForVisibleProjection(
        acceptedClientRequest,
        decoded,
        selectedStartedTurnIds,
      )
        ? acceptedClientRequest
        : undefined;
    const usersFromClientRequest = parseUsersFromClientRequest({
      acceptedClientRequest: visibleProjectionAcceptedClientRequest,
      decoded,
      meta,
      options,
    });
    if (usersFromClientRequest.length > 0) {
      for (const userFromClientRequest of usersFromClientRequest) {
        appendProjectedUserMessage(state, userFromClientRequest);
      }
      continue;
    }
    const providerUserMessage = parseProviderUserMessage(decoded, meta);
    if (providerUserMessage) {
      appendProjectedUserMessage(state, providerUserMessage);
      continue;
    }
    if (
      projectAssistantAndReasoningEvent(
        state,
        decoded,
        meta,
        eventTurnId,
        eventParentToolCallId,
      )
    ) {
      continue;
    }
    if (parseBackgroundTaskLifecycleEvent(decoded)) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertBackgroundTaskMessage(state, meta, decoded);
      continue;
    }
    const execEvent = parseExecLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (execEvent) {
      applyExecLifecycleEvent(state, meta, decoded, eventTurnId, execEvent);
      continue;
    }
    if (shouldSuppressLowValueToolCall(decoded)) continue;
    const toolCallEvent = parseToolCallLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (toolCallEvent) {
      const delegationChildRef = getDelegationChildRef(decoded);
      if (toolCallEvent.kind !== "output") {
        if (delegationChildRef !== undefined) {
          if (
            delegationChildRef === eventProviderThreadId ||
            state.delegatedTurnLinkCallIds.has(toolCallEvent.call.callId)
          ) {
            enqueuePendingDelegationTurnLink(
              state,
              eventProviderThreadId,
              eventTurnId,
              toolCallEvent.call.callId,
            );
          } else {
            state.delegationParentToolCallIdsByProviderThreadId.set(
              delegationChildRef,
              toolCallEvent.call.callId,
            );
          }
        }
      }
      applyExecLifecycleEvent(state, meta, decoded, eventTurnId, toolCallEvent);
      continue;
    }
    const webActivityEvent = parseWebActivityLifecycleEvent(
      decoded,
      eventParentToolCallId,
    );
    if (webActivityEvent) {
      const apply =
        webActivityEvent.kind === "begin"
          ? onWebActivityBegin
          : onWebActivityEnd;
      apply(state, meta, decoded.threadId, eventTurnId, webActivityEvent);
      continue;
    }
    const fileEdit = parseFileEditFromItemEvent(decoded, eventParentToolCallId);
    if (fileEdit) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertFileEdit(state, meta, decoded.threadId, eventTurnId, fileEdit);
      continue;
    }
    const compactionEvent = parseCompactionLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (compactionEvent) {
      flushToolActivityBeforeNonToolMessage(state);
      const apply =
        compactionEvent.kind === "begin" ? onCompactionBegin : onCompactionEnd;
      apply(state, meta, decoded.threadId, eventTurnId, compactionEvent);
      continue;
    }
    const operation = parseOperationMessage(decoded, meta, options);
    if (operation) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertLifecycleMessage(state, operation);
      continue;
    }
    const error = parseErrorMessage(decoded, meta);
    if (error) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(error);
      continue;
    }
  }
  finalizeProjectionState(state, options);
  const messages = sortEventProjectionMessagesBySource(state.messages);
  const callMessageById = buildCallMessageById(messages);
  enrichBackgroundAgentModels(messages, callMessageById);
  return {
    messages,
    state: {
      activeThinking: includeActiveThinking
        ? buildProjectionActiveThinking(state, options.threadStatus)
        : null,
      activeWorkflows: selectActiveWorkflowMessages(messages),
      activeBackgroundCommands: selectActiveBackgroundCommandMessages(
        messages,
        callMessageById,
      ),
    },
  };
}

function buildProjection(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
  includeActiveThinking: boolean,
): EventProjection {
  if (!events || events.length === 0) return emptyEventProjection();
  const orderedEvents = getOrderedThreadEvents(events);
  const { messages, state } = buildFlatProjectionData(
    orderedEvents,
    options,
    includeActiveThinking,
  );
  return applyProjectionTurnMessageDetail(
    normalizeEventProjection({
      ...groupEventProjectionTurns({ events: orderedEvents, messages }),
      state,
    }),
    options.turnMessageDetail,
  );
}

export function buildEventProjectionEntries(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
): EventProjection {
  return buildProjection(events, options, false);
}

export function buildEventProjection(
  events: ThreadEventWithMeta[] | undefined,
  options: BuildEventProjectionOptions,
): EventProjection {
  return buildProjection(events, options, true);
}
