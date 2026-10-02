import {
  type EventProjectionFileEditChange,
  type EventProjectionFileEditMessage,
  type EventProjectionMessage,
  type EventProjectionOperationMessage,
  type EventProjectionPermissionGrantLifecycleMessage,
  type EventProjectionUserQuestionLifecycleMessage,
  type EventProjectionPluginFormLifecycleMessage,
  type EventMeta,
  extendMessageBounds,
  haveCompatibleEventProjectionMessageScope,
  eventProjectionMessageThreadScopeFields,
  eventProjectionMessageTurnScopeFields,
} from "./event-projection-types.js";
import type {
  CompactionLifecycleEvent,
  FileEditPartial,
} from "./item-lifecycle.js";
import { messageId } from "./timeline-format.js";
import {
  mergeProvisioningMetadata,
  provisioningKey,
  provisioningTitleForStatus,
} from "./parse-operation-message.js";
import { mergeApprovalStatus } from "./tool-activity-projection.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getVisibleTextBufferText,
  type VisibleTextBuffer,
} from "./text-projection.js";

export interface OperationProjectionState {
  messages: EventProjectionMessage[];
  fileEditsByCallId: Map<string, EventProjectionFileEditMessage[]>;
  fileEditStdoutBuffersByScopedCallKey: Map<string, VisibleTextBuffer>;
  openCompactionsByKey: Map<string, EventProjectionOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  provisioningOperationsByKey: Map<string, EventProjectionOperationMessage>;
  permissionGrantsByInteractionId: Map<
    string,
    EventProjectionPermissionGrantLifecycleMessage
  >;
  userQuestionsByInteractionId: Map<
    string,
    EventProjectionUserQuestionLifecycleMessage
  >;
  pluginFormsByInteractionId: Map<
    string,
    EventProjectionPluginFormLifecycleMessage
  >;
  threadOperationsById: Map<string, EventProjectionOperationMessage>;
}

export function createOperationProjectionState(
  messages: EventProjectionMessage[],
): OperationProjectionState {
  return {
    messages,
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    provisioningOperationsByKey: new Map(),
    permissionGrantsByInteractionId: new Map(),
    userQuestionsByInteractionId: new Map(),
    pluginFormsByInteractionId: new Map(),
    threadOperationsById: new Map(),
    fileEditsByCallId: new Map(),
    fileEditStdoutBuffersByScopedCallKey: new Map(),
  };
}

export type CompactionTurnFinalizationStatus = Exclude<
  LifecycleStatus,
  "pending"
>;

type LifecycleStatus = NonNullable<EventProjectionOperationMessage["status"]>;

type LifecycleEventProjectionMessage =
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | EventProjectionPluginFormLifecycleMessage;

type EventProjectionMessageScopeFields = Pick<EventProjectionMessage, "scope">;

function mergeLifecycleStatus(
  existing: LifecycleStatus,
  incoming: LifecycleStatus,
): LifecycleStatus {
  return existing !== "pending" ? existing : incoming;
}

function mergeOperationDetail(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  const details = [existing, incoming].filter((value): value is string =>
    Boolean(value),
  );
  if (details.length === 0) return undefined;
  return [...new Set(details)].join("\n");
}

function upsertKeyedLifecycleMessage<
  TMessage extends LifecycleEventProjectionMessage,
