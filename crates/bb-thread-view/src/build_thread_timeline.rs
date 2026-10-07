//! Port of `build-thread-timeline.ts`: the event projection turned into timeline rows, plus the
//! thread state the timeline shows next to them.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::build_event_projection::build_event_projection;
use crate::event::{is_type, request_id};
use crate::format::{
    FileChangeRef, duration_to_compact_string, get_file_change_diff_stats, get_message_started_at,
    js_trim,
};
use crate::group_turns::{
    CompletedTurnDisplay, TimelineRowPlan, get_ordered_thread_events, plan_timeline_rows,
};
use crate::parse_operation_message::provisioning_title_for_status;
use crate::rows::{
    ApprovalDetail, ApprovalTarget, ApprovalWork, AssistantConversationFields, ConversationRole,
    ConversationRow, DelegationWork, FileChange, FileChangeWork, FileEditApprovalFields,
    FileEditApprovalLifecycle, GenericOperationFields, NonOperationSystemFields,
    NonOperationSystemKind, ParentChangeOperationFields, RowBase, RowStatus, SystemDetail,
    SystemOperationKind, SystemRow, TimelineRow, TurnRequestStatus, WorkDetail, WorkRow,
};
use crate::rows::{ApprovalStatus, TurnRequestKind};
use crate::thread_state_extraction::{
    extract_thread_context_window_usage, extract_thread_timeline_goal,
    extract_thread_timeline_model_fallback, extract_thread_timeline_pending_todos,
};
use crate::types::{
    ErrorMessage, ExecDetail, FileEditChange, Message, MessageBase, OperationMessage,
    OperationType, Projection, ProjectionEntry, ProjectionOptions, ThreadEventWithMeta,
    UserMessage, WorkflowMessage,
};
use crate::user_message_parsing::{
    build_accepted_client_request_by_id, client_request_user_messages,
    should_preserve_pending_messages, turn_request_kind,
};

/// `LOCAL_AGENT_TASK_TYPE` / `LOCAL_SUBAGENT_TASK_TYPE` (`isBackgroundAgentTaskType`).
pub fn is_background_agent_task_type(task_type: &str) -> bool {
    task_type == "local_agent" || task_type == "local_subagent"
}

/// `ThreadTimelineFromEventsOptions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineOptions {
    pub completed_turn_display: CompletedTurnDisplay,
    pub include_diagnostic_operations: bool,
    pub include_nested_rows: bool,
    pub is_latest_page: bool,
    pub thread_status: String,
    pub thread_name: String,
    pub workspace_root: Option<String>,
}

impl ThreadTimelineOptions {
    pub fn projection_options(&self) -> ProjectionOptions {
        ProjectionOptions {
            include_diagnostic_operations: self.include_diagnostic_operations,
            thread_status: self.thread_status.clone(),
            thread_name: self.thread_name.clone(),
        }
    }
}

/// The arguments of `buildThreadTimelineFromEvents`; an empty `head_state_events` is the
/// TypeScript `undefined`.
#[derive(Debug, Clone, Copy)]
pub struct ThreadTimelineArgs<'a> {
    pub context_window_events: &'a [ThreadEventWithMeta],
    pub head_state_events: &'a [ThreadEventWithMeta],
    pub events: &'a [ThreadEventWithMeta],
    pub options: &'a ThreadTimelineOptions,
}

/// `ThreadTimelineFromEventsResult`; the thread-state fields are the JSON shapes of
/// [`crate::thread_state_extraction`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineResult {
    pub active_thinking: Option<Value>,
    pub active_workflows: Vec<WorkRow>,
    pub active_background_commands: Vec<WorkRow>,
    pub context_window_usage: Option<Value>,
    pub goal: Option<Value>,
    pub model_fallback: Option<Value>,
    pub pending_todos: Option<Value>,
    pub rows: Vec<TimelineRow>,
}

struct RowOptions<'a> {
    completed_turn_display: CompletedTurnDisplay,
    include_nested_rows: bool,
    workspace_root: Option<&'a str>,
    row_id_prefix: String,
}

const MAX_ERROR_TITLE_LENGTH: usize = 80;

