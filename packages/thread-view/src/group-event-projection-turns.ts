import {
  requireThreadEventScopeTurnId,
  type CompletedTurnDisplay,
} from "@bb/domain";
import type { TimelineTurnRow } from "@bb/server-contract";
import {
  extendMessageBounds,
  type DelegationMessage,
  type EventMeta,
  type Message,
  type ProjectedTurn,
  type ProjectionEntry,
  type ThreadEventWithMeta,
  type ToolCallMessage,
} from "./event-projection-types.js";
import {
  getFirstStringField,
  getMessageStartedAt,
  messageId,
} from "./timeline-format.js";

export interface ExternalUserBoundaryTurnSpan {
  completionSequence: number | null;
  sequenceStart: number;
  turnId: string;
}

export function isExternalUserBoundaryForTurn(
  turn: ExternalUserBoundaryTurnSpan,
  message: { sequence: number; turnId: string | null },
): boolean {
  return (
    message.turnId !== turn.turnId &&
    message.sequence > turn.sequenceStart &&
    (turn.completionSequence === null ||
      message.sequence < turn.completionSequence)
  );
}

export function getOrderedThreadEvents(
  events: readonly ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  const ordered = events.every(
    ({ meta }, index) => index === 0 || events[index - 1].meta.seq <= meta.seq,
  );
  return ordered
    ? Array.from(events)
    : Array.from(events).sort((a, b) => a.meta.seq - b.meta.seq);
}

export function sortMessagesBySource(messages: Message[]): Message[] {
  return messages
    .map((message, index) => ({ index, message }))
    .sort(
      (left, right) =>
        left.message.sourceSeqStart - right.message.sourceSeqStart ||
        left.message.createdAt - right.message.createdAt ||
        left.index - right.index,
    )
    .map((entry) => entry.message);
}

interface TurnDraft {
  completionSequence: number | null;
  startedSequence: number;
  turn: ProjectedTurn;
}

function updateTurnBounds(
  { turn }: TurnDraft,
  threadId: string,
  sourceSeqStart: number,
  sourceSeqEnd: number,
  createdAt: number,
): void {
  turn.threadId = threadId;
  turn.sourceSeqStart = Math.min(turn.sourceSeqStart, sourceSeqStart);
  extendMessageBounds(turn, sourceSeqEnd, createdAt);
}

function least(values: number[]): number {
  return values.reduce((left, right) => Math.min(left, right), Infinity);
}

function greatest(values: number[]): number {
  return values.reduce((left, right) => Math.max(left, right), -Infinity);
}

function findTurnRunningAtSequence(
  turnsById: ReadonlyMap<string, TurnDraft>,
  sequence: number,
): TurnDraft | null {
  let running: TurnDraft | null = null;
  for (const draft of turnsById.values()) {
    const { startedSequence, completionSequence } = draft;
    if (
      startedSequence < sequence &&
      (completionSequence === null || completionSequence >= sequence) &&
      (running === null || startedSequence > running.startedSequence)
    ) {
      running = draft;
    }
  }
  return running;
}

function applyExternalUserBoundaries(
  turnsById: Map<string, TurnDraft>,
  messages: Message[],
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
    const boundarySeqs = new Set(
      userMessages
        .filter((message) => isExternalUserBoundaryForTurn(span, message))
        .map((message) => message.sequence),
    );
    if (boundarySeqs.size > 0) {
      draft.turn.externalUserBoundarySeqs = [...boundarySeqs].sort(
        (left, right) => left - right,
      );
    }
  }
}

function requireTurn(
  turnsById: Map<string, TurnDraft>,
  turnId: string,
  orphan: string,
): TurnDraft {
  const draft = turnsById.get(turnId);
  if (!draft) throw new Error(`Timeline projection found ${orphan}`);
  return draft;
}

