import {
  type ThreadEvent,
  getThreadEventScopeTurnId,
  type ActiveThinking,
} from "@bb/domain";
import {
  getEventParentToolCallId,
  type EventProjectionAssistantTextMessage,
  type EventProjectionMessage,
  type EventMeta,
  type BuildEventProjectionMessagesOptions,
  type EventProjectionOperationMessage,
  eventProjectionMessageTurnScopeFields,
} from "./event-projection-types.js";
import {
  flushToolActivityBeforeNonToolMessage,
  type ToolActivityProjectionState,
} from "./tool-activity-projection.js";
import type { ProjectionState } from "./build-event-projection.js";
import { messageId, durationToCompactString } from "./timeline-format.js";

export interface VisibleTextBuffer {
  pendingChunks: string[];
  pendingLength: number;
  visibleChunks: string[];
  visibleLength: number;
  visibleTextCache: string | null;
}

function appendVisibleSegment(buffer: VisibleTextBuffer, text: string): void {
  if (text.length === 0) return;
  buffer.visibleChunks.push(text);
  buffer.visibleLength += text.length;
  if (buffer.visibleTextCache !== null) buffer.visibleTextCache += text;
}

export function createVisibleTextBuffer(): VisibleTextBuffer {
  return {
    pendingChunks: [],
    pendingLength: 0,
    visibleChunks: [],
    visibleLength: 0,
    visibleTextCache: null,
  };
}

export function appendVisibleTextBuffer(
  buffer: VisibleTextBuffer,
  delta: string,
): boolean {
  if (delta.length === 0) return false;
  const lastNewlineIndex = delta.lastIndexOf("\n");
  if (lastNewlineIndex === -1) {
    buffer.pendingChunks.push(delta);
    buffer.pendingLength += delta.length;
    return true;
  }
  flushVisibleTextBuffer(buffer);
  appendVisibleSegment(buffer, delta.slice(0, lastNewlineIndex + 1));
  const trailingPartial = delta.slice(lastNewlineIndex + 1);
  if (trailingPartial.length > 0) {
    buffer.pendingChunks.push(trailingPartial);
    buffer.pendingLength += trailingPartial.length;
  }
  return true;
}

export function setVisibleTextBuffer(
  buffer: VisibleTextBuffer,
  text: string,
  flushTrailingPartial: boolean,
): boolean {
  const previousFullText = getVisibleTextBufferFullText(buffer);
  const previousVisibleText = getVisibleTextBufferText(buffer) ?? "";
  buffer.pendingChunks = [];
  buffer.pendingLength = 0;
  buffer.visibleChunks = [];
  buffer.visibleLength = 0;
  buffer.visibleTextCache = null;
  if (text.length > 0) {
    if (flushTrailingPartial) {
      buffer.visibleChunks.push(text);
      buffer.visibleLength = text.length;
      buffer.visibleTextCache = text;
    } else {
      const lastNewlineIndex = text.lastIndexOf("\n");
      if (lastNewlineIndex === -1) {
        buffer.pendingChunks.push(text);
        buffer.pendingLength = text.length;
      } else {
        const visibleText = text.slice(0, lastNewlineIndex + 1);
        buffer.visibleChunks.push(visibleText);
        buffer.visibleLength = visibleText.length;
        buffer.visibleTextCache = visibleText;
        const trailingPartial = text.slice(lastNewlineIndex + 1);
        if (trailingPartial.length > 0) {
          buffer.pendingChunks.push(trailingPartial);
          buffer.pendingLength = trailingPartial.length;
        }
      }
    }
  }
  return (
    previousFullText !== text ||
    previousVisibleText !== (getVisibleTextBufferText(buffer) ?? "")
  );
}

