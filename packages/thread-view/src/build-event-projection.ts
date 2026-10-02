import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  LOCAL_WORKFLOW_TASK_TYPE,
  requireThreadEventScopeTurnId,
  type ThreadEvent,
} from "@bb/domain";
import {
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
  type AssistantMessage,
  type EventMeta,
  type FileEditMessage,
  type InteractionMessage,
  type Message,
  type OperationMessage,
  type Projection,
  type ProjectionOptions,
  type ThreadEventWithMeta,
  type UserMessage,
  type VisibleTextBuffer,
  type WorkflowMessage,
} from "./event-projection-types.js";
import {
  buildProjectionEntries,
  getOrderedThreadEvents,
  sortMessagesBySource,
} from "./group-event-projection-turns.js";
import * as items from "./item-lifecycle.js";
import * as operations from "./operation-projection.js";
import {
  finalizeOperationMessage,
  interruptOperationMessage,
  parseErrorMessage,
  parseOperationMessage,
} from "./parse-operation-message.js";
import * as text from "./text-projection.js";
import { getMessageStartedAt } from "./timeline-format.js";
import * as tools from "./tool-activity-projection.js";
import * as requests from "./user-message-parsing.js";

interface PendingDelegationTurnLink {
  callId: string;
  parentTurnId: string;
}

export interface ProjectionState {
  messages: Message[];
  toolActivity: tools.ToolActivityState;
  backgroundTasksByItemId: Map<string, WorkflowMessage>;
  fileEditsByCallId: Map<string, FileEditMessage[]>;
  fileEditStdoutBuffersByScopedCallKey: Map<string, VisibleTextBuffer>;
  openCompactionsByKey: Map<string, OperationMessage>;
  finalizedCompactionKeys: Set<string>;
  lifecycleMessagesByKey: Map<string, OperationMessage | InteractionMessage>;
  openAssistantMessagesByKey: Map<string, AssistantMessage>;
  assistantTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleAssistantMessageKeys: Set<string>;
  finalizedAssistantMessageKeys: Set<string>;
  finalizedReasoningKeys: Set<string>;
  reasoningDeltaTextByKey: Map<string, { content: string; summary: string }>;
  reasoningMessagesAwaitingCompletion: Map<string, OperationMessage>;
  openReasoningLifecyclesByKey: Map<string, text.ActiveThinkingLifecycle>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
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

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    toolActivity: tools.createToolActivityState(),
    backgroundTasksByItemId: new Map(),
    fileEditsByCallId: new Map(),
    fileEditStdoutBuffersByScopedCallKey: new Map(),
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    lifecycleMessagesByKey: new Map(),
    openAssistantMessagesByKey: new Map(),
    assistantTextBuffersByKey: new Map(),
    visibleAssistantMessageKeys: new Set(),
    finalizedAssistantMessageKeys: new Set(),
    finalizedReasoningKeys: new Set(),
    reasoningDeltaTextByKey: new Map(),
    reasoningMessagesAwaitingCompletion: new Map(),
    openReasoningLifecyclesByKey: new Map(),
    reasoningTextBuffersByKey: new Map(),
    seenUserKeys: new Set(),
    openTurnIds: new Set(),
    closedTurnIds: new Set(),
    interruptedTurnCompletedAtById: new Map(),
    threadInterruptedAt: null,
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    delegationParentToolCallIdsByTurnId: new Map(),
    suppressedAcceptedRootParentToolCallIdsByTurnId: new Map(),
    pendingDelegationTurnLinksByProviderThreadId: new Map(),
    delegatedTurnLinkCallIds: new Set(),
  };
}

function onTurnCompleted(
  state: ProjectionState,
  meta: EventMeta,
  decoded: Extract<ThreadEvent, { type: "turn/completed" }>,
): void {
  const turnId = requireThreadEventScopeTurnId(decoded);
  state.closedTurnIds.add(turnId);
  state.openTurnIds.delete(turnId);
  if (decoded.status === "interrupted") {
    state.interruptedTurnCompletedAtById.set(turnId, meta.createdAt);
  }
  text.finalizeOpenReasoningLifecycles(
    state,
    meta,
    decoded.status === "completed" ? "completed" : "interrupted",
    turnId,
  );
  flushBufferedOutputs(state, turnId);
}

function onThreadInterrupted(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
): void {
  state.threadInterruptedAt = meta.createdAt;
  operations.interruptOpenCompactions(state, meta, threadId);
  for (const turnId of state.openTurnIds) {
    state.interruptedTurnCompletedAtById.set(turnId, meta.createdAt);
    state.closedTurnIds.add(turnId);
  }
  state.openTurnIds.clear();
  text.finalizeOpenReasoningLifecycles(state, meta, "interrupted");
  flushBufferedOutputs(state);
}

