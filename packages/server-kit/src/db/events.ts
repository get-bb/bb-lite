import {
  OWNER_USER_ID,
  type PromptInput,
  type ThreadEventType,
  type ThreadSearchSourceKind,
} from "@bb/domain";
import type { RunnerThreadEvent } from "@bb/runner";
import { latestSequence } from "./event-read.js";
import { insertRow, newId, type Db } from "./index.js";
import { setThreadUserState } from "./thread-user-state.js";
import type { ThreadRow } from "./threads.js";

export type EventSource = "server" | "runner";
type TurnRequestEvent = Extract<
  RunnerThreadEvent,
  { type: "client/turn/requested" }
>;

const DELTA_TYPES: readonly ThreadEventType[] = [
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
  "item/fileChange/outputDelta",
  "item/commandExecution/outputDelta",
];
const DELTA_TYPE_LIST = DELTA_TYPES.map((type) => `'${type}'`).join(", ");
const TERMINAL_ITEM_TYPES: readonly ThreadEventType[] = [
  "item/completed",
  "item/backgroundTask/completed",
];
const ORPHAN_DROPPABLE_TYPES: readonly ThreadEventType[] = [
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
];

function itemFields(event: RunnerThreadEvent) {
  const item = "item" in event ? event.item : null;
  const ownParent =
    item !== null && "parentToolCallId" in item
      ? item.parentToolCallId
      : undefined;
  const parent =
    ownParent ??
    ("parentToolCallId" in event ? event.parentToolCallId : undefined);
  return {
    itemId: item?.id ?? ("itemId" in event ? event.itemId : null),
    itemKind: item?.type ?? null,
    parentToolCallId: parent === undefined || parent === "" ? null : parent,
  };
}

function providerThreadIdOf(event: RunnerThreadEvent) {
  return "providerThreadId" in event &&
    typeof event.providerThreadId === "string"
    ? event.providerThreadId
    : null;
}

function hasTurnEvent(
  db: Db,
  threadId: string,
  turnId: string,
  type: ThreadEventType,
) {
  const row = db.get(
    "SELECT 1 FROM events WHERE thread_id = ? AND turn_id = ? AND type = ?",
    threadId,
    turnId,
    type,
  );
  return row !== undefined;
}

