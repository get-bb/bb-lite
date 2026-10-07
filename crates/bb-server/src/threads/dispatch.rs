//! The send checkpoint and queue drain. Skeleton of `apps/server/src/threads/dispatch.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::Outbox;
use super::execution::ExecutionTuple;
use super::session_spec::SessionEnvironment;
use crate::context::Ctx;
use crate::db::queued_messages::QueuedMessageRow;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;

/// `SendMessageRequest["mode"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SendMode {
    Start,
    Steer,
    SteerIfActive,
    QueueIfActive,
    Auto,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutboundMessage {
    /// `PromptInput[]`.
    pub input: Vec<Value>,
    pub execution: ExecutionTuple,
    pub sender_thread_id: Option<String>,
    /// `ThreadTurnInitiator`.
    pub initiator: String,
    /// `QueuedMessageSystemNotice | null`.
    pub system_notice: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DispatchArgs {
    pub message: OutboundMessage,
    pub mode: SendMode,
    pub send_at: Option<i64>,
    pub rows: Vec<QueuedMessageRow>,
    pub send_now: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Delivery {
    Sent,
    Queued { row: QueuedMessageRow },
}

pub fn attributed_message(_message: &OutboundMessage) -> OutboundMessage {
    todo!("dispatch port")
}

/// `target` is a `TurnRequestTarget`; returns a `client/turn/requested` event.
pub fn turn_request_event(_message: &OutboundMessage, _request_id: &str, _target: Value) -> Value {
    todo!("dispatch port")
}

pub fn consume_rows(
    _ctx: &Ctx,
    _out: &Outbox,
    _thread: &ThreadRow,
    _rows: &[QueuedMessageRow],
) -> ApiResult<()> {
    todo!("dispatch port")
}

pub fn session_environment_of(_ctx: &Ctx, _thread: &ThreadRow) -> ApiResult<SessionEnvironment> {
    todo!("dispatch port")
}

/// Fires `submitTurn` in the background; `args` are the runner's `SubmitTurnArgs`.
pub fn submit_to_runner(
    _ctx: &Ctx,
    _thread: &ThreadRow,
    _host_id: &str,
    _args: Value,
) -> ApiResult<()> {
    todo!("dispatch port")
}

pub async fn dispatch_message(
    _ctx: &Ctx,
    _thread_id: &str,
    _args: DispatchArgs,
) -> ApiResult<Delivery> {
    todo!("dispatch port")
}

pub async fn drain_queue(_ctx: &Ctx, _thread_id: &str) -> ApiResult<()> {
    todo!("dispatch port")
}

pub async fn send_queued_message_now(
    _ctx: &Ctx,
    _thread_id: &str,
    _queued_message_id: &str,
    _mode: crate::threads::mutations::SendQueuedMessageMode,
) -> ApiResult<Delivery> {
    todo!("dispatch port")
}