function flushBufferedOutputs(state: ProjectionState, turnId?: string): void {
  text.flushBufferedAssistantMessages(state, turnId);
  tools.flushPendingToolActivityOutput(state);
  operations.flushPendingFileEditOutput(state);
}

function finalizePendingMessages(
  state: ProjectionState,
  options: ProjectionOptions,
): void {
  if (requests.shouldPreservePendingMessages(options.threadStatus)) {
    tools.flushActiveToolCell(state);
    return;
  }
  tools.flushPendingToolActivityOutput(state);
  operations.flushPendingFileEditOutput(state);
  tools.interruptPendingToolActivity(state, state.threadInterruptedAt);
  for (const fileEdit of [...state.fileEditsByCallId.values()].flat()) {
    if (fileEdit.status === "pending") fileEdit.status = "interrupted";
  }
  text.flushBufferedAssistantMessages(state);
  for (const message of state.messages) {
    if (message.kind !== "operation") continue;
    const settledTurnCompaction =
      options.threadStatus === "idle" &&
      message.opType === "compaction" &&
      message.scope.kind === "turn" &&
      state.closedTurnIds.has(message.scope.turnId);
    if (!settledTurnCompaction) finalizeOperationMessage(message, options);
  }
  tools.flushActiveToolCell(state);
}

function finalizeInterruptedTurnPendingMessages(state: ProjectionState): void {
  for (const [turnId, completedAt] of state.interruptedTurnCompletedAtById) {
    tools.interruptPendingToolActivity(state, completedAt, turnId);
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
    } else if (message.kind === "file-edit" && message.status === "pending") {
      message.status = "interrupted";
    } else if (message.kind === "interaction" && message.status === "pending") {
      message.status = "interrupted";
      if (message.workKind === "form") message.lifecycle = "cancelled";
      else message.lifecycle = "interrupted";
    }
  }
}

interface ClientTurnRequestedWithMeta {
  event: requests.ClientTurnRequestedEvent;
  meta: EventMeta;
}

function byNewestStart(messages: WorkflowMessage[]): WorkflowMessage[] {
  return messages.sort(
    (a, b) => getMessageStartedAt(b) - getMessageStartedAt(a),
  );
}

function isVisiblePendingTask(message: Message): message is WorkflowMessage {
  return (
    message.kind === "workflow" &&
    message.status === "pending" &&
    !message.skipTranscript
  );
}

type CallMessage = Extract<Message, { callId: string }>;

function isDirectBackgroundTaskForCurrentAgent(
  message: WorkflowMessage,
  callMessageById: ReadonlyMap<string, CallMessage>,
): boolean {
  if (!message.parentToolCallId) return true;
  const spawningCall = callMessageById.get(message.parentToolCallId);
  return spawningCall ? spawningCall.parentToolCallId === undefined : true;
}

function getBackgroundTaskFamilyId(message: WorkflowMessage): string {
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
  messages: readonly Message[],
  callMessageById: ReadonlyMap<string, CallMessage>,
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
    const spawningCall = callMessageById.get(message.parentToolCallId ?? "");
    const spawningModel =
      message.parentToolCallId &&
      spawningCall?.kind === "exec" &&
      spawningCall.workKind === "delegation"
        ? spawningCall.model
        : undefined;
    message.model =
      spawningModel ??
      message.model ??
      modelByTaskFamilyId.get(taskFamilyId) ??
      null;
    if (message.model !== null) {
      modelByTaskFamilyId.set(taskFamilyId, message.model);
    }
  }
}

function getRootSpawningCallId(
  message: WorkflowMessage,
  callMessageById: ReadonlyMap<string, CallMessage>,
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
  messages: readonly Message[],
  callMessageById: ReadonlyMap<string, CallMessage>,
): WorkflowMessage[] {
  const pendingTasks = messages.filter(isVisiblePendingTask);
  const representedRootCallIds = new Set(
    pendingTasks.flatMap((message) =>
      message.parentToolCallId &&
      isDirectBackgroundTaskForCurrentAgent(message, callMessageById)
        ? [message.parentToolCallId]
        : [],
    ),
  );
  return byNewestStart(
    pendingTasks.filter((message) => {
      if (message.taskType === LOCAL_WORKFLOW_TASK_TYPE) return false;
      if (isDirectBackgroundTaskForCurrentAgent(message, callMessageById)) {
        return true;
      }
      const rootCallId = getRootSpawningCallId(message, callMessageById);
      const representedByActiveParent =
        rootCallId !== undefined && representedRootCallIds.has(rootCallId);
      return (
        !representedByActiveParent &&
        isBackgroundCommandTaskType(message.taskType)
      );
    }),
  );
}

