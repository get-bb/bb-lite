use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Weak};

use indexmap::IndexMap;
use parking_lot::Mutex;
use rusqlite::named_params;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Db, DbResult, Inner};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEventRow {
    pub id: String,
    pub thread_id: String,
    pub scope_kind: String,
    pub turn_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub item_id: Option<String>,
    pub item_kind: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub data: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EventOutputs {
    #[default]
    Full,
    Inline,
}

impl EventOutputs {
    fn key(self) -> &'static str {
        match self {
            EventOutputs::Full => "full",
            EventOutputs::Inline => "inline",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SortOrder {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimelineFilter {
    pub exclude_diagnostics: bool,
    pub horizon: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventQuery {
    pub thread_id: String,
    pub after: Option<i64>,
    pub before: Option<i64>,
    pub types: Option<Vec<String>>,
    pub turn_ids: Option<Vec<String>>,
    pub started_item_ids: Option<Vec<String>>,
    pub parent_tool_call_ids: Option<Vec<String>>,
    pub request_ids: Option<Vec<String>>,
    pub timeline: Option<TimelineFilter>,
    pub outputs: Option<EventOutputs>,
    /// Extra SQL condition ANDed into the WHERE clause (`where` in TypeScript).
    pub where_sql: Option<String>,
    pub order: Option<SortOrder>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

impl EventQuery {
    pub fn new(thread_id: impl Into<String>) -> Self {
        EventQuery { thread_id: thread_id.into(), ..EventQuery::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderingContextRow {
    pub sequence: i64,
    pub turn_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub parent_tool_call_id: Option<String>,
    pub request_id: Option<String>,
    pub client_request_id: Option<String>,
    pub initiator: Option<String>,
    pub expected_turn_id: Option<String>,
    pub has_input: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskCounts {
    pub thread_id: String,
    pub active_workflow_count: i64,
    pub active_background_agent_count: i64,
    pub active_background_command_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMeta {
    pub id: String,
    pub seq: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventWithMeta {
    pub event: Value,
    pub meta: EventMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventRow {
    pub id: String,
    pub scope: Value,
    pub thread_id: String,
    pub seq: i64,
    pub created_at: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadState {
    Goal,
    Todos,
}

pub const THREAD_TIMELINE_EXCLUDED_EVENT_TYPES: [&str; 5] = [
    "thread/started",
    "thread/identity",
    "thread/contextWindowUsage/updated",
    "thread/tokenUsage/updated",
    "turn/diff/updated",
];
pub const MAX_INLINE_OUTPUT_CHARS: i64 = 32_000;
pub const UNBOUNDED: i64 = 9_007_199_254_740_991;
pub const DIAGNOSTIC_TYPES: [&str; 1] = ["provider.env-resolved"];
pub const DECODED_EVENT_CACHE_LIMIT: usize = 20_000;
pub const KEPT_ROWS_MAX_CHARS: usize = 24_000_000;
pub const META: &str = "id, thread_id, scope_kind, turn_id, provider_thread_id, sequence, type, \
                        item_id, item_kind, parent_tool_call_id, created_at";
pub const FULL_COLUMNS: &str = "id, thread_id, scope_kind, turn_id, provider_thread_id, sequence, \
                                type, item_id, item_kind, parent_tool_call_id, created_at, data";
pub static INLINE_COLUMNS: LazyLock<String> =
    LazyLock::new(|| format!("{META}, {} AS data", inline_output_data()));
pub const IN_LIST: &str = "IN (SELECT value FROM json_each(?))";
pub const REQUEST_ID: &str = "COALESCE(json_extract(data, '$.clientRequestId'),
  json_extract(data, '$.requestId'))";
pub const STARTED_ITEM: &str = "type IN ('item/started', 'item/completed',
  'item/backgroundTask/completed') AND item_id";
pub const NOT_SUPERSEDED_PROGRESS: &str = "NOT (
  events.type = 'item/backgroundTask/progress' AND EXISTS (
    SELECT 1 FROM events AS newer
    WHERE newer.thread_id = events.thread_id
      AND newer.item_kind = 'backgroundTask'
      AND newer.item_id = events.item_id
      AND newer.type IN
        ('item/backgroundTask/progress', 'item/backgroundTask/completed')
      AND newer.sequence > events.sequence AND newer.sequence < ?))";
pub const VISIBLE_REQUEST_INPUT: &str = "EXISTS (
  SELECT 1 FROM json_each(events.data, '$.input') AS part
  WHERE COALESCE(json_extract(part.value, '$.visibility'), '') <> 'agent-only'
    AND ((json_extract(part.value, '$.type') = 'text'
        AND COALESCE(json_extract(part.value, '$.text'), '') <> '')
      OR json_extract(part.value, '$.type')
        IN ('image', 'localImage', 'localFile')))";
pub const ROOT_TURN_EVENT: &str = "turn_id IS NOT NULL
  AND parent_tool_call_id IS NULL AND EXISTS (SELECT 1 FROM events AS root
    WHERE root.thread_id = events.thread_id AND root.turn_id = events.turn_id
      AND root.type = 'turn/started' AND root.parent_tool_call_id IS NULL)";

pub fn inline_output_data() -> String {
    let max = MAX_INLINE_OUTPUT_CHARS;
    let replacements: Vec<String> = ["aggregatedOutput", "result", "resultText"]
        .iter()
        .map(|name| {
            let path = format!("'$.item.{name}'");
            let value = format!("json_extract(data, {path})");
            format!(
                "CASE WHEN json_type(data, {path}) = 'text'
        AND length({value}) > {max} THEN {path} ELSE '$.__none__' END,
      substr({value}, 1, {max}) || char(10) || '…['
        || printf('%,d', length({value}) - {max})
        || ' more characters truncated]'"
            )
        })
        .collect();
    format!(
        "CASE WHEN length(data) <= {max} THEN data
    ELSE json_replace(data, {}) END",
        replacements.join(", ")
    )
}

fn columns(outputs: EventOutputs) -> &'static str {
    match outputs {
        EventOutputs::Full => FULL_COLUMNS,
        EventOutputs::Inline => INLINE_COLUMNS.as_str(),
    }
}

fn quoted(values: &[&str]) -> String {
    values.iter().map(|value| format!("'{value}'")).collect::<Vec<_>>().join(", ")
}

type ListFilter<'a> = (Option<&'a Vec<String>>, &'static str, Option<&'static str>);

fn list_filters(query: &EventQuery) -> [ListFilter<'_>; 5] {
    [
        (query.started_item_ids.as_ref(), STARTED_ITEM, Some("events_item_lifecycle_idx")),
        (query.turn_ids.as_ref(), "turn_id", Some("events_turn_type_item_idx")),
        (
            query.parent_tool_call_ids.as_ref(),
            "parent_tool_call_id",
            Some("events_parent_tool_call_idx"),
        ),
        (query.types.as_ref(), "type", Some("events_type_idx")),
        (query.request_ids.as_ref(), REQUEST_ID, None),
    ]
}

fn event_source(query: &EventQuery) -> (String, Vec<SqlValue>) {
    let before = query.before.unwrap_or(UNBOUNDED);
    let mut clauses: Vec<String> =
        vec!["thread_id = ?".into(), "sequence > ?".into(), "sequence < ?".into()];
    let mut params: Vec<SqlValue> = vec![
        SqlValue::Text(query.thread_id.clone()),
        SqlValue::Integer(query.after.unwrap_or(-1)),
        SqlValue::Integer(before),
    ];
    let mut index = String::new();
    for (values, column, lookup) in list_filters(query) {
        let Some(values) = values else { continue };
        if let [only] = values.as_slice() {
            clauses.push(format!("{column} = ?"));
            params.push(SqlValue::Text(only.clone()));
        } else {
            clauses.push(format!("{column} {IN_LIST}"));
            params.push(SqlValue::Text(json!(values).to_string()));
        }
        if let (true, Some(lookup)) = (index.is_empty(), lookup) {
            index = format!("INDEXED BY {lookup}");
        }
    }
    if let Some(timeline) = query.timeline {
        let horizon = timeline.horizon.unwrap_or(before);
        let mut excluded: Vec<&str> = THREAD_TIMELINE_EXCLUDED_EVENT_TYPES.to_vec();
        excluded.push("provider/unhandled");
        if timeline.exclude_diagnostics {
            excluded.extend(DIAGNOSTIC_TYPES);
        }
        clauses.push(format!("type NOT IN ({})", quoted(&excluded)));
        clauses.push(NOT_SUPERSEDED_PROGRESS.into());
        params.push(SqlValue::Integer(horizon));
    }
    if let Some(extra) = &query.where_sql {
        clauses.push(extra.clone());
    }
    (format!("events {index} WHERE {}", clauses.join(" AND ")), params)
}

#[derive(Default)]
struct KeptRows {
    rows: HashMap<String, StoredEventRow>,
    chars: usize,
}

struct DbCaches {
    kept: Mutex<KeptRows>,
    decoded: RecentCache<EventWithMeta>,
}

type CacheRegistry = Mutex<Vec<(Weak<Inner>, Arc<DbCaches>)>>;

fn db_caches(db: &Db) -> Arc<DbCaches> {
    static REGISTRY: LazyLock<CacheRegistry> = LazyLock::new(|| Mutex::new(Vec::new()));
    let mut registry = REGISTRY.lock();
    registry.retain(|(owner, _)| owner.strong_count() > 0);
    let target = Arc::as_ptr(&db.inner);
    if let Some((_, caches)) = registry.iter().find(|(owner, _)| owner.as_ptr() == target) {
        return caches.clone();
    }
    let caches = Arc::new(DbCaches {
        kept: Mutex::new(KeptRows::default()),
        decoded: RecentCache::new(DECODED_EVENT_CACHE_LIMIT),
    });
    registry.push((Arc::downgrade(&db.inner), caches.clone()));
    caches
}

pub fn list_events(db: &Db, query: &EventQuery) -> DbResult<Vec<StoredEventRow>> {
    #[derive(Deserialize)]
    struct Found {
        id: String,
    }
    let (from, mut params) = event_source(query);
    let order = if query.order == Some(SortOrder::Desc) { "DESC" } else { "ASC" };
    let outputs = query.outputs.unwrap_or_default();
    params.push(SqlValue::Integer(query.limit.unwrap_or(-1)));
    params.push(SqlValue::Integer(query.offset.unwrap_or(0)));
    let sql = format!("SELECT id FROM {from} ORDER BY sequence {order} LIMIT ? OFFSET ?");
    let found: Vec<Found> = db.all(&sql, rusqlite::params_from_iter(params))?;
    let caches = db_caches(db);
    let keys: Vec<String> =
        found.iter().map(|row| format!("{}:{}", outputs.key(), row.id)).collect();
    let missing: Vec<&str> = {
        let kept = caches.kept.lock();
        found
            .iter()
            .zip(&keys)
            .filter(|(_, key)| !kept.rows.contains_key(*key))
            .map(|(row, _)| row.id.as_str())
            .collect()
    };
    let fetched: Vec<StoredEventRow> = if missing.is_empty() {
        Vec::new()
    } else {
        let sql = format!("SELECT {} FROM events WHERE id {IN_LIST}", columns(outputs));
        db.all(&sql, [json!(missing).to_string()])?
    };
    let mut kept = caches.kept.lock();
    for row in fetched {
        kept.chars += row.data.len();
        kept.rows.insert(format!("{}:{}", outputs.key(), row.id), row);
    }
    let rows = keys.iter().filter_map(|key| kept.rows.get(key).cloned()).collect();
    if kept.chars > KEPT_ROWS_MAX_CHARS {
        *kept = KeptRows::default();
    }
    Ok(rows)
}

pub fn list_turn_ids(db: &Db, query: &EventQuery) -> DbResult<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TurnRow {
        turn_id: Option<String>,
    }
    let (from, params) = event_source(query);
    let sql = format!("SELECT DISTINCT turn_id FROM {from}");
    let rows: Vec<TurnRow> = db.all(&sql, rusqlite::params_from_iter(params))?;
    Ok(rows.into_iter().filter_map(|row| row.turn_id).collect())
}

pub fn latest_sequence(db: &Db, thread_id: &str) -> DbResult<i64> {
    let sql = "SELECT MAX(sequence) AS latest FROM events WHERE thread_id = ?";
    Ok(db.scalar::<Option<i64>>(sql, [thread_id])?.flatten().unwrap_or(0))
}

pub fn context_clear_sequence(
    db: &Db,
    thread_id: &str,
    at_or_before: i64,
) -> DbResult<Option<i64>> {
    let cleared = list_events(
        db,
        &EventQuery {
            before: Some(at_or_before + 1),
            types: Some(vec!["system/operation".into()]),
            where_sql: Some(
                "json_extract(data, '$.operation') = 'context_clear'
      AND json_extract(data, '$.status') = 'completed'"
                    .into(),
            ),
            order: Some(SortOrder::Desc),
            limit: Some(1),
            ..EventQuery::new(thread_id)
        },
    )?;
    Ok(cleared.first().map(|row| row.sequence))
}

pub fn list_latest_item_states(
    db: &Db,
    thread_id: &str,
    item_ids: &[String],
    before_sequence: i64,
) -> DbResult<Vec<StoredEventRow>> {
    let sql = format!(
        "SELECT {FULL_COLUMNS} FROM events
     WHERE thread_id = :threadId AND sequence IN (
       SELECT MAX(sequence) FROM events
       WHERE thread_id = :threadId AND sequence < :beforeSequence
         AND item_id IN (SELECT value FROM json_each(:itemIds))
         AND type IN ('item/backgroundTask/progress',
           'item/backgroundTask/completed', 'item/delegation/progress',
           'item/delegation/completed')
       GROUP BY item_id)
     ORDER BY sequence"
    );
    let item_ids = json!(item_ids).to_string();
    db.all(
        &sql,
        named_params! {
            ":threadId": thread_id,
            ":beforeSequence": before_sequence,
            ":itemIds": item_ids,
        },
    )
}

pub fn list_open_background_task_states(db: &Db, thread_id: &str) -> DbResult<Vec<StoredEventRow>> {
    let sql = format!(
        "SELECT {FULL_COLUMNS} FROM events
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
     ORDER BY sequence"
    );
    db.all(&sql, named_params! { ":threadId": thread_id })
}

pub fn list_head_state_events(
    db: &Db,
    thread_ids: &[String],
    state: HeadState,
) -> DbResult<Vec<StoredEventRow>> {
    let matches = match state {
        HeadState::Goal => {
            "type IN ('thread/goal/updated', 'thread/goal/cleared',
           'thread/extensionState/updated')
         AND (type <> 'thread/extensionState/updated'
           OR json_extract(data, '$.kind') = 'provider-codex/goal')"
        }
        HeadState::Todos => {
            "type IN ('turn/plan/updated', 'item/completed')
         AND (type = 'turn/plan/updated' OR item_kind = 'planSteps')"
        }
    };
    let sql = format!(
        "SELECT {FULL_COLUMNS} FROM events
     WHERE (thread_id, sequence) IN (
       SELECT thread_id, MAX(sequence) FROM events
       WHERE thread_id {IN_LIST} AND ({matches}) GROUP BY thread_id)
     ORDER BY thread_id, sequence"
    );
    db.all(&sql, [json!(thread_ids).to_string()])
}

pub fn list_context_window_usage_events(
    db: &Db,
    thread_id: &str,
    sequence_start: i64,
) -> DbResult<Vec<StoredEventRow>> {
    let latest = |extra: &str| {
        list_events(
            db,
            &EventQuery {
                after: Some(sequence_start - 1),
                types: Some(vec!["thread/contextWindowUsage/updated".into()]),
                where_sql: Some(format!(
                    "NOT EXISTS (SELECT 1 FROM events AS nested
        WHERE nested.thread_id = events.thread_id
          AND nested.turn_id = events.turn_id
          AND nested.type = 'turn/started'
          AND nested.parent_tool_call_id IS NOT NULL) {extra}"
                )),
                order: Some(SortOrder::Desc),
                limit: Some(1),
                ..EventQuery::new(thread_id)
            },
        )
    };
    let size = "json_extract(data, '$.contextWindowUsage.modelContextWindow')";
    let mut rows = latest(&format!("AND {size} IS NOT NULL"))?;
    rows.extend(latest("")?);
    Ok(merge_event_rows(rows))
}

pub fn list_ordering_context(
    db: &Db,
    thread_id: &str,
    sequence_start: i64,
    max_seq: i64,
) -> DbResult<Vec<OrderingContextRow>> {
    let sql = format!(
        "SELECT sequence, turn_id, type, parent_tool_call_id,
       json_extract(data, '$.requestId') AS request_id,
       json_extract(data, '$.clientRequestId') AS client_request_id,
       json_extract(data, '$.initiator') AS initiator,
       json_extract(data, '$.target.expectedTurnId') AS expected_turn_id,
       CASE WHEN type = 'client/turn/requested' AND {VISIBLE_REQUEST_INPUT}
         THEN 1 ELSE 0 END AS has_input
     FROM events INDEXED BY events_type_idx
     WHERE thread_id = ? AND sequence >= ? AND sequence <= ?
       AND type IN ('client/turn/requested', 'turn/input/accepted',
         'turn/started', 'turn/completed')
     ORDER BY sequence"
    );
    db.all(&sql, rusqlite::params![thread_id, sequence_start, max_seq])
}

pub fn first_parented_boundary(
    db: &Db,
    thread_id: &str,
    sequence_start: i64,
    max_seq: i64,
) -> DbResult<Option<i64>> {
    let sql = format!(
        "WITH parents AS MATERIALIZED (
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
       AND {VISIBLE_REQUEST_INPUT}
       AND json_extract(events.data, '$.initiator') = 'user'
       AND (COALESCE(json_extract(events.data, '$.target.kind'), 'new-turn')
           IN ('thread-start', 'new-turn')
         OR (json_extract(events.data, '$.target.kind') IN ('auto', 'steer')
           AND json_extract(events.data, '$.target.expectedTurnId')
             IS NULL))"
    );
    let params = named_params! {
        ":threadId": thread_id,
        ":sequenceStart": sequence_start,
        ":maxSeq": max_seq,
    };
    Ok(db.scalar::<Option<i64>>(&sql, params)?.flatten())
}

pub fn last_output(db: &Db, thread_id: &str) -> DbResult<Option<String>> {
    let sql = "SELECT json_extract(data, '$.item.text') AS text FROM events
     WHERE thread_id = ? AND type = 'item/completed'
       AND item_kind = 'agentMessage'
       AND COALESCE(json_extract(data, '$.item.text'), '') <> ''
     ORDER BY sequence DESC LIMIT 1";
    let row = db.rows(sql, [thread_id])?.into_iter().next();
    Ok(row.and_then(|mut row| match row.remove("text") {
        Some(Value::String(text)) => Some(text),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }))
}

pub fn active_background_task_counts(
    db: &Db,
    thread_ids: &[String],
) -> DbResult<Vec<BackgroundTaskCounts>> {
    let task_type = "json_extract(active.data, '$.item.taskType')";
    let count = |types: &str| format!("SUM(CASE WHEN {task_type} IN ({types}) THEN 1 ELSE 0 END)");
    let sql = format!(
        "WITH latest AS (
       SELECT thread_id, item_id,
         MAX(CASE WHEN type <> 'item/backgroundTask/completed'
           THEN sequence END) AS sequence,
         MAX(type = 'item/backgroundTask/completed') AS completed
       FROM events
       WHERE thread_id {IN_LIST} AND item_kind = 'backgroundTask'
         AND item_id IS NOT NULL
         AND type IN ('item/started', 'item/backgroundTask/progress',
           'item/backgroundTask/completed')
       GROUP BY thread_id, item_id)
     SELECT active.thread_id,
       {} AS active_workflow_count,
       {}
         AS active_background_agent_count,
       {} AS active_background_command_count
     FROM latest JOIN events AS active
       ON active.thread_id = latest.thread_id
       AND active.sequence = latest.sequence
     WHERE latest.completed = 0
       AND json_extract(active.data, '$.item.status') = 'pending'
       AND COALESCE(json_extract(active.data, '$.item.skipTranscript'), 0) = 0
     GROUP BY active.thread_id",
        count("'local_workflow'"),
        count("'local_agent', 'local_subagent'"),
        count("'local_bash'"),
    );
    db.all(&sql, [json!(thread_ids).to_string()])
}

pub fn merge_event_rows(rows: impl IntoIterator<Item = StoredEventRow>) -> Vec<StoredEventRow> {
    let mut by_id: IndexMap<String, StoredEventRow> = IndexMap::new();
    for row in rows {
        by_id.insert(row.id.clone(), row);
    }
    let mut merged: Vec<StoredEventRow> = by_id.into_values().collect();
    merged.sort_by_key(|row| row.sequence);
    merged
}

fn event_scope(row: &StoredEventRow) -> Value {
    match &row.turn_id {
        None => json!({ "kind": "thread" }),
        Some(turn_id) => json!({ "kind": "turn", "turnId": turn_id }),
    }
}

/// Decodes a stored row into the event object the TypeScript zod parse yields:
/// legacy shapes upgraded, turn-request defaults filled, envelope columns merged.
/// Never fails; data the schema would reject is returned as stored.
pub fn decode_event(row: &StoredEventRow) -> Value {
    let data = match serde_json::from_str::<Value>(&row.data) {
        Ok(Value::Object(data)) => data,
        _ => Map::new(),
    };
    let (event_type, mut data) =
        convert_legacy_stored_thread_event(&row.event_type, data, row.turn_id.as_deref());
    if event_type == "client/turn/requested" {
        apply_turn_request_defaults(&mut data);
    }
    data.shift_remove("scope");
    data.shift_remove("turnId");
    if let Some(provider_thread_id) = &row.provider_thread_id {
        data.insert("providerThreadId".into(), Value::String(provider_thread_id.clone()));
    }
    data.insert("scope".into(), event_scope(row));
    data.insert("threadId".into(), Value::String(row.thread_id.clone()));
    data.insert("type".into(), Value::String(event_type));
    Value::Object(data)
}

fn decode_event_with_meta(row: &StoredEventRow) -> EventWithMeta {
    EventWithMeta {
        event: decode_event(row),
        meta: EventMeta { id: row.id.clone(), seq: row.sequence, created_at: row.created_at },
    }
}

/// What this database's event caches hold, for the memory diagnostics.
pub fn cache_memory(db: &Db) -> Value {
    let caches = db_caches(db);
    let decoded = caches.decoded.values();
    let decoded_bytes: usize =
        decoded.iter().map(|entry| crate::diagnostics::approx_heap_bytes(&entry.event)).sum();
    let kept = caches.kept.lock();
    json!({
        "decodedEvents": { "entries": decoded.len(), "limit": DECODED_EVENT_CACHE_LIMIT, "approxBytes": decoded_bytes },
        "keptRows": { "entries": kept.rows.len(), "dataBytes": kept.chars, "limitBytes": KEPT_ROWS_MAX_CHARS },
    })
}

struct RecentEntries<V> {
    entries: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

/// A thread-safe map that keeps the `limit` most recently remembered entries.
pub struct RecentCache<V> {
    limit: usize,
    inner: Mutex<RecentEntries<V>>,
}

impl<V: Clone> RecentCache<V> {
    pub fn new(limit: usize) -> Self {
        let entries = RecentEntries { entries: HashMap::new(), order: BTreeMap::new(), next: 0 };
        RecentCache { limit, inner: Mutex::new(entries) }
    }

    pub fn get(&self, key: &str) -> Option<V> {
        self.inner.lock().entries.get(key).map(|(_, value)| value.clone())
    }

    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn values(&self) -> Vec<V> {
        self.inner.lock().entries.values().map(|(_, value)| value.clone()).collect()
    }

    pub fn remember(&self, key: &str, value: V) -> V {
        remember_recent(self, key, value)
    }

    pub fn remove_where(&self, mut matches: impl FnMut(&str) -> bool) {
        let mut inner = self.inner.lock();
        let doomed: Vec<(u64, String)> = inner
            .entries
            .iter()
            .filter(|(key, _)| matches(key))
            .map(|(key, (stamp, _))| (*stamp, key.clone()))
            .collect();
        for (stamp, key) in doomed {
            inner.entries.remove(&key);
            inner.order.remove(&stamp);
        }
    }
}

pub fn remember_recent<V: Clone>(cache: &RecentCache<V>, key: &str, value: V) -> V {
    let mut inner = cache.inner.lock();
    let stamp = inner.next;
    inner.next += 1;
    if let Some((old, _)) = inner.entries.remove(key) {
        inner.order.remove(&old);
    }
    inner.entries.insert(key.to_string(), (stamp, value.clone()));
    inner.order.insert(stamp, key.to_string());
    while inner.entries.len() > cache.limit {
        let Some((_, oldest)) = inner.order.pop_first() else { break };
        inner.entries.remove(&oldest);
    }
    value
}

pub fn decode_events(db: &Db, rows: &[StoredEventRow]) -> Vec<EventWithMeta> {
    let caches = db_caches(db);
    rows.iter()
        .map(|row| {
            let key = format!("{}:{}", row.id, row.data.len());
            let event = caches.decoded.get(&key).unwrap_or_else(|| decode_event_with_meta(row));
            caches.decoded.remember(&key, event)
        })
        .collect()
}

pub fn to_thread_event_row(row: &StoredEventRow) -> ThreadEventRow {
    let mut data = match decode_event(row) {
        Value::Object(event) => event,
        _ => Map::new(),
    };
    data.shift_remove("scope");
    data.shift_remove("threadId");
    let event_type = match data.shift_remove("type") {
        Some(Value::String(event_type)) => event_type,
        _ => row.event_type.clone(),
    };
    ThreadEventRow {
        id: row.id.clone(),
        scope: event_scope(row),
        thread_id: row.thread_id.clone(),
        seq: row.sequence,
        created_at: row.created_at,
        event_type,
        data,
    }
}

pub const LEGACY_CODEX_GOAL_EXTENSION_KIND: &str = "provider-codex/goal";
const GOAL_FIELDS: [&str; 5] =
    ["objective", "status", "tokenBudget", "tokensUsed", "timeUsedSeconds"];

fn legacy_item_id(prefix: &str, turn_id: Option<&str>, payload: &Value) -> String {
    let text = payload.to_string();
    let mut hash: i32 = 5381;
    for unit in text.encode_utf16() {
        hash = ((i64::from(hash) * 33) as i32) ^ i32::from(unit);
    }
    format!("{prefix}:{}:{}", turn_id.unwrap_or("thread"), base36(hash as u32))
}

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

fn insert_present(target: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        target.insert(key.into(), value);
    }
}

fn or_null(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

/// `convertLegacyStoredThreadEvent`: rewrites shapes older builds stored into current ones.
pub fn convert_legacy_stored_thread_event(
    event_type: &str,
    mut data: Map<String, Value>,
    turn_id: Option<&str>,
) -> (String, Map<String, Value>) {
    match event_type {
        "item/started" | "item/completed" => {
            if let Some(item) = data.get("item")
                && let Some(upgraded) = upgrade_legacy_tool_item(item)
            {
                data.insert("item".into(), upgraded);
            }
            (event_type.into(), data)
        }
        "turn/plan/updated" => {
            let plan = data.shift_remove("plan");
            let explanation = data.shift_remove("explanation");
            let steps = match plan {
                Some(Value::Array(steps)) => Value::Array(steps),
                _ => Value::Array(Vec::new()),
            };
            let mut payload = Map::new();
            payload.insert("steps".into(), steps.clone());
            insert_present(&mut payload, "explanation", explanation.clone());
            let mut item = Map::new();
            item.insert("type".into(), json!("planSteps"));
            let id = legacy_item_id("legacy-plan", turn_id, &Value::Object(payload));
            item.insert("id".into(), Value::String(id));
            item.insert("steps".into(), steps);
            if let Some(Value::String(explanation)) = explanation {
                item.insert("explanation".into(), Value::String(explanation));
            }
            item.insert("status".into(), json!("completed"));
            data.insert("item".into(), Value::Object(item));
            ("item/completed".into(), data)
        }
        "thread/goal/updated" => {
            let mut payload = Map::new();
            for field in GOAL_FIELDS {
                insert_present(&mut payload, field, data.shift_remove(field));
            }
            data.insert("kind".into(), json!(LEGACY_CODEX_GOAL_EXTENSION_KIND));
            data.insert("payload".into(), Value::Object(payload));
            ("thread/extensionState/updated".into(), data)
        }
        "thread/goal/cleared" => {
            data.insert("kind".into(), json!(LEGACY_CODEX_GOAL_EXTENSION_KIND));
            data.insert("payload".into(), Value::Null);
            ("thread/extensionState/updated".into(), data)
        }
        "system/permissionGrant/lifecycle" => {
            let subject = data.shift_remove("subject");
            let mut payload = Map::new();
            payload.insert("kind".into(), json!("approval"));
            insert_present(&mut payload, "subject", subject);
            payload.insert("reason".into(), Value::Null);
            let interaction =
                legacy_interaction_lifecycle_record(data, Some(Value::Object(payload)));
            ("system/interaction/lifecycle".into(), interaction)
        }
        "system/userQuestion/lifecycle" => {
            let payload = data.shift_remove("payload");
            let interaction = legacy_interaction_lifecycle_record(data, payload);
            ("system/interaction/lifecycle".into(), interaction)
        }
        _ => (event_type.into(), data),
    }
}

fn legacy_interaction_lifecycle_record(
    mut data: Map<String, Value>,
    payload: Option<Value>,
) -> Map<String, Value> {
    let mut record = Map::new();
    insert_present(&mut record, "id", data.remove("interactionId"));
    insert_present(&mut record, "status", data.remove("status"));
    record.insert("statusReason".into(), or_null(data.remove("statusReason")));
    let mut origin = Map::new();
    origin.insert("kind".into(), json!("provider"));
    insert_present(&mut origin, "providerId", data.remove("providerId"));
    insert_present(&mut origin, "providerRequestId", data.remove("providerRequestId"));
    record.insert("origin".into(), Value::Object(origin));
    insert_present(&mut record, "payload", payload);
    record.insert("resolution".into(), or_null(data.remove("resolution")));
    let mut out = Map::new();
    out.insert("interaction".into(), Value::Object(record));
    out
}

const LEGACY_READ_TOOL_NAMES: [&str; 2] = ["Read", "read"];
const LEGACY_CONTENT_SEARCH_TOOL_NAMES: [&str; 2] = ["Grep", "grep"];
const LEGACY_PATH_SEARCH_TOOL_NAMES: [&str; 3] = ["Glob", "glob", "find"];
const LEGACY_LIST_TOOL_NAMES: [&str; 1] = ["ls"];
const LEGACY_SUPPRESSED_TOOL_NAMES: [&str; 8] = [
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TodoRead",
    "TodoWrite",
    "ToolSearch",
    "AskUserQuestion",
];
const LEGACY_AGENT_RESULT_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

fn first_string_field(args: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let args = args?;
    keys.iter().find_map(|key| match args.get(*key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    })
}

pub fn format_tool_call_command(tool: &str, args: Option<&Map<String, Value>>) -> String {
    let Some(args) = args else { return tool.to_string() };
    if args.is_empty() {
        return tool.to_string();
    }
    let compact: Vec<String> = args
        .iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.trim().to_string(),
                other => other.to_string(),
            };
            let units: Vec<u16> = text.encode_utf16().collect();
            let display = if units.len() > 40 {
                format!("{}...", String::from_utf16_lossy(&units[..37]))
            } else {
                text
            };
            format!("{key}: {display}")
        })
        .collect();
    format!("{tool} {{ {} }}", compact.join(", "))
}

fn strip_legacy_agent_result_metadata(result: &str) -> String {
    result
        .split('\n')
        .map(str::trim_end)
        .filter(|line| !line.starts_with("agentId:") && !line.starts_with("<usage>"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// `upgradeLegacyToolItem`: `None` when the item is kept as it is.
pub fn upgrade_legacy_tool_item(item: &Value) -> Option<Value> {
    let record = item.as_object()?;
    let is_legacy = record.get("type").and_then(Value::as_str) == Some("toolCall")
        && record.get("id").is_some_and(Value::is_string)
        && record.get("status").is_some_and(Value::is_string)
        && !record.contains_key("presentation");
    let full_tool = record.get("tool").and_then(Value::as_str)?;
    if !is_legacy {
        return None;
    }
    let tool = full_tool.rsplit(':').next().unwrap_or(full_tool);
    let args = record.get("arguments").and_then(Value::as_object);
    let status = record.get("status").and_then(Value::as_str).unwrap_or_default();
    let shaped = |kind: &str, fields: Vec<(&str, Value)>| {
        let mut out = Map::new();
        out.insert("type".into(), json!(kind));
        insert_present(&mut out, "id", record.get("id").cloned());
        insert_present(&mut out, "status", record.get("status").cloned());
        insert_present(&mut out, "parentToolCallId", record.get("parentToolCallId").cloned());
        for (key, value) in fields {
            out.insert(key.into(), value);
        }
        out.insert("cmd".into(), Value::String(format_tool_call_command(full_tool, args)));
        Some(Value::Object(out))
    };
    if LEGACY_READ_TOOL_NAMES.contains(&tool) {
        let path = first_string_field(args, &["file_path", "file", "path"])?;
        return shaped("fileRead", vec![("path", json!(path))]);
    }
    if LEGACY_CONTENT_SEARCH_TOOL_NAMES.contains(&tool) {
        let query = first_string_field(args, &["pattern", "query"])?;
        let mut fields = vec![("mode", json!("content")), ("query", json!(query))];
        if let Some(path) = first_string_field(args, &["path"]) {
            fields.push(("path", json!(path)));
        }
        return shaped("search", fields);
    }
    if LEGACY_PATH_SEARCH_TOOL_NAMES.contains(&tool) {
        let query = first_string_field(args, &["pattern"]);
        let path = first_string_field(args, &["path"]);
        if query.is_none() && path.is_none() {
            return None;
        }
        let mut fields = vec![("mode", json!("path")), ("query", json!(query.unwrap_or_default()))];
        if let Some(path) = path {
            fields.push(("path", json!(path)));
        }
        return shaped("search", fields);
    }
    if LEGACY_LIST_TOOL_NAMES.contains(&tool) {
        let path = first_string_field(args, &["path"])?;
        return shaped(
            "search",
            vec![("mode", json!("list")), ("query", json!("")), ("path", json!(path))],
        );
    }
    if LEGACY_SUPPRESSED_TOOL_NAMES.contains(&tool) {
        if status != "pending" && status != "completed" {
            return None;
        }
        let mut upgraded = record.clone();
        upgraded.insert(
            "presentation".into(),
            json!({
                "label": { "pending": format!("Running {tool}"), "completed": format!("Ran {tool}") },
                "icon": { "glyph": "Toolbox" },
                "suppress": true,
            }),
        );
        return Some(Value::Object(upgraded));
    }
    if LEGACY_AGENT_RESULT_TOOL_NAMES.contains(&tool)
        && let Some(Value::String(result)) = record.get("result")
    {
        let stripped = strip_legacy_agent_result_metadata(result);
        if stripped == *result {
            return None;
        }
        let mut upgraded = record.clone();
        upgraded.insert("result".into(), Value::String(stripped));
        return Some(Value::Object(upgraded));
    }
    None
}

fn apply_turn_request_defaults(data: &mut Map<String, Value>) {
    let defaults = [
        ("senderThreadId", Value::Null),
        ("target", json!({ "kind": "new-turn" })),
        ("systemMessageKind", json!("unlabeled")),
        ("systemMessageSubject", Value::Null),
    ];
    for (key, value) in defaults {
        data.entry(key).or_insert(value);
    }
    if let Some(Value::Array(parts)) = data.get_mut("input") {
        parts.iter_mut().for_each(normalize_prompt_input);
    }
    if let Some(Value::Array(groups)) = data.get_mut("inputGroups") {
        for group in groups {
            if let Value::Array(parts) = group {
                parts.iter_mut().for_each(normalize_prompt_input);
            }
        }
    }
}

fn normalize_prompt_input(part: &mut Value) {
    let Some(part) = part.as_object_mut() else { return };
    if part.get("type").and_then(Value::as_str) != Some("text") {
        return;
    }
    let mentions = part.entry("mentions").or_insert_with(|| Value::Array(Vec::new()));
    let Value::Array(mentions) = mentions else { return };
    for mention in mentions {
        let Some(resource) = mention.get_mut("resource").and_then(Value::as_object_mut) else {
            continue;
        };
        let is_folder = resource.get("kind").and_then(Value::as_str) == Some("folder");
        if !is_folder || !resource.get("folderId").is_some_and(Value::is_string) {
            continue;
        }
        let Some(Value::String(folder_id)) = resource.shift_remove("folderId") else { continue };
        resource.insert("kind".into(), json!("section"));
        resource.insert("sectionId".into(), Value::String(folder_id));
    }
}
