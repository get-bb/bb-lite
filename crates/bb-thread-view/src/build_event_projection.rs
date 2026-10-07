//! Port of `build-event-projection.ts`: the event loop that turns a thread's ordered events into the
//! flat message list, then groups it into turns.
//!
//! TypeScript shares message objects between `state.messages` and the lookup maps and mutates them
//! through either. Here every projected message lives in [`ProjectionState::arena`] and is named by
//! a stable [`MsgRef`]; `messages` is the ordered list of refs and the maps hold refs. A message can
//! be dropped from (or moved within) `messages` without invalidating any ref.

// Remove once text, tool-activity and operation projection are ported: until then much of the
// shared state is only written, never read.

use std::collections::{HashMap, HashSet};

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::Value;

use crate::event::{self, EventScope};
use crate::group_turns::{
    GroupTurnsError, build_projection_entries, get_ordered_thread_events, sort_messages_by_source,
};
use crate::item_lifecycle as items;
use crate::operation_projection::{self as operations, CompactionTurnFinalizationStatus};
use crate::parse_operation_message::{
    finalize_operation_message, interrupt_operation_message, parse_error_message,
    parse_operation_message,
};
use crate::rows::{
    ApprovalDetail, FormLifecycle, PermissionGrantLifecycle, QuestionLifecycle, RowStatus,
    TurnRequestKind, TurnRequestStatus, WorkDetail,
};
use crate::text_projection::{self as text, ActiveThinkingLifecycle, ReasoningCompletionStatus};
use crate::tool_activity_projection::{self as tools, ToolActivityState};
use crate::types::{
    AssistantMessage, EventMeta, ExecDetail, ExecMessage, FileEditMessage, ItemMessage, Message,
    OperationMessage, Projection, ProjectionOptions, ThreadEventWithMeta, UserMessage,
    VisibleTextBuffer, WorkflowMessage,
};
use crate::user_message_parsing::{self as requests, AcceptedClientRequest};

/// `LOCAL_WORKFLOW_TASK_TYPE` from `@bb/domain`.
pub const LOCAL_WORKFLOW_TASK_TYPE: &str = "local_workflow";
/// `LOCAL_BASH_TASK_TYPE` from `@bb/domain`.
pub const LOCAL_BASH_TASK_TYPE: &str = "local_bash";
/// `LOCAL_AGENT_TASK_TYPE` from `@bb/domain`.
pub const LOCAL_AGENT_TASK_TYPE: &str = "local_agent";
/// `LOCAL_SUBAGENT_TASK_TYPE` from `@bb/domain`.
pub const LOCAL_SUBAGENT_TASK_TYPE: &str = "local_subagent";

/// `isBackgroundCommandTaskType`.
pub fn is_background_command_task_type(task_type: &str) -> bool {
    task_type == LOCAL_BASH_TASK_TYPE
}

/// `isBackgroundAgentTaskType`.
pub fn is_background_agent_task_type(task_type: &str) -> bool {
    task_type == LOCAL_AGENT_TASK_TYPE || task_type == LOCAL_SUBAGENT_TASK_TYPE
}

/// A stable handle to a message in [`ProjectionState::arena`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct MsgRef(pub(crate) usize);

/// `PendingDelegationTurnLink`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingDelegationTurnLink {
    pub(crate) call_id: String,
    pub(crate) parent_turn_id: String,
}

/// `{ content, summary }` reasoning delta text accumulated per reasoning key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ReasoningDeltaText {
    pub(crate) content: String,
    pub(crate) summary: String,
}

