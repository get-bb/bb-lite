//! Pending provider and plugin interactions. The port of
//! `apps/server/src/threads/interactions.ts`.

use std::time::Duration;

use bb_core::types::ProviderId;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::core::Outbox;
use super::engine::{
    background, commit, connected_host_of, in_thread, later, on_host, respond, schedule_drain,
};
use super::parent_notices::notify_parent_blocked;
use crate::context::Ctx;
use crate::db::pending_interactions::{
    self as pending, InteractionSettlement, NewPendingInteraction, PendingInteractionRow,
};
use crate::db::threads::{ThreadRow, get_thread};
use crate::domain::changes::{ThreadChangeKind, ThreadChangeMetadata};
use crate::domain::events::{thread_scope, turn_scope};
use crate::domain::pending_interaction::{
    PendingInteraction, PendingInteractionOriginKind, PendingInteractionStatus,
};
use crate::error::{
    ApiError, ApiResult, conflict, host_unavailable, invalid_request, thread_not_found,
};
use crate::plugins::api::{DescribeSubmission, InputResult};

pub struct PluginInputRequest {
    pub thread_id: String,
    pub plugin_id: String,
    pub renderer_id: String,
    pub title: String,
    pub payload: Value,
    /// `ThreadEventItemPresentation`.
    pub presentation: Option<Value>,
    pub cancel: Option<CancellationToken>,
    /// The request's `timeoutMs`; when it runs out the request is cancelled
    /// with reason `timeout`.
    pub timeout: Option<Duration>,
    pub describe_submission: Option<DescribeSubmission>,
}

pub struct InputWaiter {
    pub resolve: oneshot::Sender<InputResult>,
    pub dispose: Box<dyn FnOnce() + Send>,
    pub describe_submission: Option<DescribeSubmission>,
}

/// The `interaction.requested` runner event.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderInteractionRequest {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: String,
    pub provider_id: ProviderId,
    pub provider_thread_id: String,
    pub payload: Value,
}

/// The `interaction.cancelled` runner event.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderInteractionCancel {
    pub thread_id: String,
    pub request_id: String,
    pub reason: String,
}

const ACTIVE: &[PendingInteractionStatus] =
    &[PendingInteractionStatus::Pending, PendingInteractionStatus::Resolving];
const GONE_REASON: &str = "The provider is no longer waiting for this interaction";
const MAX_DESCRIPTION_TITLE_LENGTH: usize = 160;
const MAX_DESCRIPTION_DETAIL_LENGTH: usize = 280;
const MAX_DESCRIPTION_PAYLOAD_BYTES: usize = 64 * 1024;

fn is_extension_kind(kind: &str) -> bool {
    let valid = |part: &str| {
        !part.is_empty()
            && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    kind.split_once('/').is_some_and(|(plugin, name)| valid(plugin) && valid(name))
}

/// `toInteractionLifecycle`.
fn to_interaction_lifecycle(interaction: &PendingInteraction) -> ApiResult<Value> {
    let mut record = Map::new();
    record.insert("id".into(), json!(interaction.id));
    record.insert("status".into(), serde_json::to_value(interaction.status)?);
    record.insert("statusReason".into(), json!(interaction.status_reason));
    let resolution = interaction.resolution.clone().unwrap_or(Value::Null);
    let (origin, payload, resolution) = if interaction.is_plugin() {
        let mut payload = interaction.payload.clone();
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("data");
        }
        (serde_json::to_value(&interaction.origin)?, payload, resolution)
    } else {
        let origin = json!({
            "kind": "provider",
            "providerId": interaction.provider_id,
            "providerRequestId": interaction.provider_request_id,
        });
        if interaction.is_approval() {
            let mut payload = interaction.payload.clone();
            if let Some(fields) = payload.as_object_mut() {
                fields.remove("availableDecisions");
            }
            (origin, payload, resolution)
        } else if interaction.is_user_question() {
            (origin, interaction.payload.clone(), resolution)
        } else {
            let payload = json!({
                "kind": interaction.payload["kind"],
                "title": interaction.payload["title"],
            });
            let resolution =
                if resolution.is_null() { Value::Null } else { json!({"kind": "request_answer"}) };
            (origin, payload, resolution)
        }
    };
    record.insert("origin".into(), origin);
    record.insert("payload".into(), payload);
    record.insert("resolution".into(), resolution);
    Ok(Value::Object(record))
}

