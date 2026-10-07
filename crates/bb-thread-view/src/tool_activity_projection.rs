//! Port of `tool-activity-projection.ts`: commands, tool calls, delegations, item rows and
//! background tasks, including the "active cell" that holds the latest tool row until something
//! else is projected.

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use crate::build_event_projection::{MsgRef, ProjectionState};
use crate::event::{self, EventScope};
use crate::format::message_id;
use crate::item_lifecycle::{
    ExecLifecycleEvent, ExecutionOutputUpdate, ItemLifecycleEvent, LifecycleKind,
    ProviderExecutionUpdate, item_status_to_exec_status,
};
use crate::rows::{
    ActivityIntent, ApprovalStatus, CommandTag, CommandWork, RowStatus, ToolTag, ToolWork,
    WorkDetail, WorkflowTag, WorkflowWork,
};
use crate::types::{
    DelegationMessage, EventMeta, ExecDetail, ExecMessage, ItemMessage, Message, MessageBase,
    VisibleTextBuffer, WorkflowMessage, are_thread_event_scopes_equal, extend_message_bounds,
    scope_for_turn,
};

/// `RunningExecCall`: `Unnamed<ExecMessage> & { startedAt, outputBuffer }`. `tool_name` is the
/// possibly-unknown tool/delegation name (`Unnamed`); the name inside `exec` is a placeholder
/// until it is known. `startedAt` is `exec.base.started_at`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunningExecCall {
    pub(crate) exec: ExecMessage,
    pub(crate) tool_name: Option<String>,
    pub(crate) output_buffer: VisibleTextBuffer,
}

/// `PendingExecutionOutput`: output that arrived before its call began.
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
    #[allow(dead_code)]
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

/// JavaScript `string.length`.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript truthiness of an optional string.
fn truthy(value: Option<&str>) -> bool {
    value.is_some_and(|text| !text.is_empty())
}

const TOOL_INTERRUPTED_OUTPUT: &str = "Tool execution interrupted";

// ---- Exec message field access ------------------------------------------------------------

fn exec_work_kind(exec: &ExecMessage) -> &'static str {
    match &exec.exec {
        ExecDetail::Work(work) => work.work_kind(),
        ExecDetail::Delegation(_) => "delegation",
    }
}

fn exec_call_id(exec: &ExecMessage) -> &str {
    match &exec.exec {
        ExecDetail::Work(WorkDetail::Command(work)) => &work.call_id,
        ExecDetail::Work(WorkDetail::Tool(work)) => &work.call_id,
        ExecDetail::Delegation(work) => &work.call_id,
        ExecDetail::Work(other) => panic!("exec message holds a {} row", other.work_kind()),
    }
}

/// `(output, completedAt, presentation)` of an exec message.
fn exec_common_mut(exec: &mut ExecMessage) -> (&mut String, &mut Option<i64>, &mut Option<Value>) {
    match &mut exec.exec {
        ExecDetail::Work(WorkDetail::Command(work)) => {
            (&mut work.output, &mut work.completed_at, &mut work.presentation)
        }
        ExecDetail::Work(WorkDetail::Tool(work)) => {
            (&mut work.output, &mut work.completed_at, &mut work.presentation)
        }
        ExecDetail::Delegation(work) => {
            (&mut work.output, &mut work.completed_at, &mut work.presentation)
        }
        ExecDetail::Work(other) => panic!("exec message holds a {} row", other.work_kind()),
    }
}

fn exec_output(exec: &ExecMessage) -> String {
    let mut exec = exec.clone();
    exec_common_mut(&mut exec).0.clone()
}

fn exec_tool_name_mut(exec: &mut ExecMessage) -> Option<&mut String> {
    match &mut exec.exec {
        ExecDetail::Work(WorkDetail::Tool(work)) => Some(&mut work.tool_name),
        ExecDetail::Delegation(work) => Some(&mut work.tool_name),
        _ => None,
    }
}

// ---- Incoming updates ---------------------------------------------------------------------

/// The kind-specific half of `RunningExecCall | ProviderExecutionUpdate`. `None` fields are
/// TypeScript `undefined`.
#[derive(Debug, Clone)]
enum IncomingFields {
    Command {
        command: Option<String>,
        cwd: Option<String>,
        source: Option<String>,
        activity_intents: Vec<ActivityIntent>,
        exit_code: Option<Option<i64>>,
        approval_status: Option<Option<ApprovalStatus>>,
    },
    Tool {
        tool_name: Option<String>,
        tool_args: Option<Map<String, Value>>,
        approval_status: Option<Option<ApprovalStatus>>,
    },
    Delegation {
        tool_name: Option<String>,
        child_ref: Option<Option<String>>,
        background: Option<bool>,
        subagent_type: Option<String>,
        description: Option<String>,
        model: Option<String>,
    },
}

impl IncomingFields {
    fn work_kind(&self) -> &'static str {
        match self {
            Self::Command { .. } => "command",
            Self::Tool { .. } => "tool",
            Self::Delegation { .. } => "delegation",
        }
    }
}

/// `RunningExecCall | ProviderExecutionUpdate | ExecutionOutputUpdate` as a merge source;
/// `fields` is `None` for an output update (no `workKind`).
#[derive(Debug, Clone)]
struct Incoming {
    call_id: String,
    output: Option<String>,
    status: Option<RowStatus>,
    completed_at: Option<i64>,
    presentation: Option<Value>,
    fields: Option<IncomingFields>,
}

fn incoming_from_update(update: &ProviderExecutionUpdate) -> Incoming {
    match update {
        ProviderExecutionUpdate::Command(call) => Incoming {
            call_id: call.call_id.clone(),
            output: call.output.clone(),
            status: call.status,
            completed_at: call.completed_at,
            presentation: call.presentation.clone(),
            fields: Some(IncomingFields::Command {
                command: call.command.clone(),
                cwd: call.cwd.clone(),
                source: call.source.clone(),
                activity_intents: call.activity_intents.clone(),
                exit_code: call.exit_code,
                approval_status: Some(call.approval_status),
            }),
        },
        ProviderExecutionUpdate::Tool(call) => Incoming {
            call_id: call.call_id.clone(),
            output: call.output.clone(),
            status: call.status,
            completed_at: call.completed_at,
            presentation: call.presentation.clone(),
            fields: Some(IncomingFields::Tool {
                tool_name: Some(call.tool_name.clone()),
                tool_args: call.tool_args.clone(),
                approval_status: call.approval_status.map(Some),
            }),
        },
        ProviderExecutionUpdate::Delegation(call) => Incoming {
            call_id: call.call_id.clone(),
            output: call.output.clone(),
            status: call.status,
            completed_at: call.completed_at,
            presentation: call.presentation.clone(),
            fields: Some(IncomingFields::Delegation {
                tool_name: Some(call.tool_name.clone()),
                child_ref: call.child_ref.clone().map(Some),
                background: call.background,
                subagent_type: call.subagent_type.clone(),
                description: call.description.clone(),
                model: call.model.clone(),
            }),
        },
    }
}

