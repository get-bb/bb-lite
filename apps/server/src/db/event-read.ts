import {
  buildThreadEventRow,
  parseStoredThreadEvent,
  type ThreadEvent,
  type ThreadEventItemType,
  type ThreadEventRow,
  type ThreadEventScope,
  type ThreadEventType,
} from "@bb/domain";
import {
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type { Db, SqlValue } from "./index.js";

export interface StoredEventRow {
  id: string;
  threadId: string;
  scopeKind: "thread" | "turn";
  turnId: string | null;
  providerThreadId: string | null;
  sequence: number;
  type: ThreadEventType;
  itemId: string | null;
  itemKind: ThreadEventItemType | null;
  parentToolCallId: string | null;
  data: string;
  createdAt: number;
}

export interface EventQuery {
  threadId: string;
  after?: number;
  before?: number;
  types?: readonly string[];
  turnIds?: readonly string[];
  startedItemIds?: readonly string[];
  parentToolCallIds?: readonly string[];
  requestIds?: readonly string[];
  timeline?: { excludeDiagnostics: boolean; horizon?: number };
  outputs?: "full" | "inline";
  where?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface OrderingContextRow {
  sequence: number;
  turnId: string | null;
  type: ThreadEventType;
  parentToolCallId: string | null;
  requestId: string | null;
  clientRequestId: string | null;
  initiator: string | null;
  expectedTurnId: string | null;
  hasInput: number;
}

export interface BackgroundTaskCounts {
  threadId: string;
  activeWorkflowCount: number;
  activeBackgroundAgentCount: number;
  activeBackgroundCommandCount: number;
}

export const MAX_INLINE_OUTPUT_CHARS = 32_000;
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const DIAGNOSTIC_TYPES = ["provider.env-resolved", "provider/unhandled"];
const DECODED_EVENT_CACHE_LIMIT = 20_000;
const decodedEvents = new WeakMap<Db, Map<string, ThreadEventWithMeta>>();
const META =
  "id, thread_id, scope_kind, turn_id, provider_thread_id, sequence, type, " +
  "item_id, item_kind, parent_tool_call_id, created_at";
const COLUMNS = {
  full: `${META}, data`,
  inline: `${META}, ${inlineOutputData()} AS data`,
};
const IN_LIST = "IN (SELECT value FROM json_each(?))";
const REQUEST_ID = `COALESCE(json_extract(data, '$.clientRequestId'),
  json_extract(data, '$.requestId'))`;
const STARTED_ITEM = `type IN ('item/started', 'item/completed',
  'item/backgroundTask/completed') AND item_id`;
const LIST_FILTERS = [
  ["startedItemIds", STARTED_ITEM, "events_item_lifecycle_idx"],
  ["turnIds", "turn_id", "events_turn_type_item_idx"],
  ["parentToolCallIds", "parent_tool_call_id", "events_parent_tool_call_idx"],
  ["types", "type", "events_type_idx"],
  ["requestIds", REQUEST_ID, null],
] as const;
const NOT_SUPERSEDED_PROGRESS = `NOT (
  events.type = 'item/backgroundTask/progress' AND EXISTS (
    SELECT 1 FROM events AS newer
    WHERE newer.thread_id = events.thread_id
      AND newer.item_kind = 'backgroundTask'
      AND newer.item_id = events.item_id
      AND newer.type IN
        ('item/backgroundTask/progress', 'item/backgroundTask/completed')
      AND newer.sequence > events.sequence AND newer.sequence < ?))`;
const VISIBLE_REQUEST_INPUT = `EXISTS (
  SELECT 1 FROM json_each(events.data, '$.input') AS part
  WHERE COALESCE(json_extract(part.value, '$.visibility'), '') <> 'agent-only'
    AND ((json_extract(part.value, '$.type') = 'text'
        AND COALESCE(json_extract(part.value, '$.text'), '') <> '')
      OR json_extract(part.value, '$.type')
        IN ('image', 'localImage', 'localFile')))`;
export const OPEN_TURN = `NOT EXISTS (SELECT 1 FROM events AS done
  WHERE done.thread_id = events.thread_id AND done.turn_id = events.turn_id
    AND done.type = 'turn/completed')`;
export const ROOT_TURN_EVENT = `turn_id IS NOT NULL
  AND parent_tool_call_id IS NULL AND EXISTS (SELECT 1 FROM events AS root
    WHERE root.thread_id = events.thread_id AND root.turn_id = events.turn_id
      AND root.type = 'turn/started' AND root.parent_tool_call_id IS NULL)`;
export const OUTLINE_EVENT = `(type IN ('client/turn/requested',
    'client/turn/rejected', 'turn/input/accepted', 'turn/started',
    'turn/completed',
    'system/thread/interrupted', 'system/error', 'provider/error',
    'item/agentMessage/delta', 'item/plan/delta')
  OR (type = 'item/completed' AND item_kind IN ('agentMessage', 'plan'))
  OR (item_kind IN ('backgroundTask', 'toolCall')
    AND type IN ('item/started', 'item/completed',
      'item/backgroundTask/progress', 'item/backgroundTask/completed')))`;

function inlineOutputData(): string {
  const max = MAX_INLINE_OUTPUT_CHARS;
  const replacements = ["aggregatedOutput", "result", "resultText"].map(
    (name) => {
      const path = `'$.item.${name}'`;
      const value = `json_extract(data, ${path})`;
      return `CASE WHEN json_type(data, ${path}) = 'text'
        AND length(${value}) > ${max} THEN ${path} ELSE '$.__none__' END,
      substr(${value}, 1, ${max}) || char(10) || '…['
        || printf('%,d', length(${value}) - ${max})
        || ' more characters truncated]'`;
    },
  );
  return `CASE WHEN length(data) <= ${max} THEN data
    ELSE json_replace(data, ${replacements.join(", ")}) END`;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function eventSource(query: EventQuery): { from: string; params: SqlValue[] } {
  const before = query.before ?? UNBOUNDED;
  const where = ["thread_id = ?", "sequence > ?", "sequence < ?"];
  const params: SqlValue[] = [query.threadId, query.after ?? -1, before];
  let index = "";
  for (const [key, column, lookup] of LIST_FILTERS) {
    const values = query[key];
    if (values === undefined) continue;
    const [only] = values;
    const single = values.length === 1 && only !== undefined;
    where.push(single ? `${column} = ?` : `${column} ${IN_LIST}`);
    params.push(single ? only : JSON.stringify(values));
    if (index === "" && lookup !== null) index = `INDEXED BY ${lookup}`;
  }
  if (query.timeline !== undefined) {
    const { excludeDiagnostics, horizon = before } = query.timeline;
    const excluded = [
      ...THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
      ...(excludeDiagnostics ? DIAGNOSTIC_TYPES : []),
    ];
    where.push(`type NOT IN (${quoted(excluded)})`, NOT_SUPERSEDED_PROGRESS);
    params.push(horizon);
  }
  if (query.where !== undefined) where.push(query.where);
  return { from: `events ${index} WHERE ${where.join(" AND ")}`, params };
}

export function listEvents(db: Db, query: EventQuery): StoredEventRow[] {
  const { from, params } = eventSource(query);
  const order = query.order === "desc" ? "DESC" : "ASC";
  return db.all<StoredEventRow>(
    `SELECT ${COLUMNS[query.outputs ?? "full"]} FROM ${from}
     ORDER BY sequence ${order} LIMIT ? OFFSET ?`,
    ...params,
    query.limit ?? -1,
    query.offset ?? 0,
  );
}

export function listTurnIds(db: Db, query: EventQuery): string[] {
  const { from, params } = eventSource(query);
  const sql = `SELECT DISTINCT turn_id FROM ${from}`;
  return db.all<{ turnId: string }>(sql, ...params).map((row) => row.turnId);
}

export function latestSequence(db: Db, threadId: string): number {
  const sql = "SELECT MAX(sequence) AS latest FROM events WHERE thread_id = ?";
  return db.get<{ latest: number | null }>(sql, threadId)?.latest ?? 0;
}

export function contextClearSequence(
  db: Db,
  threadId: string,
  atOrBefore: number,
): number | null {
  const [cleared] = listEvents(db, {
    threadId,
    before: atOrBefore + 1,
    types: ["system/operation"],
    where: `json_extract(data, '$.operation') = 'context_clear'
      AND json_extract(data, '$.status') = 'completed'`,
    order: "desc",
    limit: 1,
  });
  return cleared?.sequence ?? null;
}

export function listLatestItemStates(
  db: Db,
  threadId: string,
  itemIds: readonly string[],
  beforeSequence: number,
): StoredEventRow[] {
  return db.all<StoredEventRow>(
    `SELECT ${COLUMNS.full} FROM events
     WHERE thread_id = :threadId AND sequence IN (
       SELECT MAX(sequence) FROM events
       WHERE thread_id = :threadId AND sequence < :beforeSequence
         AND item_id IN (SELECT value FROM json_each(:itemIds))
         AND type IN ('item/backgroundTask/progress',
           'item/backgroundTask/completed', 'item/delegation/progress',
           'item/delegation/completed')
       GROUP BY item_id)
     ORDER BY sequence`,
    { threadId, beforeSequence, itemIds: JSON.stringify(itemIds) },
  );
}

export function listOpenBackgroundTaskStates(
  db: Db,
  threadId: string,
): StoredEventRow[] {
  return db.all<StoredEventRow>(
    `SELECT ${COLUMNS.full} FROM events
     WHERE thread_id = :threadId
       AND json_extract(data, '$.item.status') = 'pending'
       AND sequence IN (
         SELECT MAX(sequence) FROM events
         WHERE thread_id = :threadId AND item_kind = 'backgroundTask'
           AND item_id IS NOT NULL
           AND type IN ('item/started', 'item/backgroundTask/progress')
         GROUP BY item_id)
       AND item_id NOT IN (
         SELECT item_id FROM events
         WHERE thread_id = :threadId AND item_id IS NOT NULL
           AND type = 'item/backgroundTask/completed')
     ORDER BY sequence`,
    { threadId },
  );
}

export function listHeadStateEvents(
  db: Db,
  threadIds: readonly string[],
  state: "goal" | "todos",
): StoredEventRow[] {
  const matches =
    state === "goal"
      ? `type IN ('thread/goal/updated', 'thread/goal/cleared',
           'thread/extensionState/updated')
         AND (type <> 'thread/extensionState/updated'
           OR json_extract(data, '$.kind') = 'provider-codex/goal')`
      : `type IN ('turn/plan/updated', 'item/completed')
         AND (type = 'turn/plan/updated' OR item_kind = 'planSteps')`;
  return db.all<StoredEventRow>(
    `SELECT ${COLUMNS.full} FROM events
     WHERE (thread_id, sequence) IN (
       SELECT thread_id, MAX(sequence) FROM events
       WHERE thread_id ${IN_LIST} AND (${matches}) GROUP BY thread_id)
     ORDER BY thread_id, sequence`,
    JSON.stringify(threadIds),
  );
}

export function listContextWindowUsageEvents(
  db: Db,
  threadId: string,
  sequenceStart: number,
): StoredEventRow[] {
  const latest = (extra: string): StoredEventRow[] =>
    listEvents(db, {
      threadId,
      after: sequenceStart - 1,
      types: ["thread/contextWindowUsage/updated"],
      where: `NOT EXISTS (SELECT 1 FROM events AS nested
        WHERE nested.thread_id = events.thread_id
          AND nested.turn_id = events.turn_id
          AND nested.type = 'turn/started'
          AND nested.parent_tool_call_id IS NOT NULL) ${extra}`,
      order: "desc",
      limit: 1,
    });
  const size = "json_extract(data, '$.contextWindowUsage.modelContextWindow')";
  return mergeEventRows([...latest(`AND ${size} IS NOT NULL`), ...latest("")]);
}

export function listOrderingContext(
  db: Db,
  threadId: string,
  sequenceStart: number,
  maxSeq: number,
): OrderingContextRow[] {
  return db.all<OrderingContextRow>(
    `SELECT sequence, turn_id, type, parent_tool_call_id,
       json_extract(data, '$.requestId') AS request_id,
       json_extract(data, '$.clientRequestId') AS client_request_id,
       json_extract(data, '$.initiator') AS initiator,
       json_extract(data, '$.target.expectedTurnId') AS expected_turn_id,
       CASE WHEN type = 'client/turn/requested' AND ${VISIBLE_REQUEST_INPUT}
         THEN 1 ELSE 0 END AS has_input
     FROM events INDEXED BY events_type_idx
     WHERE thread_id = ? AND sequence >= ? AND sequence <= ?
       AND type IN ('client/turn/requested', 'turn/input/accepted',
         'turn/started', 'turn/completed')
     ORDER BY sequence`,
    threadId,
    sequenceStart,
    maxSeq,
  );
}

export function firstParentedBoundary(
  db: Db,
  threadId: string,
  sequenceStart: number,
  maxSeq: number,
): number | null {
  const row = db.get<{ sequence: number | null }>(
    `WITH parents AS MATERIALIZED (
       SELECT item_id, turn_id, MIN(sequence) AS start FROM events
       WHERE thread_id = :threadId
         AND type IN ('item/started', 'item/completed')
         AND item_id IN (SELECT parent_tool_call_id FROM events
           WHERE thread_id = :threadId AND parent_tool_call_id IS NOT NULL)
         AND item_kind IN ('toolCall', 'delegation')
         AND parent_tool_call_id IS NULL
         AND sequence >= :sequenceStart AND sequence <= :maxSeq
         AND EXISTS (SELECT 1 FROM events AS root
           WHERE root.thread_id = events.thread_id
             AND root.turn_id = events.turn_id AND root.type = 'turn/started'
             AND root.parent_tool_call_id IS NULL
             AND root.sequence <= :maxSeq)
       GROUP BY item_id, turn_id
     ), spans AS MATERIALIZED (
       SELECT start, (SELECT MAX(child.sequence) FROM events AS child
         WHERE child.thread_id = :threadId
           AND child.parent_tool_call_id = parents.item_id
           AND child.sequence <= :maxSeq) AS finish
       FROM parents
     )
     SELECT MIN(events.sequence) AS sequence
     FROM events INNER JOIN spans
       ON events.sequence > spans.start AND events.sequence < spans.finish
     WHERE events.type = 'client/turn/requested'
       AND events.thread_id = :threadId
       AND ${VISIBLE_REQUEST_INPUT}
       AND json_extract(events.data, '$.initiator') = 'user'
       AND (COALESCE(json_extract(events.data, '$.target.kind'), 'new-turn')
           IN ('thread-start', 'new-turn')
         OR (json_extract(events.data, '$.target.kind') IN ('auto', 'steer')
           AND json_extract(events.data, '$.target.expectedTurnId')
             IS NULL))`,
    { threadId, sequenceStart, maxSeq },
  );
  return row?.sequence ?? null;
}

export function lastOutput(db: Db, threadId: string): string | null {
  const row = db.get<{ text: string }>(
    `SELECT json_extract(data, '$.item.text') AS text FROM events
     WHERE thread_id = ? AND type = 'item/completed'
       AND item_kind = 'agentMessage'
       AND COALESCE(json_extract(data, '$.item.text'), '') <> ''
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
  );
  return row?.text ?? null;
}

export function activeBackgroundTaskCounts(
  db: Db,
  threadIds: readonly string[],
): BackgroundTaskCounts[] {
  const taskType = "json_extract(active.data, '$.item.taskType')";
  const count = (types: string): string =>
    `SUM(CASE WHEN ${taskType} IN (${types}) THEN 1 ELSE 0 END)`;
  return db.all<BackgroundTaskCounts>(
    `WITH latest AS (
       SELECT thread_id, item_id,
         MAX(CASE WHEN type <> 'item/backgroundTask/completed'
           THEN sequence END) AS sequence,
         MAX(type = 'item/backgroundTask/completed') AS completed
       FROM events
       WHERE thread_id ${IN_LIST} AND item_kind = 'backgroundTask'
         AND item_id IS NOT NULL
         AND type IN ('item/started', 'item/backgroundTask/progress',
           'item/backgroundTask/completed')
       GROUP BY thread_id, item_id)
     SELECT active.thread_id,
       ${count("'local_workflow'")} AS active_workflow_count,
       ${count("'local_agent', 'local_subagent'")}
         AS active_background_agent_count,
       ${count("'local_bash'")} AS active_background_command_count
     FROM latest JOIN events AS active
       ON active.thread_id = latest.thread_id
       AND active.sequence = latest.sequence
     WHERE latest.completed = 0
       AND json_extract(active.data, '$.item.status') = 'pending'
       AND COALESCE(json_extract(active.data, '$.item.skipTranscript'), 0) = 0
     GROUP BY active.thread_id`,
    JSON.stringify(threadIds),
  );
}

export function mergeEventRows(
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function eventScope(row: StoredEventRow): ThreadEventScope {
  return row.turnId === null
    ? { kind: "thread" }
    : { kind: "turn", turnId: row.turnId };
}

export function decodeEvent(row: StoredEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    scope: eventScope(row),
  });
}

function decodeEventWithMeta(row: StoredEventRow): ThreadEventWithMeta {
  const { id, sequence: seq, createdAt } = row;
  return { event: decodeEvent(row), meta: { id, seq, createdAt } };
}

export function decodeEvents(
  db: Db,
  rows: readonly StoredEventRow[],
): ThreadEventWithMeta[] {
  const cache = decodedEvents.get(db) ?? new Map<string, ThreadEventWithMeta>();
  decodedEvents.set(db, cache);
  const events = rows.map((row) => {
    const key = `${row.id}:${row.data.length}`;
    const event = cache.get(key) ?? decodeEventWithMeta(row);
    cache.delete(key);
    cache.set(key, event);
    return event;
  });
  for (const oldest of cache.keys()) {
    if (cache.size <= DECODED_EVENT_CACHE_LIMIT) break;
    cache.delete(oldest);
  }
  return events;
}

export function toThreadEventRow(row: StoredEventRow): ThreadEventRow {
  const { id, threadId, sequence: seq, createdAt } = row;
  const scope = eventScope(row);
  const event = decodeEvent(row);
  return buildThreadEventRow({ id, scope, threadId, seq, createdAt, event });
}