fn announce(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    row: &PendingInteractionRow,
) -> ApiResult<PendingInteraction> {
    let interaction = pending::to_pending_interaction(row)?;
    let scope = match &row.turn_id {
        None => thread_scope(),
        Some(turn_id) => turn_scope(turn_id),
    };
    let lifecycle = to_interaction_lifecycle(&interaction)?;
    let event = json!({
        "type": "system/interaction/lifecycle",
        "scope": scope,
        "interaction": lifecycle,
    });
    super::engine::append(ctx, out, thread, &[event])?;
    let active = pending::list_active_interactions(&ctx.db, &thread.id)?;
    let metadata = ThreadChangeMetadata {
        has_pending_interaction: Some(!active.is_empty()),
        project_id: Some(thread.project_id.clone()),
        ..Default::default()
    };
    out.thread(&thread.id, vec![ThreadChangeKind::InteractionsChanged], Some(metadata));
    Ok(interaction)
}

fn settle_waiter(ctx: &Ctx, interaction_id: &str, result: InputResult) {
    let Some(waiter) = ctx.engine.input_waiters.lock().remove(interaction_id) else { return };
    (waiter.dispose)();
    let _ = waiter.resolve.send(result);
}

fn settle(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    id: &str,
    from: &[PendingInteractionStatus],
    next: InteractionSettlement,
    answer: Option<InputResult>,
) -> ApiResult<Option<PendingInteraction>> {
    let status = next.status;
    let reason = next.status_reason.clone().unwrap_or_else(|| "thread-stopped".to_owned());
    let Some(row) = pending::settle_interaction(&ctx.db, id, from, next)? else { return Ok(None) };
    let result = answer.unwrap_or(InputResult::Cancelled { reason });
    if status != PendingInteractionStatus::Resolving {
        let (ctx, id) = (ctx.clone(), id.to_owned());
        out.after(move || settle_waiter(&ctx, &id, result));
    }
    announce(ctx, out, thread, &row).map(Some)
}

fn interrupted(reason: &str) -> InteractionSettlement {
    InteractionSettlement {
        status: PendingInteractionStatus::Interrupted,
        status_reason: Some(reason.to_owned()),
        resolution: None,
    }
}

pub fn interrupt_all(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    status_reason: &str,
) -> ApiResult<()> {
    for row in pending::list_active_interactions(&ctx.db, &thread.id)? {
        settle(ctx, out, thread, &row.id, ACTIVE, interrupted(status_reason), None)?;
    }
    Ok(())
}

fn denial(payload: &Value) -> Value {
    match payload["kind"].as_str() {
        Some("approval") => json!({ "decision": "deny" }),
        Some("user_question") => json!({ "kind": "user_answer", "answers": {} }),
        _ => json!({ "kind": "request_answer", "value": null }),
    }
}

fn tell_resolution(
    ctx: &Ctx,
    host_id: &str,
    thread_id: &str,
    request_id: &str,
    resolution: Value,
) -> impl std::future::Future<Output = ApiResult<Value>> + Send + 'static {
    let params =
        json!({ "threadId": thread_id, "requestId": request_id, "resolution": resolution });
    on_host(ctx, host_id, move |runner| async move {
        Ok(runner.call("resolveInteraction", params).await?)
    })
}

fn follow_up(ctx: &Ctx, result: ApiResult<()>) {
    if let Err(error) = result {
        ctx.log.error("Thread follow-up failed", json!({ "err": error.to_string() }));
    }
}

fn announce_pending(
    ctx: &Ctx,
    thread: &ThreadRow,
    interaction: &PendingInteraction,
) -> ApiResult<()> {
    let response = respond(ctx, &thread.id)?;
    let payload = json!({ "thread": response, "interaction": interaction });
    ctx.plugins.emit("interaction.pending", payload);
    Ok(())
}