fn incoming_from_running(call: &RunningExecCall) -> Incoming {
    let mut exec = call.exec.clone();
    let (output, completed_at, presentation) = exec_common_mut(&mut exec);
    let (output, completed_at, presentation) =
        (Some(output.clone()), *completed_at, presentation.clone());
    let fields = match &call.exec.exec {
        ExecDetail::Work(WorkDetail::Command(work)) => IncomingFields::Command {
            command: Some(work.command.clone()),
            cwd: work.cwd.clone(),
            source: work.source.clone(),
            activity_intents: work.activity_intents.clone(),
            exit_code: Some(work.exit_code),
            approval_status: Some(work.approval_status),
        },
        ExecDetail::Work(WorkDetail::Tool(work)) => IncomingFields::Tool {
            tool_name: call.tool_name.clone(),
            tool_args: work.tool_args.clone(),
            approval_status: Some(work.approval_status),
        },
        ExecDetail::Delegation(work) => IncomingFields::Delegation {
            tool_name: call.tool_name.clone(),
            child_ref: Some(work.child_ref.clone()),
            background: Some(work.background),
            subagent_type: work.subagent_type.clone(),
            description: work.description.clone(),
            model: work.model.clone(),
        },
        ExecDetail::Work(other) => panic!("running call holds a {} row", other.work_kind()),
    };
    Incoming {
        call_id: exec_call_id(&call.exec).to_string(),
        output,
        status: Some(call.exec.status),
        completed_at,
        presentation,
        fields: Some(fields),
    }
}

fn incoming_from_output(update: &ExecutionOutputUpdate) -> Incoming {
    Incoming {
        call_id: update.call_id.clone(),
        output: Some(update.output.clone()),
        status: update.status,
        completed_at: None,
        presentation: None,
        fields: None,
    }
}

// ---- Merge rules ----------------------------------------------------------------------------

fn find_flushed_item(
    state: &ProjectionState,
    call_id: &str,
    work_kind: Option<&str>,
) -> Option<MsgRef> {
    state.tool_activity.flushed_items.iter().rev().copied().find(|r| {
        let item = state.item(*r);
        item_call_id(item) == call_id && work_kind.is_none_or(|kind| item.work.work_kind() == kind)
    })
}

fn find_active_exec_mut<'a>(
    state: &'a mut ProjectionState,
    call_id: &str,
) -> Option<&'a mut ExecMessage> {
    match &mut state.tool_activity.active_cell {
        Some(Message::Exec(exec)) if exec_call_id(exec) == call_id => Some(exec),
        _ => None,
    }
}

/// `flushActiveToolCell`: appends the active cell to `state.messages`, records it as flushed and
/// clears it.
pub(crate) fn flush_active_tool_cell(state: &mut ProjectionState) {
    let Some(active) = state.tool_activity.active_cell.take() else {
        return;
    };
    match active {
        Message::Item(_) => {
            let r = state.push_message(active);
            state.tool_activity.flushed_items.push(r);
        }
        Message::Exec(exec) => {
            let call_id = exec_call_id(&exec).to_string();
            let pending = exec.status == RowStatus::Pending;
            let r = state.push_message(Message::Exec(exec));
            state.tool_activity.flushed_exec_by_call_id.insert(call_id.clone(), r);
            if !pending {
                state.tool_activity.finalized_exec_call_ids.insert(call_id);
            }
        }
        other => panic!("active tool cell holds a {} message", other.kind()),
    }
}

fn merge_call_status(current: Option<RowStatus>, incoming: Option<RowStatus>) -> Option<RowStatus> {
    let Some(incoming) = incoming else {
        return current;
    };
    let Some(current) = current else {
        return Some(incoming);
    };
    if incoming == RowStatus::Error {
        return Some(RowStatus::Error);
    }
    Some(if is_terminal(Some(current)) { current } else { incoming })
}

/// `mergeApprovalStatus`: the approval status after an update. `incoming` is `None` when the
/// update has no `approvalStatus` (TypeScript `undefined`) and `Some(None)` for `null`.
pub(crate) fn merge_approval_status(
    current: Option<ApprovalStatus>,
    incoming: Option<Option<ApprovalStatus>>,
    incoming_status: Option<RowStatus>,
) -> Option<ApprovalStatus> {
    match incoming {
        Some(incoming) => incoming,
        None if incoming_status.is_some() => None,
        None => current,
    }
}

fn has_semantic_intent(intents: &[ActivityIntent]) -> bool {
    intents.iter().any(|intent| !intent.is_unknown())
}

fn choose_activity_intents(
    existing: &[ActivityIntent],
    incoming: &[ActivityIntent],
) -> Vec<ActivityIntent> {
    if incoming.is_empty() {
        return existing.to_vec();
    }
    if existing.is_empty() {
        return incoming.to_vec();
    }
    if !has_semantic_intent(existing) && has_semantic_intent(incoming) {
        return incoming.to_vec();
    }
    if incoming.len() > existing.len() { incoming.to_vec() } else { existing.to_vec() }
}

fn is_terminal(status: Option<RowStatus>) -> bool {
    status.is_some_and(|status| status != RowStatus::Pending)
}

