#![allow(clippy::result_large_err)]

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::context::Ctx;
use crate::db::environments::get_environment;
use crate::db::event_read::{EventQuery, SortOrder, last_output, list_events, to_thread_event_row};
use crate::db::hosts::{HostLookup, find_host, find_host_name};
use crate::db::pending_interactions::{
    get_pending_interaction, list_active_interactions, to_pending_interaction,
};
use crate::db::projects::{
    get_project_execution_defaults, list_standard_projects, require_project,
};
use crate::db::queued_messages::{
    list_queued_messages, parse_queued_content, to_thread_queued_message,
};
use crate::db::settings::get_app_settings;
use crate::db::thread_read::{
    PromptHistoryEntry, PromptHistoryScope, ThreadListQuery, ThreadListRow, find_thread_list_row,
    list_prompt_history_entries, list_thread_mention_rows, list_thread_rows,
    list_thread_rows_by_ids, thread_child_summary,
};
use crate::db::thread_search::{
    SEARCH_LIMIT_PER_GROUP_DEFAULT, SEARCH_LIMIT_PER_GROUP_MAX, ThreadSearchGroup, search_threads,
};
use crate::db::thread_sections::{list_thread_sections, require_thread_section};
use crate::domain::changes::ChangedMessage;
use crate::domain::events::scope_policy;
use crate::domain::project::PERSONAL_PROJECT_ID;
use crate::domain::settings::DEFAULT_COMPLETED_TURN_DISPLAY;
use crate::error::{ApiResult, invalid_request, not_found_message, thread_not_found};
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::http::compression::Uncompressed;
use crate::providers::catalog::find_provider_definition;
use crate::runners::hosts::host_response;
use crate::threads::execution::{ExecutionRequest, find_turn_execution, recorded_execution};
use crate::threads::thread_display::{
    list_projects_with_threads, to_thread_list_entries, to_thread_response,
};
use crate::threads::timeline::{
    TimelineDisplay, TimelineRequest, TurnDetailsRequest, timeline_reader,
};
use crate::threads::timeline_pages::{TimelinePage, TimelinePaginationCursor};

