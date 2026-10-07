//! Sends, patches, pins, read state and queued messages. Skeleton of
//! `apps/server/src/threads/mutations.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::create::{PluginSubmission, execution_request, project_metadata, require_valid_parent};
use super::dispatch::{self, Delivery, DispatchArgs, OutboundMessage, SendMode};
use super::engine;
use super::execution::resolve_turn_execution;
use super::thread_display::{ThreadListEntry, ThreadResponse, to_thread_list_entries};
use crate::context::Ctx;
use crate::db::queued_messages::{self as queue, NewQueuedMessage, QueuedMessageRow};
use crate::db::thread_read::list_sidebar_thread_rows;
use crate::db::thread_sections::require_thread_section;
use crate::db::threads::{self as store, ThreadPatch, ThreadRow};
use crate::domain::changes::ThreadChangeKind;
use crate::domain::queued_message::QueuedMessageWaitingOn;
use crate::domain::thread::{ThreadStatus, ThreadVisibility};
use crate::error::{ApiResult, conflict};

/// `field?: T | null`: absent is `None`, `null` is `Some(None)`.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.as_ref().and_then(Option::as_ref).serialize(serializer)
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    /// `PromptInput[]`, at least one.
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_input_sources: Option<Value>,
    pub mode: SendMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_submission: Option<PluginSubmission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryKind {
    Sent,
    Queued,
}

/// `{ok: true, delivery: "sent"} | {ok: true, delivery: "queued", queuedMessage}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    pub ok: bool,
    pub delivery: DeliveryKind,
    /// `ThreadQueuedMessage`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_message: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendQueuedMessageMode {
    Auto,
    Steer,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateQueuedMessageRequest {
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_input_sources: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQueuedMessageRequest {
    pub expected_updated_at: i64,
    pub input: Vec<Value>,
}

/// `updateThreadRequestSchema`; "At least one field must be provided" is checked by the route.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub section_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub parent_thread_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub reasoning_level: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<ThreadVisibility>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderPinnedThreadRequest {
    pub previous_thread_id: Option<String>,
    pub next_thread_id: Option<String>,
}

fn to_send_response(outcome: Delivery) -> ApiResult<SendMessageResponse> {
    Ok(match outcome {
        Delivery::Sent => {
            SendMessageResponse { ok: true, delivery: DeliveryKind::Sent, queued_message: None }
        }
        Delivery::Queued { row } => SendMessageResponse {
            ok: true,
            delivery: DeliveryKind::Queued,
            queued_message: Some(serde_json::to_value(queue::to_thread_queued_message(&row)?)?),
        },
    })
}

fn turn_fields(
    model: &Option<String>,
    service_tier: &Option<String>,
    reasoning_level: &Option<String>,
    permission_mode: &Option<String>,
    execution_input_sources: &Option<Value>,
) -> Value {
    serde_json::json!({
        "model": model,
        "serviceTier": service_tier,
        "reasoningLevel": reasoning_level,
        "permissionMode": permission_mode,
        "executionInputSources": execution_input_sources,
    })
}

pub async fn send(
    ctx: &Ctx,
    thread_id: &str,
    request: SendMessageRequest,
) -> ApiResult<SendMessageResponse> {
    let thread = engine::require_thread(ctx, thread_id)?;
    let sender_thread_id = engine::sender_of(ctx, &thread, request.sender_thread_id.as_deref())?;
    let execution = execution_request(turn_fields(
        &request.model,
        &request.service_tier,
        &request.reasoning_level,
        &request.permission_mode,
        &request.execution_input_sources,
    ))?;
    let initiator = if sender_thread_id.is_none() { "user" } else { "agent" };
    let args = DispatchArgs {
        message: OutboundMessage {
            input: request.input,
            execution: resolve_turn_execution(&ctx.db, &thread, &execution)?,
            sender_thread_id,
            initiator: initiator.to_owned(),
            system_notice: None,
        },
        mode: request.mode,
        send_at: request.send_at,
        rows: Vec::new(),
        send_now: false,
    };
    to_send_response(dispatch::dispatch_message(ctx, thread_id, args).await?)
}

fn compact_input() -> Vec<Value> {
    let command = "/compact";
    vec![serde_json::json!({
        "type": "text",
        "text": command,
        "mentions": [{
            "start": 0,
            "end": command.len(),
            "resource": {
                "kind": "command",
                "trigger": "/",
                "name": "compact",
                "source": "command",
                "origin": "builtin",
                "label": "compact",
                "argumentHint": null,
            },
        }],
    })]
}

