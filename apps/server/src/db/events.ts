import type {
  PromptInput,
  ThreadEventType,
  ThreadSearchSourceKind,
} from "@bb/domain";
import type { RunnerThreadEvent } from "@bb/runner";
import { latestSequence } from "./event-read.js";
import { encodeJson, newId, type Db } from "./index.js";
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
  "provider/unhandled",
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

function providerThreadIdOf(event: RunnerThreadEvent): string | null {
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
): boolean {
  const row = db.get(
    "SELECT 1 FROM events WHERE thread_id = ? AND turn_id = ? AND type = ?",
    threadId,
    turnId,
    type,
  );
  return row !== undefined;
}

function isItemSettled(db: Db, threadId: string, itemId: string): boolean {
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

function isRedundant(
  db: Db,
  threadId: string,
  event: RunnerThreadEvent,
): boolean {
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
  const now = db.now();
  db.run(
    `INSERT INTO thread_search_segments
       (id, thread_id, source_kind, source_key, source_seq, text,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, source_kind, source_key) DO UPDATE
     SET text = excluded.text, updated_at = excluded.updated_at`,
    `${threadId}:${kind}:${key}`,
    threadId,
    kind,
    key,
    sequence,
    trimmed,
    now,
    now,
  );
}

function visiblePromptInput(input: readonly PromptInput[]): PromptInput[] {
  return input.filter((part) => part.visibility !== "agent-only");
}

export function visiblePromptText(input: readonly PromptInput[]): string {
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
): void {
  const key = `event:${sequence}`;
  const text = visiblePromptText(event.input);
  upsertSearchSegment(db, thread.id, "user_message", key, sequence, text);
  if (event.initiator !== "user") return;
  const now = db.now();
  db.run("UPDATE threads SET last_read_at = ? WHERE id = ?", now, thread.id);
  const starts = event.target.kind === "thread-start";
  const input = visiblePromptInput(event.input);
  if (input.length === 0 || (starts && thread.parentThreadId !== null)) return;
  db.run(
    `INSERT INTO prompt_history_entries
       (id, project_id, thread_id, scope, request_sequence, input, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("phist"),
    thread.projectId,
    thread.id,
    starts ? "project" : "thread",
    sequence,
    encodeJson(input),
    now,
  );
}

function insertEvent(
  db: Db,
  thread: ThreadRow,
  event: RunnerThreadEvent,
  sequence: number,
): void {
  const { type, scope, ...data } = event;
  const item = itemFields(event);
  db.run(
    `INSERT INTO events
       (id, thread_id, environment_id, scope_kind, turn_id,
        provider_thread_id, sequence, type, item_id, item_kind,
        parent_tool_call_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("evt"),
    thread.id,
    thread.environmentId,
    scope.kind,
    scope.kind === "turn" ? scope.turnId : null,
    providerThreadIdOf(event),
    sequence,
    type,
    item.itemId,
    item.itemKind,
    item.parentToolCallId,
    encodeJson(data),
    db.now(),
  );
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
