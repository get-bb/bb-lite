import {
  type EventProjectionMessage,
  type EventProjection,
  type EventProjectionTurn,
  type EventProjectionTurnMessageDetail,
  findLastTerminalTimelineMessage,
  isSingletonContextManagementOperation,
  isTimelineTerminalMessage,
  isTimelineUngroupableMessage,
  type EventProjectionEntry,
  type EventMeta,
  emptyEventProjection,
  extendMessageBounds,
  getProjectionEntryMessages,
  type EventProjectionDelegationMessage,
  type EventProjectionToolCallMessage,
} from "./event-projection-types.js";
import {
  type ThreadEvent,
  requireThreadEventScopeTurnId,
  type CompletedTurnDisplay,
} from "@bb/domain";
import {
  getFirstStringField,
  getMessageStartedAt,
  messageId,
} from "./timeline-format.js";
import type { TimelineTurnRow } from "@bb/server-contract";

export interface ExternalUserBoundaryTurnSpan {
  completionSequence: number | null;
  sequenceStart: number;
  turnId: string;
}

export interface ExternalUserBoundaryMessage {
  sequence: number;
  turnId: string | null;
}

export function isExternalUserBoundaryForTurn(
  turn: ExternalUserBoundaryTurnSpan,
  message: ExternalUserBoundaryMessage,
): boolean {
  return (
    message.turnId !== turn.turnId &&
    message.sequence > turn.sequenceStart &&
    (turn.completionSequence === null ||
      message.sequence < turn.completionSequence)
  );
}

function getProjectionMessageSummaryCount(
  message: EventProjectionMessage,
): number {
  if (message.kind === "file-edit") return Math.max(1, message.changes.length);
  return 1;
}

export function getProjectionSummaryCount(
  messages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): number {
  let count = 0;
  for (const message of messages) {
    if (terminalMessage && message.id === terminalMessage.id) break;
    if (!isTimelineUngroupableMessage(message)) {
      count += getProjectionMessageSummaryCount(message);
    }
  }
  return count;
}

function shouldIncludeSummaryTurnMessages(
  messages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): boolean {
  let foundTerminalMessage = false;
  for (const message of messages) {
    if (terminalMessage && message.id === terminalMessage.id) {
      foundTerminalMessage = true;
      continue;
    }
    if (terminalMessage && isTimelineTerminalMessage(message)) return true;
    if (isTimelineUngroupableMessage(message)) return true;
    if (terminalMessage && foundTerminalMessage) return true;
  }
  return false;
}

export function assertTerminalMessageIncludedInMessages(
  turn: EventProjectionTurn,
): void {
  const messages = turn.messages;
  const terminalMessage = turn.terminalMessage;
  if (!messages || !terminalMessage) return;
  if (messages.some((message) => message.id === terminalMessage.id)) return;
  throw new Error(
    `Timeline projection turn ${turn.turnId} has terminal message ${terminalMessage.id} outside its messages array`,
  );
}

function summarizeTurn(turn: EventProjectionTurn): EventProjectionTurn {
  const messages = turn.messages ?? [];
  const terminalMessage = findLastTerminalTimelineMessage(messages);
  const summaryMessages = terminalMessage
    ? messages.slice(0, messages.indexOf(terminalMessage))
    : messages;
  const summaryCount = getProjectionSummaryCount(messages, terminalMessage);
  const includeMessages =
    turn.status === "pending" ||
    (turn.externalUserBoundarySeqs?.length ?? 0) > 0 ||
    isSingletonContextManagementOperation(summaryMessages) ||
    shouldIncludeSummaryTurnMessages(messages, terminalMessage);
  const detailedTurn: EventProjectionTurn = {
    turnId: turn.turnId,
    threadId: turn.threadId,
    sourceSeqStart: turn.sourceSeqStart,
    sourceSeqEnd: turn.sourceSeqEnd,
    startedAt: turn.startedAt,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
    status: turn.status,
    summaryCount,
    ...(turn.externalUserBoundarySeqs
      ? { externalUserBoundarySeqs: turn.externalUserBoundarySeqs }
      : {}),
  };
  if (terminalMessage) detailedTurn.terminalMessage = terminalMessage;
  if (includeMessages) detailedTurn.messages = messages;
  assertTerminalMessageIncludedInMessages(detailedTurn);
  return detailedTurn;
}

