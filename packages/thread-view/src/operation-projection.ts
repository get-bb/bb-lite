import type { ThreadEventScope } from "@bb/domain";
import type { TimelineRowStatus } from "@bb/server-contract";
import type { ProjectionState } from "./build-event-projection.js";
import {
  appendVisibleText,
  areThreadEventScopesEqual,
  createVisibleTextBuffer,
  extendMessageBounds,
  flushVisibleText,
  scopeForTurn,
  type EventMeta,
  type FileEditChange,
  type FileEditMessage,
  type InteractionMessage,
  type Message,
  type OperationMessage,
} from "./event-projection-types.js";
import type {
  CompactionLifecycleEvent,
  FileEditPartial,
} from "./item-lifecycle.js";
import {
  mergeTranscriptEntries,
  provisioningTitleForStatus,
} from "./parse-operation-message.js";
import { messageId } from "./timeline-format.js";
import { mergeApprovalStatus } from "./tool-activity-projection.js";

export type CompactionTurnFinalizationStatus = Exclude<
  TimelineRowStatus,
  "pending"
>;

type LifecycleMessage = OperationMessage | InteractionMessage;

function mergeOperationDetail(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  const details = [existing, incoming].filter((value) => Boolean(value));
  if (details.length === 0) return undefined;
  return [...new Set(details)].join("\n");
}

function lifecycleIndexKey(message: LifecycleMessage): string | null {
  const interaction = message.kind === "interaction";
  const key = interaction ? message.interactionId : message.mergeKey;
  if (!key) return null;
  const { scope } = message;
  const scopeKey = scope.kind === "thread" ? "thread" : `turn:${scope.turnId}`;
  return `${interaction ? message.workKind : message.opType}:${scopeKey}:${key}`;
}

export function upsertLifecycleMessage(
  state: ProjectionState,
  incoming: LifecycleMessage,
): void {
  const indexKey = lifecycleIndexKey(incoming);
  const existing =
    indexKey === null ? undefined : state.lifecycleMessagesByKey.get(indexKey);
  if (!existing) {
    if (indexKey !== null) state.lifecycleMessagesByKey.set(indexKey, incoming);
    state.messages.push(incoming);
    return;
  }
  existing.sourceSeqStart = Math.min(
    existing.sourceSeqStart,
    incoming.sourceSeqStart,
  );
  extendMessageBounds(existing, incoming.sourceSeqEnd, incoming.createdAt);
  existing.startedAt = Math.min(
    existing.startedAt ?? existing.createdAt,
    incoming.startedAt ?? incoming.createdAt,
  );
  if (existing.kind === "interaction" && incoming.kind === "interaction") {
    mergeInteraction(existing, incoming);
  } else if (existing.kind === "operation" && incoming.kind === "operation") {
    mergeOperation(existing, incoming);
  }
}

function mergeOperation(
  existing: OperationMessage,
  incoming: OperationMessage,
): void {
  const settles =
    existing.status === "pending" && incoming.status !== "pending";
  if (settles) {
    existing.status = incoming.status;
    existing.completedAt = incoming.completedAt ?? incoming.createdAt;
  }
  if (existing.opType === "thread-provisioning") {
    existing.title = provisioningTitleForStatus(existing.status);
    existing.transcript = mergeTranscriptEntries(
      existing.transcript,
      incoming.transcript,
    );
  } else if (settles) {
    existing.title = incoming.title;
    existing.parentChange = incoming.parentChange;
  }
  existing.detail = mergeOperationDetail(existing.detail, incoming.detail);
}

function mergeInteraction(
  existing: InteractionMessage,
  incoming: InteractionMessage,
): void {
  if (existing.workKind === "approval" && incoming.workKind === "approval") {
    existing.target = incoming.target;
    if (existing.status !== "pending") return;
    existing.status = incoming.status;
    existing.lifecycle = incoming.lifecycle;
  } else if (existing.status !== "pending") {
    return;
  } else if (
    existing.workKind === "question" &&
    incoming.workKind === "question"
  ) {
    existing.status = incoming.status;
    existing.lifecycle = incoming.lifecycle;
    existing.questions = incoming.questions;
    existing.answers = incoming.answers;
    existing.statusReason = incoming.statusReason;
  } else if (existing.workKind === "form" && incoming.workKind === "form") {
    existing.status = incoming.status;
    existing.lifecycle = incoming.lifecycle;
    existing.title = incoming.title;
    existing.statusReason = incoming.statusReason;
    existing.presentation = incoming.presentation;
    existing.payload = incoming.payload;
  }
}

function scopeKey(scope: ThreadEventScope): string {
  return scope.kind === "turn" ? scope.turnId : "thread";
}

