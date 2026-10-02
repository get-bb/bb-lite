import {
  getThreadEventScopeTurnId,
  turnScope,
  type ActiveThinking,
  type Thread,
  type ThreadEvent,
} from "@bb/domain";
import type { ProjectionState } from "./build-event-projection.js";
import {
  appendVisibleText,
  createVisibleTextBuffer,
  flushVisibleText,
  getEventParentToolCallId,
  setVisibleText,
  type AssistantMessage,
  type EventMeta,
  type OperationMessage,
  type VisibleTextBuffer,
} from "./event-projection-types.js";
import { durationToCompactString, messageId } from "./timeline-format.js";
import { flushActiveToolCell } from "./tool-activity-projection.js";

type BufferedTextKind = "assistant" | "reasoning";

interface BufferedTextIdentity {
  key: string;
  kind: BufferedTextKind;
  turnId: string;
}

function bufferedTextItem(
  decoded: ThreadEvent,
): { kind: BufferedTextKind; itemId: string } | null {
  switch (decoded.type) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
      return { kind: "assistant", itemId: decoded.itemId };
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return { kind: "reasoning", itemId: decoded.itemId };
    case "item/started":
    case "item/completed": {
      const { type, id } = decoded.item;
      if (type === "reasoning") return { kind: "reasoning", itemId: id };
      return decoded.type === "item/completed" &&
        (type === "agentMessage" || type === "plan")
        ? { kind: "assistant", itemId: id }
        : null;
    }
    default:
      return null;
  }
}

export function bufferedTextIdentity(
  decoded: ThreadEvent,
  turnIdOverride?: string,
  parentToolCallIdOverride?: string,
): BufferedTextIdentity | null {
  const item = bufferedTextItem(decoded);
  const turnId = turnIdOverride ?? getThreadEventScopeTurnId(decoded.scope);
  if (!item || !turnId) return null;
  const parent =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded) ?? "root";
  return {
    key: `kind:${item.kind}|turn:${turnId}|parent:${parent}|item:${item.itemId}`,
    kind: item.kind,
    turnId,
  };
}

function syncAssistantMessage(
  state: ProjectionState,
  messageKey: string,
  message: AssistantMessage,
  buffer: VisibleTextBuffer,
  status: AssistantMessage["status"],
): void {
  if (!buffer.visible) {
    if (status === "completed") message.status = "completed";
    return;
  }
  message.text = buffer.visible;
  message.status = status;
  if (state.visibleAssistantMessageKeys.has(messageKey)) return;
  flushActiveToolCell(state);
  state.messages.push(message);
  state.visibleAssistantMessageKeys.add(messageKey);
}

function closeAssistantMessage(state: ProjectionState, messageKey: string) {
  state.finalizedAssistantMessageKeys.add(messageKey);
  state.openAssistantMessagesByKey.delete(messageKey);
  state.assistantTextBuffersByKey.delete(messageKey);
  state.visibleAssistantMessageKeys.delete(messageKey);
}

export function flushBufferedAssistantMessages(
  state: ProjectionState,
  turnId?: string,
): void {
  const pendingMessages = [...state.openAssistantMessagesByKey]
    .filter(
      ([, { scope }]) =>
        turnId === undefined ||
        (scope.kind === "turn" && scope.turnId === turnId),
    )
    .sort(
      ([, left], [, right]) =>
        left.sourceSeqStart - right.sourceSeqStart ||
        left.sourceSeqEnd - right.sourceSeqEnd ||
        left.createdAt - right.createdAt,
    );
  for (const [messageKey, message] of pendingMessages) {
    const buffer = state.assistantTextBuffersByKey.get(messageKey);
    if (buffer) {
      flushVisibleText(buffer);
      syncAssistantMessage(state, messageKey, message, buffer, "completed");
    } else {
      message.status = "completed";
    }
    closeAssistantMessage(state, messageKey);
  }
}