export function applyProjectionTurnMessageDetail(
  projection: EventProjection,
  turnMessageDetail: EventProjectionTurnMessageDetail,
): EventProjection {
  if (turnMessageDetail === "full") return projection;
  return {
    state: projection.state,
    entries: projection.entries.map((entry) => {
      if (entry.kind === "projected-message") {
        return { kind: "projected-message", message: entry.message };
      }
      return { kind: "turn", turn: summarizeTurn(entry.turn) };
    }),
  };
}

export type ThreadEventWithMeta = { event: ThreadEvent; meta: EventMeta };

type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;

interface ProjectionTurnDraft {
  completionSequence: number | null;
  messages: EventProjectionMessage[];
  startedSequence: number;
  turn: EventProjectionTurn;
}

type ProjectionEntryDraft =
  | { kind: "turn"; createdAt: number; sourceSeqStart: number; turnId: string }
  | {
      kind: "projected-message";
      createdAt: number;
      message: EventProjectionMessage;
      sourceSeqStart: number;
    };

export function getOrderedThreadEvents(
  events: readonly ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let areEventsOrdered = true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      areEventsOrdered = false;
      break;
    }
  }
  return areEventsOrdered
    ? Array.from(events)
    : Array.from(events).sort((a, b) => a.meta.seq - b.meta.seq);
}

function createProjectionTurn(
  event: TurnStartedEvent,
  meta: EventMeta,
): ProjectionTurnDraft {
  const turnId = requireThreadEventScopeTurnId(event);
  return {
    completionSequence: null,
    messages: [],
    startedSequence: meta.seq,
    turn: {
      turnId,
      threadId: event.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      completedAt: null,
      status: "pending",
      summaryCount: 0,
    },
  };
}

function updateProjectionTurnBounds(
  draft: ProjectionTurnDraft,
  threadId: string,
  sourceSeqStart: number,
  sourceSeqEnd: number,
  createdAt: number,
): void {
  draft.turn.threadId = threadId;
  draft.turn.sourceSeqStart = Math.min(
    draft.turn.sourceSeqStart,
    sourceSeqStart,
  );
  extendMessageBounds(draft.turn, sourceSeqEnd, createdAt);
}

function addProjectionTurnMessage(
  draft: ProjectionTurnDraft,
  message: EventProjectionMessage,
): void {
  draft.messages.push(message);
  updateProjectionTurnBounds(
    draft,
    message.threadId,
    message.sourceSeqStart,
    message.sourceSeqEnd,
    message.createdAt,
  );
}

function findTurnRunningAtSequence(
  turnsById: ReadonlyMap<string, ProjectionTurnDraft>,
  sequence: number,
): ProjectionTurnDraft | null {
  let running: ProjectionTurnDraft | null = null;
  for (const draft of turnsById.values()) {
    if (draft.startedSequence >= sequence) continue;
    if (
      draft.completionSequence !== null &&
      draft.completionSequence < sequence
    ) {
      continue;
    }
    if (running === null || draft.startedSequence > running.startedSequence) {
      running = draft;
    }
  }
  return running;
}

function applyExternalUserBoundaries(
  turnsById: Map<string, ProjectionTurnDraft>,
  messages: EventProjectionMessage[],
): void {
  const userMessages = messages.flatMap((message) =>
    message.kind === "user" && message.initiator === "user"
      ? [
          {
            sequence: message.sourceSeqStart,
            turnId: message.scope.kind === "turn" ? message.scope.turnId : null,
          },
        ]
      : [],
  );
  for (const [turnId, draft] of turnsById) {
    const span = {
      completionSequence: draft.completionSequence,
      sequenceStart: draft.turn.sourceSeqStart,
      turnId,
    };
    const boundarySeqs = new Set<number>();
    for (const message of userMessages) {
      if (isExternalUserBoundaryForTurn(span, message)) {
        boundarySeqs.add(message.sequence);
      }
    }
    if (boundarySeqs.size > 0) {
      draft.turn.externalUserBoundarySeqs = [...boundarySeqs].sort(
        (left, right) => left - right,
      );
    }
  }
}

