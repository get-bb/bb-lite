//! Plugin tool calls requested by a runner (`apps/server/src/threads/tool-calls.ts`).

use bb_core::ToolCallResponse;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::engine;
use super::session_spec::plugin_context;
use crate::context::Ctx;
use crate::db::threads::get_thread;
use crate::error::{ApiResult, error_message};

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

async fn run_tool(
    ctx: &Ctx,
    event: ToolCallEvent,
    cancel: CancellationToken,
) -> ApiResult<ToolCallResponse> {
    let Some(thread) = get_thread(&ctx.db, &event.thread_id)? else {
        return Ok(ToolCallResponse::text("Thread not found.", false));
    };
    let host_id = engine::host_of(ctx, &thread)?;
    let scope = plugin_context(&ctx.db, &thread, host_id.as_deref());
    Ok(ctx.plugins.call_tool(&event.tool, event.arguments, scope, cancel).await)
}

pub fn start_tool_call(ctx: &Ctx, host_id: &str, event: ToolCallEvent) -> ApiResult<()> {
    let request_id = event.request_id.clone();
    let cancel = {
        let mut calls = ctx.engine.tool_calls.lock();
        if calls.contains_key(&request_id) {
            return Ok(());
        }
        let cancel = CancellationToken::new();
        calls.insert(request_id.clone(), cancel.clone());
        cancel
    };
    let (task_ctx, host_id) = (ctx.clone(), host_id.to_owned());
    let settled = async move {
        let ctx = task_ctx;
        let thread_id = event.thread_id.clone();
        let result = run_tool(&ctx, event, cancel)
            .await
            .unwrap_or_else(|error| ToolCallResponse::text(error_message(&error), false));
        let resolved = async {
            let runner = ctx.runners.get(&host_id)?;
            let params =
                json!({ "threadId": thread_id, "requestId": request_id, "result": result });
            runner.call("resolveToolCall", params).await?;
            Ok(())
        }
        .await;
        ctx.engine.tool_calls.lock().remove(&request_id);
        resolved
    };
    engine::background(ctx, "tool call", settled);
    Ok(())
}

pub fn cancel_tool_call(ctx: &Ctx, request_id: &str) {
    if let Some(cancel) = ctx.engine.tool_calls.lock().get(request_id) {
        cancel.cancel();
    }
}