/// `ProjectionState`. TypeScript `Map`/`Set` iterate in insertion order, so ordered collections are
/// `IndexMap`/`IndexSet`; remove with `shift_remove` to keep that order.
#[derive(Debug, Default)]
pub(crate) struct ProjectionState {
    /// Storage for every message ever projected; never shrinks. See [`MsgRef`].
    pub(crate) arena: Vec<Message>,
    /// `messages`: the flat message list, in projection order.
    pub(crate) messages: Vec<MsgRef>,
    pub(crate) tool_activity: ToolActivityState,
    pub(crate) background_tasks_by_item_id: IndexMap<String, MsgRef>,
    pub(crate) file_edits_by_call_id: IndexMap<String, Vec<MsgRef>>,
    pub(crate) file_edit_stdout_buffers_by_scoped_call_key: IndexMap<String, VisibleTextBuffer>,
    pub(crate) open_compactions_by_key: IndexMap<String, MsgRef>,
    pub(crate) finalized_compaction_keys: HashSet<String>,
    /// Operation or interaction messages.
    pub(crate) lifecycle_messages_by_key: IndexMap<String, MsgRef>,
    pub(crate) open_assistant_messages_by_key: IndexMap<String, MsgRef>,
    pub(crate) assistant_text_buffers_by_key: IndexMap<String, VisibleTextBuffer>,
    pub(crate) visible_assistant_message_keys: HashSet<String>,
    pub(crate) finalized_assistant_message_keys: HashSet<String>,
    pub(crate) finalized_reasoning_keys: HashSet<String>,
    pub(crate) reasoning_delta_text_by_key: IndexMap<String, ReasoningDeltaText>,
    pub(crate) reasoning_messages_awaiting_completion: IndexMap<String, MsgRef>,
    pub(crate) open_reasoning_lifecycles_by_key: IndexMap<String, ActiveThinkingLifecycle>,
    pub(crate) reasoning_text_buffers_by_key: IndexMap<String, VisibleTextBuffer>,
    pub(crate) seen_user_keys: HashSet<String>,
    pub(crate) open_turn_ids: IndexSet<String>,
    pub(crate) closed_turn_ids: HashSet<String>,
    pub(crate) interrupted_turn_completed_at_by_id: IndexMap<String, i64>,
    pub(crate) thread_interrupted_at: Option<i64>,
    pub(crate) delegation_parent_tool_call_ids_by_provider_thread_id: HashMap<String, String>,
    pub(crate) delegation_parent_tool_call_ids_by_turn_id: HashMap<String, String>,
    pub(crate) suppressed_accepted_root_parent_tool_call_ids_by_turn_id: HashMap<String, String>,
    pub(crate) pending_delegation_turn_links_by_provider_thread_id:
        HashMap<String, Vec<PendingDelegationTurnLink>>,
    pub(crate) delegated_turn_link_call_ids: HashSet<String>,
}

/// `(get, get_mut, Variant, Type)` generates both accessors; `(get_mut, Variant, Type)` only the
/// mutable one.
macro_rules! typed_accessors {
    ($get:ident, $get_mut:ident, $variant:ident, $ty:ty) => {
        /// The message behind `r`; panics if it is another kind (a projection bug).
        pub(crate) fn $get(&self, r: MsgRef) -> &$ty {
            match &self.arena[r.0] {
                Message::$variant(message) => message,
                other => panic!("{r:?} is a {} message", other.kind()),
            }
        }

        typed_accessors!($get_mut, $variant, $ty);
    };
    ($get_mut:ident, $variant:ident, $ty:ty) => {
        /// The message behind `r`, mutably; panics if it is another kind (a projection bug).
        pub(crate) fn $get_mut(&mut self, r: MsgRef) -> &mut $ty {
            match &mut self.arena[r.0] {
                Message::$variant(message) => message,
                other => panic!("{r:?} is a {} message", other.kind()),
            }
        }
    };
}

impl ProjectionState {
    /// `createProjectionState`.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Stores `message` without listing it in `messages`.
    pub(crate) fn alloc(&mut self, message: Message) -> MsgRef {
        self.arena.push(message);
        MsgRef(self.arena.len() - 1)
    }

    /// `state.messages.push(message)`: stores and lists `message`.
    pub(crate) fn push_message(&mut self, message: Message) -> MsgRef {
        let r = self.alloc(message);
        self.messages.push(r);
        r
    }

    pub(crate) fn message(&self, r: MsgRef) -> &Message {
        &self.arena[r.0]
    }

    pub(crate) fn message_mut(&mut self, r: MsgRef) -> &mut Message {
        &mut self.arena[r.0]
    }

    /// The listed messages in order (cloned refs, so the state can be mutated while iterating).
    pub(crate) fn message_refs(&self) -> Vec<MsgRef> {
        self.messages.clone()
    }

    typed_accessors!(assistant, assistant_mut, AssistantText, AssistantMessage);
    typed_accessors!(exec_mut, Exec, ExecMessage);
    typed_accessors!(item, item_mut, Item, ItemMessage);
    typed_accessors!(file_edit, file_edit_mut, FileEdit, FileEditMessage);
    typed_accessors!(operation_mut, Operation, OperationMessage);

    /// The operation message behind `r` (read only by the operation projection tests).
    #[cfg(test)]
    pub(crate) fn operation(&self, r: MsgRef) -> &OperationMessage {
        match &self.arena[r.0] {
            Message::Operation(message) => message,
            other => panic!("{r:?} is a {} message", other.kind()),
        }
    }
    typed_accessors!(workflow_mut, Workflow, WorkflowMessage);

    /// The listed messages, materialized in order.
    fn into_messages(self) -> Vec<Message> {
        let mut slots: Vec<Option<Message>> = self.arena.into_iter().map(Some).collect();
        self.messages.iter().filter_map(|r| slots[r.0].take()).collect()
    }
}