/// `mergeExecutionFields`. `name` is the target's (possibly unknown) tool name.
fn merge_execution_fields(
    target: &mut ExecMessage,
    name: &mut Option<String>,
    incoming: &Incoming,
) {
    let status = incoming.status;
    if incoming.presentation.as_ref().is_some_and(js_value_truthy) {
        *exec_common_mut(target).2 = incoming.presentation.clone();
    }
    match (&mut target.exec, &incoming.fields) {
        (
            ExecDetail::Work(WorkDetail::Command(target)),
            Some(IncomingFields::Command {
                command,
                cwd,
                source,
                activity_intents,
                exit_code,
                approval_status,
            }),
        ) => {
            if truthy(cwd.as_deref()) && !truthy(target.cwd.as_deref()) {
                target.cwd = cwd.clone();
            }
            if truthy(source.as_deref()) && !truthy(target.source.as_deref()) {
                target.source = source.clone();
            }
            match command {
                Some(command) if !command.is_empty() && *command != target.command => {
                    target.command = command.clone();
                    target.activity_intents = activity_intents.clone();
                }
                _ => {
                    target.activity_intents =
                        choose_activity_intents(&target.activity_intents, activity_intents);
                }
            }
            if let Some(exit_code) = exit_code {
                target.exit_code = *exit_code;
            }
            target.approval_status =
                merge_approval_status(target.approval_status, *approval_status, status);
        }
        (
            ExecDetail::Work(WorkDetail::Tool(target)),
            Some(IncomingFields::Tool { tool_name, tool_args, approval_status }),
        ) => {
            if truthy(tool_name.as_deref()) && !truthy(name.as_deref()) {
                name.clone_from(tool_name);
            }
            if tool_args.is_some() && target.tool_args.is_none() {
                target.tool_args = tool_args.clone();
            }
            target.approval_status =
                merge_approval_status(target.approval_status, *approval_status, status);
        }
        (
            ExecDetail::Delegation(target),
            Some(IncomingFields::Delegation {
                tool_name,
                child_ref,
                background,
                subagent_type,
                description,
                model,
            }),
        ) => {
            if truthy(tool_name.as_deref()) && !truthy(name.as_deref()) {
                name.clone_from(tool_name);
            }
            let incoming_child_ref = child_ref.clone().flatten();
            if truthy(incoming_child_ref.as_deref()) && !truthy(target.child_ref.as_deref()) {
                target.child_ref = incoming_child_ref;
            }
            if *background == Some(true) {
                target.background = true;
            }
            if truthy(subagent_type.as_deref()) && !truthy(target.subagent_type.as_deref()) {
                target.subagent_type = subagent_type.clone();
            }
            if truthy(description.as_deref())
                && (!truthy(target.description.as_deref()) || child_ref.is_some())
            {
                target.description = description.clone();
            }
            if truthy(model.as_deref()) && !truthy(target.model.as_deref()) {
                target.model = model.clone();
            }
        }
        _ => {}
    }
}

fn js_value_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `mergeExecutionFields` into a projected message (whose tool name is always known).
fn merge_fields_into_message(target: &mut ExecMessage, incoming: &Incoming) {
    let mut name = exec_tool_name_mut(target).map(|name| name.clone());
    merge_execution_fields(target, &mut name, incoming);
    if let (Some(slot), Some(name)) = (exec_tool_name_mut(target), name) {
        *slot = name;
    }
}

/// `mergeExecutionCompletion`.
fn merge_execution_completion(target: &mut ExecMessage, incoming: &Incoming) {
    let Some(completed_at) = incoming.completed_at else {
        return;
    };
    if target.status == RowStatus::Interrupted && incoming.status != Some(RowStatus::Error) {
        return;
    }
    *exec_common_mut(target).1 = Some(completed_at);
}

fn running_set_output(call: &mut RunningExecCall, text: &str, show_trailing_partial: bool) {
    call.output_buffer.set(text, show_trailing_partial);
    *exec_common_mut(&mut call.exec).0 = call.output_buffer.visible.clone();
}

fn buffered_length(buffer: &VisibleTextBuffer) -> usize {
    js_len(&buffer.visible) + js_len(&buffer.pending)
}

/// `createRunningExecCall`.
fn create_running_exec_call(
    incoming: &ProviderExecutionUpdate,
    meta: &EventMeta,
    thread_id: &str,
    scope: EventScope,
) -> RunningExecCall {
    let parts = incoming_from_update(incoming);
    let mut output_buffer = VisibleTextBuffer::new();
    output_buffer.set(parts.output.as_deref().unwrap_or(""), is_terminal(parts.status));
    let call_id = parts.call_id.clone();
    let output = output_buffer.visible.clone();
    let presentation = parts.presentation.clone().filter(js_value_truthy);
    let work_kind = match incoming {
        ProviderExecutionUpdate::Command(_) => "command",
        ProviderExecutionUpdate::Tool(_) => "tool",
        ProviderExecutionUpdate::Delegation(_) => "delegation",
    };
    let base = MessageBase {
        id: message_id(thread_id, work_kind, &call_id),
        thread_id: thread_id.to_string(),
        source_seq_start: meta.seq,
        source_seq_end: meta.seq,
        created_at: meta.created_at,
        scope,
        started_at: Some(meta.created_at),
        parent_tool_call_id: parts.parent_tool_call_id_of(incoming),
    };
    let (detail, tool_name) = match incoming {
        ProviderExecutionUpdate::Command(call) => (
            ExecDetail::Work(WorkDetail::Command(CommandWork {
                work_kind: CommandTag,
                call_id,
                command: call.command.clone().unwrap_or_default(),
                cwd: call.cwd.clone(),
                source: call.source.clone(),
                output,
                output_preview: None,
                exit_code: call.exit_code.flatten(),
                completed_at: call.completed_at,
                approval_status: call.approval_status,
                activity_intents: call.activity_intents.clone(),
                presentation,
            })),
            None,
        ),
        ProviderExecutionUpdate::Tool(call) => (
            ExecDetail::Work(WorkDetail::Tool(ToolWork {
                work_kind: ToolTag,
                call_id,
                tool_name: String::new(),
                tool_args: call.tool_args.clone(),
                output,
                output_preview: None,
                completed_at: call.completed_at,
                approval_status: call.approval_status,
                presentation,
            })),
            Some(call.tool_name.clone()),
        ),
        ProviderExecutionUpdate::Delegation(call) => (
            ExecDetail::Delegation(DelegationMessage {
                call_id,
                tool_name: String::new(),
                child_ref: call.child_ref.clone(),
                background: call.background.unwrap_or(false),
                subagent_type: call.subagent_type.clone(),
                description: call.description.clone(),
                model: call.model.clone(),
                output,
                completed_at: call.completed_at,
                children: Vec::new(),
                presentation,
            }),
            Some(call.tool_name.clone()),
        ),
    };
    RunningExecCall {
        exec: ExecMessage {
            base,
            status: parts.status.unwrap_or(RowStatus::Pending),
            exec: detail,
        },
        tool_name,
        output_buffer,
    }
}

impl Incoming {
    fn parent_tool_call_id_of(&self, update: &ProviderExecutionUpdate) -> Option<String> {
        let parent = match update {
            ProviderExecutionUpdate::Command(call) => &call.parent_tool_call_id,
            ProviderExecutionUpdate::Tool(call) => &call.parent_tool_call_id,
            ProviderExecutionUpdate::Delegation(call) => &call.parent_tool_call_id,
        };
        parent.clone().filter(|parent| !parent.is_empty())
    }
}

