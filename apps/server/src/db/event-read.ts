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
import type { Db, SqlParams, SqlValue } from "./index.js";

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

export interface EventWindow {
  threadId: string;
  sequenceStart: number;
  beforeSequence: number;
  excludeDiagnostics: boolean;
  fullOutputs?: boolean;
}

export interface ScopedItem {
  itemId: string;
  scopeKind: "thread" | "turn";
  turnId: string | null;
}

export interface ItemSpan extends ScopedItem {
  minSequence: number;
  maxSequence: number;
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
export const BUFFERED_TEXT_DELTA_TYPES: readonly string[] = [
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
];
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const DIAGNOSTIC_TYPES = ["provider.env-resolved", "provider/unhandled"];
const INLINE_OUTPUT_PATHS = ["aggregatedOutput", "result", "resultText"];
const META =
  "id, thread_id, scope_kind, turn_id, provider_thread_id, sequence, type, " +
  "item_id, item_kind, parent_tool_call_id, created_at";
const FULL = `${META}, data`;
const INLINE = `${META}, ${inlineOutputData()} AS data`;
const IN_LIST = "(SELECT value FROM json_each(?))";
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

function inlineOutputData(): string {
  const max = MAX_INLINE_OUTPUT_CHARS;
  const replacements = INLINE_OUTPUT_PATHS.map((name) => {
    const path = `'$.item.${name}'`;
    const value = `json_extract(data, ${path})`;
    return `CASE WHEN json_type(data, ${path}) = 'text'
        AND length(${value}) > ${max} THEN ${path} ELSE '$.__none__' END,
      substr(${value}, 1, ${max}) || char(10) || '…['
        || printf('%,d', length(${value}) - ${max})
        || ' more characters truncated]'`;
  });
  return `CASE WHEN length(data) <= ${max} THEN data
    ELSE json_replace(data, ${replacements.join(", ")}) END`;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function jsonList(values: Iterable<string | number>): string {
  return JSON.stringify([...new Set(values)]);
}

function windowWhere(window: EventWindow, horizon = window.beforeSequence) {
  const excluded = [
    ...THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    ...(window.excludeDiagnostics ? DIAGNOSTIC_TYPES : []),
  ];
  const { threadId, sequenceStart, beforeSequence } = window;
  return {
    columns: window.fullOutputs === true ? FULL : INLINE,
    where: `thread_id = ? AND sequence >= ? AND sequence < ?
      AND type NOT IN (${quoted(excluded)}) AND ${NOT_SUPERSEDED_PROGRESS}`,
    params: [threadId, sequenceStart, beforeSequence, horizon] as SqlValue[],
  };
}

function select(
  db: Db,
  columns: string,
  where: string,
  params: SqlParams,
): StoredEventRow[] {
  const sql = `SELECT ${columns} FROM events WHERE ${where} ORDER BY sequence`;
  return db.all<StoredEventRow>(sql, ...params);
}

export function latestSequence(db: Db, threadId: string): number {
  const row = db.get<{ sequence: number | null }>(
    "SELECT MAX(sequence) AS sequence FROM events WHERE thread_id = ?",
    threadId,
  );
  return row?.sequence ?? 0;
}

export function contextClearSequence(
  db: Db,
  threadId: string,
  atOrBefore = UNBOUNDED,
): number | null {
  const row = db.get<{ sequence: number }>(
    `SELECT sequence FROM events
     WHERE thread_id = ? AND type = 'system/operation' AND sequence <= ?
       AND json_extract(data, '$.operation') = 'context_clear'
       AND json_extract(data, '$.status') = 'completed'
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
    atOrBefore,
  );
  return row?.sequence ?? null;
}

export function requestSequencesDescending(
  db: Db,
  window: Omit<EventWindow, "excludeDiagnostics">,
  limit: number,
): number[] {
  const rows = db.all<{ sequence: number }>(
    `SELECT sequence FROM events
     WHERE thread_id = ? AND type = 'client/turn/requested'
       AND sequence >= ? AND sequence < ?
     ORDER BY sequence DESC LIMIT ?`,
    window.threadId,
    window.sequenceStart,
    window.beforeSequence,
    limit,
  );
  return rows.map((row) => row.sequence);
}

export function hasSequence(db: Db, threadId: string, sequence: number) {
  const sql = "SELECT 1 FROM events WHERE thread_id = ? AND sequence = ?";
  return db.get(sql, threadId, sequence) !== undefined;
}

export function windowBudgetFloor(
  db: Db,
  window: EventWindow,
  eventBudget: number,
): number | undefined {
  const { where, params } = windowWhere(window, UNBOUNDED);
  const row = db.get<{ sequence: number }>(
    `SELECT sequence FROM events WHERE ${where}
     ORDER BY sequence DESC LIMIT 1 OFFSET ?`,
    ...params,
    eventBudget,
  );
  return row?.sequence;
}

export function listWindowEvents(
  db: Db,
  window: EventWindow,
  scope: "thread-scoped" | "all",
): StoredEventRow[] {
  const { columns, where, params } = windowWhere(window);
  const scoped = scope === "all" ? where : `${where} AND turn_id IS NULL`;
  return select(db, columns, scoped, params);
}

export function listRootWindowTurnIds(db: Db, window: EventWindow): string[] {
  const { where, params } = windowWhere(window);
  const rows = db.all<{ turnId: string }>(
    `SELECT DISTINCT turn_id FROM events
     WHERE ${where} AND turn_id IS NOT NULL AND parent_tool_call_id IS NULL
       AND EXISTS (SELECT 1 FROM events AS root
         WHERE root.thread_id = events.thread_id
           AND root.turn_id = events.turn_id AND root.type = 'turn/started'
           AND root.parent_tool_call_id IS NULL)`,
    ...params,
  );
  return rows.map((row) => row.turnId);
}

export function listTurnEvents(
  db: Db,
  window: EventWindow,
  turnIds: readonly string[],
): StoredEventRow[] {
  if (turnIds.length === 0) return [];
  const { columns, where, params } = windowWhere(window);
  const scoped = `${where} AND turn_id IN ${IN_LIST}`;
  return select(db, columns, scoped, [...params, jsonList(turnIds)]);
}

export function listChildEvents(
  db: Db,
  window: EventWindow,
  parentToolCallIds: readonly string[],
): StoredEventRow[] {
  if (parentToolCallIds.length === 0) return [];
  const { columns, where, params } = windowWhere(window);
  const scoped = `${where} AND parent_tool_call_id IN ${IN_LIST}`;
  return select(db, columns, scoped, [...params, jsonList(parentToolCallIds)]);
}

export function listDelegatingItemEvents(
  db: Db,
  threadId: string,
  itemIds: readonly string[],
  fullOutputs = false,
): StoredEventRow[] {
  if (itemIds.length === 0) return [];
  return select(
    db,
    fullOutputs ? FULL : INLINE,
    `thread_id = ? AND item_id IN ${IN_LIST}
     AND item_kind IN ('toolCall', 'delegation')
     AND type IN ('item/started', 'item/completed')`,
    [threadId, jsonList(itemIds)],
  );
}

export function listBackgroundTaskStates(
  db: Db,
  threadId: string,
  itemIds: readonly string[],
  beforeSequence: number,
): StoredEventRow[] {
  if (itemIds.length === 0) return [];
  return select(
    db,
    FULL,
    `thread_id = :threadId AND sequence IN (
       SELECT MAX(sequence) FROM events
       WHERE thread_id = :threadId AND sequence < :beforeSequence
         AND item_id IN (SELECT value FROM json_each(:itemIds))
         AND type IN ('item/backgroundTask/progress',
           'item/backgroundTask/completed', 'item/delegation/progress',
           'item/delegation/completed')
       GROUP BY item_id)`,
    [{ threadId, beforeSequence, itemIds: jsonList(itemIds) }],
  );
}

export function listOpenBackgroundTaskStates(
  db: Db,
  threadId: string,
): StoredEventRow[] {
  return select(
    db,
    FULL,
    `thread_id = :threadId
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
         AND type = 'item/backgroundTask/completed')`,
    [{ threadId }],
  );
}

export interface ListEventsArgs {
  threadId: string;
  afterSequence?: number;
  beforeSequence?: number;
  types?: readonly ThreadEventType[];
  limit?: number;
  order?: "asc" | "desc";
}

export function listEvents(db: Db, args: ListEventsArgs): StoredEventRow[] {
  const typed = args.types === undefined ? "" : `AND type IN ${IN_LIST}`;
  const order = args.order === "desc" ? "DESC" : "ASC";
  return db.all<StoredEventRow>(
    `SELECT ${FULL} FROM events
     WHERE thread_id = ? AND sequence > ? AND sequence < ? ${typed}
     ORDER BY sequence ${order} LIMIT ?`,
    args.threadId,
    args.afterSequence ?? -1,
    args.beforeSequence ?? UNBOUNDED,
    ...(args.types === undefined ? [] : [jsonList(args.types)]),
    args.limit ?? -1,
  );
}

export function listTurnRequestsByIds(
  db: Db,
  threadId: string,
  requestIds: readonly string[],
): StoredEventRow[] {
  if (requestIds.length === 0) return [];
  return select(
    db,
    FULL,
    `thread_id = ? AND type = 'client/turn/requested'
     AND json_extract(data, '$.requestId') IN ${IN_LIST}`,
    [threadId, jsonList(requestIds)],
  );
}

export function listRequestOutcomes(
  db: Db,
  threadId: string,
  requestIds: readonly string[],
  afterSequence: number,
  types = ["turn/input/accepted", "client/turn/rejected"],
): StoredEventRow[] {
  if (requestIds.length === 0) return [];
  return select(
    db,
    FULL,
    `thread_id = ? AND sequence > ? AND type IN (${quoted(types)})
     AND COALESCE(json_extract(data, '$.clientRequestId'),
       json_extract(data, '$.requestId')) IN ${IN_LIST}`,
    [threadId, afterSequence, jsonList(requestIds)],
  );
}

export function listTurnStarts(
  db: Db,
  threadId: string,
  turnIds: readonly string[],
  sequenceCutoff: number,
): StoredEventRow[] {
  if (turnIds.length === 0) return [];
  return select(
    db,
    FULL,
    `thread_id = ? AND type = 'turn/started' AND sequence <= ?
     AND turn_id IN ${IN_LIST}`,
    [threadId, sequenceCutoff, jsonList(turnIds)],
  );
}

export function listGoalStateEvents(
  db: Db,
  threadIds: readonly string[],
): StoredEventRow[] {
  if (threadIds.length === 0) return [];
  const goalState = `type IN ('thread/goal/updated', 'thread/goal/cleared')
    OR (type = 'thread/extensionState/updated'
      AND json_extract(data, '$.kind') = 'provider-codex/goal')`;
  return db.all<StoredEventRow>(
    `SELECT ${FULL} FROM events
     WHERE (thread_id, sequence) IN (
       SELECT thread_id, MAX(sequence) FROM events
       WHERE thread_id IN ${IN_LIST} AND (${goalState})
       GROUP BY thread_id)
     ORDER BY thread_id, sequence`,
    jsonList(threadIds),
  );
}

export function listTodoSnapshotEvents(
  db: Db,
  threadId: string,
): StoredEventRow[] {
  return db.all<StoredEventRow>(
    `SELECT ${FULL} FROM events
     WHERE thread_id = ? AND (type = 'turn/plan/updated'
       OR (item_kind = 'planSteps' AND type = 'item/completed'))
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
  );
}

export function listContextWindowUsageEvents(
  db: Db,
  threadId: string,
  sequenceStart: number,
): StoredEventRow[] {
  const windowSize =
    "json_extract(data, '$.contextWindowUsage.modelContextWindow')";
  const latest = (extra: string): StoredEventRow | undefined =>
    db.get<StoredEventRow>(
      `SELECT ${FULL} FROM events
       WHERE thread_id = ? AND sequence >= ?
         AND type = 'thread/contextWindowUsage/updated'
         AND NOT EXISTS (SELECT 1 FROM events AS nested
           WHERE nested.thread_id = events.thread_id
             AND nested.turn_id = events.turn_id
             AND nested.type = 'turn/started'
             AND nested.parent_tool_call_id IS NOT NULL)
         ${extra}
       ORDER BY sequence DESC LIMIT 1`,
      threadId,
      sequenceStart,
    );
  const newest = latest("");
  if (newest === undefined) return [];
  const sized = latest(`AND ${windowSize} IS NOT NULL`);
  return sized === undefined || sized.id === newest.id
    ? [newest]
    : [sized, newest];
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
     FROM events
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

export function listRequestIdsInRange(
  db: Db,
  threadId: string,
  sequenceStart: number,
  sequenceEnd: number,
): string[] {
  const rows = db.all<{ requestId: string }>(
    `SELECT json_extract(data, '$.requestId') AS request_id FROM events
     WHERE thread_id = ? AND type = 'client/turn/requested'
       AND sequence >= ? AND sequence <= ? ORDER BY sequence`,
    threadId,
    sequenceStart,
    sequenceEnd,
  );
  return rows.map((row) => row.requestId);
}

export function scopedItemKey(item: ScopedItem): string {
  return `${item.scopeKind}\u0000${item.turnId ?? ""}\u0000${item.itemId}`;
}

export function listItemSpans(
  db: Db,
  threadId: string,
  items: readonly ScopedItem[],
): ItemSpan[] {
  if (items.length === 0) return [];
  const keys = new Set(items.map(scopedItemKey));
  const spans = db.all<ItemSpan>(
    `SELECT item_id, scope_kind, turn_id, MIN(sequence) AS min_sequence,
       MAX(sequence) AS max_sequence
     FROM events
     WHERE thread_id = ? AND item_id IN ${IN_LIST} AND type LIKE 'item/%'
     GROUP BY scope_kind, turn_id, item_id`,
    threadId,
    jsonList(items.map((item) => item.itemId)),
  );
  return spans.filter((span) => keys.has(scopedItemKey(span)));
}

export function listItemEvents(
  db: Db,
  threadId: string,
  items: readonly ScopedItem[],
  kind: "lifecycle" | "text-deltas",
  beforeSequence: number,
  fullOutputs = true,
): StoredEventRow[] {
  if (items.length === 0) return [];
  const keys = new Set(items.map(scopedItemKey));
  const types =
    kind === "lifecycle"
      ? ["item/started", "item/completed"]
      : BUFFERED_TEXT_DELTA_TYPES;
  const rows = select(
    db,
    fullOutputs ? FULL : INLINE,
    `thread_id = ? AND sequence < ? AND item_id IN ${IN_LIST}
     AND type IN (${quoted(types)})`,
    [threadId, beforeSequence, jsonList(items.map((item) => item.itemId))],
  );
  return rows.filter((row) => keys.has(scopedItemKey(eventItem(row))));
}

export function eventItem(row: StoredEventRow): ScopedItem {
  const { scopeKind, turnId } = row;
  return { itemId: row.itemId ?? "", scopeKind, turnId };
}

const OUTLINE_STRUCTURAL_DATA = `CASE item_kind
  WHEN 'toolCall' THEN json_remove(data, '$.item.arguments', '$.item.result',
    '$.item.error', '$.item.durationMs', '$.item.truncation')
  WHEN 'backgroundTask' THEN json_remove(data, '$.item.workflow',
    '$.item.usage', '$.item.summary', '$.item.error', '$.item.outputFile')
  ELSE data END`;

export function listOutlineEvents(
  db: Db,
  threadId: string,
  sequenceStart: number,
): StoredEventRow[] {
  const conversation = select(
    db,
    FULL,
    `thread_id = ? AND sequence >= ? AND (type IN ('client/turn/requested',
       'turn/input/accepted', 'turn/started', 'turn/completed',
       'system/thread/interrupted', 'system/error', 'provider/error',
       'item/agentMessage/delta', 'item/plan/delta')
     OR (type = 'item/completed' AND item_kind IN ('agentMessage', 'plan')))`,
    [threadId, sequenceStart],
  );
  const structural = select(
    db,
    `${META}, ${OUTLINE_STRUCTURAL_DATA} AS data`,
    `thread_id = ? AND sequence >= ?
     AND type IN ('item/started', 'item/completed',
       'item/backgroundTask/progress', 'item/backgroundTask/completed')
     AND item_kind IN ('backgroundTask', 'toolCall')
     AND (type = 'item/started'
       OR json_extract(data, '$.item.status') <> 'completed'
       OR NOT EXISTS (SELECT 1 FROM events AS earlier
         WHERE earlier.thread_id = events.thread_id
           AND earlier.item_id = events.item_id
           AND earlier.type = 'item/started'
           AND earlier.item_kind = events.item_kind
           AND earlier.sequence < events.sequence))
     AND ${NOT_SUPERSEDED_PROGRESS}`,
    [threadId, sequenceStart, UNBOUNDED],
  );
  return mergeEventRows([...conversation, ...structural]);
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

export function listOpenAcceptedInputs(
  db: Db,
  threadIds: readonly string[],
): StoredEventRow[] {
  if (threadIds.length === 0) return [];
  return db.all<StoredEventRow>(
    `SELECT ${FULL} FROM events
     WHERE thread_id IN ${IN_LIST} AND type = 'turn/input/accepted'
       AND NOT EXISTS (SELECT 1 FROM events AS done
         WHERE done.thread_id = events.thread_id
           AND done.turn_id = events.turn_id AND done.type = 'turn/completed')
     ORDER BY thread_id, sequence`,
    jsonList(threadIds),
  );
}

export function activeBackgroundTaskCounts(
  db: Db,
  threadIds: readonly string[],
): BackgroundTaskCounts[] {
  if (threadIds.length === 0) return [];
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
       WHERE thread_id IN ${IN_LIST} AND item_kind = 'backgroundTask'
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
    jsonList(threadIds),
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

export function decodeEventWithMeta(row: StoredEventRow): ThreadEventWithMeta {
  const { id, sequence: seq, createdAt } = row;
  return { event: decodeEvent(row), meta: { id, seq, createdAt } };
}

export function toThreadEventRow(row: StoredEventRow): ThreadEventRow {
  const { id, threadId, sequence: seq, createdAt } = row;
  const scope = eventScope(row);
  const event = decodeEvent(row);
  return buildThreadEventRow({ id, scope, threadId, seq, createdAt, event });
}
