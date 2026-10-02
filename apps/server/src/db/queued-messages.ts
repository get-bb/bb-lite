import * as domain from "@bb/domain";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
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
  sortKey: string;
}

type Envelope = "threadId" | "senderThreadId" | "sendAt" | "content";
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
    threadId: row.threadId,
    content: parseQueuedContent(row),
    model: row.model,
    reasoningLevel: row.reasoningLevel,
    permissionMode: row.permissionMode,
    serviceTier: row.serviceTier,
    groupWithNext: false,
    sendAt: row.sendAt,
    waitingOn: parseQueuedWait(row),
    failureReason: row.failureReason,
    payload: { kind: "inline" },
    editable: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