function groupMessagesIntoTurns(
  events: ThreadEventWithMeta[],
  messages: Message[],
): ProjectionEntry[] {
  const turnsById = new Map<string, TurnDraft>();
  const clientRequestMetaById = new Map<string, EventMeta>();
  const drafts: { seq: number; createdAt: number; entry: ProjectionEntry }[] =
    [];
  for (const { event, meta } of events) {
    if (event.type === "client/turn/requested") {
      clientRequestMetaById.set(event.requestId, meta);
    }
  }
  for (const { event, meta } of events) {
    const { seq, createdAt } = meta;
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId(event);
      if (turnsById.has(turnId)) continue;
      const turn: ProjectedTurn = {
        turnId,
        threadId: event.threadId,
        sourceSeqStart: seq,
        sourceSeqEnd: seq,
        startedAt: createdAt,
        createdAt,
        completedAt: null,
        status: "pending",
        messages: [],
      };
      turnsById.set(turnId, {
        completionSequence: null,
        startedSequence: seq,
        turn,
      });
      drafts.push({ seq, createdAt, entry: { kind: "turn", turn } });
    } else if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId(event);
      const orphan = `${event.type} without turn/started for ${turnId}`;
      const existing = requireTurn(turnsById, turnId, orphan);
      updateTurnBounds(existing, event.threadId, seq, seq, createdAt);
      existing.turn.completedAt = createdAt;
      existing.turn.status = event.status === "failed" ? "error" : event.status;
      existing.completionSequence ??= seq;
    } else if (event.type === "turn/input/accepted") {
      const turnId = requireThreadEventScopeTurnId(event);
      const orphan = `${event.type} without turn/started for ${turnId}`;
      const existing = requireTurn(turnsById, turnId, orphan);
      const request = clientRequestMetaById.get(event.clientRequestId);
      if (request) {
        const { seq: requested, createdAt: at } = request;
        updateTurnBounds(existing, event.threadId, requested, requested, at);
      }
    }
  }
  for (const message of messages) {
    const { scope, sourceSeqStart: seq, createdAt } = message;
    const draft =
      scope.kind === "turn"
        ? requireTurn(
            turnsById,
            scope.turnId,
            `message ${message.id} for turn ${scope.turnId} without turn/started`,
          )
        : message.kind === "interaction"
          ? findTurnRunningAtSequence(turnsById, seq)
          : null;
    if (draft) {
      draft.turn.messages.push(message);
      const { threadId, sourceSeqEnd } = message;
      updateTurnBounds(draft, threadId, seq, sourceSeqEnd, createdAt);
    } else {
      const entry: ProjectionEntry = { kind: "projected-message", message };
      drafts.push({ seq, createdAt, entry });
    }
  }
  applyExternalUserBoundaries(turnsById, messages);
  return drafts
    .sort(
      (left, right) => left.seq - right.seq || left.createdAt - right.createdAt,
    )
    .map((draft) => draft.entry);
}