export function flushPendingFileEditOutput(state: ProjectionState): void {
  const buffers = state.fileEditStdoutBuffersByScopedCallKey;
  const flushed = new Set([...buffers.values()].filter(flushVisibleText));
  for (const [callId, fileEdits] of state.fileEditsByCallId) {
    for (const fileEdit of fileEdits) {
      const buffer = buffers.get(`${scopeKey(fileEdit.scope)}:${callId}`);
      if (buffer && flushed.has(buffer)) fileEdit.stdout = buffer.visible;
    }
  }
}

function fileEditChangeMatchKeys(change: FileEditChange): string[] {
  return change.movePath && change.movePath !== change.path
    ? [change.path, change.movePath]
    : [change.path];
}

function groupFileEditRowsByChangeMatchKey(
  rows: readonly FileEditMessage[],
): Map<string, FileEditMessage[]> {
  const grouped = new Map<string, FileEditMessage[]>();
  for (const row of rows) {
    const change = row.changes[0];
    if (!change) continue;
    for (const matchKey of fileEditChangeMatchKeys(change)) {
      const rowsForIdentity = grouped.get(matchKey) ?? [];
      rowsForIdentity.push(row);
      grouped.set(matchKey, rowsForIdentity);
    }
  }
  return grouped;
}

function takeUnusedFileEditRow(
  groupedRows: Map<string, FileEditMessage[]>,
  matchKey: string,
  usedRowIds: Set<string>,
): FileEditMessage | undefined {
  const rows = groupedRows.get(matchKey);
  if (!rows || rows.length === 0) return undefined;
  let row: FileEditMessage | undefined;
  while (!row && rows.length > 0) {
    const candidate = rows.shift();
    if (candidate && !usedRowIds.has(candidate.id)) row = candidate;
  }
  if (rows.length === 0) groupedRows.delete(matchKey);
  if (row) usedRowIds.add(row.id);
  return row;
}

function updateFileEditMessage(
  existing: FileEditMessage,
  meta: EventMeta,
  partial: FileEditPartial,
  change: FileEditChange | null,
  stdout: string | undefined,
): void {
  existing.sourceSeqEnd = meta.seq;
  existing.createdAt = meta.createdAt;
  if (!existing.parentToolCallId && partial.parentToolCallId) {
    existing.parentToolCallId = partial.parentToolCallId;
  }
  if ("presentation" in partial && partial.presentation) {
    existing.presentation = partial.presentation;
  }
  if (change) {
    const previous = existing.changes[0];
    existing.changes = [
      previous
        ? {
            path: change.path,
            kind: change.kind ?? previous.kind,
            movePath: change.movePath ?? previous.movePath,
            diff: change.diff ?? previous.diff,
          }
        : { ...change },
    ];
  }
  existing.stdout = stdout;
  existing.approvalStatus = mergeApprovalStatus(
    existing.approvalStatus,
    "approvalStatus" in partial ? partial.approvalStatus : undefined,
    partial.status,
  );
  if (partial.status === "error") {
    existing.status = "error";
  } else if (
    existing.status === "pending" ||
    existing.status === "interrupted"
  ) {
    existing.status = partial.status;
  } else if (existing.status !== "error" && partial.status === "completed") {
    existing.status = "completed";
  }
}