export function flushVisibleTextBuffer(buffer: VisibleTextBuffer): boolean {
  if (buffer.pendingLength === 0) return false;
  if (buffer.visibleTextCache !== null) {
    buffer.visibleTextCache += buffer.pendingChunks.join("");
  }
  buffer.visibleChunks.push(...buffer.pendingChunks);
  buffer.visibleLength += buffer.pendingLength;
  buffer.pendingChunks = [];
  buffer.pendingLength = 0;
  return true;
}

export function getVisibleTextBufferFullLength(
  buffer: VisibleTextBuffer,
): number {
  return buffer.visibleLength + buffer.pendingLength;
}

export function getVisibleTextBufferFullText(
  buffer: VisibleTextBuffer,
): string {
  const visibleText = buffer.visibleTextCache ?? buffer.visibleChunks.join("");
  if (buffer.pendingLength === 0) return visibleText;
  return `${visibleText}${buffer.pendingChunks.join("")}`;
}

export function getVisibleTextBufferText(
  buffer: VisibleTextBuffer,
): string | undefined {
  if (buffer.visibleLength === 0) return undefined;
  if (buffer.visibleTextCache === null) {
    buffer.visibleTextCache = buffer.visibleChunks.join("");
  }
  return buffer.visibleTextCache;
}

export function parseAssistantDeltaText(decoded: ThreadEvent): string | null {
  if (
    decoded.type !== "item/agentMessage/delta" &&
    decoded.type !== "item/plan/delta"
  ) {
    return null;
  }
  return decoded.delta.length > 0 ? decoded.delta : null;
}

export function parseAssistantFinalText(decoded: ThreadEvent): string | null {
  if (decoded.type !== "item/completed") return null;
  if (decoded.item.type === "plan") {
    return decoded.item.text.length > 0 ? decoded.item.text : null;
  }
  if (decoded.item.type !== "agentMessage") return null;
  return decoded.item.text.length > 0 ? decoded.item.text : null;
}

export function parseReasoningDeltaText(decoded: ThreadEvent): string | null {
  if (
    decoded.type !== "item/reasoning/summaryTextDelta" &&
    decoded.type !== "item/reasoning/textDelta"
  ) {
    return null;
  }
  return decoded.delta.length > 0 ? decoded.delta : null;
}

export function parseReasoningFinalText(decoded: ThreadEvent): string | null {
  if (decoded.type !== "item/completed") return null;
  if (decoded.item.type !== "reasoning") return null;
  const summaryText = decoded.item.summary.join("");
  const contentText = decoded.item.content.join("");
  const text = `${summaryText}${contentText}`;
  return text.length > 0 ? text : null;
}

type BufferedTextInstanceKind = "assistant" | "reasoning";

export interface BufferedTextInstanceIdentity {
  itemId: string;
  kind: BufferedTextInstanceKind;
  parentToolCallId: string | null;
  turnId: string;
}

export function createBufferedTextInstanceKey(
  identity: BufferedTextInstanceIdentity,
): string {
  return [
    `kind:${identity.kind}`,
    `turn:${identity.turnId}`,
    `parent:${identity.parentToolCallId ?? "root"}`,
    `item:${identity.itemId}`,
  ].join("|");
}