pub const THREAD_EVENT_LIST_PAGE_SIZE: i64 = 100;
pub const PROMPT_HISTORY_ENTRY_LIMIT: i64 = 50;
pub const THREAD_MENTION_RESOLVE_MAX_IDS: usize = 32;
const TIMELINE_WINDOW_EVENT_BUDGET: i64 = 1_500;
const DEFAULT_SEGMENT_LIMIT: i64 = 20;
const MAX_SEGMENT_LIMIT: i64 = 100;
const MAX_EVENT_WAIT_MS: i64 = 30_000;
const DIGITS: &str = "Invalid string: must match pattern /^\\d+$/";
const SEQUENCE: &str = "Invalid string: must match pattern /^(0|[1-9]\\d*)$/";
const NON_EMPTY: &str = "Too small: expected string to have >=1 characters";
const FLAG: &str = "Invalid option: expected one of \"true\"|\"false\"";
const ID_ALPHABET: &str = "23456789abcdefghijkmnpqrstuvwxyz";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryQuery {
    pub limit: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchQuery {
    pub query: Option<String>,
    pub limit_per_group: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMentionsRequest {
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ThreadGetQuery {
    pub include: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineQuery {
    pub include_nested_rows: Option<String>,
    pub segment_limit: Option<String>,
    pub before_anchor_seq: Option<String>,
    pub before_anchor_id: Option<String>,
    pub summary_only: Option<String>,
    pub after_sequence: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummaryDetailsQuery {
    pub before_cursor: Option<String>,
    pub turn_id: Option<String>,
    pub source_seq_start: Option<String>,
    pub source_seq_end: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventsQuery {
    pub after_seq: Option<String>,
    pub before_seq: Option<String>,
    pub limit: Option<String>,
    pub order: Option<String>,
    pub types: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventWaitQuery {
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub after_seq: Option<String>,
    pub wait_ms: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ThreadPath {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionPath {
    pub id: String,
    pub interaction_id: String,
}

pub fn thread_read_routes() -> Router<Ctx> {
    Router::new()
        .route("/sidebar-bootstrap", get(sidebar_bootstrap))
        .route("/projects/{id}/default-execution-options", get(project_execution_options))
        .route("/projects/{id}/prompt-history", get(project_prompt_history))
        .route("/threads", get(list))
        .route("/threads/search", get(search))
        .route("/threads/resolve-mentions", post(resolve_mentions))
        .route("/threads/{id}", get(show))
        .route("/threads/{id}/child-summary", get(child_summary))
        .route("/threads/{id}/timeline", get(timeline))
        .route("/threads/{id}/timeline/turn-summary-details", get(turn_summary_details))
        .route("/threads/{id}/output", get(output))
        .route("/threads/{id}/events", get(events))
        .route("/threads/{id}/events/wait", get(event_wait))
        .route("/threads/{id}/default-execution-options", get(thread_execution_options))
        .route("/threads/{id}/queued-messages", get(queued_messages))
        .route("/threads/{id}/interactions", get(interactions))
        .route("/threads/{id}/interactions/{interactionId}", get(interaction))
        .route("/threads/{id}/prompt-history", get(thread_prompt_history))
}

fn integer(value: Option<&str>) -> Option<i64> {
    value.map(|value| value.parse::<i64>().unwrap_or(i64::MAX))
}

fn positive(value: Option<&str>, name: &str, fallback: i64) -> ApiResult<i64> {
    let parsed = integer(value).unwrap_or(fallback);
    if parsed <= 0 {
        return Err(invalid_request(format!("{name} must be positive")));
    }
    Ok(parsed)
}

fn bounded(value: i64, name: &str, max: i64) -> ApiResult<i64> {
    if value <= max {
        return Ok(value);
    }
    Err(invalid_request(format!("{name} must be less than or equal to {max}")))
}

fn check(valid: bool, message: &str) -> ApiResult<()> {
    if valid { Ok(()) } else { Err(invalid_request(message)) }
}

fn digits(value: Option<&String>) -> ApiResult<()> {
    let valid = |value: &String| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    check(value.is_none_or(valid), DIGITS)
}

fn non_empty(value: Option<&String>) -> ApiResult<()> {
    check(value.is_none_or(|value| !value.is_empty()), NON_EMPTY)
}

fn flag(value: Option<&String>) -> ApiResult<()> {
    check(value.is_none_or(|value| value == "true" || value == "false"), FLAG)
}

fn required(value: Option<&String>) -> ApiResult<&String> {
    value.ok_or_else(|| invalid_request("Required"))
}

fn comma_list(value: &str, allowed: impl Fn(&str) -> bool) -> bool {
    value.split(',').all(|part| !part.is_empty() && allowed(part))
}

fn is_raw_thread_id(value: &str) -> bool {
    value.strip_prefix("thr_").is_some_and(|suffix| {
        suffix.chars().count() == 10 && suffix.chars().all(|c| ID_ALPHABET.contains(c))
    })
}

fn require_thread(ctx: &Ctx, id: &str) -> ApiResult<ThreadListRow> {
    match find_thread_list_row(&ctx.db, id)? {
        Some(thread) if thread.deleted_at.is_none() => Ok(thread),
        _ => Err(thread_not_found()),
    }
}

fn timeline_display(ctx: &Ctx, thread: &ThreadListRow) -> ApiResult<TimelineDisplay> {
    let provider_id = thread.provider_id.as_str();
    let settings = get_app_settings(&ctx.db)?;
    let provider = find_provider_definition(&ctx.db, provider_id).map(|definition| definition.info);
    let completed_turn_display = settings
        .provider_completed_turn_display
        .get(provider_id)
        .copied()
        .or(provider.as_ref().map(|info| info.completed_turn_display))
        .unwrap_or(DEFAULT_COMPLETED_TURN_DISPLAY);
    Ok(TimelineDisplay {
        completed_turn_display,
        include_diagnostic_operations: settings.show_diagnostic_events,
        provider_display_name: provider.map(|info| info.display_name),
    })
}

fn search_group(ctx: &Ctx, group: ThreadSearchGroup) -> ApiResult<Value> {
    let thread_ids: Vec<String> = group.hits.iter().map(|hit| hit.thread_id.clone()).collect();
    let rows = list_thread_rows_by_ids(&ctx.db, &thread_ids)?;
    let entries = to_thread_list_entries(ctx, &rows)?;
    let mut results = Vec::new();
    for hit in group.hits {
        if let Some(thread) = entries.iter().find(|entry| entry.thread.id == hit.thread_id) {
            results.push(json!({ "thread": thread, "matches": hit.matches }));
        }
    }
    Ok(json!({ "total": group.total, "results": results }))
}

fn take_visible_prompt_history_entries(
    entries: Vec<PromptHistoryEntry>,
    limit: i64,
) -> Vec<PromptHistoryEntry> {
    let mut visible: Vec<PromptHistoryEntry> = Vec::new();
    if limit <= 0 {
        return visible;
    }
    for entry in entries {
        if visible.last().is_some_and(|last| last.input == entry.input) {
            continue;
        }
        visible.push(entry);
        if visible.len() as i64 >= limit {
            break;
        }
    }
    visible
}

fn prompt_history(
    ctx: &Ctx,
    scope: PromptHistoryScope<'_>,
    query: &PromptHistoryQuery,
    queued: Vec<PromptHistoryEntry>,
) -> ApiResult<Vec<PromptHistoryEntry>> {
    let max = PROMPT_HISTORY_ENTRY_LIMIT;
    let wanted = positive(query.limit.as_deref(), "limit", max)?.min(max);
    let row_limit = (max * 2).min(wanted + max);
    let accepted = list_prompt_history_entries(&ctx.db, scope, row_limit)?;
    let mut entries: Vec<PromptHistoryEntry> = queued.into_iter().chain(accepted).collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
    Ok(take_visible_prompt_history_entries(entries, wanted))
}

async fn sidebar_bootstrap(State(ctx): State<Ctx>) -> ApiResponse<Value> {
    let personal = require_project(&ctx.db, PERSONAL_PROJECT_ID)?;
    let mut listed = vec![personal];
    listed.extend(list_standard_projects(&ctx.db)?);
    let mut projects = list_projects_with_threads(&ctx, listed)?.into_iter();
    let personal_project = projects.next();
    let rest: Vec<_> = projects.collect();
    let sections = list_thread_sections(&ctx.db)?;
    Ok(Json(json!({ "sections": sections, "projects": rest, "personalProject": personal_project })))
}

async fn project_execution_options(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
) -> ApiResponse<Value> {
    let project = require_project(&ctx.db, &path.id)?;
    Ok(Json(json!(get_project_execution_defaults(&ctx.db, &project.id)?)))
}

async fn project_prompt_history(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<PromptHistoryQuery>,
) -> ApiResponse<Vec<PromptHistoryEntry>> {
    digits(query.limit.as_ref())?;
    let project = require_project(&ctx.db, &path.id)?;
    Ok(Json(prompt_history(&ctx, PromptHistoryScope::Project(&project.id), &query, Vec::new())?))
}

fn validate_list_query(query: &ThreadListQuery) -> ApiResult<()> {
    for value in [&query.project_id, &query.environment_id, &query.host_id, &query.parent_thread_id]
    {
        non_empty(value.as_ref())?;
    }
    non_empty(query.section_id.as_ref())?;
    non_empty(query.origin_plugin_id.as_ref())?;
    digits(query.limit.as_ref())?;
    digits(query.offset.as_ref())
}

async fn list(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<ThreadListQuery>,
) -> ApiResponse<Value> {
    validate_list_query(&query)?;
    if query.section_id.is_some()
        && query.unsectioned == Some(crate::db::thread_read::QueryFlag::True)
    {
        return Err(invalid_request("sectionId and unsectioned cannot be used together"));
    }
    if let Some(project_id) = &query.project_id {
        require_project(&ctx.db, project_id)?;
    }
    if let Some(section_id) = &query.section_id {
        require_thread_section(&ctx.db, section_id)?;
    }
    if query.limit.is_some() {
        positive(query.limit.as_deref(), "limit", 1)?;
    }
    let rows = list_thread_rows(&ctx.db, &query)?;
    Ok(Json(json!(to_thread_list_entries(&ctx, &rows)?)))
}

async fn search(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<ThreadSearchQuery>,
) -> ApiResponse<Value> {
    let text = required(query.query.as_ref())?.trim();
    check(text.chars().count() >= 2, "Too small: expected string to have >=2 characters")?;
    digits(query.limit_per_group.as_ref())?;
    if text.chars().filter(|c| !c.is_whitespace()).count() < 2 {
        return Err(invalid_request("query must contain at least two non-whitespace characters"));
    }
    let limit = positive(
        query.limit_per_group.as_deref(),
        "limitPerGroup",
        SEARCH_LIMIT_PER_GROUP_DEFAULT,
    )?;
    let limit = bounded(limit, "limitPerGroup", SEARCH_LIMIT_PER_GROUP_MAX)?;
    let found = search_threads(&ctx.db, text, limit)?;
    let active = search_group(&ctx, found.active)?;
    Ok(Json(json!({ "active": active, "archived": search_group(&ctx, found.archived)? })))
}

async fn resolve_mentions(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<ResolveMentionsRequest>,
) -> ApiResponse<Value> {
    if payload.thread_ids.iter().any(|id| !is_raw_thread_id(id)) {
        return Err(invalid_request(format!(
            "Invalid string: must match pattern /^thr_[{ID_ALPHABET}]{{10}}$/u"
        )));
    }
    if payload.thread_ids.len() > THREAD_MENTION_RESOLVE_MAX_IDS {
        return Err(invalid_request(format!(
            "Too big: expected array to have <={THREAD_MENTION_RESOLVE_MAX_IDS} items"
        )));
    }
    let mut thread_ids: Vec<String> = Vec::new();
    for id in payload.thread_ids {
        if !thread_ids.contains(&id) {
            thread_ids.push(id);
        }
    }
    let rows = list_thread_mention_rows(&ctx.db, &thread_ids)?;
    let resolved: Vec<Value> = thread_ids
        .iter()
        .filter_map(|thread_id| {
            let thread = rows.iter().find(|row| &row.id == thread_id)?;
            let named = [&thread.title, &thread.title_fallback]
                .into_iter()
                .flatten()
                .find(|name| !name.trim().is_empty());
            let label = match named {
                Some(name) => name.clone(),
                None => format!("Thread {}", thread_id.chars().take(8).collect::<String>()),
            };
            Some(json!({ "threadId": thread_id, "projectId": thread.project_id, "label": label }))
        })
        .collect();
    Ok(Json(Value::Array(resolved)))
}

async fn show(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<ThreadGetQuery>,
) -> ApiResponse<Value> {
    non_empty(query.include.as_ref())?;
    let valid = |value: &String| comma_list(value, |part| part == "environment" || part == "host");
    check(query.include.as_ref().is_none_or(valid), "Invalid include")?;
    let thread = require_thread(&ctx, &path.id)?;
    let includes: HashSet<&str> =
        query.include.as_deref().map(|value| value.split(',').collect()).unwrap_or_default();
    let mut response = json!(to_thread_response(&ctx, &thread)?);
    let environment = match &thread.environment_id {
        Some(environment_id) if !includes.is_empty() => get_environment(&ctx.db, environment_id)?,
        _ => None,
    };
    if let Value::Object(fields) = &mut response {
        if includes.contains("environment") {
            fields.insert("environment".into(), json!(environment));
        }
        if includes.contains("host") {
            let host_id = environment.as_ref().map(|env| env.host_id.as_str()).unwrap_or_default();
            let host = find_host(&ctx.db, HostLookup::Id, host_id)?;
            let host = host.map(|host| host_response(&ctx, &host));
            fields.insert("host".into(), json!(host));
            fields.insert("environmentHostName".into(), json!(find_host_name(&ctx.db, host_id)?));
        }
    }
    Ok(Json(response))
}

async fn child_summary(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    Ok(Json(json!(thread_child_summary(&ctx.db, &thread.id)?)))
}

async fn timeline(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<ThreadTimelineQuery>,
) -> ApiResponse<Value> {
    flag(query.include_nested_rows.as_ref())?;
    digits(query.segment_limit.as_ref())?;
    let sequence = |value: &String| {
        value == "0"
            || (!value.starts_with('0') && !value.is_empty())
                && value.bytes().all(|b| b.is_ascii_digit())
    };
    check(query.before_anchor_seq.as_ref().is_none_or(sequence), SEQUENCE)?;
    non_empty(query.before_anchor_id.as_ref())?;
    flag(query.summary_only.as_ref())?;
    digits(query.after_sequence.as_ref())?;
    if query.before_anchor_seq.is_some() != query.before_anchor_id.is_some() {
        return Err(invalid_request(
            "beforeAnchorSeq and beforeAnchorId must be provided together",
        ));
    }
    let thread = require_thread(&ctx, &path.id)?;
    let segment_limit = integer(query.segment_limit.as_deref()).unwrap_or(DEFAULT_SEGMENT_LIMIT);
    let segment_limit = bounded(segment_limit, "segmentLimit", MAX_SEGMENT_LIMIT)?;
    if segment_limit <= 0 {
        return Err(invalid_request("segmentLimit must be a positive integer"));
    }
    let segment_limit = segment_limit as usize;
    let page = match (&query.before_anchor_seq, query.before_anchor_id) {
        (Some(anchor_seq), Some(anchor_id)) => TimelinePage::Older {
            segment_limit,
            before_cursor: TimelinePaginationCursor {
                anchor_seq: integer(Some(anchor_seq)).unwrap_or_default(),
                anchor_id,
            },
        },
        _ => TimelinePage::Latest { segment_limit },
    };
    let request = TimelineRequest {
        display: timeline_display(&ctx, &thread)?,
        page,
        include_nested_rows: query.include_nested_rows.as_deref() == Some("true"),
        summary_only: query.summary_only.as_deref() == Some("true"),
        event_budget: TIMELINE_WINDOW_EVENT_BUDGET,
        after_sequence: integer(query.after_sequence.as_deref()),
    };
    Ok(Json(timeline_reader(&ctx).read_thread_timeline(&thread, &request).await?))
}

async fn turn_summary_details(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<TurnSummaryDetailsQuery>,
) -> ApiResponse<Value> {
    non_empty(query.before_cursor.as_ref())?;
    let turn_id = required(query.turn_id.as_ref())?;
    non_empty(Some(turn_id))?;
    let start = required(query.source_seq_start.as_ref())?;
    digits(Some(start))?;
    let end = required(query.source_seq_end.as_ref())?;
    digits(Some(end))?;
    let thread = require_thread(&ctx, &path.id)?;
    let request = TurnDetailsRequest {
        display: timeline_display(&ctx, &thread)?,
        turn_id: turn_id.clone(),
        source_seq_start: integer(Some(start)).unwrap_or_default(),
        source_seq_end: integer(Some(end)).unwrap_or_default(),
        before_cursor: query.before_cursor.clone(),
    };
    Ok(Json(timeline_reader(&ctx).read_turn_summary_details(&thread, &request).await?))
}

async fn output(State(ctx): State<Ctx>, ApiPath(path): ApiPath<ThreadPath>) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    Ok(Json(json!({ "output": last_output(&ctx.db, &thread.id)? })))
}

async fn events(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<ThreadEventsQuery>,
) -> ApiResponse<Value> {
    digits(query.after_seq.as_ref())?;
    digits(query.before_seq.as_ref())?;
    digits(query.limit.as_ref())?;
    let page_size = THREAD_EVENT_LIST_PAGE_SIZE;
    let within = |value: &String| integer(Some(value)).is_some_and(|limit| limit <= page_size);
    let exceeded = format!("Thread event limit cannot exceed {page_size}");
    check(query.limit.as_ref().is_none_or(within), &exceeded)?;
    let order = match query.order.as_deref() {
        None => None,
        Some("asc") => Some(SortOrder::Asc),
        Some("desc") => Some(SortOrder::Desc),
        Some(_) => return Err(invalid_request("Invalid option: expected one of \"asc\"|\"desc\"")),
    };
    let known = |value: &String| comma_list(value, |part| scope_policy(part).is_some());
    check(query.types.as_ref().is_none_or(known), "Invalid thread event types")?;
    let thread = require_thread(&ctx, &path.id)?;
    let limit = positive(query.limit.as_deref(), "limit", page_size)?.min(page_size);
    let rows = list_events(
        &ctx.db,
        &EventQuery {
            after: integer(query.after_seq.as_deref()),
            before: integer(query.before_seq.as_deref()),
            limit: Some(limit),
            order,
            types: query.types.map(|types| types.split(',').map(String::from).collect()),
            ..EventQuery::new(thread.id.clone())
        },
    )?;
    Ok(Json(json!(rows.iter().map(to_thread_event_row).collect::<Vec<_>>())))
}

async fn event_wait(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<ThreadEventWaitQuery>,
) -> ApiResult<Response> {
    let event_type = required(query.event_type.as_ref())?;
    non_empty(Some(event_type))?;
    digits(query.after_seq.as_ref())?;
    digits(query.wait_ms.as_ref())?;
    let thread_id = require_thread(&ctx, &path.id)?.id.clone();
    if scope_policy(event_type).is_none() {
        return Err(invalid_request("Invalid event type"));
    }
    let after = integer(query.after_seq.as_deref());
    let wait_ms = integer(query.wait_ms.as_deref()).unwrap_or(MAX_EVENT_WAIT_MS);
    let wait_ms = wait_ms.clamp(0, MAX_EVENT_WAIT_MS) as u64;
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let changed = Arc::new(Notify::new());
    let _listener = {
        let changed = changed.clone();
        let thread_id = thread_id.clone();
        ctx.hub.on_changed(move |message| {
            if let ChangedMessage::Thread { id, .. } = message
                && *id == thread_id
            {
                changed.notify_one();
            }
        })
    };
    loop {
        let next = EventQuery {
            after,
            types: Some(vec![event_type.clone()]),
            limit: Some(1),
            ..EventQuery::new(thread_id.clone())
        };
        if let Some(found) = list_events(&ctx.db, &next)?.first() {
            let row = to_thread_event_row(found);
            return Ok((Extension(Uncompressed), Json(row)).into_response());
        }
        if Instant::now() >= deadline {
            return Ok((StatusCode::NO_CONTENT, Extension(Uncompressed)).into_response());
        }
        let _ = tokio::time::timeout_at(deadline, changed.notified()).await;
    }
}

async fn thread_execution_options(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    let execution = find_turn_execution(&ctx.db, &thread, &ExecutionRequest::default())?;
    Ok(Json(json!(execution.map(recorded_execution))))
}

async fn queued_messages(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    let rows = list_queued_messages(&ctx.db, &thread.id)?;
    let messages = rows.iter().map(to_thread_queued_message).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!(messages)))
}

async fn interactions(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    let rows = list_active_interactions(&ctx.db, &thread.id)?;
    let found = rows.iter().map(to_pending_interaction).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!(found)))
}

async fn interaction(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<InteractionPath>,
) -> ApiResponse<Value> {
    let thread = require_thread(&ctx, &path.id)?;
    match get_pending_interaction(&ctx.db, &path.interaction_id)? {
        Some(found) if found.thread_id == thread.id => {
            Ok(Json(json!(to_pending_interaction(&found)?)))
        }
        _ => Err(not_found_message("Interaction not found")),
    }
}

async fn thread_prompt_history(
    State(ctx): State<Ctx>,
    ApiPath(path): ApiPath<ThreadPath>,
    ApiQuery(query): ApiQuery<PromptHistoryQuery>,
) -> ApiResponse<Vec<PromptHistoryEntry>> {
    digits(query.limit.as_ref())?;
    let thread = require_thread(&ctx, &path.id)?;
    let mut queued = Vec::new();
    for row in list_queued_messages(&ctx.db, &thread.id)? {
        queued.push(PromptHistoryEntry {
            id: format!("queued-message:{}", row.id),
            created_at: row.created_at,
            input: parse_queued_content(&row)?,
        });
    }
    Ok(Json(prompt_history(&ctx, PromptHistoryScope::Thread(&thread.id), &query, queued)?))
}