export function upsertFileEdit(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  partial: FileEditPartial,
): void {
  const { callId } = partial;
  const scope = scopeForTurn(turnId);
  const existingRows = state.fileEditsByCallId.get(callId) ?? [];
  const inScope = (row: FileEditMessage) =>
    areThreadEventScopesEqual(row.scope, scope);
  const compatibleRows = existingRows.filter(inScope);
  const foreignRows = existingRows.filter((row) => !inScope(row));
  const foreignMessageIds = new Set(foreignRows.map((row) => row.id));
  const scopedCallKey = `${scopeKey(scope)}:${callId}`;
  const stdoutBuffer =
    state.fileEditStdoutBuffersByScopedCallKey.get(scopedCallKey) ??
    createVisibleTextBuffer();
  state.fileEditStdoutBuffersByScopedCallKey.set(scopedCallKey, stdoutBuffer);
  if ("stdout" in partial) {
    appendVisibleText(stdoutBuffer, partial.stdout);
  } else if (partial.status !== "pending") {
    flushVisibleText(stdoutBuffer);
  }
  const stdout = stdoutBuffer.visible || undefined;
  const createMessage = (
    change: FileEditChange | null,
    baseKey: string,
  ): FileEditMessage => {
    const foreign = foreignMessageIds.has(
      messageId(threadId, "file-edit", baseKey),
    );
    const messageKey = foreign ? `${scopeKey(scope)}:${baseKey}` : baseKey;
    return {
      kind: "file-edit",
      id: messageId(threadId, "file-edit", messageKey),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      scope,
      ...(partial.parentToolCallId
        ? { parentToolCallId: partial.parentToolCallId }
        : {}),
      ...("presentation" in partial && partial.presentation
        ? { presentation: partial.presentation }
        : {}),
      callId,
      changes: change ? [{ ...change }] : [],
      stdout,
      approvalStatus:
        ("approvalStatus" in partial ? partial.approvalStatus : undefined) ??
        null,
      status: partial.status,
    };
  };
  if ("changes" in partial && partial.changes.length > 0) {
    const existingRowsByMatchKey =
      groupFileEditRowsByChangeMatchKey(compatibleRows);
    const usedRowIds = new Set<string>();
    const seenIdentityCounts = new Map<string, number>();
    const nextRows = partial.changes.map((change) => {
      const identity = change.movePath ?? change.path;
      const seenCount = seenIdentityCounts.get(identity) ?? 0;
      seenIdentityCounts.set(identity, seenCount + 1);
      let existing: FileEditMessage | undefined;
      for (const matchKey of fileEditChangeMatchKeys(change)) {
        existing ??= takeUnusedFileEditRow(
          existingRowsByMatchKey,
          matchKey,
          usedRowIds,
        );
      }
      if (!existing) {
        return createMessage(
          change,
          seenCount === 0
            ? `${callId}:${identity}`
            : `${callId}:${identity}:${seenCount}`,
        );
      }
      updateFileEditMessage(existing, meta, partial, change, stdout);
      return existing;
    });
    const allRows = [...foreignRows, ...nextRows];
    const ofCall = (message: Message) =>
      message.kind === "file-edit" && message.callId === callId;
    const insertionIndex = state.messages.findIndex(ofCall);
    const otherMessages = state.messages.filter((message) => !ofCall(message));
    if (insertionIndex === -1) {
      otherMessages.push(...allRows);
    } else {
      otherMessages.splice(insertionIndex, 0, ...allRows);
    }
    state.messages = otherMessages;
    state.fileEditsByCallId.set(callId, allRows);
    return;
  }
  if (compatibleRows.length === 0) {
    const message = createMessage(null, `${callId}:0`);
    compatibleRows.push(message);
    state.messages.push(message);
  } else {
    for (const existing of compatibleRows) {
      updateFileEditMessage(existing, meta, partial, null, stdout);
    }
  }
  state.fileEditsByCallId.set(callId, [...foreignRows, ...compatibleRows]);
}

const COMPACTION_SETTLED_TITLES = {
  error: "Context compaction failed",
  completed: "Context compaction skipped",
  interrupted: "Context compaction interrupted",
};

export function applyCompactionEvent(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  const { key } = payload;
  const completed = payload.kind === "end";
  let message = state.openCompactionsByKey.get(key);
  if (!message && !state.finalizedCompactionKeys.has(key)) {
    message = {
      kind: "operation",
      id: messageId(threadId, "op", `compaction:${key}`),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      completedAt: null,
      scope: scopeForTurn(turnId),
      opType: "compaction",
      title: "Compacting context",
      status: "pending",
    };
    state.messages.push(message);
  }
  if (message) {
    extendMessageBounds(message, meta.seq, meta.createdAt);
    message.detail = payload.detail ?? message.detail;
    message.parentToolCallId =
      payload.parentToolCallId ?? message.parentToolCallId;
    if (completed) {
      message.completedAt = meta.createdAt;
      message.status = "completed";
      message.title = "Context compacted";
      state.openCompactionsByKey.delete(key);
    } else {
      message.status = "pending";
      message.title = "Compacting context";
      state.openCompactionsByKey.set(key, message);
    }
  }
  if (completed) state.finalizedCompactionKeys.add(key);
}

function finalizeOpenCompaction(
  message: OperationMessage,
  meta: EventMeta,
  status: CompactionTurnFinalizationStatus,
  detail: string | undefined,
): void {
  extendMessageBounds(message, meta.seq, meta.createdAt);
  message.completedAt = meta.createdAt;
  message.status = status;
  message.title = COMPACTION_SETTLED_TITLES[status];
  message.detail = detail ?? message.detail;
}

export function finalizeOpenCompactionsForTurn(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  status: CompactionTurnFinalizationStatus,
  detail: string | undefined,
): boolean {
  if (!turnId) return false;
  let settledPending = false;
  for (const message of state.openCompactionsByKey.values()) {
    if (
      message.threadId !== threadId ||
      message.scope.kind !== "turn" ||
      message.scope.turnId !== turnId
    ) {
      continue;
    }
    if (message.status === "pending") settledPending = true;
    finalizeOpenCompaction(message, meta, status, detail);
  }
  return settledPending;
}

export function interruptOpenCompactions(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
): void {
  for (const message of state.openCompactionsByKey.values()) {
    if (
      message.threadId === threadId &&
      message.status === "pending" &&
      message.sourceSeqStart <= meta.seq
    ) {
      finalizeOpenCompaction(message, meta, "interrupted", undefined);
    }
  }
}