>(
  state: OperationProjectionState,
  index: Map<string, TMessage>,
  key: string | null | undefined,
  incoming: TMessage,
  mergeExisting: (existing: TMessage, incoming: TMessage) => void,
): void {
  const scopedKey =
    incoming.scope.kind === "thread"
      ? `thread:${key}`
      : `turn:${incoming.scope.turnId}:${key}`;
  const existing = key ? index.get(scopedKey) : undefined;
  if (!existing) {
    if (key) index.set(scopedKey, incoming);
    state.messages.push(incoming);
    return;
  }
  if (!haveCompatibleEventProjectionMessageScope(existing, incoming)) {
    throw new Error(
      `Cannot merge ${existing.kind} messages with different scopes`,
    );
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
  mergeExisting(existing, incoming);
}

export function upsertLifecycleMessage(
  state: OperationProjectionState,
  incoming: LifecycleEventProjectionMessage,
): void {
  if (incoming.kind === "permission-grant-lifecycle") {
    upsertKeyedLifecycleMessage(
      state,
      state.permissionGrantsByInteractionId,
      incoming.interactionId,
      incoming,
      mergePermissionGrantLifecycleMessage,
    );
  } else if (incoming.kind === "user-question-lifecycle") {
    upsertKeyedLifecycleMessage(
      state,
      state.userQuestionsByInteractionId,
      incoming.interactionId,
      incoming,
      mergeUserQuestionLifecycleMessage,
    );
  } else if (incoming.kind === "plugin-form-lifecycle") {
    upsertKeyedLifecycleMessage(
      state,
      state.pluginFormsByInteractionId,
      incoming.interactionId,
      incoming,
      mergePluginFormLifecycleMessage,
    );
  } else if (incoming.opType === "thread-provisioning") {
    upsertKeyedLifecycleMessage(
      state,
      state.provisioningOperationsByKey,
      provisioningKey(incoming),
      incoming,
      mergeProvisioningOperation,
    );
  } else if (incoming.opType === "operation") {
    upsertKeyedLifecycleMessage(
      state,
      state.threadOperationsById,
      incoming.threadOperation?.operationId,
      incoming,
      mergeThreadOperationMessage,
    );
  } else {
    state.messages.push(incoming);
  }
}

function mergeProvisioningOperation(
  existing: EventProjectionOperationMessage,
  incoming: EventProjectionOperationMessage,
): void {
  const wasPending = (existing.status ?? "pending") === "pending";
  existing.status = mergeLifecycleStatus(
    existing.status ?? "pending",
    incoming.status ?? "pending",
  );
  existing.title = provisioningTitleForStatus(existing.status);
  if (wasPending && existing.status !== "pending") {
    existing.completedAt = incoming.completedAt ?? incoming.createdAt;
  }
  existing.provisioning = mergeProvisioningMetadata(
    existing.provisioning,
    incoming.provisioning,
  );
  existing.detail = mergeOperationDetail(existing.detail, incoming.detail);
}

function mergeThreadOperationMessage(
  existing: EventProjectionOperationMessage,
  incoming: EventProjectionOperationMessage,
): void {
  const mergedStatus = mergeLifecycleStatus(
    existing.status ?? "pending",
    incoming.status ?? "pending",
  );
  const shouldUseIncomingLifecycle = existing.status !== mergedStatus;
  existing.status = mergedStatus;
  if (shouldUseIncomingLifecycle) {
    existing.title = incoming.title;
    existing.threadOperation = incoming.threadOperation;
    if (mergedStatus !== "pending") {
      existing.completedAt = incoming.completedAt ?? incoming.createdAt;
    }
  }
  existing.detail = mergeOperationDetail(existing.detail, incoming.detail);
}

function mergePluginFormLifecycleMessage(
  existing: EventProjectionPluginFormLifecycleMessage,
  incoming: EventProjectionPluginFormLifecycleMessage,
): void {
  if (existing.status !== "pending") return;
  existing.status = incoming.status;
  existing.lifecycle = incoming.lifecycle;
  existing.title = incoming.title;
  existing.statusReason = incoming.statusReason;
  existing.presentation = incoming.presentation;
  existing.payload = incoming.payload;
}

function mergeUserQuestionLifecycleMessage(
  existing: EventProjectionUserQuestionLifecycleMessage,
  incoming: EventProjectionUserQuestionLifecycleMessage,
): void {
  if (existing.status !== "pending") return;
  existing.status = incoming.status;
  existing.lifecycle = incoming.lifecycle;
  existing.questions = incoming.questions;
  existing.answers = incoming.answers;
  existing.statusReason = incoming.statusReason;
}

function mergePermissionGrantLifecycleMessage(
  existing: EventProjectionPermissionGrantLifecycleMessage,
  incoming: EventProjectionPermissionGrantLifecycleMessage,
): void {
  if (existing.status === "pending") {
    existing.status = incoming.status;
    existing.lifecycle = incoming.lifecycle;
  }
  existing.approvalTarget = incoming.approvalTarget;
}

export function flushPendingFileEditOutput(
  state: OperationProjectionState,
): void {
  const flushedBufferByScopedCallKey = new Map<
    string,
    VisibleTextBuffer | null
  >();
  for (const [callId, fileEdits] of state.fileEditsByCallId.entries()) {
    for (const fileEdit of fileEdits) {
      const scopedCallKey = scopedFileEditCallKey(callId, fileEdit);
      let flushedBuffer = flushedBufferByScopedCallKey.get(scopedCallKey);
      if (flushedBuffer === undefined) {
        const buffer =
          state.fileEditStdoutBuffersByScopedCallKey.get(scopedCallKey);
        flushedBuffer =
          buffer && flushVisibleTextBuffer(buffer) ? buffer : null;
        flushedBufferByScopedCallKey.set(scopedCallKey, flushedBuffer);
      }
      if (flushedBuffer !== null) {
        fileEdit.stdout = getVisibleTextBufferText(flushedBuffer);
      }
    }
  }
}

function fileEditChangeMatchKeys(
  change: EventProjectionFileEditChange,
): string[] {
  if (change.movePath && change.movePath !== change.path) {
    return [change.path, change.movePath];
  }
  return [change.path];
}

function fileEditScopeDiscriminator(
  scopeFields: EventProjectionMessageScopeFields,
): string {
  const scope = scopeFields.scope;
  return scope.kind === "turn" ? scope.turnId : "thread";
}

function scopedFileEditCallKey(
  callId: string,
  scopeFields: EventProjectionMessageScopeFields,
): string {
  return `${fileEditScopeDiscriminator(scopeFields)}:${callId}`;
}

function groupFileEditRowsByChangeMatchKey(
  rows: readonly EventProjectionFileEditMessage[],
): Map<string, EventProjectionFileEditMessage[]> {
  const grouped = new Map<string, EventProjectionFileEditMessage[]>();
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

function takeUnusedFileEditRowForMatchKey(
  groupedRows: Map<string, EventProjectionFileEditMessage[]>,
  matchKey: string,
  usedRowIds: Set<string>,
): EventProjectionFileEditMessage | undefined {
  const rows = groupedRows.get(matchKey);
  if (!rows || rows.length === 0) return undefined;
  let row: EventProjectionFileEditMessage | undefined;
  while (!row && rows.length > 0) {
    const candidate = rows.shift();
    if (candidate && !usedRowIds.has(candidate.id)) row = candidate;
  }
  if (rows.length === 0) groupedRows.delete(matchKey);
  if (row) usedRowIds.add(row.id);
  return row;
}

function updateFileEditMessage(
  existing: EventProjectionFileEditMessage,
  meta: EventMeta,
  partial: FileEditPartial,
  scopeFields: EventProjectionMessageScopeFields,
  change: EventProjectionFileEditChange | null,
  stdout: string | undefined,
): void {
  if (!haveCompatibleEventProjectionMessageScope(existing, scopeFields)) {
    throw new Error(
      `Cannot merge file-edit messages with different scopes for call ${partial.callId}`,
    );
  }
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
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  partial: FileEditPartial,
): void {
  const scopeFields = turnId
    ? eventProjectionMessageTurnScopeFields(turnId)
    : eventProjectionMessageThreadScopeFields();
  const existingRows = state.fileEditsByCallId.get(partial.callId) ?? [];
  const compatibleRows: EventProjectionFileEditMessage[] = [];
  const foreignRows: EventProjectionFileEditMessage[] = [];
  for (const row of existingRows) {
    if (haveCompatibleEventProjectionMessageScope(row, scopeFields)) {
      compatibleRows.push(row);
    } else {
      foreignRows.push(row);
    }
  }
  const foreignMessageIds = new Set(foreignRows.map((row) => row.id));
  const scopedCallKey = scopedFileEditCallKey(partial.callId, scopeFields);
  const stdoutBuffer =
    state.fileEditStdoutBuffersByScopedCallKey.get(scopedCallKey) ??
    createVisibleTextBuffer();
  state.fileEditStdoutBuffersByScopedCallKey.set(scopedCallKey, stdoutBuffer);
  if ("stdout" in partial) {
    if (partial.stdout) appendVisibleTextBuffer(stdoutBuffer, partial.stdout);
  } else if (partial.status !== "pending") {
    flushVisibleTextBuffer(stdoutBuffer);
  }
  const stdout = getVisibleTextBufferText(stdoutBuffer);
  const createMessage = (
    change: EventProjectionFileEditChange | null,
    baseKey: string,
  ): EventProjectionFileEditMessage => {
    const messageKey = foreignMessageIds.has(
      messageId(threadId, "file-edit", baseKey),
    )
      ? `${fileEditScopeDiscriminator(scopeFields)}:${baseKey}`
      : baseKey;
    return {
      kind: "file-edit",
      id: messageId(threadId, "file-edit", messageKey),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      ...scopeFields,
      ...(partial.parentToolCallId
        ? { parentToolCallId: partial.parentToolCallId }
        : {}),
      ...("presentation" in partial && partial.presentation
        ? { presentation: partial.presentation }
        : {}),
      callId: partial.callId,
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
      let existing: EventProjectionFileEditMessage | undefined;
      for (const matchKey of fileEditChangeMatchKeys(change)) {
        existing ??= takeUnusedFileEditRowForMatchKey(
          existingRowsByMatchKey,
          matchKey,
          usedRowIds,
        );
      }
      if (!existing) {
        return createMessage(
          change,
          seenCount === 0
            ? `${partial.callId}:${identity}`
            : `${partial.callId}:${identity}:${seenCount}`,
        );
      }
      updateFileEditMessage(
        existing,
        meta,
        partial,
        scopeFields,
        change,
        stdout,
      );
      return existing;
    });
    const allRows = [...foreignRows, ...nextRows];
    const insertionIndex = state.messages.findIndex(
      (message) =>
        message.kind === "file-edit" && message.callId === partial.callId,
    );
    const messagesWithoutCallRows = state.messages.filter(
      (message) =>
        message.kind !== "file-edit" || message.callId !== partial.callId,
    );
    if (insertionIndex === -1) {
      messagesWithoutCallRows.push(...allRows);
    } else {
      messagesWithoutCallRows.splice(insertionIndex, 0, ...allRows);
    }
    state.messages = messagesWithoutCallRows;
    state.fileEditsByCallId.set(partial.callId, allRows);
    return;
  }
  if (compatibleRows.length === 0) {
    const message = createMessage(null, `${partial.callId}:0`);
    compatibleRows.push(message);
    state.messages.push(message);
  } else {
    for (const existing of compatibleRows) {
      updateFileEditMessage(existing, meta, partial, scopeFields, null, stdout);
    }
  }
  state.fileEditsByCallId.set(partial.callId, [
    ...foreignRows,
    ...compatibleRows,
  ]);
}

function buildCompactionMessage(
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
  completed: boolean,
): EventProjectionOperationMessage {
  return {
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    completedAt: completed ? meta.createdAt : null,
    ...(turnId
      ? eventProjectionMessageTurnScopeFields(turnId)
      : eventProjectionMessageThreadScopeFields()),
    opType: "compaction",
    title: completed ? "Context compacted" : "Compacting context",
    detail: payload.detail,
    ...(payload.parentToolCallId
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
    status: completed ? "completed" : "pending",
  };
}

function touchCompactionMessage(
  existing: EventProjectionOperationMessage,
  meta: EventMeta,
  payload: CompactionLifecycleEvent,
  completed: boolean,
): void {
  extendMessageBounds(existing, meta.seq, meta.createdAt);
  if (completed) existing.completedAt = meta.createdAt;
  existing.status = completed ? "completed" : "pending";
  existing.title = completed ? "Context compacted" : "Compacting context";
  existing.detail = payload.detail ?? existing.detail;
  existing.parentToolCallId =
    payload.parentToolCallId ?? existing.parentToolCallId;
}

export function onCompactionBegin(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  if (state.finalizedCompactionKeys.has(payload.key)) return;
  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    touchCompactionMessage(existing, meta, payload, false);
    return;
  }
  const message = buildCompactionMessage(
    meta,
    threadId,
    turnId,
    payload,
    false,
  );
  state.openCompactionsByKey.set(payload.key, message);
  state.messages.push(message);
}

export function onCompactionEnd(
  state: OperationProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    touchCompactionMessage(existing, meta, payload, true);
    state.openCompactionsByKey.delete(payload.key);
  } else if (!state.finalizedCompactionKeys.has(payload.key)) {
    state.messages.push(
      buildCompactionMessage(meta, threadId, turnId, payload, true),
    );
  }
  state.finalizedCompactionKeys.add(payload.key);
}