export function resolveBufferedTextIdentity(args: {
  decoded: ThreadEvent;
  kind: BufferedTextInstanceKind;
  parentToolCallId?: string;
  turnId?: string;
}): BufferedTextInstanceIdentity | null {
  const turnId = args.turnId ?? getThreadEventScopeTurnId(args.decoded.scope);
  if (!turnId) return null;
  const parentToolCallId =
    args.parentToolCallId ?? getEventParentToolCallId(args.decoded) ?? null;
  if (args.kind === "assistant") {
    if (
      args.decoded.type === "item/agentMessage/delta" ||
      args.decoded.type === "item/plan/delta"
    ) {
      return {
        itemId: args.decoded.itemId,
        kind: "assistant",
        parentToolCallId,
        turnId,
      };
    }
    if (
      args.decoded.type === "item/completed" &&
      (args.decoded.item.type === "agentMessage" ||
        args.decoded.item.type === "plan")
    ) {
      return {
        itemId: args.decoded.item.id,
        kind: "assistant",
        parentToolCallId,
        turnId,
      };
    }
    return null;
  }
  if (
    args.decoded.type === "item/reasoning/summaryTextDelta" ||
    args.decoded.type === "item/reasoning/textDelta"
  ) {
    return {
      itemId: args.decoded.itemId,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  if (
    (args.decoded.type === "item/started" ||
      args.decoded.type === "item/completed") &&
    args.decoded.item.type === "reasoning"
  ) {
    return {
      itemId: args.decoded.item.id,
      kind: "reasoning",
      parentToolCallId,
      turnId,
    };
  }
  return null;
}

export interface AssistantStreamProjectionState extends ToolActivityProjectionState {
  messages: EventProjectionMessage[];
  openAssistantMessagesByKey: Map<string, EventProjectionAssistantTextMessage>;
  assistantTextBuffersByKey: Map<string, VisibleTextBuffer>;
  visibleAssistantMessageKeys: Set<string>;
  finalizedAssistantMessageKeys: Set<string>;
}

export function syncBufferedTextMessage(
  state: AssistantStreamProjectionState,
  messageKey: string,
  message: EventProjectionAssistantTextMessage,
  buffer: VisibleTextBuffer,
  status: EventProjectionAssistantTextMessage["status"],
): void {
  const text = getVisibleTextBufferText(buffer);
  if (!text) {
    if (status === "completed") message.status = "completed";
    return;
  }
  message.text = text;
  message.status = status;
  if (state.visibleAssistantMessageKeys.has(messageKey)) return;
  flushToolActivityBeforeNonToolMessage(state);
  state.messages.push(message);
  state.visibleAssistantMessageKeys.add(messageKey);
}

function flushBufferedTextMessages(
  state: AssistantStreamProjectionState,
  shouldFlush: (message: EventProjectionAssistantTextMessage) => boolean,
): void {
  const pendingMessages = Array.from(state.openAssistantMessagesByKey.entries())
    .filter(([, message]) => shouldFlush(message))
    .sort(
      (left, right) =>
        left[1].sourceSeqStart - right[1].sourceSeqStart ||
        left[1].sourceSeqEnd - right[1].sourceSeqEnd ||
        left[1].createdAt - right[1].createdAt,
    );
  for (const [messageKey, message] of pendingMessages) {
    const buffer = state.assistantTextBuffersByKey.get(messageKey);
    if (buffer) {
      flushVisibleTextBuffer(buffer);
      syncBufferedTextMessage(state, messageKey, message, buffer, "completed");
    } else {
      message.status = "completed";
    }
    state.finalizedAssistantMessageKeys.add(messageKey);
    state.openAssistantMessagesByKey.delete(messageKey);
    state.assistantTextBuffersByKey.delete(messageKey);
    state.visibleAssistantMessageKeys.delete(messageKey);
  }
}

export function flushBufferedAssistantMessages(
  state: AssistantStreamProjectionState,
): void {
  flushBufferedTextMessages(state, () => true);
}

export function flushBufferedAssistantMessagesForTurn(
  state: AssistantStreamProjectionState,
  turnId: string,
): void {
  flushBufferedTextMessages(
    state,
    (message) =>
      message.scope.kind === "turn" && message.scope.turnId === turnId,
  );
}

export function projectAssistantTextEvent(
  state: ProjectionState,
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
  identity: BufferedTextInstanceIdentity | null,
  mode: "delta" | "final",
  text: string | null,
): boolean {
  if (!text) return false;
  if (!identity) return true;
  const messageKey = createBufferedTextInstanceKey(identity);
  if (
    state.closedTurnIds.has(identity.turnId) ||
    state.finalizedAssistantMessageKeys.has(messageKey)
  ) {
    return true;
  }
  state.openTurnIds.add(identity.turnId);
  let message = state.openAssistantMessagesByKey.get(messageKey);
  if (message) {
    message.sourceSeqEnd = meta.seq;
    message.createdAt = meta.createdAt;
  } else {
    message = {
      kind: "assistant-text",
      id: messageId(decoded.threadId, "assistant", messageKey),
      threadId: decoded.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      scope: decoded.scope,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      text: "",
      status: "streaming",
    };
    state.openAssistantMessagesByKey.set(messageKey, message);
  }
  const buffer =
    state.assistantTextBuffersByKey.get(messageKey) ??
    createVisibleTextBuffer();
  state.assistantTextBuffersByKey.set(messageKey, buffer);
  if (mode === "delta") {
    appendVisibleTextBuffer(buffer, text);
    syncBufferedTextMessage(state, messageKey, message, buffer, "streaming");
    return true;
  }
  setVisibleTextBuffer(buffer, text, true);
  syncBufferedTextMessage(state, messageKey, message, buffer, "completed");
  state.openAssistantMessagesByKey.delete(messageKey);
  state.assistantTextBuffersByKey.delete(messageKey);
  state.visibleAssistantMessageKeys.delete(messageKey);
  state.finalizedAssistantMessageKeys.add(messageKey);
  return true;
}

export function projectReasoningTextEvent(
  state: ProjectionState,
  identity: BufferedTextInstanceIdentity | null,
  mode: "content-delta" | "final" | "summary-delta",
  text: string | null,
): boolean {
  if (!text) return false;
  if (!identity) return true;
  const messageKey = createBufferedTextInstanceKey(identity);
  if (
    state.closedTurnIds.has(identity.turnId) ||
    state.finalizedReasoningKeys.has(messageKey)
  ) {
    return true;
  }
  state.openTurnIds.add(identity.turnId);
  const buffer =
    state.reasoningTextBuffersByKey.get(messageKey) ??
    createVisibleTextBuffer();
  state.reasoningTextBuffersByKey.set(messageKey, buffer);
  if (mode !== "final") {
    const deltas = state.reasoningDeltaTextByKey.get(messageKey) ?? {
      content: "",
      summary: "",
    };
    deltas[mode === "summary-delta" ? "summary" : "content"] += text;
    state.reasoningDeltaTextByKey.set(messageKey, deltas);
    appendVisibleTextBuffer(buffer, text);
    return true;
  }
  setVisibleTextBuffer(buffer, text, true);
  return true;
}

interface ActiveThinkingLifecycle {
  messageKey: string;
  parentToolCallId: string | null;
  sourceSeqStart: number;
  startedAt: number;
  threadId: string;
  turnId: string;
  updatedAt: number;
  updatedSeq: number;
}

export interface ReasoningProjectionState {
  finalizedReasoningKeys: Set<string>;
  reasoningDeltaTextByKey: Map<string, { content: string; summary: string }>;
  reasoningMessagesAwaitingCompletion: Map<
    string,
    EventProjectionOperationMessage
  >;
  openReasoningLifecyclesByKey: Map<string, ActiveThinkingLifecycle>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
}

interface ReasoningLifecycleHostState extends ReasoningProjectionState {
  closedTurnIds: Set<string>;
  openTurnIds: Set<string>;
  messages: EventProjectionMessage[];
}

type ReasoningCompletionStatus = "completed" | "interrupted";

const MAX_REASONING_DETAIL_CHARS = 32_000;

const REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL = " more characters truncated]";

function normalizeReasoningDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= MAX_REASONING_DETAIL_CHARS) return trimmed;
  const dropped = trimmed.length - MAX_REASONING_DETAIL_CHARS;
  return `${trimmed.slice(0, MAX_REASONING_DETAIL_CHARS)}\n…[${dropped.toLocaleString("en-US")}${REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL}`;
}

