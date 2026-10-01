import {
  promptInputSchema,
  queuedMessageSystemNoticeSchema,
  queuedMessageWaitingOnSchema,
  type PermissionMode,
  type PromptInput,
  type QueuedMessageSystemNotice,
  type QueuedMessageWaitingOn,
  type QueuedMessageWaitingOnKind,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadCreateOrigin,
  type ThreadQueuedMessage,
} from "@bb/domain";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import { decodeJson, encodeJson, newId, type Db } from "./index.js";
import { orderKeyBetween } from "./order-keys.js";

export interface QueuedMessageRow {
  id: string;
  threadId: string;
  content: string;
  senderThreadId: string | null;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  systemNotice: string | null;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
  groupWithNext: number;
  sendAt: number | null;
  waitingOn: string | null;
  failureReason: string | null;
  sortKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewQueuedMessage {
  threadId: string;
  content: PromptInput[];
  senderThreadId: string | null;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  systemNotice: QueuedMessageSystemNotice | null;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
  waitingOn: QueuedMessageWaitingOn | null;
  sendAt: number | null;
}

function rejected(message: string): ApiError {
  return new ApiError(409, "invalid_request", message);
}

export function queuedMessageNotFound(): ApiError {
  return new ApiError(404, "invalid_request", "Queued message not found");
}

const contentSchema = z.array(promptInputSchema).min(1);

export function listQueuedMessages(db: Db, threadId: string) {
  return db.all<QueuedMessageRow>(
    `SELECT * FROM queued_thread_messages
     WHERE thread_id = ? ORDER BY sort_key, id`,
    threadId,
  );
}

export function getQueuedMessage(db: Db, threadId: string, id: string) {
  return db.get<QueuedMessageRow>(
    "SELECT * FROM queued_thread_messages WHERE thread_id = ? AND id = ?",
    threadId,
    id,
  );
}

function encodeOptional(value: object | null): string | null {
  return value === null ? null : encodeJson(value);
}

export function insertQueuedMessage(
  db: Db,
  input: NewQueuedMessage,
): QueuedMessageRow {
  const id = newId("qmsg");
  const now = db.now();
  const last = listQueuedMessages(db, input.threadId).at(-1);
  db.run(
    `INSERT INTO queued_thread_messages
       (id, thread_id, content, sender_thread_id, origin, origin_plugin_id,
        system_notice, model, reasoning_level, permission_mode, service_tier,
        send_at, waiting_on, sort_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.threadId,
    encodeJson(input.content),
    input.senderThreadId,
    input.origin,
    input.originPluginId,
    encodeOptional(input.systemNotice),
    input.model,
    input.reasoningLevel,
    input.permissionMode,
    input.serviceTier,
    input.sendAt,
    encodeOptional(input.waitingOn),
    orderKeyBetween(last?.sortKey ?? null, null),
    now,
    now,
  );
  const row = getQueuedMessage(db, input.threadId, id);
  if (row === undefined) throw new Error("Queued message insert was lost");
  return row;
}

export function deleteQueuedMessages(db: Db, ids: readonly string[]): void {
  for (const id of ids) {
    db.run("DELETE FROM queued_thread_messages WHERE id = ?", id);
  }
}

export function setQueuedMessageWait(
  db: Db,
  rows: readonly QueuedMessageRow[],
  waitingOn: QueuedMessageWaitingOn | null,
): void {
  for (const row of rows) {
    db.run(
      `UPDATE queued_thread_messages SET waiting_on = ?, updated_at = ?
       WHERE id = ?`,
      encodeOptional(waitingOn),
      Math.max(db.now(), row.updatedAt + 1),
      row.id,
    );
  }
}

export function updateQueuedMessageContent(
  db: Db,
  row: QueuedMessageRow,
  content: PromptInput[],
): void {
  db.run(
    "UPDATE queued_thread_messages SET content = ?, updated_at = ? WHERE id = ?",
    encodeJson(content),
    Math.max(db.now(), row.updatedAt + 1),
    row.id,
  );
}

export function parseQueuedContent(row: QueuedMessageRow): PromptInput[] {
  return decodeJson(contentSchema, row.content);
}

export function parseQueuedWait(
  row: QueuedMessageRow,
): QueuedMessageWaitingOn | null {
  if (row.waitingOn === null) return null;
  return decodeJson(queuedMessageWaitingOnSchema, row.waitingOn);
}

export function parseQueuedNotice(
  row: QueuedMessageRow,
): QueuedMessageSystemNotice | null {
  if (row.systemNotice === null) return null;
  return decodeJson(queuedMessageSystemNoticeSchema, row.systemNotice);
}

export function sharesGroupEnvelope(
  lead: QueuedMessageRow,
  row: QueuedMessageRow,
): boolean {
  return (
    row.senderThreadId === lead.senderThreadId &&
    row.model === lead.model &&
    row.reasoningLevel === lead.reasoningLevel &&
    row.permissionMode === lead.permissionMode &&
    row.serviceTier === lead.serviceTier
  );
}

export function groupStartingAt(
  rows: readonly QueuedMessageRow[],
  start: number,
): QueuedMessageRow[] {
  const lead = rows[start];
  const group = [lead];
  for (let index = start; rows[index].groupWithNext === 1; index += 1) {
    const next = rows.at(index + 1);
    if (next === undefined || !sharesGroupEnvelope(lead, next)) break;
    group.push(next);
  }
  return group;
}

function setGroupFlags(
  db: Db,
  rows: readonly QueuedMessageRow[],
  groupedCount: number,
): void {
  rows.forEach((row, index) => {
    const flag = index < groupedCount - 1 ? 1 : 0;
    if (row.groupWithNext === flag) return;
    db.run(
      `UPDATE queued_thread_messages SET group_with_next = ?, updated_at = ?
       WHERE id = ?`,
      flag,
      db.now(),
      row.id,
    );
  });
}

function applyGroupBoundary(
  db: Db,
  threadId: string,
  boundaryId: string,
  expectedPrefixIds: readonly string[] | null,
): QueuedMessageRow[] {
  const rows = listQueuedMessages(db, threadId);
  const boundary = rows.findIndex((row) => row.id === boundaryId);
  if (boundary < 0) throw queuedMessageNotFound();
  const prefix = rows.slice(0, boundary + 1);
  const prefixIds = prefix.map((row) => row.id).join();
  if (expectedPrefixIds !== null && prefixIds !== expectedPrefixIds.join()) {
    throw rejected("Queued message order changed");
  }
  const [lead] = prefix;
  if (prefix.some((row) => row.senderThreadId !== lead.senderThreadId)) {
    throw rejected("Queued messages from different senders cannot be grouped");
  }
  if (prefix.some((row) => !sharesGroupEnvelope(lead, row))) {
    const cause = "different execution options";
    throw rejected(`Queued messages with ${cause} cannot be grouped`);
  }
  setGroupFlags(db, rows, prefix.length);
  return listQueuedMessages(db, threadId);
}

export function setQueuedMessageGroupBoundary(
  db: Db,
  threadId: string,
  boundaryId: string,
  expectedPrefixIds: readonly string[],
): QueuedMessageRow[] {
  return db.transaction(() =>
    applyGroupBoundary(db, threadId, boundaryId, expectedPrefixIds),
  );
}

export interface QueueReorder {
  threadId: string;
  id: string;
  previousId: string | null;
  nextId: string | null;
  boundaryId: string | undefined;
}

export function reorderQueuedMessage(
  db: Db,
  move: QueueReorder,
): QueuedMessageRow[] {
  const { threadId, id, previousId, nextId, boundaryId } = move;
  return db.transaction(() => {
    const rows = listQueuedMessages(db, threadId);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw queuedMessageNotFound();
    const neighbor = (neighborId: string | null) => {
      if (neighborId === null) return null;
      const row = rows.find((candidate) => candidate.id === neighborId);
      if (row !== undefined && row.id !== id) return row;
      throw rejected("Queued message order changed");
    };
    const previous = neighbor(previousId);
    const next = neighbor(nextId);
    if (
      previous !== null &&
      next !== null &&
      previous.sortKey >= next.sortKey
    ) {
      throw rejected("Queued message order is invalid");
    }
    const before = index === 0 ? null : rows[index - 1].id;
    const after = rows.at(index + 1)?.id ?? null;
    if (before !== previousId || after !== nextId) {
      const sortKey = orderKeyBetween(
        previous?.sortKey ?? null,
        next?.sortKey ?? null,
      );
      db.run(
        `UPDATE queued_thread_messages
         SET sort_key = ?, group_with_next = 0, updated_at = ? WHERE id = ?`,
        sortKey,
        db.now(),
        id,
      );
    }
    if (boundaryId === undefined) return listQueuedMessages(db, threadId);
    return applyGroupBoundary(db, threadId, boundaryId, null);
  });
}

export function listThreadIdsWaitingOn(
  db: Db,
  kind: QueuedMessageWaitingOnKind,
  dueBy?: number,
): string[] {
  const rows = db.all<{ threadId: string }>(
    `SELECT DISTINCT thread_id FROM queued_thread_messages
     WHERE json_extract(waiting_on, '$.kind') = ?
       AND (? IS NULL OR send_at <= ?)`,
    kind,
    dueBy ?? null,
    dueBy ?? null,
  );
  return rows.map((row) => row.threadId);
}

export function queuedInitiator(row: QueuedMessageRow) {
  if (row.systemNotice !== null) return "system";
  return row.senderThreadId === null ? "user" : "agent";
}

export function toThreadQueuedMessage(
  row: QueuedMessageRow,
): ThreadQueuedMessage {
  const notice = row.systemNotice !== null;
  return {
    id: row.id,
    origin: row.origin,
    originPluginId: row.originPluginId,
    initiator: queuedInitiator(row),
    senderThreadId: row.senderThreadId,
    threadId: row.threadId,
    content: parseQueuedContent(row),
    model: row.model,
    reasoningLevel: row.reasoningLevel,
    permissionMode: row.permissionMode,
    serviceTier: row.serviceTier,
    groupWithNext: row.groupWithNext === 1,
    sendAt: row.sendAt,
    waitingOn: parseQueuedWait(row),
    failureReason: row.failureReason,
    payload: { kind: "inline" },
    editable: !notice,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
