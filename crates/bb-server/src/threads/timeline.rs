use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Weak};

use bb_thread_view::build_thread_timeline::{
    ThreadTimelineArgs, ThreadTimelineOptions, ThreadTimelineResult,
    build_thread_timeline_from_events,
};
use bb_thread_view::group_turns::{
    CompletedTurnDisplay, ExternalUserBoundaryTurnSpan, is_external_user_boundary_for_turn,
};
use bb_thread_view::thread_state_extraction::compact_thread_timeline_summary_events;
use bb_thread_view::types::{EventMeta, ThreadEventWithMeta};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::context::{Ctx, ServerContext};
use crate::db::Db;
use crate::db::event_read::{
    self as events, EventOutputs, EventQuery, HeadState, RecentCache, SortOrder, StoredEventRow,
    TimelineFilter,
};
use crate::db::thread_read::ThreadListRow;
use crate::domain::changes::{ChangedMessage, ThreadChangeKind};
use crate::domain::thread::ThreadStatus;
use crate::error::{ApiError, invalid_request};
use crate::threads::timeline_pages::{
    self as pages, PaginateTimelineArgs, TimelineContentCursor, TimelinePage,
    TimelinePaginationCursor, TimelineSnapshot,
};
use crate::ws::hub::ListenerGuard;