/// `upsertRunningExecCall`: the merged running call (not yet stored back into the map).
fn upsert_running_exec_call(
    state: &ProjectionState,
    incoming: &ProviderExecutionUpdate,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
) -> RunningExecCall {
    let Some(existing) = state.tool_activity.running_calls_by_id.get(incoming.call_id()) else {
        return create_running_exec_call(incoming, meta, thread_id, scope_for_turn(turn_id));
    };
    let mut existing = existing.clone();
    let parts = incoming_from_update(incoming);
    let terminal = is_terminal(parts.status);
    merge_execution_fields(&mut existing.exec, &mut existing.tool_name, &parts);
    merge_execution_completion(&mut existing.exec, &parts);
    if existing.exec.base.parent_tool_call_id.as_deref().is_none_or(str::is_empty)
        && let Some(parent) = parts.parent_tool_call_id_of(incoming)
    {
        existing.exec.base.parent_tool_call_id = Some(parent);
    }
    if let Some(output) = parts.output.as_deref().filter(|output| !output.is_empty())
        && (terminal || js_len(output) >= buffered_length(&existing.output_buffer))
    {
        running_set_output(&mut existing, output, terminal);
    }
    existing.exec.base.thread_id = thread_id.to_string();
    existing.exec.status =
        merge_call_status(Some(existing.exec.status), parts.status).unwrap_or(RowStatus::Pending);
    extend_message_bounds(&mut existing.exec.base, meta.seq, meta.created_at);
    existing
}

/// `applyExecutionOutputUpdate` on a running call's or pending output's buffer.
fn apply_execution_output_update(
    buffer: &mut VisibleTextBuffer,
    output: &mut String,
    incoming: &ExecutionOutputUpdate,
    append_output: bool,
    replace_output: bool,
) {
    if append_output {
        buffer.append(&incoming.output);
    } else if replace_output {
        buffer.set(&incoming.output, is_terminal(incoming.status));
    } else if js_len(&incoming.output) >= buffered_length(buffer) {
        buffer.set(&incoming.output, true);
    } else {
        return;
    }
    output.clone_from(&buffer.visible);
}

/// `upsertPendingExecutionOutput`.
fn upsert_pending_execution_output(
    state: &mut ProjectionState,
    meta: &EventMeta,
    incoming: &ExecutionOutputUpdate,
    append_output: bool,
    replace_output: bool,
) {
    let pending = state
        .tool_activity
        .pending_outputs_by_call_id
        .entry(incoming.call_id.clone())
        .or_insert_with(|| PendingExecutionOutput {
            call_id: incoming.call_id.clone(),
            parent_tool_call_id: None,
            source_seq_start: meta.seq,
            source_seq_end: meta.seq,
            created_at: meta.created_at,
            started_at: meta.created_at,
            output: String::new(),
            status: incoming.status,
            output_buffer: VisibleTextBuffer::new(),
        });
    apply_execution_output_update(
        &mut pending.output_buffer,
        &mut pending.output,
        incoming,
        append_output,
        replace_output,
    );
    pending.source_seq_end = pending.source_seq_end.max(meta.seq);
    pending.created_at = pending.created_at.max(meta.created_at);
    if pending.parent_tool_call_id.as_deref().is_none_or(str::is_empty)
        && let Some(parent) = incoming.parent_tool_call_id.as_ref().filter(|p| !p.is_empty())
    {
        pending.parent_tool_call_id = Some(parent.clone());
    }
    pending.status = merge_call_status(pending.status, incoming.status);
}

/// `applyPendingExecutionOutput`.
fn apply_pending_execution_output(state: &mut ProjectionState, call: &mut RunningExecCall) {
    let call_id = exec_call_id(&call.exec).to_string();
    let Some(mut pending) = state.tool_activity.pending_outputs_by_call_id.shift_remove(&call_id)
    else {
        return;
    };
    let terminal = is_terminal(Some(call.exec.status));
    if terminal {
        pending.output_buffer.flush();
    }
    let pending_text =
        format!("{}{}", pending.output_buffer.visible, pending.output_buffer.pending);
    let call_text = format!("{}{}", call.output_buffer.visible, call.output_buffer.pending);
    if !pending_text.is_empty() && !call_text.contains(&pending_text) {
        let text = if pending_text.contains(&call_text) {
            pending_text
        } else {
            format!("{pending_text}{call_text}")
        };
        running_set_output(call, &text, terminal);
    }
    let base = &mut call.exec.base;
    base.source_seq_start = base.source_seq_start.min(pending.source_seq_start);
    base.started_at = Some(base.started_at_or_created().min(pending.started_at));
    extend_message_bounds(base, pending.source_seq_end, pending.created_at);
    if base.parent_tool_call_id.as_deref().is_none_or(str::is_empty)
        && pending.parent_tool_call_id.is_some()
    {
        base.parent_tool_call_id = pending.parent_tool_call_id.clone();
    }
    call.exec.status =
        merge_call_status(Some(call.exec.status), pending.status).unwrap_or(call.exec.status);
}

/// `interruptPendingToolMessage` for an exec message.
fn interrupt_pending_exec(exec: &mut ExecMessage, completed_at: Option<i64>) {
    if exec.status != RowStatus::Pending {
        return;
    }
    exec.status = RowStatus::Interrupted;
    let (output, completed, _) = exec_common_mut(exec);
    *completed = completed_at;
    if output.is_empty() {
        *output = TOOL_INTERRUPTED_OUTPUT.to_string();
    }
}

/// `interruptPendingToolMessage` for an item message (any work kind, through its JSON).
fn interrupt_pending_item(item: &mut ItemMessage, completed_at: Option<i64>) {
    if item.status != RowStatus::Pending {
        return;
    }
    let mut json = serde_json::to_value(&*item).expect("item message serializes");
    let object = json.as_object_mut().expect("item message is an object");
    object.insert("status".into(), Value::from("interrupted"));
    object.insert("completedAt".into(), completed_at.map_or(Value::Null, Value::from));
    if let Some(output) = object.get_mut("output")
        && !js_value_truthy(output)
    {
        *output = Value::from(TOOL_INTERRUPTED_OUTPUT);
    }
    *item = serde_json::from_value(json).expect("item message deserializes");
}

fn interrupt_pending_message(message: &mut Message, completed_at: Option<i64>) {
    match message {
        Message::Exec(exec) => interrupt_pending_exec(exec, completed_at),
        Message::Item(item) => interrupt_pending_item(item, completed_at),
        _ => {}
    }
}

#[derive(Default)]
struct SummaryOptions {
    append_output: bool,
    replace_output: bool,
    visible_output: Option<String>,
}