function createEventProjectionEntry(
  draft: ProjectionEntryDraft,
  turnsById: Map<string, ProjectionTurnDraft>,
): EventProjectionEntry {
  if (draft.kind === "projected-message") {
    return { kind: "projected-message", message: draft.message };
  }
  const turnDraft = turnsById.get(draft.turnId);
  if (!turnDraft) {
    throw new Error(
      `Cannot build timeline projection for missing turn ${draft.turnId}`,
    );
  }
  const terminalMessage = findLastTerminalTimelineMessage(turnDraft.messages);
  const turn: EventProjectionTurn = {
    ...turnDraft.turn,
    summaryCount: getProjectionSummaryCount(
      turnDraft.messages,
      terminalMessage,
    ),
    messages: turnDraft.messages,
  };
  if (terminalMessage) turn.terminalMessage = terminalMessage;
  assertTerminalMessageIncludedInMessages(turn);
  return { kind: "turn", turn };
}

export function groupEventProjectionTurns(args: {
  events: ThreadEventWithMeta[];
  messages: EventProjectionMessage[];
}): EventProjection {
  const turnsById = new Map<string, ProjectionTurnDraft>();
  const clientRequestMetaById = new Map<string, EventMeta>();
  const entryDrafts: ProjectionEntryDraft[] = [];
  for (const { event, meta } of args.events) {
    if (event.type === "client/turn/requested") {
      clientRequestMetaById.set(event.requestId, meta);
    }
  }
  for (const { event, meta } of args.events) {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId(event);
      if (turnsById.has(turnId)) continue;
      turnsById.set(turnId, createProjectionTurn(event, meta));
      entryDrafts.push({
        kind: "turn",
        turnId,
        sourceSeqStart: meta.seq,
        createdAt: meta.createdAt,
      });
      continue;
    }
    if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId(event);
      const existing = turnsById.get(turnId);
      if (!existing) {
        throw new Error(
          `Timeline projection found turn/completed without turn/started for ${turnId}`,
        );
      }
      updateProjectionTurnBounds(
        existing,
        event.threadId,
        meta.seq,
        meta.seq,
        meta.createdAt,
      );
      existing.turn.completedAt = meta.createdAt;
      existing.turn.status = event.status === "failed" ? "error" : event.status;
      existing.completionSequence ??= meta.seq;
      continue;
    }
    if (event.type === "turn/input/accepted") {
      const turnId = requireThreadEventScopeTurnId(event);
      const existing = turnsById.get(turnId);
      if (!existing) {
        throw new Error(
          `Timeline projection found turn/input/accepted without turn/started for ${turnId}`,
        );
      }
      const clientRequestMeta = clientRequestMetaById.get(
        event.clientRequestId,
      );
      if (clientRequestMeta) {
        updateProjectionTurnBounds(
          existing,
          event.threadId,
          clientRequestMeta.seq,
          clientRequestMeta.seq,
          clientRequestMeta.createdAt,
        );
      }
    }
  }
  for (const message of args.messages) {
    if (message.scope.kind === "thread") {
      const runningTurn =
        "interactionId" in message
          ? findTurnRunningAtSequence(turnsById, message.sourceSeqStart)
          : null;
      if (runningTurn !== null) {
        addProjectionTurnMessage(runningTurn, message);
        continue;
      }
      entryDrafts.push({
        kind: "projected-message",
        message,
        sourceSeqStart: message.sourceSeqStart,
        createdAt: message.createdAt,
      });
      continue;
    }
    const turnId = message.scope.turnId;
    const turnDraft = turnsById.get(turnId);
    if (!turnDraft) {
      throw new Error(
        `Timeline projection found message ${message.id} for turn ${turnId} without turn/started`,
      );
    }
    addProjectionTurnMessage(turnDraft, message);
  }
  applyExternalUserBoundaries(turnsById, args.messages);
  const orderedEntryDrafts = [...entryDrafts].sort(
    (left, right) =>
      left.sourceSeqStart - right.sourceSeqStart ||
      left.createdAt - right.createdAt,
  );
  return emptyEventProjection(
    orderedEntryDrafts.map((entryDraft) =>
      createEventProjectionEntry(entryDraft, turnsById),
    ),
  );
}