static RECONNECT_PROGRESS_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Reconnecting\.\.\.\s+[0-9]+/[0-9]+$").expect("valid regex"));

fn provider_error_category_title(category: &str) -> Option<&'static str> {
    Some(match category {
        "active-turn-not-steerable" => "Turn is not steerable",
        "bad-request" => "Provider rejected request",
        "billing" => "Provider billing issue",
        "budget-exceeded" => "Provider budget exceeded",
        "connection-failed" => "Provider connection failed",
        "context-window-exceeded" => "Context window exceeded",
        "internal" => "Provider internal error",
        "max-output-tokens" => "Provider output token limit reached",
        "max-turns" => "Maximum turns reached",
        "overloaded" => "Provider overloaded",
        "policy" => "Provider policy blocked request",
        "rate-limit" => "Provider rate limit reached",
        "sandbox" => "Provider sandbox error",
        "stream-disconnected" => "Provider stream disconnected",
        "structured-output-retries" => "Structured output retries exhausted",
        "thread-rollback-failed" => "Thread rollback failed",
        "too-many-failed-attempts" => "Provider failed after too many attempts",
        "unauthorized" => "Provider authorization failed",
        _ => return None,
    })
}

fn detail_beyond_title(detail: Option<&str>, title: &str) -> Option<String> {
    detail.filter(|detail| js_trim(detail) != js_trim(title)).map(str::to_string)
}

