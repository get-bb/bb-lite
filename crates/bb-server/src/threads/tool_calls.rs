//! Plugin tool calls requested by a runner. Skeleton of
//! `apps/server/src/threads/tool-calls.ts`.

use serde_json::Value;

use crate::context::Ctx;
use crate::error::ApiResult;

/// The `toolCall.requested` runner event.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallEvent {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: String,
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
}

pub fn start_tool_call(_ctx: &Ctx, _host_id: &str, _event: ToolCallEvent) -> ApiResult<()> {
    todo!("tool_calls port")
}

pub fn cancel_tool_call(_ctx: &Ctx, _request_id: &str) {
    todo!("tool_calls port")
}
