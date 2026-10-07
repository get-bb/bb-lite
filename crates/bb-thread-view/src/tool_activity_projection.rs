//! Port of `tool-activity-projection.ts`: commands, tool calls, delegations, item rows and
//! background tasks, including the "active cell" that holds the latest tool row until something
//! else is projected.

// Remove once text, tool-activity and operation projection are ported: until then much of the
// shared state is only written, never read.
#![allow(dead_code)]

use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use crate::build_event_projection::{MsgRef, ProjectionState};
use crate::item_lifecycle::{ExecLifecycleEvent, ItemLifecycleEvent};
use crate::rows::{ApprovalStatus, RowStatus};
use crate::types::{EventMeta, ExecMessage, Message, VisibleTextBuffer};

/// `RunningExecCall`: `Unnamed<ExecMessage> & { startedAt, outputBuffer }`. `tool_name` is the
/// possibly-unknown tool/delegation name (`Unnamed`); the name inside `exec` is a placeholder
/// until it is known. Only this module reads it, so its owner may reshape it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunningExecCall {
    pub(crate) exec: ExecMessage,
    pub(crate) tool_name: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) output_buffer: VisibleTextBuffer,
}

/// `PendingExecutionOutput`: output that arrived before its call began. Only this module reads
/// it, so its owner may reshape it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingExecutionOutput {
    pub(crate) call_id: String,
    pub(crate) parent_tool_call_id: Option<String>,
    pub(crate) source_seq_start: i64,
    pub(crate) source_seq_end: i64,
    pub(crate) created_at: i64,
    pub(crate) started_at: i64,
    pub(crate) output: String,
    pub(crate) status: Option<RowStatus>,
    pub(crate) output_buffer: VisibleTextBuffer,
}

/// `ToolActivityState`. `active_cell` is an exec or item message not yet in `state.messages`
/// (`ToolActivityCell`); `flushed_exec_by_call_id` and `flushed_items` point into the arena.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolActivityState {
    pub(crate) running_calls_by_id: IndexMap<String, RunningExecCall>,
    pub(crate) pending_outputs_by_call_id: IndexMap<String, PendingExecutionOutput>,
    pub(crate) active_cell: Option<Message>,
    pub(crate) flushed_exec_by_call_id: IndexMap<String, MsgRef>,
    pub(crate) flushed_items: Vec<MsgRef>,
    pub(crate) finalized_exec_call_ids: IndexSet<String>,
    pub(crate) finalized_item_keys: IndexSet<String>,
}

impl ToolActivityState {
    /// `createToolActivityState`.
    pub(crate) fn new() -> Self {
        Self::default()
    }
}

/// `BackgroundTaskLifecycleEvent`; `item` is the `ThreadEventBackgroundTaskItem` JSON.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BackgroundTaskLifecycleEvent<'a> {
    pub(crate) ended: bool,
    pub(crate) item: &'a Value,
}

/// `flushActiveToolCell`: appends the active cell to `state.messages`, records it as flushed and
/// clears it.
pub(crate) fn flush_active_tool_cell(_state: &mut ProjectionState) {
    todo!("tool_activity_projection port")
}

/// `mergeApprovalStatus`: the approval status after an update. `incoming` is `None` when the
/// update has no `approvalStatus` (TypeScript `undefined`) and `Some(None)` for `null`.
pub(crate) fn merge_approval_status(
    _current: Option<ApprovalStatus>,
    _incoming: Option<Option<ApprovalStatus>>,
    _incoming_status: Option<RowStatus>,
) -> Option<ApprovalStatus> {
    todo!("tool_activity_projection port")
}

/// `flushPendingToolActivityOutput`: shows the held-back partial output line of every running
/// call and pending output.
pub(crate) fn flush_pending_tool_activity_output(_state: &mut ProjectionState) {
    todo!("tool_activity_projection port")
}

/// `interruptPendingToolActivity`: turns running calls into messages and marks pending exec and
/// item messages (of `turn_id` only, when given) interrupted at `completed_at`.
pub(crate) fn interrupt_pending_tool_activity(
    _state: &mut ProjectionState,
    _completed_at: Option<i64>,
    _turn_id: Option<&str>,
) {
    todo!("tool_activity_projection port")
}

/// `applyExecLifecycleEvent`: applies a begin, end or output event of a command, tool call or
/// delegation.
pub(crate) fn apply_exec_lifecycle_event(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
    _turn_id: Option<&str>,
    _lifecycle: ExecLifecycleEvent,
) {
    todo!("tool_activity_projection port")
}

/// `applyItemLifecycleEvent`: creates or merges an item row (web search, file read, plan, ...).
pub(crate) fn apply_item_lifecycle_event(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
    _turn_id: Option<&str>,
    _event: ItemLifecycleEvent,
) {
    todo!("tool_activity_projection port")
}

/// `parseBackgroundTaskLifecycleEvent`: the background-task item of an `item/started`,
/// `item/completed`, `item/backgroundTask/progress` or `item/backgroundTask/completed` event.
pub(crate) fn parse_background_task_lifecycle_event(
    _decoded: &Value,
) -> Option<BackgroundTaskLifecycleEvent<'_>> {
    todo!("tool_activity_projection port")
}

/// `upsertBackgroundTaskMessage`: creates or updates the workflow message of a background task.
pub(crate) fn upsert_background_task_message(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _decoded: &Value,
    _event: BackgroundTaskLifecycleEvent<'_>,
) {
    todo!("tool_activity_projection port")
}
