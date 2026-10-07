//! The port of `apps/server/src/http/routes/threads.ts`.

use std::collections::HashSet;

use axum::extract::State;
use axum::routing::{delete, patch, post, put};
use axum::{Json, Router};
use http::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::thread_sections::{
    self as sections, ThreadSectionMutationResponse, ThreadSectionResponse,
};
use crate::db::threads::require_thread;
use crate::db::{RevisionOutcome, RowValues, write_revision};
use crate::domain::changes::{
    ProjectChangeKind, ThreadChangeKind, ThreadChangeMetadata, ThreadOpenFile, ThreadOpenSignal,
    ThreadOpenSplit,
};
use crate::domain::pending_interaction::PendingInteraction;
use crate::domain::project::PERSONAL_PROJECT_ID;
use crate::error::{ApiError, invalid_request};
use crate::http::api::{ApiJson, ApiPath, ApiResponse};
use crate::http::validate::{
    Field, Kind, NON_EMPTY, check_array, check_object, check_present, check_record, nullable, opt,
    req,
};
use crate::threads::create::CreateThreadRequest;
use crate::threads::engine::ops;
use crate::threads::mutations::{
    CreateQueuedMessageRequest, ReorderPinnedThreadRequest, SendMessageRequest,
    SendMessageResponse, SendQueuedMessageMode, UpdateQueuedMessageRequest, UpdateThreadRequest,
};
use crate::threads::thread_display::{ThreadListEntry, ThreadResponse};

pub const PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const THREAD_TAB_ID_MAX_LENGTH: usize = 4_194_304;
const THREAD_TAB_PATH_MAX_LENGTH: usize = 32_768;
const THREAD_TAB_TITLE_MAX_LENGTH: usize = 1_024;
const THREAD_TAB_PARAMS_MAX_LENGTH: usize = 1_048_576;
const THREAD_TAB_LIST_MAX_LENGTH: usize = 200;
const THREAD_TABS_JSON_MAX_LENGTH: usize = 8_388_608;

type Created<T> = Result<(StatusCode, Json<T>), ApiError>;
type Ack = ApiResponse<Value>;

pub fn thread_routes() -> Router<Ctx> {
    Router::new()
        .route("/threads", post(create))
        .route("/threads/{id}", patch(update).delete(remove))
        .route("/threads/{id}/send", post(send))
        .route("/threads/{id}/stop", post(stop))
        .route("/threads/{id}/compact", post(compact))
        .route("/threads/{id}/context/clear", post(clear_context))
        .route("/threads/{id}/unarchive", post(unarchive))
        .route("/threads/{id}/archive-all", post(archive_all))
        .route("/threads/{id}/pin", post(pin))
        .route("/threads/{id}/unpin", post(unpin))
        .route("/threads/{id}/pin-order", patch(pin_order))
        .route("/threads/{id}/read", post(read))
        .route("/threads/{id}/unread", post(unread))
        .route("/threads/{id}/queued-messages", post(create_queued))
        .route(
            "/threads/{id}/queued-messages/{queued_message_id}",
            patch(update_queued).delete(delete_queued),
        )
        .route("/threads/{id}/queued-messages/{queued_message_id}/send", post(send_queued))
        .route("/threads/{id}/interactions/{interaction_id}/resolve", post(resolve_interaction))
        .route("/threads/{id}/interactions/{interaction_id}/respond", post(respond_interaction))
        .route("/threads/{id}/interactions/{interaction_id}/cancel", post(cancel_interaction))
        .route("/threads/{id}/open", post(open))
        .route("/threads/{id}/tabs", put(update_tabs).get(tabs))
        .route("/thread-sections", post(create_section).get(list_sections).patch(update_section))
        .route("/thread-sections", delete(delete_section))
}

const PIN_ORDER: &[Field] = &[
    req("previousThreadId", Kind::NullableStr { min: 1 }),
    req("nextThreadId", Kind::NullableStr { min: 1 }),
];

fn invalid() -> ApiError {
    invalid_request("Invalid request")
}