/// `mergeExecutionSummary`.
fn merge_execution_summary(
    target: &mut ExecMessage,
    incoming: &Incoming,
    options: &SummaryOptions,
) {
    {
        let output = exec_common_mut(target).0;
        if let Some(visible) = &options.visible_output {
            output.clone_from(visible);
        } else if let Some(incoming_output) = incoming.output.as_deref().filter(|o| !o.is_empty()) {
            if options.append_output {
                output.push_str(incoming_output);
            } else if options.replace_output || js_len(incoming_output) >= js_len(output) {
                *output = incoming_output.to_string();
            }
        }
    }
    if let Some(fields) = &incoming.fields {
        let target_kind = exec_work_kind(target);
        if target_kind != fields.work_kind() {
            let label = |kind: &str| {
                if kind == "tool" { "tool-call".to_string() } else { kind.to_string() }
            };
            panic!(
                "Cannot merge {} with {} for call {}",
                label(target_kind),
                label(fields.work_kind()),
                incoming.call_id
            );
        }
        merge_fields_into_message(target, incoming);
        merge_execution_completion(target, incoming);
    }
    target.status =
        merge_call_status(Some(target.status), incoming.status).unwrap_or(target.status);
}

/// `flushPendingToolActivityOutput`: shows the held-back partial output line of every running
/// call and pending output.
pub(crate) fn flush_pending_tool_activity_output(state: &mut ProjectionState) {
    let call_ids: Vec<String> = state.tool_activity.running_calls_by_id.keys().cloned().collect();
    for call_id in call_ids {
        let call = state.tool_activity.running_calls_by_id.get_mut(&call_id).expect("running call");
        if !call.output_buffer.flush() {
            continue;
        }
        let output = call.output_buffer.visible.clone();
        *exec_common_mut(&mut call.exec).0 = output.clone();
        if let Some(active) = find_active_exec_mut(state, &call_id) {
            *exec_common_mut(active).0 = output.clone();
        }
        if let Some(r) = state.tool_activity.flushed_exec_by_call_id.get(&call_id).copied() {
            *exec_common_mut(state.exec_mut(r)).0 = output;
        }
    }
}

/// `interruptPendingToolActivity`: turns running calls into messages and marks pending exec and
/// item messages (of `turn_id` only, when given) interrupted at `completed_at`.
pub(crate) fn interrupt_pending_tool_activity(
    state: &mut ProjectionState,
    completed_at: Option<i64>,
    turn_id: Option<&str>,
) {
    let in_scope = |scope: &EventScope| match turn_id {
        None => true,
        Some(turn_id) => matches!(scope, EventScope::Turn { turn_id: id } if id == turn_id),
    };
    let call_ids: Vec<String> = state.tool_activity.running_calls_by_id.keys().cloned().collect();
    for call_id in call_ids {
        let call = state.tool_activity.running_calls_by_id.get_mut(&call_id).expect("running call");
        if !in_scope(&call.exec.base.scope) {
            continue;
        }
        call.output_buffer.flush();
        *exec_common_mut(&mut call.exec).0 = call.output_buffer.visible.clone();
        interrupt_pending_exec(&mut call.exec, completed_at);
        let call = call.clone();
        let incoming = incoming_from_running(&call);
        if let Some(active) = find_active_exec_mut(state, &call_id) {
            merge_execution_summary(active, &incoming, &SummaryOptions::default());
        } else if let Some(r) = state.tool_activity.flushed_exec_by_call_id.get(&call_id).copied() {
            merge_execution_summary(state.exec_mut(r), &incoming, &SummaryOptions::default());
        } else {
            state.push_message(Message::Exec(create_exec_message(&call)));
        }
        state.tool_activity.running_calls_by_id.shift_remove(&call_id);
    }
    if let Some(active) = &mut state.tool_activity.active_cell
        && in_scope(&active.base().scope)
    {
        interrupt_pending_message(active, completed_at);
    }
    for r in state.message_refs() {
        let message = state.message_mut(r);
        if matches!(message, Message::Exec(_) | Message::Item(_)) && in_scope(&message.base().scope)
        {
            interrupt_pending_message(message, completed_at);
        }
    }
}

/// `createExecMessage`.
fn create_exec_message(call: &RunningExecCall) -> ExecMessage {
    let mut exec = call.exec.clone();
    let work_kind = exec_work_kind(&exec);
    exec.base.id = message_id(&exec.base.thread_id, work_kind, exec_call_id(&call.exec));
    let placeholder = if work_kind == "tool" { "tool" } else { "delegation" };
    if let Some(slot) = exec_tool_name_mut(&mut exec) {
        *slot = call.tool_name.clone().unwrap_or_else(|| placeholder.to_string());
    }
    if let ExecDetail::Delegation(delegation) = &mut exec.exec {
        delegation.children.clear();
    }
    exec
}

fn on_exec_begin(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    incoming: &ProviderExecutionUpdate,
) {
    let mut call = upsert_running_exec_call(state, incoming, meta, thread_id, turn_id);
    apply_pending_execution_output(state, &mut call);
    let call_id = exec_call_id(&call.exec).to_string();
    state.tool_activity.running_calls_by_id.insert(call_id.clone(), call.clone());
    if let Some(active) = find_active_exec_mut(state, &call_id) {
        merge_execution_summary(active, &incoming_from_running(&call), &SummaryOptions::default());
        extend_message_bounds(
            &mut active.base,
            call.exec.base.source_seq_end,
            call.exec.base.created_at,
        );
        return;
    }
    flush_active_tool_cell(state);
    state.tool_activity.active_cell = Some(Message::Exec(create_exec_message(&call)));
}

fn on_exec_output(
    state: &mut ProjectionState,
    meta: &EventMeta,
    incoming: &ExecutionOutputUpdate,
    append_output: bool,
    replace_output: bool,
) {
    let call_id = incoming.call_id.as_str();
    let parts = incoming_from_output(incoming);
    let mut options = SummaryOptions { append_output, replace_output, visible_output: None };
    let mut targets = 0;
    if let Some(running) = state.tool_activity.running_calls_by_id.get_mut(call_id) {
        let (output, _, _) = exec_common_mut(&mut running.exec);
        apply_execution_output_update(
            &mut running.output_buffer,
            output,
            incoming,
            append_output,
            replace_output,
        );
        options.visible_output = Some(output.clone());
        merge_execution_summary(&mut running.exec, &parts, &options);
        extend_message_bounds(&mut running.exec.base, meta.seq, meta.created_at);
        targets += 1;
    }
    if let Some(active) = find_active_exec_mut(state, call_id) {
        merge_execution_summary(active, &parts, &options);
        extend_message_bounds(&mut active.base, meta.seq, meta.created_at);
        targets += 1;
    }
    if let Some(r) = state.tool_activity.flushed_exec_by_call_id.get(call_id).copied() {
        let flushed = state.exec_mut(r);
        merge_execution_summary(flushed, &parts, &options);
        extend_message_bounds(&mut flushed.base, meta.seq, meta.created_at);
        targets += 1;
    }
    if targets == 0 {
        upsert_pending_execution_output(state, meta, incoming, append_output, replace_output);
    }
}