function projectAssistantText(
  state: ProjectionState,
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallId: string | undefined,
  identity: BufferedTextIdentity | null,
  final: boolean,
  text: string,
): boolean {
  if (!text) return false;
  if (!identity) return true;
  const { key } = identity;
  if (
    state.closedTurnIds.has(identity.turnId) ||
    state.finalizedAssistantMessageKeys.has(key)
  ) {
    return true;
  }
  state.openTurnIds.add(identity.turnId);
  let message = state.openAssistantMessagesByKey.get(key);
  if (message) {
    message.sourceSeqEnd = meta.seq;
    message.createdAt = meta.createdAt;
  } else {
    message = {
      kind: "assistant-text",
      id: messageId(decoded.threadId, "assistant", key),
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
    state.openAssistantMessagesByKey.set(key, message);
  }
  const buffer =
    state.assistantTextBuffersByKey.get(key) ?? createVisibleTextBuffer();
  state.assistantTextBuffersByKey.set(key, buffer);
  if (!final) {
    appendVisibleText(buffer, text);
    syncAssistantMessage(state, key, message, buffer, "streaming");
    return true;
  }
  setVisibleText(buffer, text, true);
  syncAssistantMessage(state, key, message, buffer, "completed");
  closeAssistantMessage(state, key);
  return true;
}

function openReasoningBuffer(
  state: ProjectionState,
  identity: BufferedTextIdentity,
): VisibleTextBuffer | null {
  if (
    state.closedTurnIds.has(identity.turnId) ||
    state.finalizedReasoningKeys.has(identity.key)
  ) {
    return null;
  }
  state.openTurnIds.add(identity.turnId);
  const buffer =
    state.reasoningTextBuffersByKey.get(identity.key) ??
    createVisibleTextBuffer();
  state.reasoningTextBuffersByKey.set(identity.key, buffer);
  return buffer;
}

function projectReasoningDelta(
  state: ProjectionState,
  identity: BufferedTextIdentity | null,
  channel: "summary" | "content",
  text: string,
): boolean {
  if (!text) return false;
  const buffer = identity && openReasoningBuffer(state, identity);
  if (!identity || !buffer) return true;
  const deltas = state.reasoningDeltaTextByKey.get(identity.key) ?? {
    content: "",
    summary: "",
  };
  deltas[channel] += text;
  state.reasoningDeltaTextByKey.set(identity.key, deltas);
  appendVisibleText(buffer, text);
  return true;
}

export interface ActiveThinkingLifecycle {
  messageKey: string;
  parentToolCallId: string | null;
  sourceSeqStart: number;
  startedAt: number;
  threadId: string;
  turnId: string;
  updatedAt: number;
  updatedSeq: number;
}

type ReasoningCompletionStatus = "completed" | "interrupted";

const MAX_REASONING_DETAIL_CHARS = 32_000;

function normalizeReasoningDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= MAX_REASONING_DETAIL_CHARS) return trimmed;
  const dropped = trimmed.length - MAX_REASONING_DETAIL_CHARS;
  return `${trimmed.slice(0, MAX_REASONING_DETAIL_CHARS)}\n…[${dropped.toLocaleString("en-US")} more characters truncated]`;
}

export function buildProjectionActiveThinking(
  state: ProjectionState,
  threadStatus: Thread["status"],
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
    text: buffer?.visible.trim() ?? "",
    startedAt: latest.startedAt,
    updatedAt: latest.updatedAt,
  };
}

function upsertReasoningLifecycle(
  state: ProjectionState,
  meta: EventMeta,
  identity: BufferedTextIdentity,
  parentToolCallId: string | undefined,
  threadId: string,
): void {
  const { key, turnId } = identity;
  if (
    state.closedTurnIds.has(turnId) ||
    state.finalizedReasoningKeys.has(key)
  ) {
    return;
  }
  state.openTurnIds.add(turnId);
  const existing = state.openReasoningLifecyclesByKey.get(key);
  if (existing) {
    existing.updatedAt = meta.createdAt;
    existing.updatedSeq = meta.seq;
    return;
  }
  state.openReasoningLifecyclesByKey.set(key, {
    messageKey: key,
    parentToolCallId: parentToolCallId ?? null,
    sourceSeqStart: meta.seq,
    startedAt: meta.createdAt,
    threadId,
    turnId,
    updatedAt: meta.createdAt,
    updatedSeq: meta.seq,
  });
}