function toolCallAsDelegationMessage(
  message: ToolCallMessage,
): DelegationMessage {
  const { toolArgs, approvalStatus, ...shared } = message;
  const subagentType = getFirstStringField(toolArgs, [
    "subagent_type",
    "subagentType",
  ]);
  const description = getFirstStringField(toolArgs, ["description", "prompt"]);
  const model = getFirstStringField(toolArgs, ["model"]);
  return {
    ...shared,
    id: messageId(message.threadId, "delegation", message.callId),
    workKind: "delegation",
    ...(subagentType ? { subagentType } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    childRef: null,
    background: false,
    children: [],
  };
}

function withChildren(
  message: DelegationMessage,
  children: Message[],
): DelegationMessage {
  if (children.length === 0) return { ...message, children };
  const family = [message, ...children];
  return {
    ...message,
    sourceSeqStart: least(family.map((member) => member.sourceSeqStart)),
    sourceSeqEnd: greatest(family.map((member) => member.sourceSeqEnd)),
    createdAt: greatest(family.map((member) => member.createdAt)),
    startedAt: least(family.map(getMessageStartedAt)),
    children,
  };
}

function entryMessages(entry: ProjectionEntry): Message[] {
  return entry.kind === "turn" ? entry.turn.messages : [entry.message];
}

function nestDelegatedMessages(entries: ProjectionEntry[]): ProjectionEntry[] {
  const all = entries.flatMap(entryMessages);
  const referencedParentCallIds = new Set(
    all.flatMap(({ parentToolCallId }) =>
      parentToolCallId === undefined ? [] : [parentToolCallId],
    ),
  );
  const promoted = new Map<Message, Message>();
  for (const message of all) {
    if (
      message.kind === "exec" &&
      message.workKind === "tool" &&
      referencedParentCallIds.has(message.callId)
    ) {
      promoted.set(message, toolCallAsDelegationMessage(message));
    }
  }
  const sources = (messages: Message[]) =>
    messages.map((message) => promoted.get(message) ?? message);
  const isDelegation = (message: Message): message is DelegationMessage =>
    message.kind === "exec" && message.workKind === "delegation";
  const delegationCallIds = new Set(
    sources(all)
      .filter(isDelegation)
      .map((message) => message.callId),
  );
  const childrenByParentCallId = new Map<string, Message[]>();
  const attachedMessageIds = new Set<string>();
  for (const message of sources(all)) {
    const { parentToolCallId } = message;
    if (!parentToolCallId || !delegationCallIds.has(parentToolCallId)) continue;
    const children = childrenByParentCallId.get(parentToolCallId) ?? [];
    children.push(message);
    childrenByParentCallId.set(parentToolCallId, children);
    attachedMessageIds.add(message.id);
  }
  const nested = (message: Message): Message =>
    isDelegation(message)
      ? withChildren(
          message,
          (childrenByParentCallId.get(message.callId) ?? []).map(nested),
        )
      : message;
  const roots = (messages: Message[]) =>
    sources(messages)
      .filter(
        (message) =>
          !attachedMessageIds.has(message.id) &&
          message.parentToolCallId === undefined,
      )
      .map(nested);
  return entries.flatMap((entry): ProjectionEntry[] => {
    const messages = roots(entryMessages(entry));
    const [message] = messages;
    if (!message) return [];
    return entry.kind === "turn"
      ? [{ kind: "turn", turn: { ...entry.turn, messages } }]
      : [{ kind: "projected-message", message }];
  });
}

export function buildProjectionEntries(
  events: ThreadEventWithMeta[],
  messages: Message[],
): ProjectionEntry[] {
  return nestDelegatedMessages(groupMessagesIntoTurns(events, messages));
}

function isTerminalMessage(message: Message): boolean {
  return message.kind === "assistant-text" || message.kind === "error";
}

function isUngroupableMessage(message: Message): boolean {
  return (
    message.kind === "user" &&
    !(
      message.turnRequest.kind === "steer" &&
      (message.initiator === "agent" || message.initiator === "system")
    )
  );
}

function isSingletonContextManagementOperation(
  messages: readonly Message[],
): boolean {
  const [only] = messages;
  return (
    messages.length === 1 &&
    only?.kind === "operation" &&
    (only.opType === "compaction" || only.opType === "context-clear")
  );
}

function summaryCountOf(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (isUngroupableMessage(message)) continue;
    count +=
      message.kind === "file-edit" ? Math.max(1, message.changes.length) : 1;
  }
  return count;
}

interface SummaryGroup {
  kind: "summary";
  startedAt: number;
  completedAt: number | null;
  segmentIndex: number | null;
  sourceMessages: Message[];
  summaryCount: number;
}

type SummaryItem = SummaryGroup | { kind: "message"; message: Message };

function findVisibleResponseMessageIds(
  summaryMessages: readonly Message[],
  terminalMessage: Message | undefined,
): Set<string> {
  const visibleIds = new Set<string>();
  summaryMessages.forEach((message, index) => {
    const next = summaryMessages[index + 1] ?? terminalMessage;
    if (message.kind === "assistant-text" && next?.kind === "assistant-text") {
      visibleIds.add(message.id);
    }
  });
  return visibleIds;
}

