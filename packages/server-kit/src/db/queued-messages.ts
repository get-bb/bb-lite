import * as domain from "@bb/domain";
import { z } from "zod";
import { ApiError, conflict } from "../http/errors.js";
import { decodeJson, insertRow, newId, type Db } from "./index.js";
import { orderKeyBetween } from "./order-keys.js";

type Encoded = "content" | "waitingOn" | "groupWithNext";
type Derived = "initiator" | "payload" | "editable";

export interface QueuedMessageRow extends Omit<
  domain.ThreadQueuedMessage,
  Encoded | Derived
> {
  content: string;
  systemNotice: string | null;
  waitingOn: string | null;
  groupWithNext: number;
  sortKey: string;
}

type Envelope =
  | "threadId"
  | "senderThreadId"
  | "requestedByUserId"
  | "sendAt"
  | "content";
type Execution = "model" | "reasoningLevel" | "permissionMode" | "serviceTier";

export interface NewQueuedMessage extends Pick<
  domain.ThreadQueuedMessage,
  Envelope | Execution | "waitingOn"
> {
  systemNotice: domain.QueuedMessageSystemNotice | null;
}

export function queuedMessageNotFound(): ApiError {
  return new ApiError(404, "invalid_request", "Queued message not found");
}

const contentSchema = z.array(domain.promptInputSchema).min(1);

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

function encodeOptional(value: object | null) {
  return value === null ? null : JSON.stringify(value);
}

export function insertQueuedMessage(
  db: Db,
  input: NewQueuedMessage,
): QueuedMessageRow {
  const id = newId("qmsg");
  const last = listQueuedMessages(db, input.threadId).at(-1);
  insertRow(db, "queued_thread_messages", {
    ...input,
    id,
    content: JSON.stringify(input.content),
    systemNotice: encodeOptional(input.systemNotice),
    waitingOn: encodeOptional(input.waitingOn),
    sortKey: orderKeyBetween(last?.sortKey ?? null, null),
    createdAt: db.now(),
    updatedAt: db.now(),
  });
  const row = getQueuedMessage(db, input.threadId, id);
  if (row === undefined) throw new Error("Queued message insert was lost");
  return row;
}

export function reorderQueuedMessages(
  db: Db,
  threadId: string,
  ids: readonly string[],
): void {
  const rows = listQueuedMessages(db, threadId);
  const known = new Set(rows.map(({ id }) => id));
  const missing = ids.find((id) => !known.has(id));
  if (missing !== undefined) throw queuedMessageNotFound();
  const rest = rows.map(({ id }) => id).filter((id) => !ids.includes(id));
  let previous: string | null = null;
  for (const id of [...new Set(ids), ...rest]) {
    previous = orderKeyBetween(previous, null);
    db.run(
      "UPDATE queued_thread_messages SET sort_key = ? WHERE id = ?",
      previous,
      id,
    );
  }
}

function groupable(lead: QueuedMessageRow, row: QueuedMessageRow) {
  return (
    row.senderThreadId === lead.senderThreadId &&
    row.model === lead.model &&
    row.reasoningLevel === lead.reasoningLevel &&
    row.permissionMode === lead.permissionMode &&
    row.serviceTier === lead.serviceTier
  );
}

export function queuedGroups(
  rows: readonly QueuedMessageRow[],
): QueuedMessageRow[][] {
  const groups: QueuedMessageRow[][] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    const lead = group?.[0];
    const tail = group?.at(-1);
    if (group && lead && tail?.groupWithNext && groupable(lead, row)) {
      group.push(row);
    } else {
      groups.push([row]);
    }
  }
  return groups;
}