function canUseAcceptedClientRequestForVisibleProjection(
  acceptedClientRequest: requests.AcceptedClientRequest,
  { target }: requests.ClientTurnRequestedEvent,
  selectedStartedTurnIds: ReadonlySet<string>,
): boolean {
  if (target.kind !== "auto" && target.kind !== "steer") return true;
  return (
    target.expectedTurnId === null ||
    acceptedClientRequest.turnId === target.expectedTurnId ||
    selectedStartedTurnIds.has(acceptedClientRequest.turnId)
  );
}

function appendProjectedUserMessages(
  state: ProjectionState,
  messages: readonly UserMessage[],
): void {
  for (const message of messages) {
    if (state.seenUserKeys.has(message.id)) continue;
    state.seenUserKeys.add(message.id);
    tools.flushActiveToolCell(state);
    state.messages.push(message);
  }
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
  pendingLinks.push({ callId, parentTurnId });
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

function getCompactionTurnFinalization(decoded: ThreadEvent):
  | {
      status: operations.CompactionTurnFinalizationStatus;
      detail: string | undefined;
    }
  | undefined {
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

function linkDelegationChild(
  state: ProjectionState,
  decoded: ThreadEvent,
  callId: string,
): void {
  const childRef = getDelegationChildRef(decoded);
  if (childRef === undefined) return;
  const providerThreadId = getEventProviderThreadId(decoded);
  if (
    childRef === providerThreadId ||
    state.delegatedTurnLinkCallIds.has(callId)
  ) {
    enqueuePendingDelegationTurnLink(
      state,
      providerThreadId,
      getEventTurnId(decoded),
      callId,
    );
  } else {
    state.delegationParentToolCallIdsByProviderThreadId.set(childRef, callId);
  }
}

function buildFlatProjectionData(
  orderedEvents: ThreadEventWithMeta[],
  options: ProjectionOptions,
): Omit<Projection, "entries"> & { messages: Message[] } {
  const state = createProjectionState();
  const acceptedClientRequestById =
    requests.buildAcceptedClientRequestById(orderedEvents);
  const clientRequestById = new Map<string, ClientTurnRequestedWithMeta>();
  const rejectedClientRequestIds = new Set<string>();
  const selectedStartedTurnIds = new Set<string>();
  for (const { event, meta } of orderedEvents) {
    if (event.type === "client/turn/requested") {
      clientRequestById.set(event.requestId, { event, meta });
    } else if (event.type === "client/turn/rejected") {
      rejectedClientRequestIds.add(event.requestId);
    } else if (event.type === "turn/started") {
      selectedStartedTurnIds.add(requireThreadEventScopeTurnId(event));
    }
  }
  const acceptedRootClientTurnIds = new Set(
    orderedEvents.flatMap(({ event }) => {
      if (event.type !== "turn/input/accepted") return [];
      const target = clientRequestById.get(event.clientRequestId)?.event.target;
      return target?.kind === "new-turn" || target?.kind === "thread-start"
        ? [requireThreadEventScopeTurnId(event)]
        : [];
    }),
  );
  for (const { event: decoded, meta } of orderedEvents) {
    const { threadId } = decoded;
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
        const parentToolCallId =
          explicitEventParentToolCallId ?? pendingParentToolCallId;
        if (parentToolCallId) {
          state.delegationParentToolCallIdsByTurnId.set(
            turnId,
            parentToolCallId,
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
      const settledPendingCompaction =
        operations.finalizeOpenCompactionsForTurn(
          state,
          meta,
          threadId,
          eventTurnId,
          compactionTurnFinalization.status,
          compactionTurnFinalization.detail,
        );
      if (settledPendingCompaction && decoded.type === "provider/warning") {
        continue;
      }
    }
    if (decoded.type === "turn/completed") {
      onTurnCompleted(state, meta, decoded);
      continue;
    }
    if (decoded.type === "system/thread/interrupted") {
      onThreadInterrupted(state, meta, threadId);
    }
    if (decoded.type === "turn/input/accepted") {
      const clientRequest = clientRequestById.get(decoded.clientRequestId);
      const accepted = acceptedClientRequestById.get(decoded.clientRequestId);
      if (
        clientRequest &&
        accepted &&
        requests.turnRequestKind(clientRequest.event, accepted) === "steer"
      ) {
        appendProjectedUserMessages(
          state,
          requests.clientRequestUserMessages(
            clientRequest.event,
            clientRequest.meta,
            "accepted",
            accepted,
          ),
        );
      }
      continue;
    }
    if (decoded.type === "client/turn/rejected") {
      const clientRequest = clientRequestById.get(decoded.requestId);
      if (clientRequest) {
        appendProjectedUserMessages(
          state,
          requests.clientRequestUserMessages(
            clientRequest.event,
            meta,
            "rejected",
          ),
        );
      }
      continue;
    }
    if (decoded.type === "client/turn/requested") {
      if (rejectedClientRequestIds.has(decoded.requestId)) continue;
      const accepted = acceptedClientRequestById.get(decoded.requestId);
      const visibleAccepted =
        accepted &&
        canUseAcceptedClientRequestForVisibleProjection(
          accepted,
          decoded,
          selectedStartedTurnIds,
        )
          ? accepted
          : undefined;
      if (requests.turnRequestKind(decoded, visibleAccepted) === "message") {
        appendProjectedUserMessages(
          state,
          requests.clientRequestUserMessages(
            decoded,
            meta,
            visibleAccepted ? "accepted" : "pending",
            visibleAccepted,
          ),
        );
      }
      continue;
    }
    const providerUserMessage = requests.parseProviderUserMessage(
      decoded,
      meta,
    );
    if (providerUserMessage) {
      appendProjectedUserMessages(state, [providerUserMessage]);
      continue;
    }
    if (
      text.projectAssistantAndReasoningEvent(
        state,
        decoded,
        meta,
        eventTurnId,
        eventParentToolCallId,
      )
    ) {
      continue;
    }
    const backgroundTask = tools.parseBackgroundTaskLifecycleEvent(decoded);
    if (backgroundTask) {
      tools.flushActiveToolCell(state);
      tools.upsertBackgroundTaskMessage(state, meta, decoded, backgroundTask);
      continue;
    }
    const execEvent = items.parseExecLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (execEvent) {
      tools.applyExecLifecycleEvent(
        state,
        meta,
        threadId,
        eventTurnId,
        execEvent,
      );
      continue;
    }
    if (items.shouldSuppressLowValueToolCall(decoded)) continue;
    const toolCallEvent = items.parseToolCallLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (toolCallEvent) {
      if (toolCallEvent.kind !== "output") {
        linkDelegationChild(state, decoded, toolCallEvent.call.callId);
      }
      tools.applyExecLifecycleEvent(
        state,
        meta,
        threadId,
        eventTurnId,
        toolCallEvent,
      );
      continue;
    }
    const itemEvent = items.parseItemLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (itemEvent) {
      tools.applyItemLifecycleEvent(
        state,
        meta,
        threadId,
        eventTurnId,
        itemEvent,
      );
      continue;
    }
    const fileEdit = items.parseFileEditFromItemEvent(
      decoded,
      eventParentToolCallId,
    );
    if (fileEdit) {
      tools.flushActiveToolCell(state);
      operations.upsertFileEdit(state, meta, threadId, eventTurnId, fileEdit);
      continue;
    }
    const compactionEvent = items.parseCompactionLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
    );
    if (compactionEvent) {
      tools.flushActiveToolCell(state);
      operations.applyCompactionEvent(
        state,
        meta,
        threadId,
        eventTurnId,
        compactionEvent,
      );
      continue;
    }
    const operation = parseOperationMessage(decoded, meta, options);
    if (operation) {
      tools.flushActiveToolCell(state);
      operations.upsertLifecycleMessage(state, operation);
      continue;
    }
    const error = parseErrorMessage(decoded, meta);
    if (error) {
      tools.flushActiveToolCell(state);
      state.messages.push(error);
    }
  }
  finalizeInterruptedTurnPendingMessages(state);
  finalizePendingMessages(state, options);
  const messages = sortMessagesBySource(state.messages);
  const callMessageById = new Map(
    messages.flatMap((message) =>
      "callId" in message ? [[message.callId, message] as const] : [],
    ),
  );
  enrichBackgroundAgentModels(messages, callMessageById);
  return {
    messages,
    activeThinking: text.buildProjectionActiveThinking(
      state,
      options.threadStatus,
    ),
    activeWorkflows: byNewestStart(
      messages
        .filter(isVisiblePendingTask)
        .filter((message) => message.taskType === LOCAL_WORKFLOW_TASK_TYPE),
    ),
    activeBackgroundCommands: selectActiveBackgroundCommandMessages(
      messages,
      callMessageById,
    ),
  };
}

export function buildEventProjection(
  events: ThreadEventWithMeta[],
  options: ProjectionOptions,
): Projection {
  const orderedEvents = getOrderedThreadEvents(events);
  const { messages, ...state } = buildFlatProjectionData(
    orderedEvents,
    options,
  );
  return {
    entries: buildProjectionEntries(orderedEvents, messages),
    ...state,
  };
}