fn on_exec_end(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    incoming: &ProviderExecutionUpdate,
) {
    let call_id = incoming.call_id().to_string();
    let mut merged = upsert_running_exec_call(state, incoming, meta, thread_id, turn_id);
    apply_pending_execution_output(state, &mut merged);
    if is_terminal(Some(merged.exec.status)) {
        merged.output_buffer.flush();
        *exec_common_mut(&mut merged.exec).0 = merged.output_buffer.visible.clone();
    }
    state.tool_activity.running_calls_by_id.shift_remove(&call_id);
    let has_active = find_active_exec_mut(state, &call_id).is_some();
    if !has_active
        && state.tool_activity.finalized_exec_call_ids.contains(&call_id)
        && merged.exec.status != RowStatus::Error
    {
        return;
    }
    let options =
        SummaryOptions { visible_output: Some(exec_output(&merged.exec)), ..Default::default() };
    let merged_incoming = incoming_from_running(&merged);
    let (seq_end, created_at) = (merged.exec.base.source_seq_end, merged.exec.base.created_at);
    let projected = if has_active {
        find_active_exec_mut(state, &call_id)
    } else {
        state
            .tool_activity
            .flushed_exec_by_call_id
            .get(&call_id)
            .copied()
            .map(|r| state.exec_mut(r))
    };
    if let Some(projected) = projected {
        merge_execution_summary(projected, &merged_incoming, &options);
        extend_message_bounds(&mut projected.base, seq_end, created_at);
        state.tool_activity.finalized_exec_call_ids.insert(call_id);
        if has_active {
            flush_active_tool_cell(state);
        }
        return;
    }
    flush_active_tool_cell(state);
    let mut exec_message = create_exec_message(&merged);
    let incoming_status = incoming_from_update(incoming).status;
    exec_message.status = merge_call_status(Some(exec_message.status), incoming_status)
        .unwrap_or(exec_message.status);
    state.tool_activity.active_cell = Some(Message::Exec(exec_message));
    flush_active_tool_cell(state);
}

/// `applyExecLifecycleEvent`: applies a begin, end or output event of a command, tool call or
/// delegation.
pub(crate) fn apply_exec_lifecycle_event(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    lifecycle: ExecLifecycleEvent,
) {
    match lifecycle {
        ExecLifecycleEvent::Output { output, append_output, replace_output } => {
            on_exec_output(state, meta, &output, append_output, replace_output);
        }
        ExecLifecycleEvent::Begin { call } => on_exec_begin(state, meta, thread_id, turn_id, &call),
        ExecLifecycleEvent::End { call } => on_exec_end(state, meta, thread_id, turn_id, &call),
    }
}

fn item_call_id(item: &ItemMessage) -> String {
    let work = serde_json::to_value(&item.work).expect("work detail serializes");
    event::str_field(&work, "callId").unwrap_or_default().to_string()
}

/// `createItemMessage`.
fn create_item_message(
    thread_id: &str,
    meta: &EventMeta,
    turn_id: Option<&str>,
    event: &ItemLifecycleEvent,
    id_key: &str,
) -> ItemMessage {
    ItemMessage {
        base: MessageBase {
            id: message_id(thread_id, event.row.work.work_kind(), id_key),
            thread_id: thread_id.to_string(),
            source_seq_start: meta.seq,
            source_seq_end: meta.seq,
            created_at: meta.created_at,
            scope: scope_for_turn(turn_id),
            started_at: Some(meta.created_at),
            parent_tool_call_id: event.parent_tool_call_id.clone().filter(|p| !p.is_empty()),
        },
        status: event.row.status,
        work: event.row.work.clone(),
    }
}

/// `mergeItemMessage`: `Object.assign` of the row (without status and completion unless it
/// ended) over the target, through their JSON.
fn merge_item_message(
    target: &mut ItemMessage,
    meta: &EventMeta,
    turn_id: Option<&str>,
    event: &ItemLifecycleEvent,
) {
    if !are_thread_event_scopes_equal(&target.base.scope, &scope_for_turn(turn_id)) {
        panic!(
            "Cannot merge {} messages with different scopes for call {}",
            target.work.work_kind(),
            item_call_id(target)
        );
    }
    extend_message_bounds(&mut target.base, meta.seq, meta.created_at);
    if target.base.parent_tool_call_id.as_deref().is_none_or(str::is_empty)
        && let Some(parent) = event.parent_tool_call_id.as_ref().filter(|p| !p.is_empty())
    {
        target.base.parent_tool_call_id = Some(parent.clone());
    }
    let mut json = serde_json::to_value(&*target).expect("item message serializes");
    let Value::Object(mut row) = serde_json::to_value(&event.row).expect("item row serializes")
    else {
        panic!("item row is not an object");
    };
    if event.kind != LifecycleKind::End {
        row.remove("status");
        row.remove("completedAt");
    }
    json.as_object_mut().expect("item message is an object").extend(row);
    *target = serde_json::from_value(json).expect("item message deserializes");
}

/// `applyItemLifecycleEvent`: creates or merges an item row (web search, file read, plan, ...).
pub(crate) fn apply_item_lifecycle_event(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    event: ItemLifecycleEvent,
) {
    let work_kind = event.row.work.work_kind();
    let call_id = {
        let work = serde_json::to_value(&event.row.work).expect("work detail serializes");
        event::str_field(&work, "callId").unwrap_or_default().to_string()
    };
    let key = format!("{work_kind}:{call_id}");
    if state.tool_activity.finalized_item_keys.contains(&key) {
        return;
    }
    let mut has_active = matches!(
        &state.tool_activity.active_cell,
        Some(Message::Item(active)) if item_call_id(active) == call_id
    );
    if has_active {
        if let Some(Message::Item(active)) = &mut state.tool_activity.active_cell
            && active.work.work_kind() != work_kind
        {
            interrupt_pending_item(active, Some(meta.created_at));
            has_active = false;
        }
        if !has_active {
            flush_active_tool_cell(state);
        }
    }
    if has_active {
        if let Some(Message::Item(active)) = &mut state.tool_activity.active_cell {
            merge_item_message(active, meta, turn_id, &event);
        }
        if event.kind == LifecycleKind::Begin {
            return;
        }
        flush_active_tool_cell(state);
        state.tool_activity.finalized_item_keys.insert(key);
        return;
    }
    flush_active_tool_cell(state);
    if event.kind == LifecycleKind::Begin {
        let item = create_item_message(thread_id, meta, turn_id, &event, &call_id);
        state.tool_activity.active_cell = Some(Message::Item(item));
        return;
    }
    if let Some(conflicting) = find_flushed_item(state, &call_id, None) {
        let conflicting = state.item_mut(conflicting);
        if conflicting.work.work_kind() != work_kind {
            interrupt_pending_item(conflicting, Some(meta.created_at));
        }
    }
    if let Some(flushed) = find_flushed_item(state, &call_id, Some(work_kind)) {
        merge_item_message(state.item_mut(flushed), meta, turn_id, &event);
    } else {
        let id_key = format!("{call_id}:{}", meta.seq);
        let item = create_item_message(thread_id, meta, turn_id, &event, &id_key);
        state.push_message(Message::Item(item));
    }
    state.tool_activity.finalized_item_keys.insert(key);
}

