//! Pending provider and plugin interactions. Skeleton of
//! `apps/server/src/threads/interactions.ts`.

use bb_core::types::ProviderId;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::core::Outbox;
use crate::context::Ctx;
use crate::db::pending_interactions::PendingInteraction;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;
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

pub fn interrupt_all(
    _ctx: &Ctx,
    _out: &Outbox,
    _thread: &ThreadRow,
    _status_reason: &str,
) -> ApiResult<()> {
    todo!("interactions port")
}

pub fn register_provider_interaction(
    _ctx: &Ctx,
    _host_id: &str,
    _event: ProviderInteractionRequest,
) -> ApiResult<()> {
    todo!("interactions port")
}

pub fn cancel_provider_interaction(_ctx: &Ctx, _event: ProviderInteractionCancel) -> ApiResult<()> {
    todo!("interactions port")
}

/// `resolution` is a `PendingInteractionResolution`.
pub fn resolve_provider_interaction(
    _ctx: &Ctx,
    _thread_id: &str,
    _interaction_id: &str,
    _resolution: Value,
) -> ApiResult<PendingInteraction> {
    todo!("interactions port")
}

pub fn respond_to_interaction(
    _ctx: &Ctx,
    _thread_id: &str,
    _interaction_id: &str,
    _value: Value,
) -> ApiResult<PendingInteraction> {
    todo!("interactions port")
}

pub fn cancel_plugin_interaction(
    _ctx: &Ctx,
    _thread_id: &str,
    _interaction_id: &str,
    _reason: &str,
) -> ApiResult<PendingInteraction> {
    todo!("interactions port")
}

pub fn cancel_by_user(
    _ctx: &Ctx,
    _thread_id: &str,
    _interaction_id: &str,
) -> ApiResult<PendingInteraction> {
    todo!("interactions port")
}

pub async fn request_input(_ctx: &Ctx, _request: PluginInputRequest) -> ApiResult<InputResult> {
    todo!("interactions port")
}
