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

type OrderRejection =
  | "not_found"
  | "stale_neighbor"
  | "invalid_neighbor_order"
  | "invalid_sender"
  | "invalid_execution_options";
export type QueueOrderOutcome =
  | { kind: "ok"; rows: QueuedMessageRow[] }
  | { kind: OrderRejection };

class QueueOrderRollback extends Error {
  constructor(readonly kind: OrderRejection) {
    super(kind);
  }
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
  if (boundary < 0) throw new QueueOrderRollback("not_found");
  const prefix = rows.slice(0, boundary + 1);
  const prefixIds = prefix.map((row) => row.id).join();
  if (expectedPrefixIds !== null && prefixIds !== expectedPrefixIds.join()) {
    throw new QueueOrderRollback("stale_neighbor");
  }
  const [lead] = prefix;
  if (prefix.some((row) => row.senderThreadId !== lead.senderThreadId)) {
    throw new QueueOrderRollback("invalid_sender");
  }
  if (prefix.some((row) => !sharesGroupEnvelope(lead, row))) {
    throw new QueueOrderRollback("invalid_execution_options");
  }
  setGroupFlags(db, rows, prefix.length);
  return listQueuedMessages(db, threadId);
}

function settleOrder(db: Db, work: () => QueuedMessageRow[]) {
  try {
    return { kind: "ok" as const, rows: db.transaction(work) };
  } catch (error) {
    if (error instanceof QueueOrderRollback) return { kind: error.kind };
    throw error;
  }
}

export function setQueuedMessageGroupBoundary(
  db: Db,
  threadId: string,
  boundaryId: string,
  expectedPrefixIds: readonly string[],
): QueueOrderOutcome {
  return settleOrder(db, () =>
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
): QueueOrderOutcome {
  const { threadId, id, previousId, nextId, boundaryId } = move;
  return settleOrder(db, () => {
    const rows = listQueuedMessages(db, threadId);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new QueueOrderRollback("not_found");
    const neighbor = (neighborId: string | null) => {
      if (neighborId === null) return null;
      const row = rows.find((candidate) => candidate.id === neighborId);
      if (row === undefined || row.id === id) {
        throw new QueueOrderRollback("stale_neighbor");
      }
      return row;
    };
    const previous = neighbor(previousId);
    const next = neighbor(nextId);
    if (
      previous !== null &&
      next !== null &&
      previous.sortKey >= next.sortKey
    ) {
      throw new QueueOrderRollback("invalid_neighbor_order");
    }
    const before = index === 0 ? null : rows[index - 1].id;
    const after = rows.at(index + 1)?.id ?? null;
    const inPlace = before === previousId && after === nextId;
    if (!inPlace) {
      const sortKey = orderKeyBetween(
        previous?.sortKey ?? null,
        next?.sortKey ?? null,
      );
      db.run(
        `UPDATE queued_thread_messages SET sort_key = ?, updated_at = ?
         WHERE id = ?`,
        sortKey,
        db.now(),
        id,
      );
    }
    if (boundaryId !== undefined) {
      return applyGroupBoundary(db, threadId, boundaryId, null);
    }
    if (inPlace) return rows;
    const leadIds = groupStartingAt(rows, 0).map((row) => row.id);
    const moved = listQueuedMessages(db, threadId);
    const kept = moved
      .slice(0, leadIds.length)
      .every((row) => leadIds.includes(row.id));
    setGroupFlags(db, moved, kept ? leadIds.length : 0);
    return listQueuedMessages(db, threadId);
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

export function toThreadQueuedMessage(
  row: QueuedMessageRow,
): ThreadQueuedMessage {
  const notice = row.systemNotice !== null;
  return {
    id: row.id,
    origin: row.origin,
    originPluginId: row.originPluginId,
    initiator: notice
      ? "system"
      : row.senderThreadId === null
        ? "user"
        : "agent",
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