function finalizeOpenCompaction(
  message: EventProjectionOperationMessage,
  meta: EventMeta,
  status: CompactionTurnFinalizationStatus,
  detail: string | undefined,
): void {
  extendMessageBounds(message, meta.seq, meta.createdAt);
  message.completedAt = meta.createdAt;
  message.status = status;
  message.title =
    status === "error"
      ? "Context compaction failed"
      : status === "completed"
        ? "Context compaction skipped"
        : "Context compaction interrupted";
  message.detail = detail ?? message.detail;
}

export function finalizeOpenCompactionsForTurn(args: {
  state: OperationProjectionState;
  meta: EventMeta;
  threadId: string;
  turnId: string | undefined;
  status: CompactionTurnFinalizationStatus;
  detail: string | undefined;
}): boolean {
  if (!args.turnId) return false;
  let settledPending = false;
  for (const message of args.state.openCompactionsByKey.values()) {
    if (
      message.threadId !== args.threadId ||
      message.scope.kind !== "turn" ||
      message.scope.turnId !== args.turnId
    ) {
      continue;
    }
    if (message.status === "pending") settledPending = true;
    finalizeOpenCompaction(message, args.meta, args.status, args.detail);
  }
  return settledPending;
}

export function interruptOpenCompactions(args: {
  state: OperationProjectionState;
  meta: EventMeta;
  threadId: string;
}): void {
  for (const message of args.state.openCompactionsByKey.values()) {
    if (
      message.threadId !== args.threadId ||
      message.status !== "pending" ||
      message.sourceSeqStart > args.meta.seq
    ) {
      continue;
    }
    finalizeOpenCompaction(message, args.meta, "interrupted", undefined);
  }
}