pub fn register_provider_interaction(
    ctx: &Ctx,
    host_id: &str,
    event: ProviderInteractionRequest,
) -> ApiResult<()> {
    let db = &ctx.db;
    let thread_id = event.thread_id.as_str();
    let request_id = event.request_id.as_str();
    let thread = get_thread(db, thread_id)?;
    let active = pending::list_active_interactions(db, thread_id)?;
    if active.iter().any(|row| row.provider_request_id.as_deref() == Some(request_id)) {
        return Ok(());
    }
    let known = pending::find_provider_interaction(db, thread_id, request_id)?;
    let busy = !active.is_empty() || known.is_some();
    let thread = match thread {
        Some(thread) if thread.deleted_at.is_none() && !busy => thread,
        _ => {
            let resolution = denial(&event.payload);
            let refused = tell_resolution(ctx, host_id, thread_id, request_id, resolution);
            background(ctx, "refuse interaction", refused);
            return Ok(());
        }
    };
    commit(ctx, |out| {
        let row = pending::insert_pending_interaction(
            db,
            NewPendingInteraction {
                thread_id: thread_id.to_owned(),
                origin_kind: PendingInteractionOriginKind::Provider,
                turn_id: event.turn_id.clone().or_else(|| thread.active_turn_id.clone()),
                provider_id: Some(event.provider_id.as_str().to_owned()),
                provider_thread_id: Some(event.provider_thread_id.clone()),
                provider_request_id: Some(event.request_id.clone()),
                plugin_id: None,
                renderer_id: None,
                payload: event.payload.clone(),
            },
        )?;
        let interaction = announce(ctx, out, &thread, &row)?;
        let (ctx, thread) = (ctx.clone(), thread.clone());
        out.after(move || {
            follow_up(&ctx, announce_pending(&ctx, &thread, &interaction));
            if thread.parent_thread_id.is_some() {
                follow_up(&ctx, notify_parent_blocked(&ctx, &thread, &interaction));
            }
        });
        Ok(())
    })
}

pub fn cancel_provider_interaction(ctx: &Ctx, event: ProviderInteractionCancel) -> ApiResult<()> {
    let thread = get_thread(&ctx.db, &event.thread_id)?;
    let row = pending::find_provider_interaction(&ctx.db, &event.thread_id, &event.request_id)?;
    let (Some(thread), Some(row)) = (thread, row) else { return Ok(()) };
    commit(ctx, |out| {
        settle(ctx, out, &thread, &row.id, ACTIVE, interrupted(&event.reason), None)?;
        let (ctx, thread_id) = (ctx.clone(), thread.id.clone());
        out.after(move || schedule_drain(&ctx, &thread_id));
        Ok(())
    })
}

fn require_interaction(ctx: &Ctx, thread_id: &str, id: &str) -> ApiResult<PendingInteractionRow> {
    match pending::get_pending_interaction(&ctx.db, id)? {
        Some(row) if row.thread_id == thread_id => Ok(row),
        _ => Err(ApiError::new(404, "invalid_request", "Pending interaction not found")),
    }
}

fn already_settled(row: &PendingInteractionRow) -> ApiError {
    conflict(format!("Pending interaction {} is already {}", row.id, row.status.as_str()))
}

fn assert_resolution_fits(interaction: &PendingInteraction, resolution: &Value) -> ApiResult<()> {
    if interaction.is_approval() {
        let available: Vec<&str> = interaction.payload["availableDecisions"]
            .as_array()
            .map(|decisions| decisions.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let decision = resolution.get("decision");
        if decision.is_some_and(|decision| available.iter().any(|allowed| decision == *allowed)) {
            return Ok(());
        }
        let allowed = available.join(", ");
        return Err(invalid_request(format!("This approval accepts a decision of: {allowed}.")));
    }
    let kind = resolution.get("kind").and_then(Value::as_str);
    let fits = if interaction.is_user_question() {
        kind == Some("user_answer")
    } else {
        interaction.payload_kind().is_some_and(is_extension_kind) && kind == Some("request_answer")
    };
    if fits { Ok(()) } else { Err(invalid_request("The resolution does not fit this request.")) }
}

fn finish_resolution(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    delivered: bool,
) -> ApiResult<()> {
    let Some(thread) = get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    commit(ctx, |out| {
        let next = if delivered {
            InteractionSettlement {
                status: PendingInteractionStatus::Resolved,
                status_reason: None,
                resolution: None,
            }
        } else {
            interrupted(GONE_REASON)
        };
        let from = [PendingInteractionStatus::Resolving];
        settle(ctx, out, &thread, interaction_id, &from, next, None)?;
        let (ctx, thread_id) = (ctx.clone(), thread_id.to_owned());
        out.after(move || schedule_drain(&ctx, &thread_id));
        Ok(())
    })
}

/// `resolution` is a `PendingInteractionResolution`.
pub fn resolve_provider_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    resolution: Value,
) -> ApiResult<PendingInteraction> {
    let row = require_interaction(ctx, thread_id, interaction_id)?;
    let thread = get_thread(&ctx.db, thread_id)?.ok_or_else(thread_not_found)?;
    if row.status != PendingInteractionStatus::Pending {
        let same = row.resolution.as_deref() == Some(serde_json::to_string(&resolution)?.as_str());
        if same && row.status != PendingInteractionStatus::Interrupted {
            return Ok(pending::to_pending_interaction(&row)?);
        }
        return Err(already_settled(&row));
    }
    let request_id = match (&row.origin_kind, &row.provider_request_id) {
        (PendingInteractionOriginKind::Provider, Some(request_id)) => request_id.clone(),
        _ => return Err(invalid_request("Answer a plugin interaction with respond.")),
    };
    assert_resolution_fits(&pending::to_pending_interaction(&row)?, &resolution)?;
    let host_id = connected_host_of(ctx, &thread)?.ok_or_else(host_unavailable)?;
    let resolving = commit(ctx, |out| {
        let next = InteractionSettlement {
            status: PendingInteractionStatus::Resolving,
            status_reason: None,
            resolution: Some(resolution.clone()),
        };
        settle(ctx, out, &thread, &row.id, &[PendingInteractionStatus::Pending], next, None)
    })?;
    let resolving = resolving.ok_or_else(|| already_settled(&row))?;
    let told = tell_resolution(ctx, &host_id, thread_id, &request_id, resolution);
    let (task_ctx, id, interaction) = (ctx.clone(), thread_id.to_owned(), row.id.clone());
    let delivered = async move {
        let accepted = match told.await {
            Ok(result) => result["delivered"].as_bool().unwrap_or(false),
            Err(_) => false,
        };
        let finish_ctx = task_ctx.clone();
        let finish_id = id.clone();
        in_thread(&task_ctx, &id, async move {
            finish_resolution(&finish_ctx, &finish_id, &interaction, accepted)
        })
        .await
    };
    background(ctx, "resolve interaction", delivered);
    Ok(resolving)
}