function finalizeReasoningLifecycleByKey(
  state: ProjectionState,
  meta: EventMeta,
  messageKey: string,
  status: ReasoningCompletionStatus,
): OperationMessage | null {
  const lifecycle = state.openReasoningLifecyclesByKey.get(messageKey);
  const buffer = state.reasoningTextBuffersByKey.get(messageKey);
  state.openReasoningLifecyclesByKey.delete(messageKey);
  state.reasoningTextBuffersByKey.delete(messageKey);
  state.finalizedReasoningKeys.add(messageKey);
  if (!lifecycle || !buffer) return null;
  const detail = buffer.visible + buffer.pending;
  if (detail.trim().length === 0) return null;
  const durationMs = meta.createdAt - lifecycle.startedAt;
  const message: OperationMessage = {
    kind: "operation",
    id: messageId(lifecycle.threadId, "op", `reasoning:${messageKey}`),
    threadId: lifecycle.threadId,
    sourceSeqStart: lifecycle.sourceSeqStart,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: lifecycle.startedAt,
    completedAt: meta.createdAt,
    scope: turnScope(lifecycle.turnId),
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

export function finalizeOpenReasoningLifecycles(
  state: ProjectionState,
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

function completeReasoningItem(
  state: ProjectionState,
  meta: EventMeta,
  identity: BufferedTextIdentity | null,
  summary: string,
  content: string,
): boolean {
  const finalText = `${summary}${content}`;
  if (!identity) return finalText.length > 0;
  const { key } = identity;
  const deltas = state.reasoningDeltaTextByKey.get(key);
  const streamed = deltas?.summary === summary && deltas.content === content;
  const completionText = streamed ? "" : finalText;
  const buffer = completionText ? openReasoningBuffer(state, identity) : null;
  if (buffer) setVisibleText(buffer, completionText, true);
  state.reasoningDeltaTextByKey.delete(key);
  const awaiting = state.reasoningMessagesAwaitingCompletion.get(key);
  if (awaiting) {
    state.reasoningMessagesAwaitingCompletion.delete(key);
    awaiting.sourceSeqEnd = meta.seq;
    if (completionText.trim()) {
      awaiting.detail = normalizeReasoningDetail(completionText);
    }
  } else {
    finalizeReasoningLifecycleByKey(state, meta, key, "completed");
  }
  return finalText.length > 0;
}

export function projectAssistantAndReasoningEvent(
  state: ProjectionState,
  decoded: ThreadEvent,
  meta: EventMeta,
  turnId: string | undefined,
  parentToolCallId: string | undefined,
): boolean {
  const identity = bufferedTextIdentity(decoded, turnId, parentToolCallId);
  if (identity?.kind === "reasoning") {
    upsertReasoningLifecycle(
      state,
      meta,
      identity,
      parentToolCallId,
      decoded.threadId,
    );
  }
  const assistant = (final: boolean, text: string) =>
    projectAssistantText(
      state,
      decoded,
      meta,
      parentToolCallId,
      identity,
      final,
      text,
    );
  switch (decoded.type) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
      return assistant(false, decoded.delta);
    case "item/reasoning/summaryTextDelta":
      return projectReasoningDelta(state, identity, "summary", decoded.delta);
    case "item/reasoning/textDelta":
      return projectReasoningDelta(state, identity, "content", decoded.delta);
    case "item/completed": {
      const { item } = decoded;
      if (item.type === "agentMessage" || item.type === "plan") {
        return assistant(true, item.text);
      }
      return item.type === "reasoning"
        ? completeReasoningItem(
            state,
            meta,
            identity,
            item.summary.join(""),
            item.content.join(""),
          )
        : false;
    }
    default:
      return false;
  }
}