export function createReasoningProjectionState(): ReasoningProjectionState {
  return {
    openReasoningLifecyclesByKey: new Map(),
    reasoningDeltaTextByKey: new Map(),
    reasoningTextBuffersByKey: new Map(),
    finalizedReasoningKeys: new Set(),
    reasoningMessagesAwaitingCompletion: new Map(),
  };
}

export function buildProjectionActiveThinking(
  state: ReasoningProjectionState,
  threadStatus: BuildEventProjectionMessagesOptions["threadStatus"],
): ActiveThinking | null {
  if (threadStatus !== "active") return null;
  let latest: ActiveThinkingLifecycle | null = null;
  for (const lifecycle of state.openReasoningLifecyclesByKey.values()) {
    if (
      latest === null ||
      (lifecycle.updatedSeq !== latest.updatedSeq
        ? lifecycle.updatedSeq > latest.updatedSeq
        : lifecycle.updatedAt > latest.updatedAt)
    ) {
      latest = lifecycle;
    }
  }
  if (!latest) return null;
  const buffer = state.reasoningTextBuffersByKey.get(latest.messageKey);
  return {
    id: messageId(latest.threadId, "op", `reasoning:${latest.messageKey}`),
    text: (buffer ? getVisibleTextBufferText(buffer) : undefined)?.trim() ?? "",
    startedAt: latest.startedAt,
    updatedAt: latest.updatedAt,
  };
}