function isItemSettled(db: Db, threadId: string, itemId: string) {
  const latest = db.get<{ type: ThreadEventType }>(
    `SELECT type FROM events
     WHERE thread_id = ? AND item_id = ? AND type IN
       ('item/started', 'item/completed', 'item/backgroundTask/completed')
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
    itemId,
  );
  return latest !== undefined && TERMINAL_ITEM_TYPES.includes(latest.type);
}

function isRedundant(db: Db, threadId: string, event: RunnerThreadEvent) {
  const { type, scope } = event;
  if (type === "turn/diff/updated") return true;
  if (scope.kind === "turn") {
    if (type === "turn/started" || type === "turn/completed") {
      return hasTurnEvent(db, threadId, scope.turnId, type);
    }
    if (
      ORPHAN_DROPPABLE_TYPES.includes(type) &&
      !hasTurnEvent(db, threadId, scope.turnId, "turn/started")
    ) {
      return true;
    }
  }
  const { itemId } = itemFields(event);
  if (itemId === null || !TERMINAL_ITEM_TYPES.includes(type)) return false;
  return isItemSettled(db, threadId, itemId);
}

export function pruneSupersededDeltas(
  db: Db,
  threadId: string,
  itemId: string,
): void {
  db.run(
    `DELETE FROM events
     WHERE thread_id = ? AND item_id = ? AND type IN (${DELTA_TYPE_LIST})
       AND sequence > (
         SELECT MIN(first.sequence) FROM events first
         WHERE first.thread_id = events.thread_id
           AND first.item_id = events.item_id AND first.type = events.type
       )`,
    threadId,
    itemId,
  );
}

export function upsertSearchSegment(
  db: Db,
  threadId: string,
  kind: ThreadSearchSourceKind,
  key: string,
  sequence: number | null,
  text: string | null,
): void {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") {
    db.run(
      `DELETE FROM thread_search_segments
       WHERE thread_id = ? AND source_kind = ? AND source_key = ?`,
      threadId,
      kind,
      key,
    );
    return;
  }
  const at = { createdAt: db.now(), updatedAt: db.now() };
  const id = `${threadId}:${kind}:${key}`;
  const source = { sourceKind: kind, sourceKey: key, sourceSeq: sequence };
  const segment = { id, threadId, ...source, text: trimmed, ...at };
  const identity = ["thread_id", "source_kind", "source_key"];
  insertRow(db, "thread_search_segments", segment, identity);
}

function visiblePromptInput(input: readonly PromptInput[]): PromptInput[] {
  return input.filter((part) => part.visibility !== "agent-only");
}

function visiblePromptText(input: readonly PromptInput[]) {
  return visiblePromptInput(input)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function recordTurnRequest(
  db: Db,
  thread: ThreadRow,
  event: TurnRequestEvent,
  sequence: number,
) {
  const key = `event:${sequence}`;
  const text = visiblePromptText(event.input);
  upsertSearchSegment(db, thread.id, "user_message", key, sequence, text);
  const { actorUserId = null } = event;
  if (actorUserId !== null) {
    const sql = "UPDATE threads SET last_actor_user_id = ? WHERE id = ?";
    db.run(sql, actorUserId, thread.id);
  }
  if (event.initiator !== "user") return;
  const now = db.now();
  const userId = actorUserId ?? OWNER_USER_ID;
  setThreadUserState(db, thread.id, userId, { lastReadAt: now });
  const starts = event.target.kind === "thread-start";
  const input = visiblePromptInput(event.input);
  if (input.length === 0 || (starts && thread.parentThreadId !== null)) return;
  insertRow(db, "prompt_history_entries", {
    id: newId("phist"),
    projectId: thread.projectId,
    threadId: thread.id,
    scope: starts ? "project" : "thread",
    requestSequence: sequence,
    userId,
    input: JSON.stringify(input),
    createdAt: now,
  });
}

function insertEvent(
  db: Db,
  thread: ThreadRow,
  event: RunnerThreadEvent,
  sequence: number,
) {
  const { type, scope, ...data } = event;
  insertRow(db, "events", {
    id: newId("evt"),
    threadId: thread.id,
    environmentId: thread.environmentId,
    scopeKind: scope.kind,
    turnId: scope.kind === "turn" ? scope.turnId : null,
    providerThreadId: providerThreadIdOf(event),
    sequence,
    type,
    ...itemFields(event),
    data: JSON.stringify(data),
    createdAt: db.now(),
  });
  if (type === "client/turn/requested") {
    recordTurnRequest(db, thread, event, sequence);
  } else if (type === "item/completed") {
    pruneSupersededDeltas(db, thread.id, event.item.id);
    if (event.item.type !== "agentMessage") return;
    const key = `event:${sequence}`;
    const { text } = event.item;
    upsertSearchSegment(
      db,
      thread.id,
      "assistant_message",
      key,
      sequence,
      text,
    );
  }
}

export function appendEvents(
  db: Db,
  thread: ThreadRow,
  events: readonly RunnerThreadEvent[],
  source: EventSource,
): RunnerThreadEvent[] {
  return db.transaction(() => {
    let sequence = latestSequence(db, thread.id);
    const stored: RunnerThreadEvent[] = [];
    for (const event of events) {
      if (source === "runner" && isRedundant(db, thread.id, event)) continue;
      sequence += 1;
      insertEvent(db, thread, event, sequence);
      stored.push(event);
    }
    return stored;
  });
}

export function lastSystemErrorMessage(
  db: Db,
  threadId: string,
): string | null {
  const row = db.get<{ message: string | null }>(
    `SELECT json_extract(data, '$.message') AS message FROM events
     WHERE thread_id = ? AND type = 'system/error'
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
  );
  return row?.message ?? null;
}

export function lastSystemError(
  db: Db,
  threadId: string,
): { code: string | null; message: string; detail: string | null } | null {
  const row = db.get<{
    code: string | null;
    message: string | null;
    detail: string | null;
  }>(
    `SELECT json_extract(data, '$.code') AS code,
       json_extract(data, '$.message') AS message,
       json_extract(data, '$.detail') AS detail FROM events
     WHERE thread_id = ? AND type = 'system/error'
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
  );
  if (row === undefined || row.message === null) return null;
  return { code: row.code, message: row.message, detail: row.detail };
}

export function isQueueAutoSendPaused(db: Db, threadId: string): boolean {
  const stop = db.get<{ sequence: number; reason: string | null }>(
    `SELECT sequence, json_extract(data, '$.reason') AS reason FROM events
     WHERE thread_id = ? AND type = 'system/thread/interrupted'
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
  );
  if (stop?.reason !== "manual-stop") return false;
  const later = db.get(
    `SELECT 1 FROM events
     WHERE thread_id = ? AND type = 'client/turn/requested' AND sequence > ?`,
    threadId,
    stop.sequence,
  );
  return later === undefined;
}