/// `parseBackgroundTaskLifecycleEvent`: the background-task item of an `item/started`,
/// `item/completed`, `item/backgroundTask/progress` or `item/backgroundTask/completed` event.
pub(crate) fn parse_background_task_lifecycle_event(
    decoded: &Value,
) -> Option<BackgroundTaskLifecycleEvent<'_>> {
    let event_type = event::event_type(decoded);
    let item = event::item(decoded)?;
    match event_type {
        "item/started" | "item/completed" if event::item_type(item) == Some("backgroundTask") => {
            Some(BackgroundTaskLifecycleEvent { ended: event_type == "item/completed", item })
        }
        "item/backgroundTask/progress" => Some(BackgroundTaskLifecycleEvent { ended: false, item }),
        "item/backgroundTask/completed" => Some(BackgroundTaskLifecycleEvent { ended: true, item }),
        _ => None,
    }
}

/// `backgroundTaskFields`, written over a workflow message.
fn assign_background_task_fields(message: &mut WorkflowMessage, item: &Value) {
    let string = |key: &str| event::str_field(item, key).map(str::to_string);
    let present = |key: &str| event::field(item, key).filter(|value| !value.is_null()).cloned();
    message.family_id = string("familyId");
    message.workflow.task_type = string("taskType").unwrap_or_default();
    message.workflow.workflow_name = string("workflowName");
    message.workflow.description = string("description").unwrap_or_default();
    message.status =
        item_status_to_exec_status(event::item_status(item)).unwrap_or(RowStatus::Pending);
    message.workflow.task_status = string("taskStatus").unwrap_or_default();
    message.skip_transcript = event::bool_field(item, "skipTranscript").unwrap_or(false);
    message.workflow.workflow = present("workflow");
    message.workflow.usage = present("usage");
    message.workflow.summary = string("summary");
    message.workflow.error = string("error");
}

/// `upsertBackgroundTaskMessage`: creates or updates the workflow message of a background task.
pub(crate) fn upsert_background_task_message(
    state: &mut ProjectionState,
    meta: &EventMeta,
    decoded: &Value,
    event: BackgroundTaskLifecycleEvent<'_>,
) {
    let BackgroundTaskLifecycleEvent { ended, item } = event;
    let item_id = event::item_id(item).unwrap_or_default().to_string();
    if let Some(r) = state.background_tasks_by_item_id.get(&item_id).copied() {
        let existing = state.workflow_mut(r);
        assign_background_task_fields(existing, item);
        if ended && existing.workflow.completed_at.is_none() {
            existing.workflow.completed_at = Some(meta.created_at);
        }
        existing.base.created_at = existing.base.created_at.max(meta.created_at);
        return;
    }
    let mut message = WorkflowMessage {
        base: MessageBase {
            id: item_id.clone(),
            thread_id: event::thread_id(decoded).unwrap_or_default().to_string(),
            source_seq_start: meta.seq,
            source_seq_end: meta.seq,
            created_at: meta.created_at,
            scope: event::scope_or_thread(decoded),
            started_at: Some(meta.created_at),
            parent_tool_call_id: event::non_empty_str_field(item, "parentToolCallId")
                .map(str::to_string),
        },
        family_id: None,
        skip_transcript: false,
        status: RowStatus::Pending,
        workflow: WorkflowWork {
            work_kind: WorkflowTag,
            item_id: item_id.clone(),
            task_type: String::new(),
            workflow_name: None,
            description: String::new(),
            model: None,
            task_status: String::new(),
            workflow: None,
            usage: None,
            summary: None,
            error: None,
            completed_at: ended.then_some(meta.created_at),
            presentation: event::field(item, "presentation")
                .filter(|v| js_value_truthy(v))
                .cloned(),
        },
    };
    assign_background_task_fields(&mut message, item);
    let r = state.push_message(Message::Workflow(message));
    state.background_tasks_by_item_id.insert(item_id, r);
}

#[cfg(test)]
mod tests {
    //! Drives a `ProjectionState` with only the events this module consumes and compares the
    //! resulting exec, item and workflow messages with projections recorded from TypeScript.
    use super::*;
    use crate::item_lifecycle as items;
    use crate::parse_operation_message::{parse_error_message, parse_operation_message};
    use crate::types::ProjectionOptions;
    use crate::user_message_parsing::should_preserve_pending_messages;
    use std::collections::BTreeMap;
    use std::path::Path;