/// `"callId" in message`: the call id of exec, item and file-edit messages.
pub fn message_call_id(message: &Message) -> Option<&str> {
    match message {
        Message::Exec(m) => match &m.exec {
            ExecDetail::Delegation(d) => Some(&d.call_id),
            ExecDetail::Work(work) => work_call_id(work),
        },
        Message::Item(m) => work_call_id(&m.work),
        Message::FileEdit(m) => Some(&m.call_id),
        _ => None,
    }
}

fn work_call_id(work: &WorkDetail) -> Option<&str> {
    match work {
        WorkDetail::Command(w) => Some(&w.call_id),
        WorkDetail::Tool(w) => Some(&w.call_id),
        WorkDetail::FileChange(w) => Some(&w.call_id),
        WorkDetail::WebSearch(w) => Some(&w.call_id),
        WorkDetail::WebFetch(w) => Some(&w.call_id),
        WorkDetail::ImageGeneration(w) => Some(&w.call_id),
        WorkDetail::ImageView(w) => Some(&w.call_id),
        WorkDetail::FileRead(w) => Some(&w.call_id),
        WorkDetail::Search(w) => Some(&w.call_id),
        WorkDetail::PlanSteps(w) => Some(&w.call_id),
        WorkDetail::Extension(w) => Some(&w.call_id),
        WorkDetail::Delegation(w) => Some(&w.call_id),
        WorkDetail::Approval(_)
        | WorkDetail::Question(_)
        | WorkDetail::Form(_)
        | WorkDetail::Workflow(_) => None,
    }
}

fn on_turn_completed(state: &mut ProjectionState, meta: &EventMeta, decoded: &Value) {
    let Some(turn_id) = event::turn_id(decoded) else {
        return;
    };
    state.closed_turn_ids.insert(turn_id.to_owned());
    state.open_turn_ids.shift_remove(turn_id);
    let status = event::status(decoded);
    if status == Some("interrupted") {
        state.interrupted_turn_completed_at_by_id.insert(turn_id.to_owned(), meta.created_at);
    }
    let reasoning_status = if status == Some("completed") {
        ReasoningCompletionStatus::Completed
    } else {
        ReasoningCompletionStatus::Interrupted
    };
    text::finalize_open_reasoning_lifecycles(state, meta, reasoning_status, Some(turn_id));
    flush_buffered_outputs(state, Some(turn_id));
}

fn on_thread_interrupted(state: &mut ProjectionState, meta: &EventMeta, thread_id: &str) {
    state.thread_interrupted_at = Some(meta.created_at);
    operations::interrupt_open_compactions(state, meta, thread_id);
    for turn_id in std::mem::take(&mut state.open_turn_ids) {
        state.interrupted_turn_completed_at_by_id.insert(turn_id.clone(), meta.created_at);
        state.closed_turn_ids.insert(turn_id);
    }
    text::finalize_open_reasoning_lifecycles(
        state,
        meta,
        ReasoningCompletionStatus::Interrupted,
        None,
    );
    flush_buffered_outputs(state, None);
}

fn flush_buffered_outputs(state: &mut ProjectionState, turn_id: Option<&str>) {
    text::flush_buffered_assistant_messages(state, turn_id);
    tools::flush_pending_tool_activity_output(state);
    operations::flush_pending_file_edit_output(state);
}

fn finalize_pending_messages(state: &mut ProjectionState, options: &ProjectionOptions) {
    if requests::should_preserve_pending_messages(&options.thread_status) {
        tools::flush_active_tool_cell(state);
        return;
    }
    tools::flush_pending_tool_activity_output(state);
    operations::flush_pending_file_edit_output(state);
    let interrupted_at = state.thread_interrupted_at;
    tools::interrupt_pending_tool_activity(state, interrupted_at, None);
    let file_edit_refs: Vec<MsgRef> =
        state.file_edits_by_call_id.values().flatten().copied().collect();
    for r in file_edit_refs {
        let file_edit = state.file_edit_mut(r);
        if file_edit.status == RowStatus::Pending {
            file_edit.status = RowStatus::Interrupted;
        }
    }
    text::flush_buffered_assistant_messages(state, None);
    for r in state.message_refs() {
        let closed_turn = |turn_id: &str| state.closed_turn_ids.contains(turn_id);
        let Message::Operation(message) = &state.arena[r.0] else {
            continue;
        };
        let settled_turn_compaction = options.thread_status == "idle"
            && message.op_type == crate::types::OperationType::Compaction
            && matches!(&message.base.scope, EventScope::Turn { turn_id } if closed_turn(turn_id));
        if !settled_turn_compaction {
            finalize_operation_message(state.operation_mut(r), options);
        }
    }
    tools::flush_active_tool_cell(state);
}