#[derive(Clone, Debug, PartialEq)]
pub struct TimelineDisplay {
    pub completed_turn_display: CompletedTurnDisplay,
    pub include_diagnostic_operations: bool,
    pub provider_display_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimelineRequest {
    pub display: TimelineDisplay,
    pub page: TimelinePage,
    pub include_nested_rows: bool,
    pub summary_only: bool,
    pub event_budget: i64,
    pub after_sequence: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnDetailsRequest {
    pub display: TimelineDisplay,
    pub turn_id: String,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub before_cursor: Option<String>,
}

/// The events of one context epoch: from the last context clear (`start`) to `max_seq`.
#[derive(Clone)]
pub struct Epoch {
    pub db: Db,
    pub thread_id: String,
    pub start: i64,
    pub max_seq: i64,
    pub exclude_diagnostics: bool,
    pub outputs: EventOutputs,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupingContext {
    pub ordering_boundary: Option<i64>,
    pub accepted_turn_ids: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoadedWindow {
    pub head_state_rows: Vec<StoredEventRow>,
    pub context_only_interruptions: HashSet<i64>,
    pub ordering_boundary: Option<i64>,
    pub rows: Vec<StoredEventRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageSelection {
    pub window: LoadedWindow,
    pub owned_sequence_start: i64,
    pub owned_sequence_end: i64,
    pub known_has_older_segments: Option<bool>,
    pub page: TimelinePage,
}

pub const MAX_EMPTY_WINDOWS: usize = 8;
pub const RESPONSE_BYTE_LIMIT: i64 = 4 * 1024 * 1024;
pub const DETAIL_LEAF_LIMIT: i64 = 1_500;
pub const SERVED_KEY_LIMIT: usize = 32;
pub const SERVED_RING_SIZE: usize = 4;
const REQUESTED: &str = "client/turn/requested";
const ACCEPTED: &str = "turn/input/accepted";
const REJECTED: &str = "client/turn/rejected";
const INTERRUPTED: &str = "system/thread/interrupted";
const CONTEXT_TYPES: [&str; 6] =
    [REQUESTED, REJECTED, ACCEPTED, INTERRUPTED, "turn/started", "turn/completed"];

type ApiResult<T> = Result<T, ApiError>;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn request_ids(rows: &[StoredEventRow], types: &[&str]) -> Vec<String> {
    rows.iter()
        .filter(|row| types.contains(&row.event_type.as_str()))
        .filter_map(|row| {
            let data: Value = serde_json::from_str(&row.data).ok()?;
            let id = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_string);
            id("clientRequestId").or_else(|| id("requestId"))
        })
        .collect()
}

fn thread_name(thread: &ThreadListRow) -> String {
    let row = &thread.thread;
    row.title.clone().or_else(|| row.title_fallback.clone()).unwrap_or_default()
}

fn status_name(status: ThreadStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn history_query(epoch: &Epoch) -> EventQuery {
    EventQuery {
        after: Some(epoch.start - 1),
        before: Some(epoch.max_seq + 1),
        timeline: Some(TimelineFilter {
            exclude_diagnostics: epoch.exclude_diagnostics,
            horizon: None,
        }),
        outputs: Some(epoch.outputs),
        ..EventQuery::new(epoch.thread_id.clone())
    }
}

fn delegating_item_id(row: &StoredEventRow) -> Option<String> {
    let kind = row.item_kind.as_deref();
    let delegating = kind == Some("toolCall") || kind == Some("delegation");
    if delegating { row.item_id.clone() } else { None }
}

fn with_parented_rows(epoch: &Epoch, input: Vec<StoredEventRow>) -> ApiResult<Vec<StoredEventRow>> {
    let db = &epoch.db;
    let mut rows = input;
    let mut known: HashSet<String> = rows.iter().map(|row| row.id.clone()).collect();
    let mut tool_call_ids: Vec<String> = Vec::new();
    for id in rows.iter().filter_map(delegating_item_id) {
        if !tool_call_ids.contains(&id) {
            tool_call_ids.push(id);
        }
    }
    let mut fetched: HashSet<String> = HashSet::new();
    loop {
        let parent_ids: Vec<String> =
            tool_call_ids.iter().filter(|id| !fetched.contains(*id)).cloned().collect();
        if parent_ids.is_empty() {
            break;
        }
        fetched.extend(parent_ids.iter().cloned());
        let query = EventQuery { parent_tool_call_ids: Some(parent_ids), ..history_query(epoch) };
        let children: Vec<StoredEventRow> = events::list_events(db, &query)?
            .into_iter()
            .filter(|row| !known.contains(&row.id))
            .collect();
        known.extend(children.iter().map(|row| row.id.clone()));
        for id in children.iter().filter_map(delegating_item_id) {
            if !tool_call_ids.contains(&id) {
                tool_call_ids.push(id);
            }
        }
        rows = events::merge_event_rows(rows.into_iter().chain(children));
    }
    let started_item_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.parent_tool_call_id.clone())
        .filter(|parent| !parent.is_empty() && !tool_call_ids.contains(parent))
        .collect();
    let missing = EventQuery {
        started_item_ids: Some(started_item_ids),
        where_sql: Some("item_kind IN ('toolCall', 'delegation')".to_string()),
        outputs: Some(epoch.outputs),
        ..EventQuery::new(epoch.thread_id.clone())
    };
    Ok(events::merge_event_rows(events::list_events(db, &missing)?.into_iter().chain(rows)))
}

fn with_turn_starts(epoch: &Epoch, rows: Vec<StoredEventRow>) -> ApiResult<Vec<StoredEventRow>> {
    let started: HashSet<&str> = rows
        .iter()
        .filter(|row| row.event_type == "turn/started")
        .filter_map(|row| row.turn_id.as_deref())
        .collect();
    let turn_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.turn_id.clone())
        .filter(|turn_id| !started.contains(turn_id.as_str()))
        .collect();
    let cutoff = rows.iter().fold(0, |max, row| max.max(row.sequence));
    let query = EventQuery {
        turn_ids: Some(turn_ids),
        types: Some(strings(&["turn/started"])),
        before: Some(cutoff + 1),
        ..EventQuery::new(epoch.thread_id.clone())
    };
    Ok(events::merge_event_rows(events::list_events(&epoch.db, &query)?.into_iter().chain(rows)))
}

fn with_background_task_states(
    epoch: &Epoch,
    rows: Vec<StoredEventRow>,
) -> ApiResult<Vec<StoredEventRow>> {
    let item_ids: Vec<String> = rows
        .iter()
        .filter(|row| matches!(row.item_kind.as_deref(), Some("backgroundTask" | "delegation")))
        .filter_map(|row| row.item_id.clone())
        .collect();
    let states =
        events::list_latest_item_states(&epoch.db, &epoch.thread_id, &item_ids, epoch.max_seq + 1)?;
    Ok(events::merge_event_rows(rows.into_iter().chain(states)))
}

/// `groupingContext`: the sequence from which rows are ordered by sequence instead of by turn
/// (the first parented event or user message that lands inside another turn), and the turn each
/// accepted request started.
pub fn grouping_context(epoch: &Epoch) -> ApiResult<GroupingContext> {
    let (db, thread_id) = (&epoch.db, epoch.thread_id.as_str());
    let context = events::list_ordering_context(db, thread_id, epoch.start, epoch.max_seq)?;
    let mut spans: Vec<ExternalUserBoundaryTurnSpan> = Vec::new();
    let mut accepted: HashMap<String, (i64, String)> = HashMap::new();
    let mut accepted_order: Vec<String> = Vec::new();
    for row in &context {
        let Some(turn_id) = row.turn_id.as_deref() else { continue };
        if row.event_type == ACCEPTED
            && let Some(request_id) = row.client_request_id.as_deref()
        {
            if !accepted.contains_key(request_id) {
                accepted_order.push(request_id.to_string());
            }
            accepted.insert(request_id.to_string(), (row.sequence, turn_id.to_string()));
        }
        let root_start = row.event_type == "turn/started" && row.parent_tool_call_id.is_none();
        if root_start && !spans.iter().any(|span| span.turn_id == turn_id) {
            spans.push(ExternalUserBoundaryTurnSpan {
                completion_sequence: None,
                sequence_start: row.sequence,
                turn_id: turn_id.to_string(),
            });
        }
        if row.event_type == "turn/completed"
            && let Some(span) = spans.iter_mut().find(|span| span.turn_id == turn_id)
            && span.completion_sequence.is_none()
        {
            span.completion_sequence = Some(row.sequence);
        }
    }
    let requests: Vec<_> = context
        .iter()
        .filter(|row| row.event_type == REQUESTED && row.request_id.is_some())
        .collect();
    for row in &requests {
        let turn = row.request_id.as_deref().and_then(|id| accepted.get(id)).map(|(_, t)| t);
        if let Some(span) = spans.iter_mut().find(|span| Some(&span.turn_id) == turn) {
            span.sequence_start = span.sequence_start.min(row.sequence);
        }
    }
    let mut boundary = events::first_parented_boundary(db, thread_id, epoch.start, epoch.max_seq)?;
    for row in &requests {
        if row.initiator.as_deref() != Some("user") || row.has_input != 1 {
            continue;
        }
        let acceptance = row.request_id.as_deref().and_then(|id| accepted.get(id));
        let steered = matches!((acceptance, row.expected_turn_id.as_deref()),
            (Some((_, turn)), Some(expected)) if turn == expected);
        let sequence = match acceptance {
            Some((sequence, _)) if steered => *sequence,
            _ => row.sequence,
        };
        let turn_id = acceptance.map(|(_, turn)| turn.as_str()).or(row.expected_turn_id.as_deref());
        if boundary.is_some_and(|boundary| sequence >= boundary) {
            break;
        }
        let overlaps =
            spans.iter().any(|span| is_external_user_boundary_for_turn(span, sequence, turn_id));
        if overlaps {
            boundary = Some(sequence);
        }
    }
    let accepted_turn_ids = accepted_order
        .into_iter()
        .filter_map(|id| accepted.remove(&id).map(|(_, turn)| (id, turn)))
        .collect();
    Ok(GroupingContext { ordering_boundary: boundary, accepted_turn_ids })
}

/// `loadWindow`: the stored rows that project the window `(after, before)` of `epoch`: whole
/// turns that start in it, their parented rows, request context, and (for the latest page) open
/// background tasks and the goal/todo head state.
pub fn load_window(
    epoch: &Epoch,
    after: i64,
    before: i64,
    latest: bool,
) -> ApiResult<LoadedWindow> {
    let (db, thread_id, max_seq) = (&epoch.db, epoch.thread_id.as_str(), epoch.max_seq);
    let history = history_query(epoch);
    let window = EventQuery { after: Some(after), before: Some(before), ..history.clone() };
    let grouping = grouping_context(epoch)?;
    let known = |row: &StoredEventRow| row.sequence <= max_seq;
    let unturned = EventQuery { where_sql: Some("turn_id IS NULL".into()), ..window.clone() };
    let mut rows = events::list_events(db, &unturned)?;
    let root_turns = EventQuery { where_sql: Some(events::ROOT_TURN_EVENT.into()), ..window };
    let mut initial_turn_ids = events::list_turn_ids(db, &root_turns)?;
    initial_turn_ids.extend(
        request_ids(&rows, &[REQUESTED])
            .iter()
            .filter_map(|id| grouping.accepted_turn_ids.get(id).cloned()),
    );
    let mut fetched: HashSet<String> = HashSet::new();
    loop {
        let mut turn_ids: Vec<String> = Vec::new();
        let candidates =
            initial_turn_ids.iter().cloned().chain(rows.iter().filter_map(|r| r.turn_id.clone()));
        for turn_id in candidates {
            if !fetched.contains(&turn_id) && !turn_ids.contains(&turn_id) {
                turn_ids.push(turn_id);
            }
        }
        if turn_ids.is_empty() {
            break;
        }
        fetched.extend(turn_ids.iter().cloned());
        let query = EventQuery { turn_ids: Some(turn_ids), ..history.clone() };
        let merged =
            events::merge_event_rows(rows.into_iter().chain(events::list_events(db, &query)?));
        rows = with_parented_rows(epoch, merged)?.into_iter().filter(known).collect();
    }
    rows = with_background_task_states(epoch, rows)?.into_iter().filter(known).collect();
    if latest {
        let open = events::list_open_background_task_states(db, thread_id)?;
        rows = events::merge_event_rows(rows.into_iter().chain(open))
            .into_iter()
            .filter(known)
            .collect();
    }
    let context_start = rows.iter().fold(after + 1, |start, row| start.min(row.sequence));
    let context_end = rows.iter().fold(before - 1, |end, row| end.max(row.sequence));
    let since_context =
        EventQuery { after: Some(context_start - 1), ..EventQuery::new(thread_id.to_string()) };
    let context_rows = events::list_events(
        db,
        &EventQuery {
            before: Some(context_end + 1),
            types: Some(strings(&CONTEXT_TYPES)),
            ..since_context.clone()
        },
    )?;
    let visible: Vec<StoredEventRow> = context_rows.iter().chain(rows.iter()).cloned().collect();
    let requested: HashSet<String> = request_ids(&visible, &[REQUESTED]).into_iter().collect();
    let missing_requests: Vec<String> =
        request_ids(&rows, &[ACCEPTED]).into_iter().filter(|id| !requested.contains(id)).collect();
    let request_query = EventQuery {
        types: Some(strings(&[REQUESTED])),
        request_ids: Some(missing_requests),
        ..EventQuery::new(thread_id.to_string())
    };
    let request_rows: Vec<StoredEventRow> =
        events::list_events(db, &request_query)?.into_iter().filter(known).collect();
    let request_context: Vec<StoredEventRow> =
        context_rows.iter().chain(&request_rows).chain(&rows).cloned().collect();
    let settled: HashSet<String> =
        request_ids(&request_context, &[ACCEPTED, REJECTED]).into_iter().collect();
    let unsettled: Vec<String> = request_ids(&request_context, &[REQUESTED])
        .into_iter()
        .filter(|id| !settled.contains(id))
        .collect();
    let outcome_query = EventQuery {
        types: Some(strings(&[ACCEPTED, REJECTED])),
        request_ids: Some(unsettled),
        ..since_context
    };
    let outcomes: Vec<StoredEventRow> =
        events::list_events(db, &outcome_query)?.into_iter().filter(known).collect();
    let whole_epoch = EventQuery {
        timeline: None,
        outputs: None,
        types: Some(strings(&[INTERRUPTED])),
        ..history
    };
    let interruptions = events::list_events(db, &whole_epoch)?;
    let visible_sequences: HashSet<i64> = visible.iter().map(|row| row.sequence).collect();
    let unseen = |row: &StoredEventRow| known(row) && !visible_sequences.contains(&row.sequence);
    let mut head_state = Vec::new();
    if latest {
        let ids = [thread_id.to_string()];
        head_state.extend(events::list_head_state_events(db, &ids, HeadState::Goal)?);
        head_state.extend(events::list_head_state_events(db, &ids, HeadState::Todos)?);
    }
    let context_only_interruptions =
        interruptions.iter().filter(|row| unseen(row)).map(|row| row.sequence).collect();
    let all = interruptions
        .into_iter()
        .chain(outcomes)
        .chain(context_rows)
        .chain(request_rows)
        .chain(rows);
    Ok(LoadedWindow {
        head_state_rows: events::merge_event_rows(head_state).into_iter().filter(unseen).collect(),
        context_only_interruptions,
        ordering_boundary: grouping.ordering_boundary,
        rows: with_turn_starts(epoch, events::merge_event_rows(all))?,
    })
}

/// `windowStart`: the first sequence of a page given the newest-first request sequences
/// (`hints`) and the oldest sequence the event budget affords.
pub fn window_start(
    hints: &[i64],
    budget_floor: Option<i64>,
    segment_limit: usize,
    epoch_start: i64,
) -> i64 {
    if budget_floor.is_none() && hints.len() <= segment_limit {
        return epoch_start;
    }
    let affordable: Vec<i64> = hints
        .iter()
        .copied()
        .filter(|seq| budget_floor.is_none_or(|floor| *seq >= floor))
        .collect();
    let last = segment_limit.min(affordable.len()).checked_sub(1).and_then(|i| affordable.get(i));
    last.copied().or(hints.first().copied()).or(budget_floor).unwrap_or(epoch_start)
}

fn budget_floor(epoch: &Epoch, end: i64, offset: i64) -> ApiResult<Option<i64>> {
    let query = EventQuery {
        after: Some(epoch.start - 1),
        before: Some(end),
        timeline: Some(TimelineFilter {
            exclude_diagnostics: epoch.exclude_diagnostics,
            horizon: Some(events::UNBOUNDED),
        }),
        order: Some(SortOrder::Desc),
        limit: Some(1),
        offset: Some(offset),
        ..EventQuery::new(epoch.thread_id.clone())
    };
    Ok(events::list_events(&epoch.db, &query)?.first().map(|row| row.sequence))
}

/// `selectPage`: which sequences the page owns and the rows that project them.
pub fn select_page(
    epoch: &Epoch,
    page: &TimelinePage,
    event_budget: i64,
    content_cursor: Option<TimelineContentCursor>,
) -> ApiResult<PageSelection> {
    let (db, thread_id, start) = (&epoch.db, epoch.thread_id.as_str(), epoch.start);
    let older = match page {
        TimelinePage::Older { before_cursor, .. } => Some(before_cursor.anchor_seq),
        TimelinePage::Latest { .. } => None,
    };
    let before =
        content_cursor.map(|cursor| cursor.before_sequence).or(older).unwrap_or(epoch.max_seq + 1);
    let hint_query = EventQuery {
        after: Some(start - 1),
        before: Some(before),
        types: Some(strings(&[REQUESTED])),
        order: Some(SortOrder::Desc),
        limit: Some(page.segment_limit() as i64 + 1),
        ..EventQuery::new(thread_id.to_string())
    };
    let hints: Vec<i64> =
        events::list_events(db, &hint_query)?.iter().map(|r| r.sequence).collect();
    if let Some(anchor) = older.filter(|anchor| *anchor != start) {
        let query = EventQuery {
            after: Some(anchor - 1),
            before: Some(anchor + 1),
            ..EventQuery::new(thread_id.to_string())
        };
        if events::list_events(db, &query)?.is_empty() {
            return Err(invalid_request("Timeline pagination cursor is no longer available"));
        }
    }
    let floor = budget_floor(epoch, before, event_budget)?;
    let sequence_start = match (content_cursor, older) {
        (Some(_), Some(older)) => older,
        _ => window_start(&hints, floor, page.segment_limit(), start),
    };
    let has_older = sequence_start > start && budget_floor(epoch, sequence_start, 0)?.is_some();
    let window = load_window(epoch, sequence_start - 1, before, page.is_latest())?;
    let page = match (content_cursor, page) {
        (None, page) => page.clone(),
        (Some(_), TimelinePage::Latest { .. }) => TimelinePage::Latest { segment_limit: 1 },
        (Some(_), TimelinePage::Older { before_cursor, .. }) => {
            TimelinePage::Older { segment_limit: 1, before_cursor: before_cursor.clone() }
        }
    };
    Ok(PageSelection {
        window,
        owned_sequence_start: sequence_start,
        owned_sequence_end: before,
        known_has_older_segments: has_older.then_some(true),
        page,
    })
}

fn resolve_snapshot(
    db: &Db,
    thread: &ThreadListRow,
    surface: String,
    cursor: Option<&TimelinePaginationCursor>,
) -> ApiResult<(TimelineSnapshot, Option<TimelineContentCursor>)> {
    if let Some(cursor) = cursor {
        return pages::snapshot_from_cursor(cursor, &thread.thread.id, &surface);
    }
    let thread_id = thread.thread.id.clone();
    let max_seq = events::latest_sequence(db, &thread_id)?;
    let status = thread.thread.status;
    Ok((TimelineSnapshot { version: 3, thread_id, max_seq, status, surface }, None))
}

fn to_view_events(db: &Db, rows: &[StoredEventRow]) -> Vec<ThreadEventWithMeta> {
    events::decode_events(db, rows)
        .into_iter()
        .map(|entry| ThreadEventWithMeta {
            event: entry.event,
            meta: EventMeta {
                id: entry.meta.id,
                seq: entry.meta.seq,
                created_at: entry.meta.created_at,
            },
        })
        .collect()
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn int(row: &Value, key: &str) -> i64 {
    let value = row.get(key);
    value
        .and_then(Value::as_i64)
        .or_else(|| value.and_then(Value::as_f64).map(|v| v as i64))
        .unwrap_or(0)
}

struct Shape<'a> {
    include_nested_rows: bool,
    is_latest_page: bool,
    usage: &'a [StoredEventRow],
}

struct Projected {
    result: ThreadTimelineResult,
    rows: Vec<Value>,
}

/// `projectWindow`: runs the projection on a blocking thread, drops interruptions that are only
/// context, and orders rows from the ordering boundary on by sequence.
async fn project_window(
    db: &Db,
    thread: &ThreadListRow,
    display: &TimelineDisplay,
    thread_status: ThreadStatus,
    loaded: &LoadedWindow,
    shape: Shape<'_>,
) -> ApiResult<Projected> {
    let Shape { include_nested_rows, is_latest_page, usage } = shape;
    let context_window_events = to_view_events(db, usage);
    let head_state_events = to_view_events(db, &loaded.head_state_rows);
    let timeline_events = to_view_events(db, &loaded.rows);
    let options = ThreadTimelineOptions {
        completed_turn_display: display.completed_turn_display,
        include_diagnostic_operations: display.include_diagnostic_operations,
        include_nested_rows,
        is_latest_page,
        thread_status: status_name(thread_status),
        thread_name: thread_name(thread),
        workspace_root: thread.environment_path.clone(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let compacted = compact_thread_timeline_summary_events(&timeline_events);
        build_thread_timeline_from_events(ThreadTimelineArgs {
            context_window_events: &context_window_events,
            head_state_events: &head_state_events,
            events: &compacted,
            options: &options,
        })
    })
    .await
    .map_err(ApiError::internal)?;
    let rows: Vec<Value> = result
        .rows
        .iter()
        .filter_map(|row| serde_json::to_value(row).ok())
        .filter(|row| {
            !(text(row, "kind") == Some("system")
                && text(row, "systemKind") == Some("operation")
                && text(row, "operationKind") == Some("thread-interrupted")
                && loaded.context_only_interruptions.contains(&int(row, "sourceSeqStart")))
        })
        .collect();
    let rows = order_from_boundary(rows, loaded.ordering_boundary);
    Ok(Projected { result, rows })
}

/// Rows from the first one at or after `boundary` are sorted by source sequence.
pub fn order_from_boundary(mut rows: Vec<Value>, boundary: Option<i64>) -> Vec<Value> {
    let Some(boundary) = boundary else { return rows };
    let index = rows.iter().position(|row| int(row, "sourceSeqStart") >= boundary);
    let index = index.unwrap_or(rows.len());
    rows[index..].sort_by_key(|row| (int(row, "sourceSeqStart"), int(row, "sourceSeqEnd")));
    rows
}

/// The `surface` a timeline cursor is bound to.
pub fn timeline_surface(thread: &ThreadListRow, request: &TimelineRequest) -> String {
    let display = &request.display;
    json!([
        display.include_diagnostic_operations,
        request.include_nested_rows,
        events::MAX_INLINE_OUTPUT_CHARS,
        display.provider_display_name,
        thread_name(thread),
        thread.environment_path,
        display.completed_turn_display,
    ])
    .to_string()
}

fn page_kind(page: &TimelinePage) -> &'static str {
    if page.is_latest() { "latest" } else { "older" }
}

fn opt<T: serde::Serialize>(value: Option<T>) -> Value {
    value.and_then(|value| serde_json::to_value(value).ok()).unwrap_or(Value::Null)
}

async fn build_timeline_page(
    db: &Db,
    thread: &ThreadListRow,
    request: &TimelineRequest,
) -> ApiResult<Value> {
    let page = &request.page;
    let latest = page.is_latest();
    let cursor = match page {
        TimelinePage::Older { before_cursor, .. } => Some(before_cursor),
        TimelinePage::Latest { .. } => None,
    };
    let surface = timeline_surface(thread, request);
    let (snapshot, selection, usage, context_boundary_seq) = db.transaction(|| {
        let (snapshot, content) = resolve_snapshot(db, thread, surface, cursor)?;
        let thread_id = snapshot.thread_id.clone();
        let context_boundary_seq =
            events::context_clear_sequence(db, &thread_id, snapshot.max_seq)?;
        let start = context_boundary_seq.unwrap_or(0);
        let epoch = Epoch {
            db: db.clone(),
            thread_id: thread_id.clone(),
            start,
            max_seq: snapshot.max_seq,
            exclude_diagnostics: !request.display.include_diagnostic_operations,
            outputs: EventOutputs::Inline,
        };
        let selection = select_page(&epoch, page, request.event_budget, content)?;
        let usage = events::list_context_window_usage_events(db, &thread_id, start)?;
        Ok::<_, ApiError>(((snapshot, content), selection, usage, context_boundary_seq))
    })?;
    let (snapshot, content_cursor) = snapshot;
    let projected = project_window(
        db,
        thread,
        &request.display,
        snapshot.status,
        &selection.window,
        Shape {
            include_nested_rows: request.include_nested_rows,
            is_latest_page: latest,
            usage: &usage,
        },
    )
    .await?;
    let paginated = pages::paginate_timeline(&PaginateTimelineArgs {
        rows: &projected.rows,
        page: &selection.page,
        content_cursor,
        max_leaves: request.event_budget.max(1),
        max_bytes: RESPONSE_BYTE_LIMIT,
        owned_sequence_start: selection.owned_sequence_start,
        owned_sequence_end: selection.owned_sequence_end,
        known_has_older_segments: selection.known_has_older_segments,
    });
    let timeline = projected.result;
    let summary_only = request.summary_only;
    let older_cursor = pages::bind_cursor(
        paginated.older_cursor.as_ref(),
        &snapshot,
        paginated.content_cursor.as_ref(),
    );
    let mut timeline_page = json!({
        "kind": page_kind(page),
        "segmentLimit": page.segment_limit(),
        "returnedSegmentCount": paginated.returned_segment_count,
        "hasOlderRows": paginated.has_older_rows,
        "olderCursor": opt(older_cursor),
        "historySnapshot": serde_json::to_string(&snapshot).unwrap_or_default(),
        "olderRowsSourceSeqEnd": paginated.older_rows_source_seq_end,
    });
    if let Some(page_fields) = timeline_page.as_object_mut() {
        if let Some(updates) = paginated.older_row_updates.filter(|_| !summary_only) {
            page_fields.insert("olderRowUpdates".into(), Value::Array(updates));
        }
        if let Some(content_page) = paginated.content_page {
            page_fields.insert("contentPage".into(), opt(Some(content_page)));
        }
    }
    let rows = if summary_only { Vec::new() } else { paginated.rows };
    let mut response = json!({
        "maxSeq": snapshot.max_seq,
        "rows": rows,
        "contextBoundarySeq": context_boundary_seq,
        "completedTurnDisplay": request.display.completed_turn_display,
        "activePromptMode": null,
        "activeThinking": if latest { timeline.active_thinking } else { None },
        "activeWorkflows": if latest { opt(Some(timeline.active_workflows)) } else { json!([]) },
        "activeBackgroundCommands":
            if latest { opt(Some(timeline.active_background_commands)) } else { json!([]) },
        "pendingTodos": timeline.pending_todos,
        "goal": timeline.goal,
        "modelFallback": if latest { timeline.model_fallback } else { None },
    });
    if let (true, Some(usage), Some(fields)) =
        (latest, timeline.context_window_usage, response.as_object_mut())
    {
        fields.insert("contextWindowUsage".into(), usage);
    }
    if let Some(fields) = response.as_object_mut() {
        fields.insert("timelinePage".into(), timeline_page);
    }
    Ok(response)
}

fn older_cursor_of(response: &Value) -> Option<TimelinePaginationCursor> {
    let cursor = response.get("timelinePage")?.get("olderCursor")?;
    serde_json::from_value(cursor.clone()).ok()
}

/// `buildThreadTimeline`: one `GET /threads/:id/timeline` response (no delta), skipping up to
/// [`MAX_EMPTY_WINDOWS`] older windows that project to no rows. Async: the projection runs on
/// a blocking thread.
pub async fn build_thread_timeline(
    db: &Db,
    thread: &ThreadListRow,
    request: &TimelineRequest,
) -> ApiResult<Value> {
    let mut result = build_timeline_page(db, thread, request).await?;
    for _ in 0..MAX_EMPTY_WINDOWS {
        let Some(before_cursor) = older_cursor_of(&result) else { break };
        if request.summary_only {
            break;
        }
        if result.get("rows").and_then(Value::as_array).is_some_and(|rows| !rows.is_empty()) {
            break;
        }
        let segment_limit = request.page.segment_limit();
        let page = TimelinePage::Older { segment_limit, before_cursor };
        let older_request = TimelineRequest { page, ..request.clone() };
        let older = build_timeline_page(db, thread, &older_request).await?;
        let mut timeline_page = older.get("timelinePage").cloned().unwrap_or(Value::Null);
        if let Some(fields) = timeline_page.as_object_mut() {
            fields.insert("kind".into(), json!(page_kind(&request.page)));
        }
        if let Some(fields) = result.as_object_mut() {
            fields.insert("rows".into(), older.get("rows").cloned().unwrap_or(json!([])));
            fields.insert("timelinePage".into(), timeline_page);
        }
    }
    Ok(pages::limit_response_outputs(result, !request.include_nested_rows))
}

fn turn_details_surface(thread: &ThreadListRow, request: &TurnDetailsRequest) -> String {
    let display = &request.display;
    json!([
        "turn-details",
        request.turn_id,
        request.source_seq_start,
        request.source_seq_end,
        display.include_diagnostic_operations,
        display.provider_display_name,
        thread_name(thread),
        thread.environment_path,
        display.completed_turn_display,
    ])
    .to_string()
}

fn rows_within(rows: &[Value], request: &TurnDetailsRequest) -> Vec<Value> {
    rows.iter()
        .flat_map(|row| {
            let contained = text(row, "turnId") == Some(request.turn_id.as_str())
                && int(row, "sourceSeqStart") >= request.source_seq_start
                && int(row, "sourceSeqEnd") <= request.source_seq_end;
            if contained {
                vec![row.clone()]
            } else {
                rows_within(
                    pages::nested_timeline_rows(row).map_or(&[][..], Vec::as_slice),
                    request,
                )
            }
        })
        .collect()
}

/// `buildTurnDetails`: the rows of one completed turn summary, always projected afresh.
/// Async: the projection runs on a blocking thread.
pub async fn build_turn_details(
    db: &Db,
    thread: &ThreadListRow,
    request: &TurnDetailsRequest,
) -> ApiResult<Value> {
    let (start_seq, end_seq) = (request.source_seq_start, request.source_seq_end);
    if start_seq > end_seq {
        return Err(invalid_request("sourceSeqStart must be less than or equal to sourceSeqEnd"));
    }
    let surface = turn_details_surface(thread, request);
    let anchor_seq = start_seq.max(1);
    let cursor = request
        .before_cursor
        .as_ref()
        .map(|anchor_id| TimelinePaginationCursor { anchor_id: anchor_id.clone(), anchor_seq });
    let (snapshot, content, window) = db.transaction(|| {
        let (snapshot, content) = resolve_snapshot(db, thread, surface, cursor.as_ref())?;
        let max_seq = snapshot.max_seq;
        let start = events::context_clear_sequence(db, &snapshot.thread_id, max_seq)?.unwrap_or(0);
        let load = |outputs| {
            let epoch = Epoch {
                db: db.clone(),
                thread_id: snapshot.thread_id.clone(),
                start,
                max_seq,
                exclude_diagnostics: !request.display.include_diagnostic_operations,
                outputs,
            };
            load_window(&epoch, start_seq - 1, end_seq.min(max_seq) + 1, false)
        };
        let full = load(EventOutputs::Full)?;
        let bytes: usize = full.rows.iter().map(|row| row.data.len()).sum();
        let rows = if bytes as i64 <= RESPONSE_BYTE_LIMIT {
            full.rows
        } else {
            load(EventOutputs::Inline)?.rows
        };
        Ok::<_, ApiError>((snapshot, content, LoadedWindow { rows, ..LoadedWindow::default() }))
    })?;
    let shape = Shape { include_nested_rows: true, is_latest_page: false, usage: &[] };
    let projected =
        project_window(db, thread, &request.display, snapshot.status, &window, shape).await?;
    let turn = projected.rows.iter().find(|row| {
        text(row, "kind") == Some("turn")
            && text(row, "turnId") == Some(request.turn_id.as_str())
            && int(row, "sourceSeqEnd") >= start_seq
    });
    let collapsed = turn.and_then(|row| row.get("children")).and_then(Value::as_array).cloned();
    let found = collapsed.unwrap_or_else(|| rows_within(&projected.rows, request));
    if found.is_empty() {
        return Err(invalid_request(format!(
            "Timeline turn summary details range {start_seq}-{end_seq} does not include turn {}",
            request.turn_id
        )));
    }
    let before_leaf = content.map(|content| content.before_leaf);
    let page =
        pages::paginate_contents(&found, before_leaf, DETAIL_LEAF_LIMIT, RESPONSE_BYTE_LIMIT);
    let older = (page.start != 0)
        .then(|| {
            let anchor =
                TimelinePaginationCursor { anchor_id: request.turn_id.clone(), anchor_seq };
            let content = TimelineContentCursor {
                before_leaf: page.start,
                before_sequence: snapshot.max_seq + 1,
            };
            pages::bind_cursor(Some(&anchor), &snapshot, Some(&content))
        })
        .flatten();
    Ok(json!({
        "rows": page.rows,
        "olderCursor": older.map(|cursor| cursor.anchor_id),
        "historySnapshot": serde_json::to_string(&snapshot).unwrap_or_default(),
    }))
}

/// `computeTimelineRowDelta` over JSON rows: rows whose JSON changed (or are new), and the full
/// id order when it changed.
pub fn compute_row_delta(previous: &[Value], current: &[Value]) -> Value {
    let id = |row: &Value| text(row, "id").unwrap_or("").to_string();
    let previous_by_id: HashMap<String, String> =
        previous.iter().map(|row| (id(row), row.to_string())).collect();
    let mut upsert_rows = Vec::new();
    let mut row_order = Vec::with_capacity(current.len());
    let mut order_changed = previous.len() != current.len();
    for (index, row) in current.iter().enumerate() {
        let row_id = id(row);
        if previous.get(index).map(id).as_ref() != Some(&row_id) {
            order_changed = true;
        }
        if previous_by_id.get(&row_id) != Some(&row.to_string()) {
            upsert_rows.push(row.clone());
        }
        row_order.push(row_id);
    }
    let mut delta = json!({ "upsertRows": upsert_rows });
    if let (true, Some(fields)) = (order_changed, delta.as_object_mut()) {
        fields.insert("rowOrder".into(), json!(row_order));
    }
    delta
}

/// The projection-cache key: thread id, then status, name, workspace path, page and display.
pub fn timeline_cache_key(thread: &ThreadListRow, request: &TimelineRequest) -> String {
    let page = match &request.page {
        TimelinePage::Latest { segment_limit } => {
            json!({ "kind": "latest", "segmentLimit": segment_limit })
        }
        TimelinePage::Older { segment_limit, before_cursor } => {
            json!({ "kind": "older", "segmentLimit": segment_limit, "beforeCursor": before_cursor })
        }
    };
    let display = &request.display;
    let shown = json!({
        "completedTurnDisplay": display.completed_turn_display,
        "includeDiagnosticOperations": display.include_diagnostic_operations,
        "providerDisplayName": display.provider_display_name,
        "includeNestedRows": request.include_nested_rows,
        "summaryOnly": request.summary_only,
        "eventBudget": request.event_budget,
    });
    let facts =
        json!([thread.thread.status, thread_name(thread), thread.environment_path, page, shown]);
    format!("{}|{facts}", thread.thread.id)
}

#[derive(Clone)]
struct Served {
    latest: i64,
    full: Arc<Value>,
}

/// `createTimelineReader`: serves timelines with a per-thread projection cache
/// ([`SERVED_KEY_LIMIT`] keys, the [`SERVED_RING_SIZE`] latest projections each) and
/// `afterSequence` deltas.
pub struct TimelineReader {
    db: Db,
    served: RecentCache<Vec<Served>>,
}

impl TimelineReader {
    pub fn new(db: Db) -> Self {
        TimelineReader { db, served: RecentCache::new(SERVED_KEY_LIMIT) }
    }

    /// Drops every cached projection of a thread (on `history-rewritten`).
    pub fn forget_thread(&self, thread_id: &str) {
        self.served.remove_where(|key| key.starts_with(&format!("{thread_id}|")));
    }

    pub fn cached_key_count(&self) -> usize {
        self.served.len()
    }

    /// What the projection cache holds, for the memory diagnostics.
    pub fn memory(&self) -> Value {
        let rings = self.served.values();
        let mut seen = HashSet::new();
        let (mut entries, mut bytes) = (0usize, 0usize);
        for served in rings.iter().flatten() {
            entries += 1;
            if seen.insert(Arc::as_ptr(&served.full)) {
                bytes += crate::diagnostics::approx_heap_bytes(&served.full);
            }
        }
        json!({
            "keys": rings.len(),
            "keyLimit": SERVED_KEY_LIMIT,
            "projections": entries,
            "distinctProjections": seen.len(),
            "approxBytes": bytes,
        })
    }

    /// `timelines.timeline(thread, request)`: the `GET /threads/:id/timeline` response.
    pub async fn read_thread_timeline(
        &self,
        thread: &ThreadListRow,
        request: &TimelineRequest,
    ) -> ApiResult<Value> {
        let key = timeline_cache_key(thread, request);
        let latest = events::latest_sequence(&self.db, &thread.thread.id)?;
        let ring = self.served.get(&key).unwrap_or_default();
        let full = match ring.iter().find(|entry| entry.latest == latest) {
            Some(entry) => entry.full.clone(),
            None => Arc::new(build_thread_timeline(&self.db, thread, request).await?),
        };
        let max_seq = |value: &Value| value.get("maxSeq").and_then(Value::as_i64);
        let previous = request
            .after_sequence
            .and_then(|after| ring.iter().find(|entry| max_seq(&entry.full) == Some(after)))
            .cloned();
        let ring = self.served.get(&key).unwrap_or(ring);
        let mut next: Vec<Served> =
            ring.into_iter().filter(|entry| max_seq(&entry.full) != max_seq(&full)).collect();
        next.push(Served { latest, full: full.clone() });
        let skip = next.len().saturating_sub(SERVED_RING_SIZE);
        self.served.remember(&key, next.split_off(skip));
        let Some(previous) = previous else { return Ok((*full).clone()) };
        let delta = if Arc::ptr_eq(&previous.full, &full) {
            json!({ "upsertRows": [] })
        } else {
            let rows = |value: &Value| value.get("rows").and_then(Value::as_array).cloned();
            compute_row_delta(
                &rows(&previous.full).unwrap_or_default(),
                &rows(&full).unwrap_or_default(),
            )
        };
        let mut response = (*full).clone();
        if let Some(fields) = response.as_object_mut() {
            fields.insert("rows".into(), json!([]));
            fields.insert("delta".into(), delta);
        }
        Ok(response)
    }

    /// `timelines.turnDetails(thread, request)`: the turn-summary-details response.
    pub async fn read_turn_summary_details(
        &self,
        thread: &ThreadListRow,
        request: &TurnDetailsRequest,
    ) -> ApiResult<Value> {
        build_turn_details(&self.db, thread, request).await
    }
}

/// `readThreadTimeline(db, thread, request)` without a reader: no cache and no deltas.
pub async fn read_thread_timeline(
    db: &Db,
    thread: &ThreadListRow,
    request: &TimelineRequest,
) -> ApiResult<Value> {
    build_thread_timeline(db, thread, request).await
}

/// `readTurnSummaryDetails(db, thread, request)`.
pub async fn read_turn_summary_details(
    db: &Db,
    thread: &ThreadListRow,
    request: &TurnDetailsRequest,
) -> ApiResult<Value> {
    build_turn_details(db, thread, request).await
}

struct ServerReader {
    owner: Weak<ServerContext>,
    reader: Arc<TimelineReader>,
    _listener: ListenerGuard,
}

static READERS: LazyLock<Mutex<Vec<ServerReader>>> = LazyLock::new(Mutex::default);

/// The server's one [`TimelineReader`], created on first use and dropped with the server
/// context. A thread's cached projections are forgotten when its history is rewritten.
pub fn timeline_reader(ctx: &Ctx) -> Arc<TimelineReader> {
    let key = Arc::downgrade(ctx);
    let mut readers = READERS.lock();
    readers.retain(|entry| entry.owner.strong_count() > 0);
    if let Some(entry) = readers.iter().find(|entry| entry.owner.ptr_eq(&key)) {
        return entry.reader.clone();
    }
    let reader = Arc::new(TimelineReader::new(ctx.db.clone()));
    let listener = {
        let reader = Arc::downgrade(&reader);
        ctx.hub.on_changed(move |message| {
            if let ChangedMessage::Thread { id, changes, .. } = message
                && changes.contains(&ThreadChangeKind::HistoryRewritten)
                && let Some(reader) = reader.upgrade()
            {
                reader.forget_thread(id);
            }
        })
    };
    readers.push(ServerReader { owner: key, reader: reader.clone(), _listener: listener });
    reader
}