export function upsertReasoningLifecycle(
  state: ReasoningLifecycleHostState,
  meta: EventMeta,
  identity: BufferedTextInstanceIdentity,
  parentToolCallId: string | undefined,
  threadId: string,
): void {
  const messageKey = createBufferedTextInstanceKey(identity);
  if (
    state.closedTurnIds.has(identity.turnId) ||
    state.finalizedReasoningKeys.has(messageKey)
  ) {
    return;
  }
  state.openTurnIds.add(identity.turnId);
  const existingLifecycle = state.openReasoningLifecyclesByKey.get(messageKey);
  if (existingLifecycle) {
    existingLifecycle.updatedAt = meta.createdAt;
    existingLifecycle.updatedSeq = meta.seq;
    return;
  }
  state.openReasoningLifecyclesByKey.set(messageKey, {
    messageKey,
    parentToolCallId: parentToolCallId ?? null,
    sourceSeqStart: meta.seq,
    startedAt: meta.createdAt,
    threadId,
    turnId: identity.turnId,
    updatedAt: meta.createdAt,
    updatedSeq: meta.seq,
  });
}

function finalizeReasoningLifecycleByKey(
  state: ReasoningLifecycleHostState,
  meta: EventMeta,
  messageKey: string,
  status: ReasoningCompletionStatus,
): EventProjectionOperationMessage | null {
  const lifecycle = state.openReasoningLifecyclesByKey.get(messageKey);
  const buffer = state.reasoningTextBuffersByKey.get(messageKey);
  state.openReasoningLifecyclesByKey.delete(messageKey);
  state.reasoningTextBuffersByKey.delete(messageKey);
  state.finalizedReasoningKeys.add(messageKey);
  if (!lifecycle || !buffer) return null;
  const detail = getVisibleTextBufferFullText(buffer);
  if (detail.trim().length === 0) return null;
  const durationMs = meta.createdAt - lifecycle.startedAt;
  const message: EventProjectionOperationMessage = {
    kind: "operation",
    id: messageId(
      lifecycle.threadId,
      "op",
      `reasoning:${lifecycle.messageKey}`,
    ),
    threadId: lifecycle.threadId,
    sourceSeqStart: lifecycle.sourceSeqStart,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: lifecycle.startedAt,
    completedAt: meta.createdAt,
    ...eventProjectionMessageTurnScopeFields(lifecycle.turnId),
    ...(lifecycle.parentToolCallId
      ? { parentToolCallId: lifecycle.parentToolCallId }
      : {}),
    opType: "reasoning",
    title:
      durationMs > 0
        ? `Thought for ${durationToCompactString(durationMs)}`
        : "Thought",
    detail: normalizeReasoningDetail(detail),
    status,
  };
  state.messages.push(message);
  return message;
}