fn finalize_interrupted_turn_pending_messages(state: &mut ProjectionState) {
    let interrupted: Vec<(String, i64)> = state
        .interrupted_turn_completed_at_by_id
        .iter()
        .map(|(turn_id, at)| (turn_id.clone(), *at))
        .collect();
    for (turn_id, completed_at) in &interrupted {
        tools::interrupt_pending_tool_activity(state, Some(*completed_at), Some(turn_id));
    }
    for r in state.message_refs() {
        let in_interrupted_turn = match &state.arena[r.0].base().scope {
            EventScope::Turn { turn_id } => {
                state.interrupted_turn_completed_at_by_id.contains_key(turn_id)
            }
            _ => false,
        };
        if !in_interrupted_turn {
            continue;
        }
        match state.message_mut(r) {
            Message::Operation(message) => interrupt_operation_message(message),
            Message::FileEdit(message) if message.status == RowStatus::Pending => {
                message.status = RowStatus::Interrupted;
            }
            Message::Interaction(message) if message.status == RowStatus::Pending => {
                message.status = RowStatus::Interrupted;
                interrupt_interaction_lifecycle(&mut message.work);
            }
            _ => {}
        }
    }
}

/// `message.lifecycle = workKind === "form" ? "cancelled" : "interrupted"`. A file-edit approval
/// has no interrupted lifecycle in the row contract, so it keeps its lifecycle.
fn interrupt_interaction_lifecycle(work: &mut WorkDetail) {
    match work {
        WorkDetail::Form(form) => form.lifecycle = FormLifecycle::Cancelled,
        WorkDetail::Question(question) => question.lifecycle = QuestionLifecycle::Interrupted,
        WorkDetail::Approval(approval) => {
            if let ApprovalDetail::PermissionGrant(grant) = &mut approval.approval {
                grant.lifecycle = PermissionGrantLifecycle::Interrupted;
            }
        }
        _ => {}
    }
}

struct ClientTurnRequestedWithMeta<'a> {
    event: &'a Value,
    meta: &'a EventMeta,
}

fn by_newest_start(mut messages: Vec<WorkflowMessage>) -> Vec<WorkflowMessage> {
    // `Array.prototype.sort` is stable, as is `sort_by_key`.
    messages.sort_by_key(|message| std::cmp::Reverse(message.base.started_at_or_created()));
    messages
}

fn as_visible_pending_task(message: &Message) -> Option<&WorkflowMessage> {
    match message {
        Message::Workflow(workflow)
            if workflow.status == RowStatus::Pending && !workflow.skip_transcript =>
        {
            Some(workflow)
        }
        _ => None,
    }
}

type CallMessageById<'a> = HashMap<&'a str, &'a Message>;

fn call_parent(call: &Message) -> Option<&str> {
    call.base().parent_tool_call_id.as_deref()
}

fn is_direct_background_task_for_current_agent(
    message: &WorkflowMessage,
    call_message_by_id: &CallMessageById<'_>,
) -> bool {
    let Some(parent) = message.base.parent_tool_call_id.as_deref() else {
        return true;
    };
    match call_message_by_id.get(parent) {
        Some(spawning_call) => call_parent(spawning_call).is_none(),
        None => true,
    }
}

/// `getBackgroundTaskFamilyId`.
fn get_background_task_family_id(message: &WorkflowMessage) -> String {
    if let Some(family_id) = &message.family_id {
        return format!("family:{family_id}");
    }
    let item_id = &message.workflow.item_id;
    static GENERATION: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let generation_re = GENERATION.get_or_init(|| Regex::new(r"#(\d+)$").expect("valid regex"));
    let Some(captures) = generation_re.captures(item_id) else {
        return item_id.clone();
    };
    let whole = captures.get(0).expect("match");
    // `Number.isSafeInteger(generation) && generation > 1`.
    let generation: Option<u64> = captures[1].parse().ok();
    match generation {
        Some(g) if g > 1 && g <= 9_007_199_254_740_991 => item_id[..whole.start()].to_owned(),
        _ => item_id.clone(),
    }
}

/// `enrichBackgroundAgentModels`: a background agent's model is its spawning delegation's, else
/// its own, else the last one seen in its task family.
fn enrich_background_agent_models(messages: &mut [Message]) {
    let call_models: HashMap<String, Option<String>> = messages
        .iter()
        .filter_map(|message| {
            let call_id = message_call_id(message)?;
            let model = match message {
                Message::Exec(ExecMessage { exec: ExecDetail::Delegation(delegation), .. }) => {
                    delegation.model.clone()
                }
                _ => None,
            };
            Some((call_id.to_owned(), model))
        })
        .collect();
    // `new Map(entries)` keeps the last entry per call id, as `collect` does.
    let mut model_by_task_family_id: HashMap<String, String> = HashMap::new();
    for message in messages.iter_mut() {
        let Message::Workflow(workflow) = message else {
            continue;
        };
        if !is_background_agent_task_type(&workflow.workflow.task_type) {
            continue;
        }
        let task_family_id = get_background_task_family_id(workflow);
        let spawning_model = workflow
            .base
            .parent_tool_call_id
            .as_deref()
            .filter(|parent| !parent.is_empty())
            .and_then(|parent| call_models.get(parent).cloned().flatten());
        workflow.workflow.model = spawning_model
            .or_else(|| workflow.workflow.model.clone())
            .or_else(|| model_by_task_family_id.get(&task_family_id).cloned());
        if let Some(model) = &workflow.workflow.model {
            model_by_task_family_id.insert(task_family_id, model.clone());
        }
    }
}