fn settle_plugin_interaction(
    ctx: &Ctx,
    row: &PendingInteractionRow,
    next: InteractionSettlement,
    result: InputResult,
) -> ApiResult<PendingInteraction> {
    let thread = get_thread(&ctx.db, &row.thread_id)?.ok_or_else(thread_not_found)?;
    commit(ctx, |out| {
        settle(ctx, out, &thread, &row.id, ACTIVE, next, Some(result))?
            .ok_or_else(|| already_settled(row))
    })
}

fn description_text(fields: &Map<String, Value>, key: &str, max: usize) -> Result<Value, ()> {
    match fields.get(key) {
        None => Ok(Value::Null),
        Some(Value::String(text)) => {
            let text = text.trim();
            let length = text.encode_utf16().count();
            if (1..=max).contains(&length) { Ok(json!(text)) } else { Err(()) }
        }
        Some(_) => Err(()),
    }
}

/// `pluginInteractionDescriptionSchema.safeParse(described).data`.
fn parse_description(described: Option<Value>) -> Option<Value> {
    let described = described?;
    let fields = described.as_object()?;
    let title = description_text(fields, "title", MAX_DESCRIPTION_TITLE_LENGTH).ok()?;
    let detail = description_text(fields, "detail", MAX_DESCRIPTION_DETAIL_LENGTH).ok()?;
    let mut description = Map::new();
    if !title.is_null() {
        description.insert("title".into(), title);
    }
    if !detail.is_null() {
        description.insert("detail".into(), detail);
    }
    if let Some(payload) = fields.get("payload") {
        let bytes = serde_json::to_string(payload).ok()?.len();
        if bytes > MAX_DESCRIPTION_PAYLOAD_BYTES {
            return None;
        }
        description.insert("payload".into(), payload.clone());
    }
    Some(Value::Object(description))
}

async fn describe_submission(ctx: &Ctx, interaction_id: &str, value: &Value) -> Option<Value> {
    let describe = ctx
        .engine
        .input_waiters
        .lock()
        .get(interaction_id)
        .and_then(|waiter| waiter.describe_submission.clone())?;
    parse_description(describe(value.clone()).await)
}

pub async fn respond_to_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    value: Value,
) -> ApiResult<PendingInteraction> {
    let row = require_interaction(ctx, thread_id, interaction_id)?;
    if row.origin_kind == PendingInteractionOriginKind::Provider {
        let resolution = json!({ "kind": "request_answer", "value": value });
        return resolve_provider_interaction(ctx, thread_id, &row.id, resolution);
    }
    if row.status != PendingInteractionStatus::Pending {
        return Err(already_settled(&row));
    }
    let mut resolution = json!({ "kind": "plugin_submitted" });
    if let Some(description) = describe_submission(ctx, &row.id, &value).await {
        resolution["description"] = description;
    }
    let next = InteractionSettlement {
        status: PendingInteractionStatus::Resolved,
        status_reason: None,
        resolution: Some(resolution),
    };
    settle_plugin_interaction(ctx, &row, next, InputResult::Submitted { value })
}