/// Sends `/compact` through `engine::in_thread` itself; not serialized by the caller.
pub async fn compact(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let thread = engine::require_thread(ctx, thread_id)?;
    if thread.status != ThreadStatus::Idle && thread.status != ThreadStatus::Error {
        let state = "the thread is idle or errored";
        return Err(conflict(format!("Context can only be compacted while {state}")));
    }
    let request = SendMessageRequest {
        input: compact_input(),
        model: None,
        service_tier: None,
        reasoning_level: None,
        permission_mode: None,
        execution_input_sources: None,
        mode: SendMode::Start,
        sender_thread_id: None,
        plugin_submission: None,
        send_at: None,
    };
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    engine::in_thread(ctx, thread_id, async move { send(&task_ctx, &id, request).await }).await?;
    Ok(())
}

pub fn update(ctx: &Ctx, thread_id: &str, patch: UpdateThreadRequest) -> ApiResult<ThreadResponse> {
    let db = &ctx.db;
    let thread = engine::require_thread(ctx, thread_id)?;
    if let Some(Some(parent_thread_id)) = &patch.parent_thread_id {
        require_valid_parent(db, parent_thread_id, Some(&thread))?;
    }
    if let Some(Some(section_id)) = &patch.section_id {
        require_thread_section(db, section_id)?;
    }
    let mut fields = ThreadPatch::new();
    let mut any = false;
    if let Some(title) = &patch.title {
        fields = fields.set("title", title.clone());
        any = true;
    }
    if let Some(section_id) = &patch.section_id {
        fields = fields.set("sectionId", section_id.clone());
        any = true;
    }
    if let Some(visibility) = patch.visibility {
        fields = fields.set("visibility", visibility.as_str());
        any = true;
    }
    if let Some(model) = &patch.model {
        fields = fields.set("modelOverride", model.clone());
        any = true;
    }
    if let Some(reasoning_level) = &patch.reasoning_level {
        fields = fields.set("reasoningLevelOverride", reasoning_level.clone());
        any = true;
    }
    let mut changes = Vec::new();
    if any {
        changes.push(ThreadChangeKind::TitleChanged);
    }
    if let Some(parent_thread_id) = &patch.parent_thread_id
        && *parent_thread_id != thread.parent_thread_id
    {
        fields = fields.set("parentThreadId", parent_thread_id.clone());
        changes.push(ThreadChangeKind::ParentChanged);
    }
    let updated = engine::commit(ctx, |out| {
        if !changes.is_empty() {
            out.thread(thread_id, changes, Some(project_metadata(&thread.project_id)));
        }
        store::patch_thread(db, thread_id, &fields, true)
    })?;
    if let Some(Some(title)) = &patch.title
        && Some(title) != thread.title.as_ref()
    {
        engine::rename_session(ctx, &updated, title)?;
    }
    engine::respond(ctx, thread_id)
}

fn patch_and_announce(
    ctx: &Ctx,
    thread_id: &str,
    change: ThreadChangeKind,
    patch: ThreadPatch,
) -> ApiResult<ThreadResponse> {
    let thread = engine::require_thread(ctx, thread_id)?;
    engine::commit(ctx, |out| {
        out.thread(thread_id, vec![change], Some(project_metadata(&thread.project_id)));
        store::patch_thread(&ctx.db, thread_id, &patch, true)
    })?;
    engine::respond(ctx, thread_id)
}