fn get_root_spawning_call_id<'a>(
    message: &'a WorkflowMessage,
    call_message_by_id: &CallMessageById<'a>,
) -> Option<&'a str> {
    let mut call_id = message.base.parent_tool_call_id.as_deref();
    let mut visited = HashSet::new();
    while let Some(id) = call_id.filter(|id| !id.is_empty()) {
        if !visited.insert(id) {
            break;
        }
        match call_message_by_id.get(id).and_then(|call| call_parent(call)) {
            Some(parent) if !parent.is_empty() => call_id = Some(parent),
            _ => return Some(id),
        }
    }
    None
}

fn select_active_background_command_messages(
    messages: &[Message],
    call_message_by_id: &CallMessageById<'_>,
) -> Vec<WorkflowMessage> {
    let pending_tasks: Vec<&WorkflowMessage> =
        messages.iter().filter_map(as_visible_pending_task).collect();
    let represented_root_call_ids: HashSet<&str> = pending_tasks
        .iter()
        .filter_map(|message| {
            let parent = message.base.parent_tool_call_id.as_deref()?;
            (!parent.is_empty()
                && is_direct_background_task_for_current_agent(message, call_message_by_id))
            .then_some(parent)
        })
        .collect();
    by_newest_start(
        pending_tasks
            .into_iter()
            .filter(|message| {
                if message.workflow.task_type == LOCAL_WORKFLOW_TASK_TYPE {
                    return false;
                }
                if is_direct_background_task_for_current_agent(message, call_message_by_id) {
                    return true;
                }
                let represented_by_active_parent =
                    get_root_spawning_call_id(message, call_message_by_id)
                        .is_some_and(|root| represented_root_call_ids.contains(root));
                !represented_by_active_parent
                    && is_background_command_task_type(&message.workflow.task_type)
            })
            .cloned()
            .collect(),
    )
}

fn can_use_accepted_client_request_for_visible_projection(
    accepted: &AcceptedClientRequest,
    requested: &Value,
    selected_started_turn_ids: &HashSet<String>,
) -> bool {
    let target = event::field(requested, "target");
    let target_kind = target.and_then(|target| event::str_field(target, "kind"));
    if target_kind != Some("auto") && target_kind != Some("steer") {
        return true;
    }
    match target.and_then(|target| event::str_field(target, "expectedTurnId")) {
        None => true,
        Some(expected) => {
            accepted.turn_id == expected || selected_started_turn_ids.contains(&accepted.turn_id)
        }
    }
}

fn append_projected_user_messages(state: &mut ProjectionState, messages: Vec<UserMessage>) {
    for message in messages {
        if !state.seen_user_keys.insert(message.base.id.clone()) {
            continue;
        }
        tools::flush_active_tool_cell(state);
        state.push_message(Message::User(message));
    }
}

fn get_delegation_child_ref(decoded: &Value) -> Option<&str> {
    if !matches!(
        event::event_type(decoded),
        "item/started"
            | "item/completed"
            | "item/delegation/progress"
            | "item/delegation/completed"
    ) {
        return None;
    }
    let item = event::item(decoded)?;
    if event::item_type(item) != Some("delegation") {
        return None;
    }
    event::str_field(item, "childRef")
}

fn enqueue_pending_delegation_turn_link(
    state: &mut ProjectionState,
    provider_thread_id: Option<&str>,
    parent_turn_id: Option<&str>,
    call_id: &str,
) {
    let (Some(provider_thread_id), Some(parent_turn_id)) =
        (provider_thread_id.filter(|s| !s.is_empty()), parent_turn_id.filter(|s| !s.is_empty()))
    else {
        return;
    };
    if state.delegated_turn_link_call_ids.contains(call_id) {
        return;
    }
    state
        .pending_delegation_turn_links_by_provider_thread_id
        .entry(provider_thread_id.to_owned())
        .or_default()
        .push(PendingDelegationTurnLink {
            call_id: call_id.to_owned(),
            parent_turn_id: parent_turn_id.to_owned(),
        });
    state.delegated_turn_link_call_ids.insert(call_id.to_owned());
}