export function setQueuedMessageBoundary(
  db: Db,
  threadId: string,
  queuedMessageId: string,
  expectedGroupedPrefixQueuedMessageIds?: readonly string[],
): void {
  const rows = listQueuedMessages(db, threadId);
  const boundary = rows.findIndex(({ id }) => id === queuedMessageId);
  if (boundary === -1) throw queuedMessageNotFound();
  const prefix = rows.slice(0, boundary + 1);
  const expected = expectedGroupedPrefixQueuedMessageIds;
  if (
    expected !== undefined &&
    expected.join("\n") !== prefix.map(({ id }) => id).join("\n")
  ) {
    throw conflict("The queue changed since grouping");
  }
  const lead = prefix[0];
  if (lead && prefix.some((row) => !groupable(lead, row))) {
    throw new ApiError(
      400,
      "invalid_request",
      "Grouped messages must share a sender and execution options",
    );
  }
  for (const [index, row] of rows.entries()) {
    const groupWithNext = index < boundary ? 1 : 0;
    if (row.groupWithNext === groupWithNext) continue;
    db.run(
      `UPDATE queued_thread_messages SET group_with_next = ?, updated_at = ?
       WHERE id = ?`,
      groupWithNext,
      Math.max(db.now(), row.updatedAt + 1),
      row.id,
    );
  }
}

export function clearQueuedGroupEdges(
  db: Db,
  threadId: string,
  ids?: readonly string[],
): void {
  const rows = listQueuedMessages(db, threadId);
  for (const [index, row] of rows.entries()) {
    const next = rows[index + 1]?.id;
    if (ids !== undefined && (next === undefined || !ids.includes(next))) {
      continue;
    }
    db.run(
      "UPDATE queued_thread_messages SET group_with_next = 0 WHERE id = ?",
      row.id,
    );
  }
}

export function deleteQueuedMessages(db: Db, ids: readonly string[]): void {
  for (const id of ids) {
    db.run("DELETE FROM queued_thread_messages WHERE id = ?", id);
  }
}

export function setQueuedMessageWait(
  db: Db,
  rows: readonly QueuedMessageRow[],
  waitingOn: domain.QueuedMessageWaitingOn | null,
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
  content: domain.PromptInput[],
): void {
  db.run(
    "UPDATE queued_thread_messages SET content = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(content),
    Math.max(db.now(), row.updatedAt + 1),
    row.id,
  );
}

export function parseQueuedContent(
  row: QueuedMessageRow,
): domain.PromptInput[] {
  return decodeJson(contentSchema, row.content);
}

export function parseQueuedWait(
  row: QueuedMessageRow,
): domain.QueuedMessageWaitingOn | null {
  if (row.waitingOn === null) return null;
  return decodeJson(domain.queuedMessageWaitingOnSchema, row.waitingOn);
}

export function parseQueuedNotice(
  row: QueuedMessageRow,
): domain.QueuedMessageSystemNotice | null {
  if (row.systemNotice === null) return null;
  return decodeJson(domain.queuedMessageSystemNoticeSchema, row.systemNotice);
}

export function listThreadIdsWaitingOn(
  db: Db,
  kind: domain.QueuedMessageWaitingOnKind,
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

export function listThreadIdsHeldBy(db: Db, pluginId: string): string[] {
  const rows = db.all<{ threadId: string }>(
    `SELECT DISTINCT thread_id FROM queued_thread_messages
     WHERE json_extract(waiting_on, '$.kind') = 'plugin'
       AND json_extract(waiting_on, '$.pluginId') = ?`,
    pluginId,
  );
  return rows.map((row) => row.threadId);
}

export function queuedInitiator(row: QueuedMessageRow) {
  if (row.systemNotice !== null) return "system";
  return row.senderThreadId === null ? "user" : "agent";
}

export function toThreadQueuedMessage(
  row: QueuedMessageRow,
): domain.ThreadQueuedMessage {
  return {
    id: row.id,
    origin: row.origin,
    originPluginId: row.originPluginId,
    initiator: queuedInitiator(row),
    senderThreadId: row.senderThreadId,
    requestedByUserId: row.requestedByUserId,
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
    editable: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