fn resolve_error_title_detail(message: &ErrorMessage) -> (String, Option<String>) {
    let detail = message.detail.as_deref();
    if message.raw_type != "provider/error" {
        let title = message.message.clone();
        let detail = detail_beyond_title(detail, &title);
        return (title, detail);
    }
    let category = message
        .provider_error_info
        .as_ref()
        .and_then(|info| info.get("category"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match provider_error_category_title(category) {
        Some(title) => (title.to_string(), detail_beyond_title(detail, title)),
        None => (detail.unwrap_or(&message.message).to_string(), None),
    }
}

/// `buildTimelineErrorDisplay`: `(title, detail)`.
fn build_timeline_error_display(message: &ErrorMessage) -> (String, Option<String>) {
    if let Some(full) = message.detail.as_deref() {
        let mut parts = full.split('\n');
        let first = js_trim(parts.next().unwrap_or(""));
        if RECONNECT_PROGRESS_PATTERN.is_match(first) {
            let rest = parts.collect::<Vec<_>>().join("\n");
            let rest = js_trim(&rest);
            return (first.to_string(), (!rest.is_empty()).then(|| rest.to_string()));
        }
    }
    let (title, detail) = resolve_error_title_detail(message);
    if title.encode_utf16().count() <= MAX_ERROR_TITLE_LENGTH {
        return (title, detail);
    }
    let generic =
        if message.raw_type == "provider/error" { "Provider error" } else { "System error" };
    (generic.to_string(), Some(detail.unwrap_or(title)))
}

fn build_row_base(base: &MessageBase, row_id_prefix: &str) -> RowBase {
    RowBase {
        id: format!("{row_id_prefix}{}", base.id),
        thread_id: base.thread_id.clone(),
        turn_id: base.turn_id().map(str::to_string),
        source_seq_start: base.source_seq_start,
        source_seq_end: base.source_seq_end,
        started_at: get_message_started_at(base.created_at, base.started_at),
        created_at: base.created_at,
    }
}

fn work_row(base: RowBase, status: RowStatus, work: WorkDetail) -> TimelineRow {
    TimelineRow::Work(WorkRow { base, kind: Default::default(), status, work })
}

fn workflow_work_row(message: &WorkflowMessage, row_id_prefix: &str) -> Option<WorkRow> {
    if message.skip_transcript {
        return None;
    }
    let base = build_row_base(&message.base, row_id_prefix);
    Some(WorkRow {
        base,
        kind: Default::default(),
        status: message.status,
        work: WorkDetail::Workflow(message.workflow.clone()),
    })
}

/// `buildWorkflowWorkRows`.
fn build_workflow_work_rows(messages: &[WorkflowMessage], row_id_prefix: &str) -> Vec<WorkRow> {
    messages.iter().filter_map(|message| workflow_work_row(message, row_id_prefix)).collect()
}

/// `relativizeWorkspacePath`.
fn relativize_workspace_path(path: &str, workspace_root: Option<&str>) -> String {
    let root = workspace_root.map(|root| root.trim_end_matches('/'));
    match root {
        Some(root) if !root.is_empty() => path
            .strip_prefix(root)
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(path)
            .to_string(),
        _ => path.to_string(),
    }
}

fn to_timeline_file_change(change: &FileEditChange, workspace_root: Option<&str>) -> FileChange {
    FileChange {
        path: relativize_workspace_path(&change.path, workspace_root),
        kind: change.kind.clone(),
        move_path: change
            .move_path
            .as_deref()
            .map(|path| relativize_workspace_path(path, workspace_root)),
        diff: change.diff.clone(),
        diff_stats: get_file_change_diff_stats(&FileChangeRef::from(change)),
    }
}

/// `readTerminalOutputLines`: complete lines (a bare `\r` restarts the line), blank lines dropped.
fn read_terminal_output_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut pending_cr = false;
    let push_line = |current: &mut String, lines: &mut Vec<String>| {
        if !js_trim(current).is_empty() {
            lines.push(std::mem::take(current));
        }
        current.clear();
    };
    for c in text.chars() {
        if pending_cr {
            pending_cr = false;
            if c == '\n' {
                push_line(&mut current, &mut lines);
                continue;
            }
            current.clear();
        }
        match c {
            '\r' => pending_cr = true,
            '\n' => push_line(&mut current, &mut lines),
            _ => current.push(c),
        }
    }
    push_line(&mut current, &mut lines);
    lines
}

/// `buildTimelineOperationDetail`.
fn build_timeline_operation_detail(message: &OperationMessage) -> Option<String> {
    if message.op_type != OperationType::ThreadProvisioning {
        return message.detail.clone();
    }
    let mut lines: Vec<String> = Vec::new();
    for entry in message.transcript.iter().flatten() {
        let text = entry.get("text").and_then(Value::as_str).unwrap_or("");
        let duration = entry
            .get("metadata")
            .and_then(|metadata| metadata.get("durationMs"))
            .and_then(Value::as_f64);
        let finished =
            matches!(entry.get("status").and_then(Value::as_str), Some("completed" | "failed"));
        let line = match duration {
            Some(duration) if finished => {
                format!("{text} ({})", duration_to_compact_string(duration))
            }
            _ => text.to_string(),
        };
        lines.extend(read_terminal_output_lines(&line));
    }
    let base = &message.base;
    let elapsed_ms = base.created_at - get_message_started_at(base.created_at, base.started_at);
    if message.status != RowStatus::Pending && elapsed_ms > 1_000 {
        let label = provisioning_title_for_status(message.status);
        lines.push(format!("{label} ({})", duration_to_compact_string(elapsed_ms as f64)));
    }
    for part in message.detail.as_deref().unwrap_or("").split(['\n', '•']) {
        let line = js_trim(part);
        if !line.is_empty() && !lines.iter().any(|existing| existing == line) {
            lines.push(line.to_string());
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn is_suppressed_system_message(message: &UserMessage) -> bool {
    let fields = &message.fields;
    fields.initiator == "system"
        && fields.system_message_subject.as_ref().is_some_and(|subject| {
            subject.get("kind").and_then(Value::as_str) == Some("tool-call")
                && subject.get("suppress").and_then(Value::as_bool) == Some(true)
        })
}

fn system_row(
    base: RowBase,
    title: String,
    detail: Option<String>,
    status: Option<RowStatus>,
    system: SystemDetail,
) -> TimelineRow {
    TimelineRow::System(SystemRow { base, kind: Default::default(), title, detail, status, system })
}

/// `operationRows`.
fn operation_row(message: &OperationMessage, base: RowBase) -> TimelineRow {
    let detail = build_timeline_operation_detail(message);
    let status = Some(message.status);
    let title = message.title.clone();
    if let Some(Some(parent_change)) = &message.parent_change {
        let system = SystemDetail::ParentChange(ParentChangeOperationFields {
            system_kind: Default::default(),
            operation_kind: Default::default(),
            parent_change: parent_change.clone(),
            completed_at: message.completed_at,
        });
        return system_row(base, title, detail, status, system);
    }
    let operation_kind = match message.op_type {
        OperationType::ProviderEnvironment | OperationType::Operation => {
            SystemOperationKind::Generic
        }
        OperationType::Reasoning => SystemOperationKind::Reasoning,
        OperationType::Warning => SystemOperationKind::Warning,
        OperationType::Deprecation => SystemOperationKind::Deprecation,
        OperationType::ThreadInterrupted => SystemOperationKind::ThreadInterrupted,
        OperationType::ThreadProvisioning => SystemOperationKind::ThreadProvisioning,
        OperationType::Compaction => SystemOperationKind::Compaction,
        OperationType::ContextClear => SystemOperationKind::ContextClear,
    };
    let reasoning_id =
        (operation_kind == SystemOperationKind::Reasoning).then(|| message.base.id.clone());
    let system = SystemDetail::Operation(GenericOperationFields {
        system_kind: Default::default(),
        operation_kind,
        reasoning_id,
        completed_at: message.completed_at,
    });
    system_row(base, title, detail, status, system)
}

/// `convertMessage`.
fn convert_message(message: &Message, options: &RowOptions<'_>) -> Vec<TimelineRow> {
    let base = build_row_base(message.base(), &options.row_id_prefix);
    match message {
        Message::AssistantText(message) => vec![TimelineRow::Conversation(ConversationRow {
            base,
            kind: Default::default(),
            text: message.text.clone(),
            attachments: None,
            role: ConversationRole::Assistant(AssistantConversationFields {
                role: Default::default(),
                turn_request: (),
            }),
        })],
        Message::FileEdit(message) => {
            let pending_approval = message.approval_status.filter(|_| message.changes.is_empty());
            if let Some(approval_status) = pending_approval {
                let lifecycle = if approval_status == ApprovalStatus::Denied {
                    FileEditApprovalLifecycle::Denied
                } else {
                    FileEditApprovalLifecycle::Waiting
                };
                let work = WorkDetail::Approval(ApprovalWork {
                    work_kind: Default::default(),
                    interaction_id: message.call_id.clone(),
                    target: ApprovalTarget { item_id: message.call_id.clone(), tool_name: None },
                    approval: ApprovalDetail::FileEdit(FileEditApprovalFields {
                        approval_kind: Default::default(),
                        lifecycle,
                    }),
                });
                return vec![work_row(base, message.status, work)];
            }
            message
                .changes
                .iter()
                .enumerate()
                .map(|(index, change)| {
                    let mut base = base.clone();
                    base.id = format!("{}:file-change:{index}", base.id);
                    let work = WorkDetail::FileChange(FileChangeWork {
                        work_kind: Default::default(),
                        call_id: message.call_id.clone(),
                        change: to_timeline_file_change(change, options.workspace_root),
                        stdout: message.stdout.clone(),
                        stderr: None,
                        approval_status: message.approval_status,
                        presentation: message.presentation.clone(),
                    });
                    work_row(base, message.status, work)
                })
                .collect()
        }
        Message::Workflow(message) => workflow_work_row(message, &options.row_id_prefix)
            .map(TimelineRow::Work)
            .into_iter()
            .collect(),
        Message::Operation(message) => vec![operation_row(message, base)],
        Message::Error(message) => {
            let (title, detail) = build_timeline_error_display(message);
            let reconnect = message.will_retry == Some(true);
            let system = SystemDetail::NonOperation(NonOperationSystemFields {
                system_kind: if reconnect {
                    NonOperationSystemKind::Reconnect
                } else {
                    NonOperationSystemKind::Error
                },
            });
            let status = (!reconnect).then_some(RowStatus::Error);
            vec![system_row(base, title, detail, status, system)]
        }
        Message::Exec(exec) => match &exec.exec {
            ExecDetail::Delegation(delegation) => {
                let child_options = RowOptions {
                    completed_turn_display: options.completed_turn_display,
                    include_nested_rows: true,
                    workspace_root: options.workspace_root,
                    row_id_prefix: format!("{}:child:", base.id),
                };
                let child_rows = message_rows(&delegation.children, &child_options)
                    .into_iter()
                    .filter(|row| {
                        !matches!(row, TimelineRow::Work(WorkRow {
                            work: WorkDetail::Workflow(workflow),
                            ..
                        }) if is_background_agent_task_type(&workflow.task_type))
                    })
                    .collect();
                let work = WorkDetail::Delegation(DelegationWork {
                    work_kind: Default::default(),
                    call_id: delegation.call_id.clone(),
                    tool_name: delegation.tool_name.clone(),
                    child_ref: delegation.child_ref.clone(),
                    background: delegation.background,
                    subagent_type: delegation.subagent_type.clone(),
                    description: delegation.description.clone(),
                    output: delegation.output.clone(),
                    completed_at: delegation.completed_at,
                    child_rows,
                    presentation: delegation.presentation.clone(),
                });
                vec![work_row(base, exec.status, work)]
            }
            ExecDetail::Work(work) => vec![work_row(base, exec.status, work.clone())],
        },
        Message::Item(item) => vec![work_row(base, item.status, item.work.clone())],
        Message::Interaction(item) => vec![work_row(base, item.status, item.work.clone())],
        Message::User(user) => {
            if is_suppressed_system_message(user) {
                return Vec::new();
            }
            vec![TimelineRow::Conversation(ConversationRow {
                base,
                kind: Default::default(),
                text: user.text.clone(),
                attachments: user.attachments.clone(),
                role: ConversationRole::User(user.fields.clone()),
            })]
        }
    }
}

fn is_companion_thread_interrupted_row(previous: &TimelineRow, row: &TimelineRow) -> bool {
    let (TimelineRow::System(previous), TimelineRow::System(row)) = (previous, row) else {
        return false;
    };
    matches!(
        previous.system,
        SystemDetail::NonOperation(NonOperationSystemFields {
            system_kind: NonOperationSystemKind::Error
        })
    ) && matches!(
        row.system,
        SystemDetail::Operation(GenericOperationFields {
            operation_kind: SystemOperationKind::ThreadInterrupted,
            ..
        })
    ) && previous.base.thread_id == row.base.thread_id
        && previous.base.created_at == row.base.created_at
        && previous.base.started_at == row.base.started_at
        && previous.base.source_seq_end + 1 == row.base.source_seq_start
}

fn is_reconnect_system_row(row: Option<&TimelineRow>) -> bool {
    matches!(
        row,
        Some(TimelineRow::System(SystemRow {
            system: SystemDetail::NonOperation(NonOperationSystemFields {
                system_kind: NonOperationSystemKind::Reconnect
            }),
            ..
        }))
    )
}

/// `appendRows`: consecutive reconnect rows keep the latest; an interrupted operation right after
/// its error row is dropped.
fn append_rows(target: &mut Vec<TimelineRow>, rows: Vec<TimelineRow>) {
    for row in rows {
        match target.last_mut() {
            Some(previous)
                if is_reconnect_system_row(Some(previous))
                    && is_reconnect_system_row(Some(&row)) =>
            {
                *previous = row;
            }
            Some(previous) if is_companion_thread_interrupted_row(previous, &row) => {}
            _ => target.push(row),
        }
    }
}

fn message_rows(messages: &[Message], options: &RowOptions<'_>) -> Vec<TimelineRow> {
    let mut rows = Vec::new();
    for message in messages {
        append_rows(&mut rows, convert_message(message, options));
    }
    rows
}

/// `orderRowsAfterExternalUserBoundary`: from the first row at or after the earliest external user
/// boundary, rows are stably sorted by source sequence.
fn order_rows_after_external_user_boundary(
    mut rows: Vec<TimelineRow>,
    entries: &[ProjectionEntry],
) -> Vec<TimelineRow> {
    let first_boundary_seq = entries
        .iter()
        .filter_map(|entry| match entry {
            ProjectionEntry::Turn(turn) => turn.external_user_boundary_seqs.as_ref(),
            ProjectionEntry::ProjectedMessage(_) => None,
        })
        .flatten()
        .copied()
        .min();
    let Some(first_boundary_seq) = first_boundary_seq else {
        return rows;
    };
    let Some(start) = rows.iter().position(|row| row.base().source_seq_start >= first_boundary_seq)
    else {
        return rows;
    };
    rows[start..].sort_by_key(|row| (row.base().source_seq_start, row.base().source_seq_end));
    rows
}

fn build_timeline_rows(entries: &[ProjectionEntry], options: &RowOptions<'_>) -> Vec<TimelineRow> {
    let mut rows = Vec::new();
    for plan in plan_timeline_rows(entries, options.completed_turn_display, &options.row_id_prefix)
    {
        match plan {
            TimelineRowPlan::Message { message } => {
                append_rows(&mut rows, convert_message(&message, options));
            }
            TimelineRowPlan::Summary { mut row, messages } => {
                if options.include_nested_rows {
                    let children = messages
                        .iter()
                        .flat_map(|message| convert_message(message, options))
                        .collect();
                    row.children = Some(children);
                }
                append_rows(&mut rows, vec![TimelineRow::Turn(row)]);
            }
        }
    }
    order_rows_after_external_user_boundary(rows, entries)
}

/// `buildPendingSteerRows`: steer requests not yet accepted or rejected, while the thread status
/// preserves pending messages.
fn build_pending_steer_rows(
    events: &[ThreadEventWithMeta],
    options: &RowOptions<'_>,
    thread_status: &str,
) -> Vec<TimelineRow> {
    if !should_preserve_pending_messages(thread_status) {
        return Vec::new();
    }
    let ordered = get_ordered_thread_events(events);
    let accepted_by_id = build_accepted_client_request_by_id(&ordered);
    let rejected_ids: HashSet<&str> = ordered
        .iter()
        .filter(|entry| is_type(&entry.event, "client/turn/rejected"))
        .filter_map(|entry| request_id(&entry.event))
        .collect();
    let mut rows = Vec::new();
    for entry in &ordered {
        let event = &entry.event;
        if !is_type(event, "client/turn/requested") {
            continue;
        }
        let id = request_id(event).unwrap_or("");
        if rejected_ids.contains(id)
            || accepted_by_id.contains_key(id)
            || turn_request_kind(event, None) != TurnRequestKind::Steer
        {
            continue;
        }
        for steer in
            client_request_user_messages(event, &entry.meta, TurnRequestStatus::Pending, None)
        {
            rows.extend(convert_message(&Message::User(steer), options));
        }
    }
    rows
}

/// `buildThreadTimelineFromEvents` given the already built projection of `args.events`.
pub fn build_thread_timeline_from_projection(
    projection: &Projection,
    args: ThreadTimelineArgs<'_>,
) -> ThreadTimelineResult {
    let options = args.options;
    let combined;
    let state_events: &[ThreadEventWithMeta] = if args.head_state_events.is_empty() {
        args.events
    } else {
        let mut all = args.events.to_vec();
        all.extend_from_slice(args.head_state_events);
        combined = get_ordered_thread_events(&all);
        &combined
    };
    let row_options = RowOptions {
        completed_turn_display: options.completed_turn_display,
        include_nested_rows: options.include_nested_rows,
        workspace_root: options.workspace_root.as_deref(),
        row_id_prefix: String::new(),
    };
    let latest = options.is_latest_page;
    let mut rows = build_timeline_rows(&projection.entries, &row_options);
    rows.extend(build_pending_steer_rows(args.events, &row_options, &options.thread_status));
    ThreadTimelineResult {
        active_thinking: projection.active_thinking.clone(),
        active_workflows: build_workflow_work_rows(&projection.active_workflows, ""),
        active_background_commands: build_workflow_work_rows(
            &projection.active_background_commands,
            "",
        ),
        context_window_usage: extract_thread_context_window_usage(args.context_window_events),
        goal: latest.then(|| extract_thread_timeline_goal(state_events)).flatten(),
        model_fallback: latest
            .then(|| extract_thread_timeline_model_fallback(args.events))
            .flatten(),
        pending_todos: latest
            .then(|| extract_thread_timeline_pending_todos(&options.thread_status, state_events))
            .flatten(),
        rows,
    }
}

/// `buildThreadTimelineFromEvents`.
pub fn build_thread_timeline_from_events(args: ThreadTimelineArgs<'_>) -> ThreadTimelineResult {
    let projection = build_event_projection(args.events, &args.options.projection_options());
    build_thread_timeline_from_projection(&projection, args)
}