pub fn pin(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadResponse> {
    let pinned = engine::require_thread(ctx, thread_id)?.pinned_at.is_some();
    let sort_key = store::next_pin_sort_key(&ctx.db)?;
    let patch = if pinned {
        ThreadPatch::new()
    } else {
        ThreadPatch::new().set("pinnedAt", ctx.now()).set("pinSortKey", sort_key)
    };
    patch_and_announce(ctx, thread_id, ThreadChangeKind::PinStateChanged, patch)
}

pub fn unpin(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadResponse> {
    let cleared = ThreadPatch::new().set("pinnedAt", None::<i64>).set("pinSortKey", None::<String>);
    patch_and_announce(ctx, thread_id, ThreadChangeKind::PinStateChanged, cleared)
}

pub fn reorder_pinned(
    ctx: &Ctx,
    thread_id: &str,
    request: ReorderPinnedThreadRequest,
) -> ApiResult<Vec<ThreadListEntry>> {
    let thread = engine::require_thread(ctx, thread_id)?;
    let previous = request.previous_thread_id.as_deref();
    store::reorder_pinned_thread(&ctx.db, thread_id, previous, request.next_thread_id.as_deref())?;
    let metadata = Some(project_metadata(&thread.project_id));
    ctx.hub.thread(thread_id, vec![ThreadChangeKind::PinStateChanged], metadata);
    let mut pinned: Vec<_> = list_sidebar_thread_rows(&ctx.db)?
        .into_iter()
        .filter(|row| row.thread.pinned_at.is_some() && row.thread.parent_thread_id.is_none())
        .collect();
    pinned.sort_by(|left, right| {
        let key = |row: &ThreadRow| row.pin_sort_key.clone().unwrap_or_default();
        key(&left.thread).cmp(&key(&right.thread))
    });
    to_thread_list_entries(ctx, &pinned)
}

pub fn mark_read(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadResponse> {
    let read = ThreadPatch::new().set("lastReadAt", ctx.now());
    patch_and_announce(ctx, thread_id, ThreadChangeKind::ReadStateChanged, read)
}

pub fn mark_unread(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadResponse> {
    let unread = ThreadPatch::new().set("lastReadAt", None::<i64>);
    patch_and_announce(ctx, thread_id, ThreadChangeKind::ReadStateChanged, unread)
}

fn require_queued_message(ctx: &Ctx, thread_id: &str, id: &str) -> ApiResult<QueuedMessageRow> {
    queue::get_queued_message(&ctx.db, thread_id, id)?.ok_or_else(queue::queued_message_not_found)
}

fn queue_changed(ctx: &Ctx, thread_id: &str) {
    ctx.hub.thread(thread_id, vec![ThreadChangeKind::QueueChanged], None);
}

fn queued_message_json(row: &QueuedMessageRow) -> ApiResult<Value> {
    Ok(serde_json::to_value(queue::to_thread_queued_message(row)?)?)
}

/// Returns the `ThreadQueuedMessage`.
pub fn create_queued_message(
    ctx: &Ctx,
    thread_id: &str,
    request: CreateQueuedMessageRequest,
) -> ApiResult<Value> {
    let db = &ctx.db;
    let thread = engine::require_unarchived(ctx, thread_id)?;
    let stopping = thread.status == ThreadStatus::Stopping;
    let sender_thread_id = engine::sender_of(ctx, &thread, request.sender_thread_id.as_deref())?;
    let execution = execution_request(turn_fields(
        &request.model,
        &request.service_tier,
        &request.reasoning_level,
        &request.permission_mode,
        &request.execution_input_sources,
    ))?;
    let execution = resolve_turn_execution(db, &thread, &execution)?;
    let waiting_on = if stopping {
        QueuedMessageWaitingOn::Stopping
    } else {
        QueuedMessageWaitingOn::ThreadBusy
    };
    let row = queue::insert_queued_message(
        db,
        NewQueuedMessage {
            thread_id: thread_id.to_owned(),
            sender_thread_id,
            send_at: None,
            content: request.input,
            model: execution.model,
            reasoning_level: execution.reasoning_level.as_str().to_owned(),
            permission_mode: execution.permission_mode.as_str().to_owned(),
            service_tier: execution.service_tier.as_str().to_owned(),
            waiting_on: Some(waiting_on),
            system_notice: None,
        },
    )?;
    queue_changed(ctx, thread_id);
    if thread.status == ThreadStatus::Idle {
        engine::schedule_drain(ctx, thread_id);
    }
    queued_message_json(&row)
}

/// Returns the `ThreadQueuedMessage`.
pub fn update_queued_message(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
    request: UpdateQueuedMessageRequest,
) -> ApiResult<Value> {
    engine::require_unarchived(ctx, thread_id)?;
    let row = require_queued_message(ctx, thread_id, queued_message_id)?;
    if row.updated_at != request.expected_updated_at {
        return Err(conflict("Queued message changed since editing began"));
    }
    queue::update_queued_message_content(&ctx.db, &row, &request.input)?;
    queue_changed(ctx, thread_id);
    queued_message_json(&require_queued_message(ctx, thread_id, queued_message_id)?)
}

pub fn delete_queued_message(ctx: &Ctx, thread_id: &str, queued_message_id: &str) -> ApiResult<()> {
    require_queued_message(ctx, thread_id, queued_message_id)?;
    queue::delete_queued_messages(&ctx.db, &[queued_message_id.to_owned()])?;
    queue_changed(ctx, thread_id);
    Ok(())
}

pub async fn send_queued_message_now(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
    mode: SendQueuedMessageMode,
) -> ApiResult<SendMessageResponse> {
    engine::require_unarchived(ctx, thread_id)?;
    let sent = dispatch::send_queued_message_now(ctx, thread_id, queued_message_id, mode).await?;
    to_send_response(sent)
}