    fn project(compacted: &[Value], options: &ProjectionOptions) -> ProjectionState {
        let mut events: Vec<(Value, EventMeta)> = compacted
            .iter()
            .map(|entry| {
                let meta = &entry["meta"];
                let meta = EventMeta {
                    id: meta["id"].as_str().unwrap_or_default().to_string(),
                    seq: meta["seq"].as_i64().unwrap_or_default(),
                    created_at: meta["createdAt"].as_i64().unwrap_or_default(),
                };
                (entry["event"].clone(), meta)
            })
            .collect();
        events.sort_by_key(|(_, meta)| meta.seq);
        let mut state = ProjectionState::new();
        let mut open_turns: IndexSet<String> = IndexSet::new();
        let mut interrupted_turns: IndexMap<String, i64> = IndexMap::new();
        let mut thread_interrupted_at = None;
        for (decoded, meta) in &events {
            let event_type = event::event_type(decoded);
            let thread_id = event::thread_id(decoded).unwrap_or_default();
            let turn_id = event::turn_id(decoded);
            let parent = event::parent_tool_call_id(decoded);
            if event_type == "turn/started"
                && let Some(turn_id) = turn_id
            {
                open_turns.insert(turn_id.to_string());
            }
            if event_type == "turn/completed" {
                if let Some(turn_id) = turn_id {
                    open_turns.shift_remove(turn_id);
                    if event::status(decoded) == Some("interrupted") {
                        interrupted_turns.insert(turn_id.to_string(), meta.created_at);
                    }
                    flush_pending_tool_activity_output(&mut state);
                }
                continue;
            }
            if event_type == "system/thread/interrupted" {
                thread_interrupted_at = Some(meta.created_at);
                for turn_id in std::mem::take(&mut open_turns) {
                    interrupted_turns.insert(turn_id, meta.created_at);
                }
                flush_pending_tool_activity_output(&mut state);
                continue;
            }
            if let Some(task) = parse_background_task_lifecycle_event(decoded) {
                flush_active_tool_cell(&mut state);
                upsert_background_task_message(&mut state, meta, decoded, task);
            } else if let Some(exec) = items::parse_exec_lifecycle_event(decoded, meta, parent) {
                apply_exec_lifecycle_event(&mut state, meta, thread_id, turn_id, exec);
            } else if items::should_suppress_low_value_tool_call(decoded) {
            } else if let Some(call) = items::parse_tool_call_lifecycle_event(decoded, meta, parent)
            {
                apply_exec_lifecycle_event(&mut state, meta, thread_id, turn_id, call);
            } else if let Some(item) = items::parse_item_lifecycle_event(decoded, meta, parent) {
                apply_item_lifecycle_event(&mut state, meta, thread_id, turn_id, item);
            } else if items::parse_file_edit_from_item_event(decoded, parent).is_some()
                || items::parse_compaction_lifecycle_event(decoded, meta, parent).is_some()
                || parse_operation_message(decoded, meta, options).is_some()
                || parse_error_message(decoded, meta).is_some()
            {
                flush_active_tool_cell(&mut state);
            }
        }
        for (turn_id, completed_at) in &interrupted_turns {
            interrupt_pending_tool_activity(&mut state, Some(*completed_at), Some(turn_id));
        }
        if should_preserve_pending_messages(&options.thread_status) {
            flush_active_tool_cell(&mut state);
        } else {
            flush_pending_tool_activity_output(&mut state);
            interrupt_pending_tool_activity(&mut state, thread_interrupted_at, None);
            flush_active_tool_cell(&mut state);
        }
        state
    }

    const KINDS: [&str; 3] = ["exec", "item", "workflow"];

    fn strip(mut message: Value) -> Value {
        if let Some(object) = message.as_object_mut() {
            // Filled in after projection (delegation linking, model enrichment, previews).
            for key in ["children", "outputPreview"] {
                object.remove(key);
            }
        }
        message
    }

    fn recorded_messages(projection: &Value) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        for entry in projection["entries"].as_array().into_iter().flatten() {
            let messages = match entry["kind"].as_str() {
                Some("turn") => entry["turn"]["messages"].as_array().cloned().unwrap_or_default(),
                _ => vec![entry["message"].clone()],
            };
            // Delegated child rows are nested into `children` after projection; flatten them.
            let mut queue = messages;
            while let Some(message) = queue.pop() {
                queue.extend(message["children"].as_array().cloned().unwrap_or_default());
                if KINDS.contains(&message["kind"].as_str().unwrap_or_default()) {
                    out.insert(
                        message["id"].as_str().unwrap_or_default().to_string(),
                        strip(message),
                    );
                }
            }
        }
        out
    }

    fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
        match (left, right) {
            (Value::Object(l), Value::Object(r)) => {
                for key in l.keys().chain(r.keys()) {
                    let (a, b) =
                        (l.get(key).unwrap_or(&Value::Null), r.get(key).unwrap_or(&Value::Null));
                    if let Some(diff) = first_difference(&format!("{path}.{key}"), a, b) {
                        return Some(diff);
                    }
                }
                None
            }
            (Value::Array(l), Value::Array(r)) if l.len() == r.len() => l
                .iter()
                .zip(r)
                .enumerate()
                .find_map(|(index, (a, b))| first_difference(&format!("{path}[{index}]"), a, b)),
            _ if left == right => None,
            _ => Some(format!("{path}: rust {left} vs typescript {right}")),
        }
    }

    fn run_dir(dir: &Path, failures: &mut Vec<String>) -> usize {
        let mut cases = 0;
        let mut paths: Vec<_> =
            std::fs::read_dir(dir).expect("fixture dir").flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths.into_iter().filter(|p| p.extension().is_some_and(|e| e == "json")) {
            let fixture: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let compacted = fixture["compacted"].as_array().cloned().unwrap_or_default();
            for (index, result) in fixture["results"].as_array().into_iter().flatten().enumerate() {
                cases += 1;
                let raw = &result["options"];
                let options = ProjectionOptions {
                    include_diagnostic_operations: raw["includeDiagnosticOperations"]
                        .as_bool()
                        .unwrap_or(false),
                    thread_status: raw["threadStatus"].as_str().unwrap_or("idle").to_string(),
                    thread_name: raw["threadName"].as_str().unwrap_or_default().to_string(),
                };
                let state = project(&compacted, &options);
                let mine: BTreeMap<String, Value> = state
                    .messages
                    .iter()
                    .map(|r| serde_json::to_value(state.message(*r)).unwrap())
                    .filter(|m| KINDS.contains(&m["kind"].as_str().unwrap_or_default()))
                    .map(|m| (m["id"].as_str().unwrap_or_default().to_string(), strip(m)))
                    .collect();
                let expected = recorded_messages(&result["projection"]);
                let name = format!("{}#{index}", path.file_name().unwrap().to_string_lossy());
                let diff = expected
                    .iter()
                    .find_map(|(id, want)| match mine.get(id) {
                        None => Some(format!("missing {id}")),
                        Some(got) => first_difference(id, got, want),
                    })
                    .or_else(|| {
                        mine.keys()
                            .find(|id| !expected.contains_key(*id))
                            .map(|id| format!("extra {id}"))
                    });
                if let Some(diff) = diff {
                    failures.push(format!("{name}: {diff}"));
                }
            }
        }
        cases
    }

    #[test]
    fn tool_activity_matches_typescript() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut failures = Vec::new();
        let mut cases = run_dir(&root.join("timeline"), &mut failures);
        cases += run_dir(&root.join("tool_activity"), &mut failures);
        for failure in &failures {
            eprintln!("{failure}");
        }
        eprintln!("tool activity: {} of {cases} cases match", cases - failures.len());
        assert!(failures.is_empty(), "{} of {cases} cases differ", failures.len());
    }
}