export function finalizeReasoningLifecycle(
  state: ReasoningLifecycleHostState,
  meta: EventMeta,
  identity: BufferedTextInstanceIdentity | null,
  text: string | null,
): void {
  if (!identity) return;
  const messageKey = createBufferedTextInstanceKey(identity);
  state.reasoningDeltaTextByKey.delete(messageKey);
  const message = state.reasoningMessagesAwaitingCompletion.get(messageKey);
  if (message) {
    state.reasoningMessagesAwaitingCompletion.delete(messageKey);
    message.sourceSeqEnd = meta.seq;
    if (text?.trim()) message.detail = normalizeReasoningDetail(text);
    return;
  }
  finalizeReasoningLifecycleByKey(state, meta, messageKey, "completed");
}

export function finalizeOpenReasoningLifecycles(
  state: ReasoningLifecycleHostState,
  meta: EventMeta,
  status: ReasoningCompletionStatus,
  turnId?: string,
): void {
  for (const [messageKey, lifecycle] of state.openReasoningLifecyclesByKey) {
    if (turnId !== undefined && lifecycle.turnId !== turnId) continue;
    const message = finalizeReasoningLifecycleByKey(
      state,
      meta,
      messageKey,
      status,
    );
    if (message) {
      state.reasoningMessagesAwaitingCompletion.set(messageKey, message);
    }
  }
}

export function projectAssistantAndReasoningEvent(
  state: ProjectionState,
  decoded: ThreadEvent,
  meta: EventMeta,
  turnId: string | undefined,
  parentToolCallId: string | undefined,
): boolean {
  const assistantIdentity = resolveBufferedTextIdentity({
    decoded,
    kind: "assistant",
    parentToolCallId,
    turnId,
  });
  const reasoningIdentity = resolveBufferedTextIdentity({
    decoded,
    kind: "reasoning",
    parentToolCallId,
    turnId,
  });
  if (reasoningIdentity) {
    upsertReasoningLifecycle(
      state,
      meta,
      reasoningIdentity,
      parentToolCallId,
      decoded.threadId,
    );
  }
  const projectAssistant = (
    mode: "delta" | "final",
    text: string | null,
  ): boolean =>
    projectAssistantTextEvent(
      state,
      decoded,
      meta,
      parentToolCallId,
      assistantIdentity,
      mode,
      text,
    );
  if (
    projectAssistant("delta", parseAssistantDeltaText(decoded)) ||
    projectAssistant("final", parseAssistantFinalText(decoded)) ||
    projectReasoningTextEvent(
      state,
      reasoningIdentity,
      decoded.type === "item/reasoning/summaryTextDelta"
        ? "summary-delta"
        : "content-delta",
      parseReasoningDeltaText(decoded),
    )
  ) {
    return true;
  }
  const reasoningFinalText = parseReasoningFinalText(decoded);
  let reasoningCompletionText = reasoningFinalText;
  const reasoningItem =
    decoded.type === "item/completed" && decoded.item.type === "reasoning"
      ? decoded.item
      : null;
  if (reasoningIdentity && reasoningItem) {
    const deltas = state.reasoningDeltaTextByKey.get(
      createBufferedTextInstanceKey(reasoningIdentity),
    );
    if (
      deltas?.summary === reasoningItem.summary.join("") &&
      deltas.content === reasoningItem.content.join("")
    ) {
      reasoningCompletionText = null;
    }
  }
  const projectedReasoningFinal = projectReasoningTextEvent(
    state,
    reasoningIdentity,
    "final",
    reasoningCompletionText,
  );
  if (reasoningItem) {
    finalizeReasoningLifecycle(
      state,
      meta,
      reasoningIdentity,
      reasoningCompletionText,
    );
  }
  return projectedReasoningFinal || reasoningFinalText !== null;
}