fn consume_pending_delegation_turn_link(
    state: &mut ProjectionState,
    provider_thread_id: Option<&str>,
    turn_id: &str,
) -> Option<String> {
    let provider_thread_id = provider_thread_id.filter(|s| !s.is_empty())?;
    if let Some(existing) = state.delegation_parent_tool_call_ids_by_turn_id.get(turn_id) {
        return Some(existing.clone());
    }
    let links = &mut state.pending_delegation_turn_links_by_provider_thread_id;
    let pending_links = links.get_mut(provider_thread_id)?;
    if pending_links.is_empty() {
        return None;
    }
    while !pending_links.is_empty() {
        let pending_link = pending_links.remove(0);
        if pending_link.parent_turn_id == turn_id {
            continue;
        }
        if pending_links.is_empty() {
            links.remove(provider_thread_id);
        }
        state
            .delegation_parent_tool_call_ids_by_turn_id
            .insert(turn_id.to_owned(), pending_link.call_id.clone());
        return Some(pending_link.call_id);
    }
    links.remove(provider_thread_id);
    None
}

/// `getCompactionTurnFinalization`.
fn get_compaction_turn_finalization(
    decoded: &Value,
) -> Option<(CompactionTurnFinalizationStatus, Option<String>)> {
    let owned = |s: Option<&str>| s.map(str::to_owned);
    let error_message = || {
        event::field(decoded, "error").and_then(|error| owned(event::str_field(error, "message")))
    };
    match event::event_type(decoded) {
        "provider/error" => Some((
            CompactionTurnFinalizationStatus::Error,
            owned(event::str_field(decoded, "detail").or(event::message(decoded))),
        )),
        "provider/warning"
            if event::str_field(decoded, "category") == Some("compaction-skipped") =>
        {
            Some((
                CompactionTurnFinalizationStatus::Completed,
                owned(
                    event::str_field(decoded, "details").or(event::str_field(decoded, "summary")),
                ),
            ))
        }
        "turn/completed" => match event::status(decoded) {
            Some("failed") => Some((CompactionTurnFinalizationStatus::Error, error_message())),
            Some("interrupted") => {
                Some((CompactionTurnFinalizationStatus::Interrupted, error_message()))
            }
            _ => None,
        },
        _ => None,
    }
}

fn link_delegation_child(state: &mut ProjectionState, decoded: &Value, call_id: &str) {
    let Some(child_ref) = get_delegation_child_ref(decoded) else {
        return;
    };
    let provider_thread_id = event::provider_thread_id(decoded);
    if Some(child_ref) == provider_thread_id || state.delegated_turn_link_call_ids.contains(call_id)
    {
        enqueue_pending_delegation_turn_link(
            state,
            provider_thread_id,
            event::turn_id(decoded),
            call_id,
        );
    } else {
        state
            .delegation_parent_tool_call_ids_by_provider_thread_id
            .insert(child_ref.to_owned(), call_id.to_owned());
    }
}