interface ProjectionMessageBounds {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  startedAt: number;
}

interface TurnMessageContext {
  kind: "turn";
  entryIndex: number;
  message: EventProjectionMessage;
  messageIndex: number;
  turn: EventProjectionTurn;
}

type SemanticMessageContext =
  | {
      kind: "projected-message";
      entryIndex: number;
      message: EventProjectionMessage;
      messageIndex: number;
    }
  | TurnMessageContext;

export function sortEventProjectionMessagesBySource(
  messages: EventProjectionMessage[],
): EventProjectionMessage[] {
  return messages
    .map((message, index) => ({ index, message }))
    .sort((left, right) => {
      if (left.message.sourceSeqStart !== right.message.sourceSeqStart) {
        return left.message.sourceSeqStart - right.message.sourceSeqStart;
      }
      if (left.message.createdAt !== right.message.createdAt) {
        return left.message.createdAt - right.message.createdAt;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.message);
}

function isDelegationSourceMessage(
  message: EventProjectionMessage,
): message is EventProjectionDelegationMessage {
  return message.kind === "delegation";
}

function toolCallAsDelegationMessage(
  message: EventProjectionToolCallMessage,
): EventProjectionDelegationMessage {
  const {
    kind: _kind,
    toolArgs,
    approvalStatus: _approvalStatus,
    ...shared
  } = message;
  const subagentType = getFirstStringField(toolArgs, [
    "subagent_type",
    "subagentType",
  ]);
  const description = getFirstStringField(toolArgs, ["description", "prompt"]);
  const model = getFirstStringField(toolArgs, ["model"]);
  return {
    ...shared,
    id: messageId(message.threadId, "delegation", message.callId),
    kind: "delegation",
    ...(subagentType ? { subagentType } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    childRef: null,
    background: false,
    childProjection: emptyEventProjection(),
  };
}

function maybeStartedAt(
  message: { createdAt: number; startedAt?: number },
  childBounds: ProjectionMessageBounds | null,
): number | undefined {
  if (childBounds) {
    return Math.min(getMessageStartedAt(message), childBounds.startedAt);
  }
  return message.startedAt;
}

function toDelegationMessage(
  message: EventProjectionDelegationMessage,
  childProjection: EventProjection,
): EventProjectionDelegationMessage {
  const resolvedChildProjection = mergeChildProjections(
    message.childProjection,
    childProjection,
  );
  const childBounds = getProjectionMessageBounds(resolvedChildProjection);
  const startedAt = maybeStartedAt(message, childBounds);
  const delegation: EventProjectionDelegationMessage = {
    ...message,
    sourceSeqStart: childBounds
      ? Math.min(message.sourceSeqStart, childBounds.sourceSeqStart)
      : message.sourceSeqStart,
    sourceSeqEnd: childBounds
      ? Math.max(message.sourceSeqEnd, childBounds.sourceSeqEnd)
      : message.sourceSeqEnd,
    createdAt: childBounds
      ? Math.max(message.createdAt, childBounds.createdAt)
      : message.createdAt,
    childProjection: resolvedChildProjection,
  };
  if (startedAt !== undefined) delegation.startedAt = startedAt;
  if (message.parentToolCallId) {
    delegation.parentToolCallId = message.parentToolCallId;
  }
  return delegation;
}

function mergeChildProjections(
  existingProjection: EventProjection,
  discoveredProjection: EventProjection,
): EventProjection {
  if (existingProjection.entries.length === 0) return discoveredProjection;
  if (discoveredProjection.entries.length === 0) return existingProjection;
  const existingMessageIds = new Set(
    existingProjection.entries
      .flatMap((entry) => getProjectionEntryMessages(entry))
      .map((message) => message.id),
  );
  const discoveredEntries = discoveredProjection.entries.filter((entry) =>
    getProjectionEntryMessages(entry).some(
      (message) => !existingMessageIds.has(message.id),
    ),
  );
  if (discoveredEntries.length === 0) return existingProjection;
  return {
    state: existingProjection.state,
    entries: [...existingProjection.entries, ...discoveredEntries],
  };
}

function getProjectionMessageBounds(
  projection: EventProjection,
): ProjectionMessageBounds | null {
  let bounds: ProjectionMessageBounds | null = null;
  for (const entry of projection.entries) {
    for (const message of getProjectionEntryMessages(entry)) {
      const startedAt = getMessageStartedAt(message);
      bounds = bounds
        ? {
            sourceSeqStart: Math.min(
              bounds.sourceSeqStart,
              message.sourceSeqStart,
            ),
            sourceSeqEnd: Math.max(bounds.sourceSeqEnd, message.sourceSeqEnd),
            startedAt: Math.min(bounds.startedAt, startedAt),
            createdAt: Math.max(bounds.createdAt, message.createdAt),
          }
        : {
            sourceSeqStart: message.sourceSeqStart,
            sourceSeqEnd: message.sourceSeqEnd,
            startedAt,
            createdAt: message.createdAt,
          };
    }
  }
  return bounds;
}

function buildSourceTurn(
  sourceTurn: EventProjectionTurn,
  messages: EventProjectionMessage[],
): EventProjectionTurn {
  const terminalMessage = findLastTerminalTimelineMessage(messages);
  const turn: EventProjectionTurn = {
    ...sourceTurn,
    summaryCount: getProjectionSummaryCount(messages, terminalMessage),
    messages,
  };
  delete turn.terminalMessage;
  if (terminalMessage) turn.terminalMessage = terminalMessage;
  return turn;
}

function collectProjectionMessageContexts(
  projection: EventProjection,
): SemanticMessageContext[] {
  const contexts: SemanticMessageContext[] = [];
  let messageIndex = 0;
  projection.entries.forEach((entry, entryIndex) => {
    if (entry.kind === "projected-message") {
      contexts.push({
        kind: "projected-message",
        entryIndex,
        message: entry.message,
        messageIndex,
      });
      messageIndex += 1;
      return;
    }
    for (const message of getProjectionEntryMessages(entry)) {
      contexts.push({
        kind: "turn",
        entryIndex,
        message,
        messageIndex,
        turn: entry.turn,
      });
      messageIndex += 1;
    }
  });
  return contexts;
}

function isSameTurnEntry(
  left: SemanticMessageContext,
  right: SemanticMessageContext,
): right is TurnMessageContext {
  return (
    left.kind === "turn" &&
    right.kind === "turn" &&
    left.entryIndex === right.entryIndex
  );
}

class SemanticProjectionBuilder {
  private readonly attachedMessageIds = new Set<string>();
  private readonly childrenByParentCallId = new Map<
    string,
    SemanticMessageContext[]
  >();
  private readonly rootContexts: SemanticMessageContext[];
  constructor(contexts: SemanticMessageContext[]) {
    const referencedParentCallIds = new Set(
      contexts
        .map((context) => context.message.parentToolCallId)
        .filter((id): id is string => id !== undefined),
    );
    for (const context of contexts) {
      if (
        context.message.kind === "tool-call" &&
        referencedParentCallIds.has(context.message.callId)
      ) {
        context.message = toolCallAsDelegationMessage(context.message);
      }
    }
    const delegationCallIds = new Set(
      contexts
        .map((context) => context.message)
        .filter(isDelegationSourceMessage)
        .map((message) => message.callId),
    );
    for (const context of contexts) {
      const parentToolCallId = context.message.parentToolCallId;
      if (!parentToolCallId || !delegationCallIds.has(parentToolCallId)) {
        continue;
      }
      const children = this.childrenByParentCallId.get(parentToolCallId) ?? [];
      children.push(context);
      this.childrenByParentCallId.set(parentToolCallId, children);
      this.attachedMessageIds.add(context.message.id);
    }
    this.rootContexts = contexts.filter(
      (context) =>
        !this.attachedMessageIds.has(context.message.id) &&
        !this.isRootSuppressedContext(context),
    );
  }
  private isRootSuppressedContext(context: SemanticMessageContext): boolean {
    return context.message.parentToolCallId !== undefined;
  }
  buildRootProjection(): EventProjection {
    return this.buildRootTurnProjection(this.rootContexts);
  }
  private buildRootTurnProjection(
    contexts: SemanticMessageContext[],
  ): EventProjection {
    const entries: EventProjectionEntry[] = [];
    let index = 0;
    while (index < contexts.length) {
      const context = contexts[index];
      if (!context) break;
      if (context.kind === "projected-message") {
        entries.push({
          kind: "projected-message",
          message: this.toSemanticMessage(context.message),
        });
        index += 1;
        continue;
      }
      const sourceTurn = context.turn;
      const messages: EventProjectionMessage[] = [];
      messages.push(this.toSemanticMessage(context.message));
      index += 1;
      while (index < contexts.length) {
        const nextContext = contexts[index];
        if (!nextContext || !isSameTurnEntry(context, nextContext)) break;
        messages.push(this.toSemanticMessage(nextContext.message));
        index += 1;
      }
      entries.push({
        kind: "turn",
        turn: buildSourceTurn(sourceTurn, messages),
      });
    }
    return emptyEventProjection(entries);
  }
  private buildFlatChildProjection(
    contexts: readonly SemanticMessageContext[],
  ): EventProjection {
    return emptyEventProjection(
      contexts.map((context) => ({
        kind: "projected-message",
        message: this.toSemanticMessage(context.message),
      })),
    );
  }
  private toSemanticMessage(
    message: EventProjectionMessage,
  ): EventProjectionMessage {
    if (!isDelegationSourceMessage(message)) return message;
    const childProjection = this.buildFlatChildProjection(
      this.childrenByParentCallId.get(message.callId) ?? [],
    );
    return toDelegationMessage(message, childProjection);
  }
}

export function normalizeEventProjection(
  projection: EventProjection,
): EventProjection {
  const normalizedProjection = new SemanticProjectionBuilder(
    collectProjectionMessageContexts(projection),
  ).buildRootProjection();
  return { ...normalizedProjection, state: projection.state };
}

interface CompletedTurnSummaryGroup {
  kind: "summary";
  startedAt: number;
  completedAt: number | null;
  segmentIndex: number | null;
  sourceMessages: EventProjectionMessage[];
  summaryCount: number;
}

export type CompletedTurnSummaryItem =
  | CompletedTurnSummaryGroup
  | { kind: "ungrouped-message"; message: EventProjectionMessage };

export interface CompletedTurnMessageGroups {
  summaryItems: CompletedTurnSummaryItem[];
  terminalMessages: EventProjectionMessage[];
  trailingMessages: EventProjectionMessage[];
}

function isCompletedTurnSummaryGroup(
  item: CompletedTurnSummaryItem,
): item is CompletedTurnSummaryGroup {
  return item.kind === "summary";
}

function unwrapSingletonContextManagementGroups(
  items: readonly CompletedTurnSummaryItem[],
): CompletedTurnSummaryItem[] {
  return items.map((item) => {
    if (
      item.kind !== "summary" ||
      !isSingletonContextManagementOperation(item.sourceMessages)
    ) {
      return item;
    }
    const onlyMessage = item.sourceMessages[0];
    if (!onlyMessage) {
      throw new Error("Singleton context-management group has no message");
    }
    return { kind: "ungrouped-message", message: onlyMessage };
  });
}

function getSummaryMessageBounds(
  sourceMessages: readonly EventProjectionMessage[],
): { startedAt: number } {
  const firstMessage = sourceMessages[0];
  if (!firstMessage) {
    throw new Error("Cannot derive summary message bounds from no messages");
  }
  let startedAt = getMessageStartedAt(firstMessage);
  for (const message of sourceMessages.slice(1)) {
    startedAt = Math.min(startedAt, getMessageStartedAt(message));
  }
  return { startedAt };
}

function applySingleSummaryTurnBounds(
  turn: EventProjectionTurn,
  items: readonly CompletedTurnSummaryItem[],
): CompletedTurnSummaryItem[] {
  const summaryGroups = items.filter(isCompletedTurnSummaryGroup);
  if (summaryGroups.length !== 1) return [...items];
  const onlySummaryGroup = summaryGroups[0];
  return items.map((item) =>
    item === onlySummaryGroup
      ? { ...item, startedAt: turn.startedAt, completedAt: turn.completedAt }
      : item,
  );
}

function splitCompletedTurnMessages(
  messages: readonly EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): {
  summaryMessages: EventProjectionMessage[];
  terminalMessages: EventProjectionMessage[];
  trailingMessages: EventProjectionMessage[];
} {
  if (!terminalMessage) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [],
      trailingMessages: [],
    };
  }
  const terminalIndex = messages.findIndex(
    (message) => message.id === terminalMessage.id,
  );
  if (terminalIndex === -1) {
    return {
      summaryMessages: [...messages],
      terminalMessages: [terminalMessage],
      trailingMessages: [],
    };
  }
  const terminalMessageAtIndex = messages[terminalIndex];
  if (!terminalMessageAtIndex) {
    throw new Error(
      `Cannot split completed turn messages at index ${terminalIndex}`,
    );
  }
  return {
    summaryMessages: messages.slice(0, terminalIndex),
    terminalMessages: [terminalMessageAtIndex],
    trailingMessages: messages.slice(terminalIndex + 1),
  };
}

function isAssistantResponseMessage(
  message: EventProjectionMessage | undefined,
): boolean {
  return message?.kind === "assistant-text";
}

function findVisibleResponseMessageIds(
  summaryMessages: readonly EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): Set<string> {
  const visibleIds = new Set<string>();
  for (let index = 0; index < summaryMessages.length; index += 1) {
    const message = summaryMessages[index];
    const nextMessage = summaryMessages[index + 1] ?? terminalMessage;
    if (
      isAssistantResponseMessage(message) &&
      isAssistantResponseMessage(nextMessage)
    ) {
      visibleIds.add(message.id);
    }
  }
  return visibleIds;
}

function groupCompletedTurnSummaryMessages(
  turn: EventProjectionTurn,
  summaryMessages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): CompletedTurnSummaryItem[] {
  const externalBoundarySeqs = turn.externalUserBoundarySeqs ?? [];
  const visibleResponseIds = findVisibleResponseMessageIds(
    summaryMessages,
    terminalMessage,
  );
  if (
    externalBoundarySeqs.length === 0 &&
    visibleResponseIds.size === 0 &&
    !summaryMessages.some(isTimelineUngroupableMessage)
  ) {
    return [
      {
        kind: "summary",
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        segmentIndex: null,
        sourceMessages: summaryMessages,
        summaryCount: turn.summaryCount,
      },
    ];
  }
  const items: CompletedTurnSummaryItem[] = [];
  let groupedMessages: EventProjectionMessage[] = [];
  let segmentIndex = 0;
  let externalBoundaryIndex = 0;
  function appendSummaryGroup(sourceMessages: EventProjectionMessage[]): void {
    if (sourceMessages.length === 0) return;
    const bounds = getSummaryMessageBounds(sourceMessages);
    items.push({
      kind: "summary",
      startedAt: bounds.startedAt,
      completedAt: null,
      segmentIndex,
      sourceMessages,
      summaryCount: getProjectionSummaryCount(sourceMessages, undefined),
    });
    segmentIndex += 1;
  }
  function flushGroupedMessages(preserveLastTerminalMessage = false): void {
    if (groupedMessages.length === 0) return;
    const sourceMessages = groupedMessages;
    groupedMessages = [];
    const terminalMessage = preserveLastTerminalMessage
      ? findLastTerminalTimelineMessage(sourceMessages)
      : undefined;
    if (!terminalMessage) {
      appendSummaryGroup(sourceMessages);
      return;
    }
    appendSummaryGroup(
      sourceMessages.filter((message) => message.id !== terminalMessage.id),
    );
    items.push({ kind: "ungrouped-message", message: terminalMessage });
  }
  function flushExternalBoundariesBefore(
    message: EventProjectionMessage,
  ): void {
    while (
      externalBoundaryIndex < externalBoundarySeqs.length &&
      (externalBoundarySeqs[externalBoundaryIndex] ?? 0) <
        message.sourceSeqStart
    ) {
      flushGroupedMessages(true);
      externalBoundaryIndex += 1;
    }
  }
  for (const message of summaryMessages) {
    flushExternalBoundariesBefore(message);
    if (visibleResponseIds.has(message.id)) {
      flushGroupedMessages();
      items.push({ kind: "ungrouped-message", message });
      continue;
    }
    if (isTimelineUngroupableMessage(message)) {
      flushGroupedMessages(
        message.kind === "user" && message.initiator === "user",
      );
      items.push({ kind: "ungrouped-message", message });
      continue;
    }
    groupedMessages.push(message);
  }
  while (externalBoundaryIndex < externalBoundarySeqs.length) {
    flushGroupedMessages(true);
    externalBoundaryIndex += 1;
  }
  flushGroupedMessages();
  return applySingleSummaryTurnBounds(turn, items);
}

export function groupCompletedTurnMessages(
  turn: EventProjectionTurn,
): CompletedTurnMessageGroups {
  const messages = turn.messages ?? [];
  const { summaryMessages, terminalMessages, trailingMessages } =
    splitCompletedTurnMessages(messages, turn.terminalMessage);
  return {
    summaryItems: unwrapSingletonContextManagementGroups(
      groupCompletedTurnSummaryMessages(
        turn,
        summaryMessages,
        terminalMessages[0],
      ),
    ),
    terminalMessages,
    trailingMessages,
  };
}

type TimelineMessagePlan = { kind: "message"; message: EventProjectionMessage };

export type TimelineRowPlan =
  | TimelineMessagePlan
  | {
      kind: "summary";
      row: TimelineTurnRow;
      messages: readonly EventProjectionMessage[];
    };

function messagePlan(message: EventProjectionMessage): TimelineMessagePlan {
  return { kind: "message", message };
}

function planTurn(
  turn: EventProjectionTurn,
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
): TimelineRowPlan[] {
  if (
    turn.status === "pending" ||
    turn.completedAt === null ||
    completedTurnDisplay === "flat"
  ) {
    return (turn.messages ?? []).map(messagePlan);
  }
  const { summaryItems, terminalMessages, trailingMessages } =
    groupCompletedTurnMessages(turn);
  const plan: TimelineRowPlan[] = [];
  for (const item of summaryItems) {
    if (item.kind === "ungrouped-message") {
      plan.push(messagePlan(item.message));
      continue;
    }
    if (item.summaryCount === 0 && item.sourceMessages.length === 0) continue;
    const useTurnBounds =
      item.segmentIndex === null || item.sourceMessages.length === 0;
    let sourceSeqStart = turn.sourceSeqStart;
    let sourceSeqEnd = turn.sourceSeqEnd;
    let createdAt = turn.createdAt;
    let completedAt = item.completedAt;
    if (!useTurnBounds) {
      sourceSeqStart = Infinity;
      sourceSeqEnd = -Infinity;
      createdAt = Infinity;
    }
    for (const message of item.sourceMessages) {
      if (!useTurnBounds) {
        sourceSeqStart = Math.min(sourceSeqStart, message.sourceSeqStart);
        sourceSeqEnd = Math.max(sourceSeqEnd, message.sourceSeqEnd);
        createdAt = Math.min(createdAt, message.createdAt);
      }
      if (item.completedAt === null) {
        completedAt = Math.max(completedAt ?? -Infinity, message.createdAt);
      }
    }
    const suffix = item.segmentIndex === null ? "" : `:${item.segmentIndex}`;
    plan.push({
      kind: "summary",
      row: {
        id: `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn${suffix}`,
        threadId: turn.threadId,
        turnId: turn.turnId,
        sourceSeqStart,
        sourceSeqEnd,
        startedAt: item.startedAt,
        createdAt,
        kind: "turn",
        status: turn.status,
        summaryCount: item.summaryCount,
        completedAt,
        children: null,
      },
      messages: item.sourceMessages,
    });
  }
  plan.push(
    ...terminalMessages.map(messagePlan),
    ...trailingMessages.map(messagePlan),
  );
  return plan;
}

export function planTimelineRows(
  projection: EventProjection,
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
): TimelineRowPlan[] {
  return projection.entries.flatMap((entry) =>
    entry.kind === "projected-message"
      ? [messagePlan(entry.message)]
      : planTurn(entry.turn, completedTurnDisplay, rowIdPrefix),
  );
}