function groupSummaryMessages(
  turn: ProjectedTurn,
  summaryMessages: Message[],
  terminalMessage: Message | undefined,
): SummaryItem[] {
  const externalBoundarySeqs = turn.externalUserBoundarySeqs ?? [];
  const visibleResponseIds = findVisibleResponseMessageIds(
    summaryMessages,
    terminalMessage,
  );
  if (
    externalBoundarySeqs.length === 0 &&
    visibleResponseIds.size === 0 &&
    !summaryMessages.some(isUngroupableMessage)
  ) {
    return [
      {
        kind: "summary",
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        segmentIndex: null,
        sourceMessages: summaryMessages,
        summaryCount: summaryCountOf(summaryMessages),
      },
    ];
  }
  const items: SummaryItem[] = [];
  const groups: SummaryGroup[] = [];
  let groupedMessages: Message[] = [];
  let externalBoundaryIndex = 0;
  const appendSummaryGroup = (sourceMessages: Message[]): void => {
    if (sourceMessages.length === 0) return;
    const group: SummaryGroup = {
      kind: "summary",
      startedAt: least(sourceMessages.map(getMessageStartedAt)),
      completedAt: null,
      segmentIndex: groups.length,
      sourceMessages,
      summaryCount: summaryCountOf(sourceMessages),
    };
    groups.push(group);
    items.push(group);
  };
  const flushGroupedMessages = (preserveLastTerminalMessage = false): void => {
    const sourceMessages = groupedMessages;
    groupedMessages = [];
    const terminal = preserveLastTerminalMessage
      ? sourceMessages.filter(isTerminalMessage).pop()
      : undefined;
    if (!terminal) {
      appendSummaryGroup(sourceMessages);
      return;
    }
    appendSummaryGroup(
      sourceMessages.filter((message) => message.id !== terminal.id),
    );
    items.push({ kind: "message", message: terminal });
  };
  for (const message of summaryMessages) {
    while (
      externalBoundaryIndex < externalBoundarySeqs.length &&
      externalBoundarySeqs[externalBoundaryIndex] < message.sourceSeqStart
    ) {
      flushGroupedMessages(true);
      externalBoundaryIndex += 1;
    }
    if (visibleResponseIds.has(message.id)) {
      flushGroupedMessages();
      items.push({ kind: "message", message });
    } else if (isUngroupableMessage(message)) {
      flushGroupedMessages(
        message.kind === "user" && message.initiator === "user",
      );
      items.push({ kind: "message", message });
    } else {
      groupedMessages.push(message);
    }
  }
  while (externalBoundaryIndex < externalBoundarySeqs.length) {
    flushGroupedMessages(true);
    externalBoundaryIndex += 1;
  }
  flushGroupedMessages();
  const [onlyGroup] = groups;
  if (onlyGroup && groups.length === 1) {
    onlyGroup.startedAt = turn.startedAt;
    onlyGroup.completedAt = turn.completedAt;
  }
  return items;
}

type TimelineRowPlan =
  | { kind: "message"; message: Message }
  | { kind: "summary"; row: TimelineTurnRow; messages: readonly Message[] };

function messagePlan(message: Message): TimelineRowPlan {
  return { kind: "message", message };
}

function summaryPlan(
  turn: ProjectedTurn,
  group: SummaryGroup,
  rowIdPrefix: string,
): TimelineRowPlan[] {
  const { sourceMessages, segmentIndex } = group;
  const [only] = sourceMessages;
  if (only && isSingletonContextManagementOperation(sourceMessages)) {
    return [messagePlan(only)];
  }
  if (group.summaryCount === 0 && sourceMessages.length === 0) return [];
  const useTurnBounds = segmentIndex === null || sourceMessages.length === 0;
  const created = sourceMessages.map((message) => message.createdAt);
  const suffix = segmentIndex === null ? "" : `:${segmentIndex}`;
  return [
    {
      kind: "summary",
      row: {
        id: `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn${suffix}`,
        threadId: turn.threadId,
        turnId: turn.turnId,
        sourceSeqStart: useTurnBounds
          ? turn.sourceSeqStart
          : least(sourceMessages.map((message) => message.sourceSeqStart)),
        sourceSeqEnd: useTurnBounds
          ? turn.sourceSeqEnd
          : greatest(sourceMessages.map((message) => message.sourceSeqEnd)),
        startedAt: group.startedAt,
        createdAt: useTurnBounds ? turn.createdAt : least(created),
        kind: "turn",
        status: turn.status,
        summaryCount: group.summaryCount,
        completedAt: group.completedAt ?? (only ? greatest(created) : null),
        children: null,
      },
      messages: sourceMessages,
    },
  ];
}

function planTurn(
  turn: ProjectedTurn,
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
): TimelineRowPlan[] {
  const { messages } = turn;
  if (
    turn.status === "pending" ||
    turn.completedAt === null ||
    completedTurnDisplay === "flat"
  ) {
    return messages.map(messagePlan);
  }
  const terminal = messages.filter(isTerminalMessage).pop();
  const terminalIndex = terminal
    ? messages.findIndex((message) => message.id === terminal.id)
    : messages.length;
  const summaryItems = groupSummaryMessages(
    turn,
    messages.slice(0, terminalIndex),
    messages[terminalIndex],
  );
  return [
    ...summaryItems.flatMap((item) =>
      item.kind === "message"
        ? [messagePlan(item.message)]
        : summaryPlan(turn, item, rowIdPrefix),
    ),
    ...messages.slice(terminalIndex).map(messagePlan),
  ];
}

export function planTimelineRows(
  entries: readonly ProjectionEntry[],
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
): TimelineRowPlan[] {
  return entries.flatMap((entry) =>
    entry.kind === "projected-message"
      ? [messagePlan(entry.message)]
      : planTurn(entry.turn, completedTurnDisplay, rowIdPrefix),
  );
}