/// `buildFlatProjectionData` without the final summaries: runs the event loop and the final
/// pending-message passes, returning the state.
fn project_events(
    ordered_events: &[ThreadEventWithMeta],
    options: &ProjectionOptions,
) -> ProjectionState {
    let mut state = ProjectionState::new();
    let accepted_client_request_by_id =
        requests::build_accepted_client_request_by_id(ordered_events);
    let mut client_request_by_id: HashMap<&str, ClientTurnRequestedWithMeta<'_>> = HashMap::new();
    let mut rejected_client_request_ids: HashSet<&str> = HashSet::new();
    let mut selected_started_turn_ids: HashSet<String> = HashSet::new();
    for ThreadEventWithMeta { event, meta } in ordered_events {
        match event::event_type(event) {
            "client/turn/requested" => {
                if let Some(request_id) = event::request_id(event) {
                    client_request_by_id
                        .insert(request_id, ClientTurnRequestedWithMeta { event, meta });
                }
            }
            "client/turn/rejected" => {
                if let Some(request_id) = event::request_id(event) {
                    rejected_client_request_ids.insert(request_id);
                }
            }
            "turn/started" => {
                if let Some(turn_id) = event::turn_id(event) {
                    selected_started_turn_ids.insert(turn_id.to_owned());
                }
            }
            _ => {}
        }
    }
    let accepted_root_client_turn_ids: HashSet<&str> = ordered_events
        .iter()
        .filter(|entry| entry.event_type() == "turn/input/accepted")
        .filter_map(|entry| {
            let request = client_request_by_id.get(event::client_request_id(&entry.event)?)?;
            let target_kind =
                event::field(request.event, "target").and_then(|t| event::str_field(t, "kind"));
            matches!(target_kind, Some("new-turn" | "thread-start"))
                .then(|| event::turn_id(&entry.event))
                .flatten()
        })
        .collect();

    for ThreadEventWithMeta { event: decoded, meta } in ordered_events {
        let event_type = event::event_type(decoded);
        let thread_id = event::thread_id(decoded).unwrap_or_default();
        let event_turn_id = event::turn_id(decoded);
        let event_provider_thread_id = event::provider_thread_id(decoded);
        let is_accepted_root_client_turn =
            event_turn_id.is_some_and(|turn_id| accepted_root_client_turn_ids.contains(turn_id));
        let decoded_parent = event::parent_tool_call_id(decoded).filter(|id| !id.is_empty());
        if event_type == "turn/started"
            && is_accepted_root_client_turn
            && let (Some(turn_id), Some(parent)) = (event_turn_id, decoded_parent)
        {
            state
                .suppressed_accepted_root_parent_tool_call_ids_by_turn_id
                .insert(turn_id.to_owned(), parent.to_owned());
        }
        let explicit_parent: Option<String> = decoded_parent
            .filter(|parent| {
                !is_accepted_root_client_turn
                    || event_turn_id.is_none_or(|turn_id| {
                        state
                            .suppressed_accepted_root_parent_tool_call_ids_by_turn_id
                            .get(turn_id)
                            .map(String::as_str)
                            != Some(*parent)
                    })
            })
            .map(str::to_owned);
        if event_type == "turn/started"
            && let Some(turn_id) = event_turn_id
        {
            if is_accepted_root_client_turn {
                state.delegation_parent_tool_call_ids_by_turn_id.remove(turn_id);
            } else {
                let pending = consume_pending_delegation_turn_link(
                    &mut state,
                    event_provider_thread_id,
                    turn_id,
                );
                if let Some(parent) = explicit_parent.clone().or(pending)
                    && !parent.is_empty()
                {
                    state
                        .delegation_parent_tool_call_ids_by_turn_id
                        .insert(turn_id.to_owned(), parent);
                }
            }
            state.open_turn_ids.insert(turn_id.to_owned());
        }
        let event_parent: Option<String> = if is_accepted_root_client_turn {
            explicit_parent
        } else {
            explicit_parent
                .or_else(|| {
                    event_turn_id
                        .filter(|t| !t.is_empty())
                        .and_then(|t| state.delegation_parent_tool_call_ids_by_turn_id.get(t))
                        .cloned()
                })
                .or_else(|| {
                    event_provider_thread_id
                        .filter(|p| !p.is_empty())
                        .and_then(|p| {
                            state.delegation_parent_tool_call_ids_by_provider_thread_id.get(p)
                        })
                        .cloned()
                })
        };
        let event_parent = event_parent.as_deref();

        if let Some((status, detail)) = get_compaction_turn_finalization(decoded) {
            let settled_pending_compaction = operations::finalize_open_compactions_for_turn(
                &mut state,
                meta,
                thread_id,
                event_turn_id,
                status,
                detail.as_deref(),
            );
            if settled_pending_compaction && event_type == "provider/warning" {
                continue;
            }
        }
        if event_type == "turn/completed" {
            on_turn_completed(&mut state, meta, decoded);
            continue;
        }
        if event_type == "system/thread/interrupted" {
            on_thread_interrupted(&mut state, meta, thread_id);
        }
        if event_type == "turn/input/accepted" {
            let request_id = event::client_request_id(decoded).unwrap_or_default();
            let client_request = client_request_by_id.get(request_id);
            let accepted = accepted_client_request_by_id.get(request_id);
            if let (Some(client_request), Some(accepted)) = (client_request, accepted)
                && requests::turn_request_kind(client_request.event, Some(accepted))
                    == TurnRequestKind::Steer
            {
                append_projected_user_messages(
                    &mut state,
                    requests::client_request_user_messages(
                        client_request.event,
                        client_request.meta,
                        TurnRequestStatus::Accepted,
                        Some(accepted),
                    ),
                );
            }
            continue;
        }
        if event_type == "client/turn/rejected" {
            let request_id = event::request_id(decoded).unwrap_or_default();
            if let Some(client_request) = client_request_by_id.get(request_id) {
                append_projected_user_messages(
                    &mut state,
                    requests::client_request_user_messages(
                        client_request.event,
                        meta,
                        TurnRequestStatus::Rejected,
                        None,
                    ),
                );
            }
            continue;
        }
        if event_type == "client/turn/requested" {
            let request_id = event::request_id(decoded).unwrap_or_default();
            if rejected_client_request_ids.contains(request_id) {
                continue;
            }
            let visible_accepted =
                accepted_client_request_by_id.get(request_id).filter(|accepted| {
                    can_use_accepted_client_request_for_visible_projection(
                        accepted,
                        decoded,
                        &selected_started_turn_ids,
                    )
                });
            if requests::turn_request_kind(decoded, visible_accepted) == TurnRequestKind::Message {
                let status = if visible_accepted.is_some() {
                    TurnRequestStatus::Accepted
                } else {
                    TurnRequestStatus::Pending
                };
                append_projected_user_messages(
                    &mut state,
                    requests::client_request_user_messages(decoded, meta, status, visible_accepted),
                );
            }
            continue;
        }
        if let Some(user_message) = requests::parse_provider_user_message(decoded, meta) {
            append_projected_user_messages(&mut state, vec![user_message]);
            continue;
        }
        if text::project_assistant_and_reasoning_event(
            &mut state,
            decoded,
            meta,
            event_turn_id,
            event_parent,
        ) {
            continue;
        }
        if let Some(background_task) = tools::parse_background_task_lifecycle_event(decoded) {
            tools::flush_active_tool_cell(&mut state);
            tools::upsert_background_task_message(&mut state, meta, decoded, background_task);
            continue;
        }
        if let Some(exec_event) = items::parse_exec_lifecycle_event(decoded, meta, event_parent) {
            tools::apply_exec_lifecycle_event(
                &mut state,
                meta,
                thread_id,
                event_turn_id,
                exec_event,
            );
            continue;
        }
        if items::should_suppress_low_value_tool_call(decoded) {
            continue;
        }
        if let Some(tool_call_event) =
            items::parse_tool_call_lifecycle_event(decoded, meta, event_parent)
        {
            if let items::ExecLifecycleEvent::Begin { call }
            | items::ExecLifecycleEvent::End { call } = &tool_call_event
            {
                link_delegation_child(&mut state, decoded, call.call_id());
            }
            tools::apply_exec_lifecycle_event(
                &mut state,
                meta,
                thread_id,
                event_turn_id,
                tool_call_event,
            );
            continue;
        }
        if let Some(item_event) = items::parse_item_lifecycle_event(decoded, meta, event_parent) {
            tools::apply_item_lifecycle_event(
                &mut state,
                meta,
                thread_id,
                event_turn_id,
                item_event,
            );
            continue;
        }
        if let Some(file_edit) = items::parse_file_edit_from_item_event(decoded, event_parent) {
            tools::flush_active_tool_cell(&mut state);
            operations::upsert_file_edit(&mut state, meta, thread_id, event_turn_id, file_edit);
            continue;
        }
        if let Some(compaction_event) =
            items::parse_compaction_lifecycle_event(decoded, meta, event_parent)
        {
            tools::flush_active_tool_cell(&mut state);
            operations::apply_compaction_event(
                &mut state,
                meta,
                thread_id,
                event_turn_id,
                compaction_event,
            );
            continue;
        }
        if let Some(operation) = parse_operation_message(decoded, meta, options) {
            tools::flush_active_tool_cell(&mut state);
            operations::upsert_lifecycle_message(&mut state, operation);
            continue;
        }
        if let Some(error) = parse_error_message(decoded, meta) {
            tools::flush_active_tool_cell(&mut state);
            state.push_message(Message::Error(error));
        }
    }
    finalize_interrupted_turn_pending_messages(&mut state);
    finalize_pending_messages(&mut state, options);
    state
}