pub fn cancel_plugin_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    reason: &str,
) -> ApiResult<PendingInteraction> {
    let row = require_interaction(ctx, thread_id, interaction_id)?;
    if row.origin_kind != PendingInteractionOriginKind::Plugin {
        let advice = "stop the turn instead";
        return Err(invalid_request(format!("A provider's request cannot be cancelled; {advice}")));
    }
    let result = InputResult::Cancelled { reason: reason.to_owned() };
    settle_plugin_interaction(ctx, &row, interrupted(reason), result)
}

fn cancel_later(ctx: &Ctx, thread_id: &str, interaction_id: &str, reason: &str) {
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    let (interaction, reason) = (interaction_id.to_owned(), reason.to_owned());
    later(ctx, thread_id, "cancel plugin interaction", async move {
        let current = pending::get_pending_interaction(&task_ctx.db, &interaction)?;
        if current.is_none_or(|row| row.status != PendingInteractionStatus::Pending) {
            return Ok(());
        }
        cancel_plugin_interaction(&task_ctx, &id, &interaction, &reason).map(|_| ())
    });
}

fn open_plugin_interaction(
    ctx: &Ctx,
    request: PluginInputRequest,
    deadline: Option<Instant>,
) -> ApiResult<oneshot::Receiver<InputResult>> {
    let db = &ctx.db;
    let thread_id = request.thread_id.as_str();
    let thread = match get_thread(db, thread_id)? {
        Some(thread) if thread.deleted_at.is_none() => thread,
        _ => return Err(thread_not_found()),
    };
    if !pending::list_active_interactions(db, thread_id)?.is_empty() {
        return Err(conflict(format!("Thread {thread_id} is already awaiting user interaction")));
    }
    let mut payload = json!({ "kind": "plugin", "title": request.title, "data": request.payload });
    if let Some(presentation) = &request.presentation {
        payload["presentation"] = presentation.clone();
    }
    let row = commit(ctx, |out| {
        let created = pending::insert_pending_interaction(
            db,
            NewPendingInteraction {
                thread_id: thread_id.to_owned(),
                origin_kind: PendingInteractionOriginKind::Plugin,
                turn_id: None,
                provider_id: None,
                provider_thread_id: None,
                provider_request_id: None,
                plugin_id: Some(request.plugin_id.clone()),
                renderer_id: Some(request.renderer_id.clone()),
                payload,
            },
        )?;
        let interaction = announce(ctx, out, &thread, &created)?;
        let response = respond(ctx, &thread.id)?;
        let ctx = ctx.clone();
        out.after(move || {
            let payload = json!({ "thread": response, "interaction": interaction });
            ctx.plugins.emit("interaction.pending", payload);
        });
        Ok(created)
    })?;
    let (resolve, result) = oneshot::channel();
    let done = CancellationToken::new();
    let watched = done.clone();
    let dispose = Box::new(move || watched.cancel());
    let describe_submission = request.describe_submission;
    let waiter = InputWaiter { resolve, dispose, describe_submission };
    ctx.engine.input_waiters.lock().insert(row.id.clone(), waiter);
    if request.cancel.is_some() || deadline.is_some() {
        let (ctx, id, signal) = (ctx.clone(), row.id, request.cancel);
        tokio::spawn(async move {
            let aborted = async {
                match &signal {
                    Some(signal) => signal.cancelled().await,
                    None => std::future::pending().await,
                }
            };
            let expired = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            };
            let reason = tokio::select! {
                biased;
                () = done.cancelled() => return,
                () = aborted => "request-aborted",
                () = expired => "timeout",
            };
            cancel_later(&ctx, &thread.id, &id, reason);
        });
    }
    Ok(result)
}

pub fn cancel_by_user(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
) -> ApiResult<PendingInteraction> {
    cancel_plugin_interaction(ctx, thread_id, interaction_id, "user")
}

pub async fn request_input(ctx: &Ctx, request: PluginInputRequest) -> ApiResult<InputResult> {
    let deadline = request.timeout.map(|timeout| Instant::now() + timeout);
    if request.cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Ok(InputResult::Cancelled { reason: "request-aborted".to_owned() });
    }
    let task_ctx = ctx.clone();
    let thread_id = request.thread_id.clone();
    let opened =
        in_thread(
            ctx,
            &thread_id,
            async move { open_plugin_interaction(&task_ctx, request, deadline) },
        )
        .await?;
    Ok(opened
        .await
        .unwrap_or_else(|_| InputResult::Cancelled { reason: "thread-stopped".to_owned() }))
}