fn ok() -> Value {
    json!({ "ok": true })
}

fn parse<T: DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body)
        .map_err(|error| invalid_request(crate::http::validate::from_serde_error(&error)))
}

fn object(body: &Value) -> Result<&Map<String, Value>, ApiError> {
    body.as_object()
        .ok_or_else(|| invalid_request(crate::http::validate::invalid_type("object", body)))
}

fn strict(body: &Map<String, Value>, allowed: &[&str]) -> Result<(), ApiError> {
    match crate::http::validate::unknown_key(body, allowed) {
        None => Ok(()),
        Some(message) => Err(invalid_request(message)),
    }
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn non_empty_strings(
    body: &Map<String, Value>,
    keys: &[&str],
    nullable: bool,
) -> Result<(), ApiError> {
    for key in keys {
        match body.get(*key) {
            None => {}
            Some(Value::Null) if nullable => {}
            Some(Value::String(text)) if !text.is_empty() => {}
            Some(_) => return Err(invalid()),
        }
    }
    Ok(())
}

fn non_negative_int(body: &Map<String, Value>, key: &str, required: bool) -> Result<(), ApiError> {
    match body.get(key) {
        None if !required => Ok(()),
        Some(value) if value.as_u64().is_some() => Ok(()),
        _ => Err(invalid()),
    }
}

fn non_empty_input(body: &Map<String, Value>) -> Result<(), ApiError> {
    match body.get("input").and_then(Value::as_array) {
        Some(input) if !input.is_empty() => Ok(()),
        _ => Err(invalid()),
    }
}

fn is_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    first_ok && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

const REASONING_LEVELS: &[&str] =
    &["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"];
const VISIBILITIES: &[&str] = &["visible", "hidden"];

/// `createThreadRequestSchema` up to `pluginMetadata`, which is a record checked on its own.
const CREATE_HEAD: &[Field] = &[
    req("projectId", NON_EMPTY),
    opt("providerId", NON_EMPTY),
    req("origin", Kind::Enum(&["app", "cli", "sdk", "plugin"])),
    opt("originPluginId", NON_EMPTY),
];

const CREATE_BEFORE_INPUT: &[Field] = &[
    opt("lifecycleOwnerThreadId", NON_EMPTY),
    opt("visibility", Kind::Enum(VISIBILITIES)),
    opt("title", NON_EMPTY),
];

const CREATE_BEFORE_ENVIRONMENT: &[Field] = &[
    opt("model", NON_EMPTY),
    opt("serviceTier", Kind::Enum(&["fast", "default"])),
    opt("reasoningLevel", Kind::Enum(REASONING_LEVELS)),
    opt("permissionMode", Kind::Any),
    opt("executionInputSources", Kind::Object),
];

const CREATE_TAIL: &[Field] = &[
    opt("parentThreadId", NON_EMPTY),
    opt("sectionId", Kind::NullableStr { min: 1 }),
    opt("pinned", Kind::Bool),
    opt("startedOnBehalfOf", Kind::Object),
    opt("sendAt", Kind::Int { min: Some(0), max: None, positive: false }),
    opt("pluginSubmission", Kind::Object),
];

/// The first zod issue of `createThreadRequestSchema`'s fields, in schema order; nested shapes
/// (`input` items, `environment`, ...) are left to the typed parse.
fn check_create_fields(body: &Value) -> Result<(), String> {
    check_object(body, CREATE_HEAD, false)?;
    check_record(body.get("pluginMetadata"))?;
    check_object(body, CREATE_BEFORE_INPUT, false)?;
    check_array(body.get("input"), 0, None)?;
    check_object(body, CREATE_BEFORE_ENVIRONMENT, false)?;
    check_present(body.get("environment"))?;
    let tail: Vec<Field> = CREATE_TAIL
        .iter()
        .map(|field| if field.key == "startedOnBehalfOf" { nullable(body, *field) } else { *field })
        .collect();
    check_object(body, &tail, false)
}

fn validate_create(body: &Value) -> Result<CreateThreadRequest, ApiError> {
    check_create_fields(body).map_err(invalid_request)?;
    let fields = object(body)?;
    let origin = fields.get("origin").and_then(Value::as_str);
    let origin_plugin_id = fields.get("originPluginId").and_then(Value::as_str);
    let is_plugin = origin == Some("plugin");
    if is_plugin && origin_plugin_id.is_none() {
        return Err(invalid_request(r#"originPluginId is required when origin is "plugin""#));
    }
    if !is_plugin && origin_plugin_id.is_some() {
        return Err(invalid_request(r#"originPluginId requires origin "plugin""#));
    }
    let has_metadata = fields.contains_key("pluginMetadata");
    if has_metadata && !is_plugin {
        return Err(invalid_request(r#"pluginMetadata requires origin "plugin""#));
    }
    if has_metadata && origin_plugin_id.is_some_and(|id| !is_plugin_id(id)) {
        return Err(invalid_request(
            "pluginMetadata requires originPluginId to be a valid plugin id",
        ));
    }
    if fields.get("input").and_then(Value::as_array).is_some_and(Vec::is_empty) {
        return Err(invalid_request("input must contain at least one entry"));
    }
    parse(body.clone())
}

async fn create(State(ctx): State<Ctx>, ApiJson(body): ApiJson<Value>) -> Created<ThreadResponse> {
    let request = validate_create(&body)?;
    Ok((StatusCode::CREATED, Json(ops::create(&ctx, request).await?)))
}

/// `updateThreadRequestSchema`: every field optional and all but `visibility` nullable.
const UPDATE: &[Field] = &[
    opt("title", Kind::NullableStr { min: 1 }),
    opt("sectionId", Kind::NullableStr { min: 1 }),
    opt("parentThreadId", Kind::NullableStr { min: 1 }),
    opt("model", Kind::NullableStr { min: 1 }),
    opt("reasoningLevel", Kind::Enum(REASONING_LEVELS)),
    opt("visibility", Kind::Enum(VISIBILITIES)),
];

async fn update(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<ThreadResponse> {
    let fields: Vec<Field> = UPDATE
        .iter()
        .map(|field| if field.key == "visibility" { *field } else { nullable(&body, *field) })
        .collect();
    check_object(&body, &fields, false).map_err(invalid_request)?;
    let fields = object(&body)?;
    if !UPDATE.iter().any(|field| fields.contains_key(field.key)) {
        return Err(invalid_request("At least one field must be provided"));
    }
    let patch: UpdateThreadRequest = parse(body)?;
    Ok(Json(ops::update(&ctx, &id, patch).await?))
}

async fn remove(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> Ack {
    check_object(&body, &[req("childThreadsConfirmed", Kind::Bool)], false)
        .map_err(invalid_request)?;
    let confirmed = body.get("childThreadsConfirmed").and_then(Value::as_bool).ok_or_else(invalid)?;
    ops::delete(&ctx, &id, confirmed).await?;
    Ok(Json(ok()))
}

async fn send(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<SendMessageResponse> {
    let fields = object(&body)?;
    non_empty_input(fields)?;
    non_empty_strings(fields, &["senderThreadId"], false)?;
    non_negative_int(fields, "sendAt", false)?;
    let request: SendMessageRequest = parse(body)?;
    Ok(Json(ops::send(&ctx, &id, request).await?))
}

async fn stop(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> Ack {
    ops::stop(&ctx, &id).await?;
    Ok(Json(ok()))
}

async fn compact(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> Ack {
    ops::compact(&ctx, &id).await?;
    Ok(Json(ok()))
}

async fn clear_context(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> Ack {
    ops::clear_context(&ctx, &id).await?;
    Ok(Json(ok()))
}

async fn unarchive(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> Ack {
    ops::unarchive(&ctx, &id).await?;
    Ok(Json(ok()))
}

async fn archive_all(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> Ack {
    let archived_thread_ids = ops::archive(&ctx, &id).await?;
    Ok(Json(json!({ "ok": true, "archivedThreadIds": archived_thread_ids })))
}

async fn pin(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<ThreadResponse> {
    Ok(Json(ops::pin(&ctx, &id).await?))
}

async fn unpin(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<ThreadResponse> {
    Ok(Json(ops::unpin(&ctx, &id).await?))
}

async fn pin_order(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<Vec<ThreadListEntry>> {
    check_object(&body, PIN_ORDER, false).map_err(invalid_request)?;
    let fields = object(&body)?;
    for key in ["previousThreadId", "nextThreadId"] {
        if !fields.contains_key(key) {
            return Err(invalid());
        }
    }
    non_empty_strings(fields, &["previousThreadId", "nextThreadId"], true)?;
    let request: ReorderPinnedThreadRequest = parse(body)?;
    Ok(Json(ops::reorder_pinned(&ctx, &id, request)?))
}

async fn read(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<ThreadResponse> {
    Ok(Json(ops::mark_read(&ctx, &id).await?))
}

async fn unread(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
) -> ApiResponse<ThreadResponse> {
    Ok(Json(ops::mark_unread(&ctx, &id).await?))
}

async fn create_queued(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> Created<Value> {
    let fields = object(&body)?;
    non_empty_input(fields)?;
    non_empty_strings(fields, &["senderThreadId"], false)?;
    let request: CreateQueuedMessageRequest = parse(body)?;
    let queued = ops::create_queued_message(&ctx, &id, request).await?;
    Ok((StatusCode::CREATED, Json(queued)))
}

async fn update_queued(
    State(ctx): State<Ctx>,
    ApiPath((id, queued_message_id)): ApiPath<(String, String)>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<Value> {
    let fields = object(&body)?;
    non_empty_input(fields)?;
    non_negative_int(fields, "expectedUpdatedAt", true)?;
    let request: UpdateQueuedMessageRequest = parse(body)?;
    Ok(Json(ops::update_queued_message(&ctx, &id, &queued_message_id, request).await?))
}

async fn delete_queued(
    State(ctx): State<Ctx>,
    ApiPath((id, queued_message_id)): ApiPath<(String, String)>,
) -> Ack {
    ops::delete_queued_message(&ctx, &id, &queued_message_id).await?;
    Ok(Json(ok()))
}

async fn send_queued(
    State(ctx): State<Ctx>,
    ApiPath((id, queued_message_id)): ApiPath<(String, String)>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<SendMessageResponse> {
    let mode: SendQueuedMessageMode = parse(body.get("mode").cloned().unwrap_or(Value::Null))?;
    Ok(Json(ops::send_queued_message_now(&ctx, &id, &queued_message_id, mode).await?))
}

/// `pendingInteractionResolutionSchema` is a plain union with a custom error: a body that no member
/// accepts reports that one message. Members are told apart here by their discriminating key; their
/// nested fields are checked by the resolution itself.
fn check_resolution(body: &Value) -> Result<(), String> {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let object_or_null = |key: &str| body.get(key).is_some_and(|v| v.is_object() || v.is_null());
    let matched = match (text("decision"), text("kind")) {
        (Some("allow_once" | "allow_for_session"), _) if object_or_null("grantedPermissions") => true,
        (Some("deny"), _) => true,
        (_, Some("user_answer")) => body.get("answers").is_some_and(Value::is_object),
        (_, Some("plugin_submitted")) => body.get("description").is_none_or(Value::is_object),
        (_, Some("request_answer")) => body.get("value").is_some(),
        _ => false,
    };
    if matched {
        return Ok(());
    }
    Err("Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'".to_owned())
}

async fn resolve_interaction(
    State(ctx): State<Ctx>,
    ApiPath((id, interaction_id)): ApiPath<(String, String)>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<PendingInteraction> {
    check_resolution(&body).map_err(invalid_request)?;
    Ok(Json(ops::resolve_interaction(&ctx, &id, &interaction_id, body).await?))
}

async fn respond_interaction(
    State(ctx): State<Ctx>,
    ApiPath((id, interaction_id)): ApiPath<(String, String)>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<PendingInteraction> {
    // `value` is `jsonValueSchema`, a union: a missing value fails every member.
    let value = object(&body)?.get("value").cloned().ok_or_else(|| invalid_request("Invalid input"))?;
    let size = serde_json::to_string(&value).map_or(0, |json| json.len());
    if size > PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES {
        let message = "Interaction response exceeds 64 KiB";
        return Err(ApiError::new(413, "invalid_request", message));
    }
    Ok(Json(ops::respond_to_interaction(&ctx, &id, &interaction_id, value).await?))
}

async fn cancel_interaction(
    State(ctx): State<Ctx>,
    ApiPath((id, interaction_id)): ApiPath<(String, String)>,
) -> ApiResponse<PendingInteraction> {
    Ok(Json(ops::cancel_interaction(&ctx, &id, &interaction_id).await?))
}

const OPEN_SPLIT: Field = opt("split", Kind::Enum(&["right", "down", "left", "top", "replace"]));

async fn open(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<Value> {
    let open_fields = [OPEN_SPLIT, nullable(&body, req("file", Kind::Object))];
    check_object(&body, &open_fields, false).map_err(invalid_request)?;
    let fields = object(&body)?;
    let file: Option<ThreadOpenFile> = parse(fields.get("file").cloned().ok_or_else(invalid)?)?;
    strict(fields, &["split", "file"])?;
    let split: Option<ThreadOpenSplit> =
        parse(fields.get("split").cloned().unwrap_or(Value::Null))?;
    let thread = require_thread(&ctx.db, &id)?;
    if file.as_ref().is_some_and(|file| file.path.split('/').any(|part| part == "..")) {
        return Err(invalid_request("File path must stay inside its root."));
    }
    let split = split.unwrap_or(ThreadOpenSplit::Replace);
    let delivered = ctx.hub.thread_open(ThreadOpenSignal {
        project_id: thread.project_id.clone(),
        thread_id: thread.id.clone(),
        split,
        file,
    });
    Ok(Json(json!({ "delivered": delivered })))
}

#[derive(Clone, Copy)]
enum Rule {
    Kind,
    Text(usize),

    NullableNonEmpty,
    Params,
    LineRange,
    Source,
    StatusLabel,
    Owner,
    Target,
}

#[derive(Clone, Copy, PartialEq)]
enum Presence {
    Required,
    Optional,
    DefaultNull,
}

use Presence::{DefaultNull, Optional, Required};

fn tab_fields(kind: &str) -> Option<&'static [(&'static str, Rule, Presence)]> {
    const ID: (&str, Rule, Presence) = ("id", Rule::Text(THREAD_TAB_ID_MAX_LENGTH), Required);
    const KIND: (&str, Rule, Presence) = ("kind", Rule::Kind, Required);
    const PATH: (&str, Rule, Presence) = ("path", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required);
    const LINES: (&str, Rule, Presence) = ("lineRange", Rule::LineRange, Required);
    const ENV: (&str, Rule, Presence) = ("environmentId", Rule::NullableNonEmpty, Required);
    let fields: &'static [(&'static str, Rule, Presence)] = match kind {
        "thread-info" | "git-diff" | "new-tab" => &[ID, KIND],
        "plugin-panel" => &[
            ("actionId", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required),
            ("fileOpenerOwner", Rule::Owner, Optional),
            ID,
            KIND,
            ("paramsJson", Rule::Params, Required),
            ("pluginId", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required),
            ("title", Rule::Text(THREAD_TAB_TITLE_MAX_LENGTH), Required),
        ],
        "workspace-file-preview" => &[
            ENV,
            ID,
            KIND,
            LINES,
            PATH,
            ("projectId", Rule::NullableNonEmpty, Required),
            ("source", Rule::Source, Required),
            ("statusLabel", Rule::StatusLabel, Required),
        ],
        "host-file-preview" => &[
            ENV,
            ("hostId", Rule::NullableNonEmpty, DefaultNull),
            ID,
            KIND,
            LINES,
            PATH,
            ("threadId", Rule::NullableNonEmpty, Required),
        ],
        "terminal" => &[
            ID,
            KIND,
            ("target", Rule::Target, Optional),
            ("terminalId", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required),
        ],
        _ => return None,
    };
    Some(fields)
}

fn shaped(
    value: &Value,
    fields: &[(&str, Rule, Presence)],
    check: impl Fn(Rule, &Value) -> Option<Value>,
) -> Option<Value> {
    let input = value.as_object()?;
    if !input.keys().all(|key| fields.iter().any(|(name, _, _)| name == key)) {
        return None;
    }
    let mut out = Map::new();
    for (name, rule, presence) in fields {
        match (input.get(*name), presence) {
            (None, Required) => return None,
            (None, Optional) => {}
            (None, DefaultNull) => {
                out.insert((*name).to_owned(), Value::Null);
            }
            (Some(field), _) => {
                out.insert((*name).to_owned(), check(*rule, field)?);
            }
        }
    }
    Some(Value::Object(out))
}

fn check_rule(rule: Rule, value: &Value) -> Option<Value> {
    let text = value.as_str();
    let ok = match rule {
        Rule::Kind => text.is_some(),
        Rule::Text(max) => text.is_some_and(|t| !t.is_empty() && js_len(t) <= max),
        Rule::NullableNonEmpty => value.is_null() || text.is_some_and(|t| !t.is_empty()),
        Rule::Params => {
            value.is_null() || text.is_some_and(|t| js_len(t) <= THREAD_TAB_PARAMS_MAX_LENGTH)
        }
        Rule::StatusLabel => value.is_null() || text == Some("deleted"),
        Rule::LineRange => {
            return if value.is_null() { Some(Value::Null) } else { line_range(value) };
        }
        Rule::Source => return source(value),
        Rule::Owner => return owner(value),
        Rule::Target => return target(value),
    };
    ok.then(|| value.clone())
}

fn line_range(value: &Value) -> Option<Value> {
    let positive = |key: &str| value.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
    let (end, start) = (positive("endLineNumber")?, positive("startLineNumber")?);
    let fields =
        [("endLineNumber", Rule::Kind, Required), ("startLineNumber", Rule::Kind, Required)];
    (start <= end).then(|| shaped(value, &fields, |_, field| Some(field.clone())))?
}

fn source(value: &Value) -> Option<Value> {
    let kind = ("kind", Rule::Kind, Required);
    match value.get("kind").and_then(Value::as_str)? {
        "working-tree" | "head" => shaped(value, &[kind], check_rule),
        "merge-base" => shaped(
            value,
            &[kind, ("ref", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required)],
            check_rule,
        ),
        _ => None,
    }
}

fn target(value: &Value) -> Option<Value> {
    value.get("kind").and_then(Value::as_str).map(|_| value.clone())
}

fn owner(value: &Value) -> Option<Value> {
    let lines = ("lineRange", Rule::LineRange, Required);
    let path = ("path", Rule::Text(THREAD_TAB_PATH_MAX_LENGTH), Required);
    match value.get("kind").and_then(Value::as_str)? {
        "workspace-file-preview" => {
            let tab = [
                lines,
                path,
                ("source", Rule::Source, Required),
                ("statusLabel", Rule::StatusLabel, Required),
            ];
            let tab = shaped(value.get("tab")?, &tab, check_rule)?;
            let fields = [
                ("environmentId", Rule::NullableNonEmpty, Required),
                ("kind", Rule::Kind, Required),
                ("projectId", Rule::NullableNonEmpty, Required),
                ("tab", Rule::Kind, Required),
                ("threadId", Rule::NullableNonEmpty, Required),
            ];
            let mut shaped_owner = shaped(value, &fields, |rule, field| match rule {
                Rule::Kind => Some(field.clone()),
                other => check_rule(other, field),
            })?;
            shaped_owner["tab"] = tab;
            Some(shaped_owner)
        }
        "host-file-preview" => {
            let tab = shaped(value.get("tab")?, &[lines, path], check_rule)?;
            let fields = [
                ("environmentId", Rule::NullableNonEmpty, DefaultNull),
                ("hostId", Rule::NullableNonEmpty, DefaultNull),
                ("kind", Rule::Kind, Required),
                ("tab", Rule::Kind, Required),
                ("threadId", Rule::NullableNonEmpty, DefaultNull),
            ];
            let mut shaped_owner = shaped(value, &fields, |rule, field| match rule {
                Rule::Kind => Some(field.clone()),
                other => check_rule(other, field),
            })?;
            shaped_owner["tab"] = tab;
            let has_host = !shaped_owner["hostId"].is_null();
            let has_thread =
                !shaped_owner["environmentId"].is_null() && !shaped_owner["threadId"].is_null();
            (has_host || has_thread).then_some(shaped_owner)
        }
        _ => None,
    }
}

/// Parses one tab with `threadTabSchema`, returning it in schema key order with defaults filled.
pub fn parse_thread_tab(value: &Value) -> Option<Value> {
    let fields = tab_fields(value.get("kind").and_then(Value::as_str)?)?;
    shaped(value, fields, check_rule)
}

fn parse_thread_tabs(value: &Value) -> Result<Vec<Value>, ApiError> {
    let candidates = value.as_array().ok_or_else(invalid)?;
    if candidates.len() > THREAD_TAB_LIST_MAX_LENGTH {
        return Err(invalid());
    }
    let tabs = candidates.iter().map(parse_thread_tab).collect::<Option<Vec<_>>>();
    let tabs = tabs.ok_or_else(invalid)?;
    let json = serde_json::to_string(&tabs).map_err(ApiError::internal)?;
    if js_len(&json) > THREAD_TABS_JSON_MAX_LENGTH {
        return Err(invalid_request("Thread tabs payload is too large"));
    }
    let mut seen = HashSet::new();
    for tab in &tabs {
        let id = tab["id"].as_str().unwrap_or_default();
        if !seen.insert(id.to_owned()) {
            return Err(invalid_request(format!("Duplicate tab id: {id}")));
        }
    }
    Ok(tabs)
}

fn to_wire_tab(mut tab: Value) -> Value {
    let kind = tab["kind"].as_str().unwrap_or_default().to_owned();
    let Some(fields) = tab.as_object_mut() else { return tab };
    if kind == "host-file-preview" {
        if fields.get("hostId").is_some_and(Value::is_null) {
            fields.shift_remove("hostId");
        }
        return tab;
    }
    if kind == "plugin-panel"
        && let Some(Value::Object(owner)) = fields.get_mut("fileOpenerOwner")
        && owner.get("kind").and_then(Value::as_str) == Some("host-file-preview")
        && owner.get("hostId").is_some_and(Value::is_null)
    {
        owner.shift_remove("hostId");
    }
    tab
}

fn stored_wire_tabs(tabs_json: &str) -> Vec<Value> {
    let parsed: Value = serde_json::from_str(tabs_json).unwrap_or(Value::Null);
    let candidates = parsed.as_array().cloned().unwrap_or_default();
    candidates.iter().filter_map(parse_thread_tab).map(to_wire_tab).collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTabs {
    revision: i64,
    tabs_json: String,
}

async fn tabs(State(ctx): State<Ctx>, ApiPath(id): ApiPath<String>) -> ApiResponse<Value> {
    let thread = require_thread(&ctx.db, &id)?;
    let sql = "SELECT revision, tabs_json FROM thread_tabs WHERE thread_id = ?";
    let stored: Option<StoredTabs> = ctx.db.get(sql, [&thread.id])?;
    let Some(StoredTabs { revision, tabs_json }) = stored else {
        return Ok(Json(json!({ "revision": 0, "tabs": [] })));
    };
    Ok(Json(json!({ "revision": revision, "tabs": stored_wire_tabs(&tabs_json) })))
}

async fn update_tabs(
    State(ctx): State<Ctx>,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<Value> {
    let revision = req("expectedRevision", Kind::Int { min: Some(0), max: None, positive: false });
    check_object(&body, &[revision], false).map_err(invalid_request)?;
    check_array(body.get("tabs"), 0, Some(THREAD_TAB_LIST_MAX_LENGTH)).map_err(invalid_request)?;
    let fields = object(&body)?;
    let expected = fields.get("expectedRevision").and_then(Value::as_u64).ok_or_else(invalid)?;
    let tabs = parse_thread_tabs(fields.get("tabs").ok_or_else(invalid)?)?;
    strict(fields, &["expectedRevision", "tabs"])?;
    let thread = require_thread(&ctx.db, &id)?;
    let tabs_json = serde_json::to_string(&tabs).map_err(ApiError::internal)?;
    let row = RowValues::new().set("threadId", thread.id.as_str()).set("tabsJson", tabs_json);
    let expected = i64::try_from(expected).map_err(|_| invalid())?;
    let write = write_revision(&ctx.db, "thread_tabs", "threadId", &row, Some(expected))?;
    if write.outcome == RevisionOutcome::Conflict {
        let message = "Thread tabs changed on another client";
        let details = json!({ "currentRevision": write.revision });
        return Err(ApiError::new(409, "thread_tabs_conflict", message).details(details));
    }
    ctx.hub.thread(&thread.id, vec![ThreadChangeKind::TabsChanged], None);
    let tabs: Vec<Value> = tabs.into_iter().map(to_wire_tab).collect();
    Ok(Json(json!({ "revision": write.revision, "tabs": tabs })))
}

fn section_name(name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid_request("Section name cannot be empty"));
    }
    Ok(trimmed.to_owned())
}

fn section_field(body: &Value, allowed: &[&str], key: &str) -> Result<String, ApiError> {
    let fields = object(body)?;
    strict(fields, allowed)?;
    match fields.get(key).and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => Err(invalid()),
    }
}

fn announce_sections(ctx: &Ctx) {
    ctx.hub.project(PERSONAL_PROJECT_ID, vec![ProjectChangeKind::ThreadsChanged]);
}

async fn list_sections(State(ctx): State<Ctx>) -> ApiResponse<Vec<ThreadSectionResponse>> {
    Ok(Json(sections::list_thread_sections(&ctx.db)?))
}

async fn create_section(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Value>,
) -> Created<ThreadSectionResponse> {
    check_object(&body, &[req("name", NON_EMPTY)], false).map_err(invalid_request)?;
    let name = section_name(&section_field(&body, &["name"], "name")?)?;
    let section = sections::create_thread_section(&ctx.db, &name)?;
    announce_sections(&ctx);
    Ok((StatusCode::CREATED, Json(section)))
}

async fn update_section(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<ThreadSectionMutationResponse> {
    check_object(&body, &[req("id", NON_EMPTY), req("name", NON_EMPTY)], false)
        .map_err(invalid_request)?;
    let id = section_field(&body, &["id", "name"], "id")?;
    let name = section_name(&section_field(&body, &["id", "name"], "name")?)?;
    let renamed = sections::rename_thread_section(&ctx.db, &id, &name)?;
    announce_sections(&ctx);
    Ok(Json(renamed))
}

async fn delete_section(
    State(ctx): State<Ctx>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResponse<ThreadSectionMutationResponse> {
    check_object(&body, &[req("id", NON_EMPTY)], false).map_err(invalid_request)?;
    let id = section_field(&body, &["id"], "id")?;
    let deleted = sections::delete_thread_section(&ctx.db, &id)?;
    for thread in &deleted.threads {
        let metadata = ThreadChangeMetadata {
            project_id: Some(thread.project_id.clone()),
            ..Default::default()
        };
        ctx.hub.thread(&thread.id, vec![ThreadChangeKind::TitleChanged], Some(metadata));
    }
    let mut projects = indexmap::IndexSet::from([PERSONAL_PROJECT_ID.to_owned()]);
    projects.extend(deleted.threads.iter().map(|thread| thread.project_id.clone()));
    for project_id in projects {
        ctx.hub.project(&project_id, vec![ProjectChangeKind::ThreadsChanged]);
    }
    Ok(Json(deleted.response()))
}