/// `buildEventProjection`, reporting a turn-grouping failure (which TypeScript throws).
pub fn try_build_event_projection(
    events: &[ThreadEventWithMeta],
    options: &ProjectionOptions,
) -> Result<Projection, GroupTurnsError> {
    let ordered_events = get_ordered_thread_events(events);
    let state = project_events(&ordered_events, options);
    let active_thinking = text::build_projection_active_thinking(&state, &options.thread_status);
    let mut messages = sort_messages_by_source(state.into_messages());
    enrich_background_agent_models(&mut messages);
    let call_message_by_id: CallMessageById<'_> =
        messages.iter().filter_map(|message| Some((message_call_id(message)?, message))).collect();
    let active_workflows = by_newest_start(
        messages
            .iter()
            .filter_map(as_visible_pending_task)
            .filter(|message| message.workflow.task_type == LOCAL_WORKFLOW_TASK_TYPE)
            .cloned()
            .collect(),
    );
    let active_background_commands =
        select_active_background_command_messages(&messages, &call_message_by_id);
    Ok(Projection {
        entries: build_projection_entries(&ordered_events, &messages)?,
        active_thinking,
        active_workflows,
        active_background_commands,
    })
}

/// `buildEventProjection`. Panics where TypeScript throws (an inconsistent turn grouping, which
/// the projection never produces from well-formed state); use [`try_build_event_projection`] to
/// handle it.
pub fn build_event_projection(
    events: &[ThreadEventWithMeta],
    options: &ProjectionOptions,
) -> Projection {
    try_build_event_projection(events, options)
        .unwrap_or_else(|error| panic!("timeline projection failed: {}", error.0))
}
