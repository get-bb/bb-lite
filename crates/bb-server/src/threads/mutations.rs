//! Sends, patches, pins, read state and queued messages. Skeleton of
//! `apps/server/src/threads/mutations.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::create::PluginSubmission;
use super::dispatch::SendMode;
use super::thread_display::{ThreadListEntry, ThreadResponse};
use crate::context::Ctx;
use crate::domain::thread::ThreadVisibility;
use crate::error::ApiResult;

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

pub async fn send(
    _ctx: &Ctx,
    _thread_id: &str,
    _request: SendMessageRequest,
) -> ApiResult<SendMessageResponse> {
    todo!("mutations port")
}

/// Sends `/compact` through `engine::in_thread` itself; not serialized by the caller.
pub async fn compact(_ctx: &Ctx, _thread_id: &str) -> ApiResult<()> {
    todo!("mutations port")
}

pub fn update(
    _ctx: &Ctx,
    _thread_id: &str,
    _patch: UpdateThreadRequest,
) -> ApiResult<ThreadResponse> {
    todo!("mutations port")
}

pub fn pin(_ctx: &Ctx, _thread_id: &str) -> ApiResult<ThreadResponse> {
    todo!("mutations port")
}

pub fn unpin(_ctx: &Ctx, _thread_id: &str) -> ApiResult<ThreadResponse> {
    todo!("mutations port")
}

pub fn reorder_pinned(
    _ctx: &Ctx,
    _thread_id: &str,
    _request: ReorderPinnedThreadRequest,
) -> ApiResult<Vec<ThreadListEntry>> {
    todo!("mutations port")
}

pub fn mark_read(_ctx: &Ctx, _thread_id: &str) -> ApiResult<ThreadResponse> {
    todo!("mutations port")
}

pub fn mark_unread(_ctx: &Ctx, _thread_id: &str) -> ApiResult<ThreadResponse> {
    todo!("mutations port")
}

/// Returns the `ThreadQueuedMessage`.
pub fn create_queued_message(
    _ctx: &Ctx,
    _thread_id: &str,
    _request: CreateQueuedMessageRequest,
) -> ApiResult<Value> {
    todo!("mutations port")
}

/// Returns the `ThreadQueuedMessage`.
pub fn update_queued_message(
    _ctx: &Ctx,
    _thread_id: &str,
    _queued_message_id: &str,
    _request: UpdateQueuedMessageRequest,
) -> ApiResult<Value> {
    todo!("mutations port")
}

pub fn delete_queued_message(
    _ctx: &Ctx,
    _thread_id: &str,
    _queued_message_id: &str,
) -> ApiResult<()> {
    todo!("mutations port")
}

pub async fn send_queued_message_now(
    _ctx: &Ctx,
    _thread_id: &str,
    _queued_message_id: &str,
    _mode: SendQueuedMessageMode,
) -> ApiResult<SendMessageResponse> {
    todo!("mutations port")
}
