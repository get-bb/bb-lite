//! Grouping projected messages into turns and planning a turn's timeline rows: the port of
//! `group-event-projection-turns.ts`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{self, EventScope};
use crate::format::{get_first_string_field, message_id};
use crate::rows::{RowBase, RowStatus, TurnRequestKind, TurnRow, TurnTag, WorkDetail};
use crate::types::{
    DelegationMessage, EventMeta, ExecDetail, ExecMessage, Message, OperationType, ProjectedTurn,
    ProjectionEntry, ThreadEventWithMeta, extend_message_bounds,
};

/// `ExternalUserBoundaryTurnSpan`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUserBoundaryTurnSpan {
    pub completion_sequence: Option<i64>,
    pub sequence_start: i64,
    pub turn_id: String,
}

/// `isExternalUserBoundaryForTurn`: a message at `sequence` (in turn `turn_id`, if any) falls
/// strictly inside another turn's span.
pub fn is_external_user_boundary_for_turn(
    turn: &ExternalUserBoundaryTurnSpan,
    sequence: i64,
    turn_id: Option<&str>,
) -> bool {
    turn_id != Some(turn.turn_id.as_str())
        && sequence > turn.sequence_start
        && turn.completion_sequence.is_none_or(|completion| sequence < completion)
}

/// `getOrderedThreadEvents`: events in `meta.seq` order (stable).
pub fn get_ordered_thread_events(events: &[ThreadEventWithMeta]) -> Vec<ThreadEventWithMeta> {
    let mut ordered = events.to_vec();
    if !events.windows(2).all(|pair| pair[0].meta.seq <= pair[1].meta.seq) {
        ordered.sort_by_key(|event| event.meta.seq);
    }
    ordered
}

/// `sortMessagesBySource`: messages by `sourceSeqStart`, then `createdAt` (stable).
pub fn sort_messages_by_source(messages: Vec<Message>) -> Vec<Message> {
    let mut messages = messages;
    messages.sort_by_key(|message| (message.base().source_seq_start, message.base().created_at));
    messages
}

/// A grouping failure: the TypeScript `Error` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupTurnsError(pub String);

impl std::fmt::Display for GroupTurnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GroupTurnsError {}

struct TurnDraft {
    turn_id: String,
    completion_sequence: Option<i64>,
    started_sequence: i64,
    turn: ProjectedTurn,
}

fn update_turn_bounds(
    draft: &mut TurnDraft,
    thread_id: &str,
    source_seq_start: i64,
    source_seq_end: i64,
    created_at: i64,
) {
    let turn = &mut draft.turn;
    turn.thread_id = thread_id.to_string();
    turn.source_seq_start = turn.source_seq_start.min(source_seq_start);
    extend_message_bounds(turn, source_seq_end, created_at);
}

/// `requireThreadEventScopeTurnId`.
fn require_scope_turn_id(event: &Value) -> Result<String, GroupTurnsError> {
    let scope = event::field(event, "scope");
    let kind = scope.and_then(|scope| event::str_field(scope, "kind"));
    if kind == Some("turn") {
        let turn_id = scope.and_then(|scope| event::str_field(scope, "turnId"));
        return Ok(turn_id.unwrap_or_default().to_string());
    }
    Err(GroupTurnsError(format!(
        "{} requires turn scope but received {} scope",
        event::event_type(event),
        kind.unwrap_or("undefined")
    )))
}

fn require_turn(
    index_by_turn_id: &HashMap<String, usize>,
    turn_id: &str,
    orphan: impl FnOnce() -> String,
) -> Result<usize, GroupTurnsError> {
    index_by_turn_id
        .get(turn_id)
        .copied()
        .ok_or_else(|| GroupTurnsError(format!("Timeline projection found {}", orphan())))
}

fn find_turn_running_at_sequence(drafts: &[TurnDraft], sequence: i64) -> Option<usize> {
    let mut running: Option<usize> = None;
    for (index, draft) in drafts.iter().enumerate() {
        if draft.started_sequence < sequence
            && draft.completion_sequence.is_none_or(|completion| completion >= sequence)
            && running
                .is_none_or(|current| draft.started_sequence > drafts[current].started_sequence)
        {
            running = Some(index);
        }
    }
    running
}

fn is_user_initiated(message: &Message) -> bool {
    matches!(message, Message::User(user) if user.fields.initiator == "user")
}

fn apply_external_user_boundaries(drafts: &mut [TurnDraft], messages: &[Message]) {
    let user_messages: Vec<(i64, Option<&str>)> = messages
        .iter()
        .filter(|message| is_user_initiated(message))
        .map(|message| (message.base().source_seq_start, message.base().turn_id()))
        .collect();
    for draft in drafts {
        let span = ExternalUserBoundaryTurnSpan {
            completion_sequence: draft.completion_sequence,
            sequence_start: draft.turn.source_seq_start,
            turn_id: draft.turn_id.clone(),
        };
        let mut seqs: Vec<i64> = user_messages
            .iter()
            .filter(|(sequence, turn_id)| {
                is_external_user_boundary_for_turn(&span, *sequence, *turn_id)
            })
            .map(|(sequence, _)| *sequence)
            .collect();
        if !seqs.is_empty() {
            seqs.sort_unstable();
            seqs.dedup();
            draft.turn.external_user_boundary_seqs = Some(seqs);
        }
    }
}

#[allow(clippy::large_enum_variant)]
enum DraftEntry {
    Turn(usize),
    Message(Message),
}

fn group_messages_into_turns(
    events: &[ThreadEventWithMeta],
    messages: &[Message],
) -> Result<Vec<ProjectionEntry>, GroupTurnsError> {
    let mut turns: Vec<TurnDraft> = Vec::new();
    let mut index_by_turn_id: HashMap<String, usize> = HashMap::new();
    let mut client_request_meta_by_id: HashMap<&str, &EventMeta> = HashMap::new();
    let mut drafts: Vec<(i64, i64, DraftEntry)> = Vec::new();
    for ThreadEventWithMeta { event, meta } in events {
        if event::is_type(event, "client/turn/requested")
            && let Some(request_id) = event::request_id(event)
        {
            client_request_meta_by_id.insert(request_id, meta);
        }
    }
    for ThreadEventWithMeta { event, meta } in events {
        let (seq, created_at) = (meta.seq, meta.created_at);
        let event_type = event::event_type(event);
        let thread_id = event::thread_id(event).unwrap_or_default();
        match event_type {
            "turn/started" => {
                let turn_id = require_scope_turn_id(event)?;
                if index_by_turn_id.contains_key(&turn_id) {
                    continue;
                }
                let turn = ProjectedTurn {
                    turn_id: turn_id.clone(),
                    thread_id: thread_id.to_string(),
                    source_seq_start: seq,
                    source_seq_end: seq,
                    started_at: created_at,
                    created_at,
                    completed_at: None,
                    status: RowStatus::Pending,
                    external_user_boundary_seqs: None,
                    messages: Vec::new(),
                };
                index_by_turn_id.insert(turn_id.clone(), turns.len());
                drafts.push((seq, created_at, DraftEntry::Turn(turns.len())));
                turns.push(TurnDraft {
                    turn_id,
                    completion_sequence: None,
                    started_sequence: seq,
                    turn,
                });
            }
            "turn/completed" => {
                let turn_id = require_scope_turn_id(event)?;
                let index = require_turn(&index_by_turn_id, &turn_id, || {
                    format!("{event_type} without turn/started for {turn_id}")
                })?;
                let draft = &mut turns[index];
                update_turn_bounds(draft, thread_id, seq, seq, created_at);
                draft.turn.completed_at = Some(created_at);
                draft.turn.status = completed_turn_status(event::status(event));
                draft.completion_sequence.get_or_insert(seq);
            }
            "turn/input/accepted" => {
                let turn_id = require_scope_turn_id(event)?;
                let index = require_turn(&index_by_turn_id, &turn_id, || {
                    format!("{event_type} without turn/started for {turn_id}")
                })?;
                let request = event::client_request_id(event)
                    .and_then(|id| client_request_meta_by_id.get(id));
                if let Some(request) = request {
                    let (requested, at) = (request.seq, request.created_at);
                    update_turn_bounds(&mut turns[index], thread_id, requested, requested, at);
                }
            }
            _ => {}
        }
    }
    for message in messages {
        let base = message.base();
        let (seq, created_at) = (base.source_seq_start, base.created_at);
        let index = match &base.scope {
            EventScope::Turn { turn_id } => Some(require_turn(&index_by_turn_id, turn_id, || {
                format!("message {} for turn {turn_id} without turn/started", base.id)
            })?),
            EventScope::Thread if matches!(message, Message::Interaction(_)) => {
                find_turn_running_at_sequence(&turns, seq)
            }
            EventScope::Thread => None,
        };
        match index {
            Some(index) => {
                let draft = &mut turns[index];
                draft.turn.messages.push(message.clone());
                update_turn_bounds(draft, &base.thread_id, seq, base.source_seq_end, created_at);
            }
            None => drafts.push((seq, created_at, DraftEntry::Message(message.clone()))),
        }
    }
    apply_external_user_boundaries(&mut turns, messages);
    drafts.sort_by_key(|(seq, created_at, _)| (*seq, *created_at));
    let mut turns: Vec<Option<ProjectedTurn>> =
        turns.into_iter().map(|draft| Some(draft.turn)).collect();
    Ok(drafts
        .into_iter()
        .filter_map(|(_, _, entry)| match entry {
            DraftEntry::Turn(index) => turns[index].take().map(ProjectionEntry::Turn),
            DraftEntry::Message(message) => Some(ProjectionEntry::ProjectedMessage(message)),
        })
        .collect())
}

/// `event.status === "failed" ? "error" : event.status`.
fn completed_turn_status(status: Option<&str>) -> RowStatus {
    match status {
        Some("failed" | "error") => RowStatus::Error,
        Some("interrupted") => RowStatus::Interrupted,
        Some("pending") => RowStatus::Pending,
        _ => RowStatus::Completed,
    }
}

fn delegation_of(message: &Message) -> Option<&DelegationMessage> {
    match message {
        Message::Exec(ExecMessage { exec: ExecDetail::Delegation(delegation), .. }) => {
            Some(delegation)
        }
        _ => None,
    }
}

/// `toolCallAsDelegationMessage`; `outputPreview` has no field on [`DelegationMessage`].
fn tool_call_as_delegation_message(message: &ExecMessage) -> Option<Message> {
    let ExecDetail::Work(WorkDetail::Tool(tool)) = &message.exec else { return None };
    let args = tool.tool_args.as_ref();
    let string = |keys: &[&str]| get_first_string_field(args, keys).map(str::to_string);
    let mut base = message.base.clone();
    base.id = message_id(&base.thread_id, "delegation", &tool.call_id);
    Some(Message::Exec(ExecMessage {
        base,
        status: message.status,
        exec: ExecDetail::Delegation(DelegationMessage {
            call_id: tool.call_id.clone(),
            tool_name: tool.tool_name.clone(),
            child_ref: None,
            background: false,
            subagent_type: string(&["subagent_type", "subagentType"]),
            description: string(&["description", "prompt"]),
            model: string(&["model"]),
            output: tool.output.clone(),
            completed_at: tool.completed_at,
            children: Vec::new(),
            presentation: tool.presentation.clone(),
        }),
    }))
}

fn with_children(message: &Message, children: Vec<Message>) -> Message {
    let mut message = message.clone();
    if !children.is_empty() {
        let family = std::iter::once(&message).chain(&children).map(Message::base);
        let (mut start, mut end) = (i64::MAX, i64::MIN);
        let (mut created, mut started) = (i64::MIN, i64::MAX);
        for base in family {
            start = start.min(base.source_seq_start);
            end = end.max(base.source_seq_end);
            created = created.max(base.created_at);
            started = started.min(base.started_at_or_created());
        }
        let base = message.base_mut();
        base.source_seq_start = start;
        base.source_seq_end = end;
        base.created_at = created;
        base.started_at = Some(started);
    }
    if let Message::Exec(ExecMessage { exec: ExecDetail::Delegation(delegation), .. }) =
        &mut message
    {
        delegation.children = children;
    }
    message
}

fn entry_messages(entry: &ProjectionEntry) -> &[Message] {
    match entry {
        ProjectionEntry::Turn(turn) => &turn.messages,
        ProjectionEntry::ProjectedMessage(message) => std::slice::from_ref(message),
    }
}

struct Nesting<'a> {
    children_by_parent_call_id: HashMap<&'a str, Vec<&'a Message>>,
    attached_message_ids: HashSet<&'a str>,
}

impl Nesting<'_> {
    /// `nested`; a delegation that contains itself recurses forever in TypeScript (a thrown
    /// `RangeError`), reported here as the same error message.
    fn nested(
        &self,
        message: &Message,
        path: &mut Vec<String>,
    ) -> Result<Message, GroupTurnsError> {
        let Some(delegation) = delegation_of(message) else { return Ok(message.clone()) };
        if path.contains(&delegation.call_id) {
            return Err(GroupTurnsError("Maximum call stack size exceeded".to_string()));
        }
        path.push(delegation.call_id.clone());
        let children = self
            .children_by_parent_call_id
            .get(delegation.call_id.as_str())
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|child| self.nested(child, path))
            .collect::<Result<Vec<_>, _>>()?;
        path.pop();
        Ok(with_children(message, children))
    }
}

fn nest_delegated_messages(
    entries: Vec<ProjectionEntry>,
) -> Result<Vec<ProjectionEntry>, GroupTurnsError> {
    let all: Vec<&Message> = entries.iter().flat_map(entry_messages).collect();
    let referenced_parent_call_ids: HashSet<&str> =
        all.iter().filter_map(|message| message.base().parent_tool_call_id.as_deref()).collect();
    let promote = |message: &Message| -> Option<Message> {
        let Message::Exec(exec) = message else { return None };
        let ExecDetail::Work(WorkDetail::Tool(tool)) = &exec.exec else { return None };
        if !referenced_parent_call_ids.contains(tool.call_id.as_str()) {
            return None;
        }
        tool_call_as_delegation_message(exec)
    };
    let sources: Vec<Vec<Message>> = entries
        .iter()
        .map(|entry| {
            entry_messages(entry)
                .iter()
                .map(|message| promote(message).unwrap_or_else(|| message.clone()))
                .collect()
        })
        .collect();
    let delegation_call_ids: HashSet<&str> = sources
        .iter()
        .flatten()
        .filter_map(|message| delegation_of(message).map(|delegation| delegation.call_id.as_str()))
        .collect();
    let mut nesting = Nesting {
        children_by_parent_call_id: HashMap::new(),
        attached_message_ids: HashSet::new(),
    };
    for message in sources.iter().flatten() {
        let Some(parent) = message.base().parent_tool_call_id.as_deref() else { continue };
        if parent.is_empty() || !delegation_call_ids.contains(parent) {
            continue;
        }
        nesting.children_by_parent_call_id.entry(parent).or_default().push(message);
        nesting.attached_message_ids.insert(&message.base().id);
    }
    let mut nested_entries = Vec::new();
    for (entry, source) in entries.iter().zip(&sources) {
        let mut messages = Vec::new();
        for message in source {
            let base = message.base();
            if nesting.attached_message_ids.contains(base.id.as_str())
                || base.parent_tool_call_id.is_some()
            {
                continue;
            }
            messages.push(nesting.nested(message, &mut Vec::new())?);
        }
        if messages.is_empty() {
            continue;
        }
        nested_entries.push(match entry {
            ProjectionEntry::Turn(turn) => {
                ProjectionEntry::Turn(ProjectedTurn { messages, ..turn.clone() })
            }
            ProjectionEntry::ProjectedMessage(_) => {
                ProjectionEntry::ProjectedMessage(messages.swap_remove(0))
            }
        });
    }
    Ok(nested_entries)
}

/// `buildProjectionEntries`: groups `messages` (already in source order) into the turns started
/// by `events` (in `seq` order), then nests delegated messages under their delegation.
pub fn build_projection_entries(
    events: &[ThreadEventWithMeta],
    messages: &[Message],
) -> Result<Vec<ProjectionEntry>, GroupTurnsError> {
    nest_delegated_messages(group_messages_into_turns(events, messages)?)
}

fn is_terminal_message(message: &Message) -> bool {
    matches!(message, Message::AssistantText(_) | Message::Error(_))
}

fn is_ungroupable_message(message: &Message) -> bool {
    let Message::User(user) = message else { return false };
    let fields = &user.fields;
    !(fields.turn_request.kind == TurnRequestKind::Steer
        && (fields.initiator == "agent" || fields.initiator == "system"))
}

fn is_singleton_context_management_operation(messages: &[Message]) -> bool {
    matches!(
        messages,
        [Message::Operation(operation)]
            if matches!(operation.op_type, OperationType::Compaction | OperationType::ContextClear)
    )
}

fn summary_count_of(messages: &[Message]) -> u64 {
    messages
        .iter()
        .filter(|message| !is_ungroupable_message(message))
        .map(|message| match message {
            Message::FileEdit(edit) => edit.changes.len().max(1) as u64,
            _ => 1,
        })
        .sum()
}

struct SummaryGroup {
    started_at: i64,
    completed_at: Option<i64>,
    segment_index: Option<usize>,
    source_messages: Vec<Message>,
    summary_count: u64,
}

#[allow(clippy::large_enum_variant)]
enum SummaryItem {
    Summary(usize),
    Message(Message),
}

fn find_visible_response_message_ids<'a>(
    summary_messages: &'a [Message],
    terminal_message: Option<&Message>,
) -> HashSet<&'a str> {
    let mut visible = HashSet::new();
    for (index, message) in summary_messages.iter().enumerate() {
        let next = summary_messages.get(index + 1).or(terminal_message);
        if matches!(message, Message::AssistantText(_))
            && matches!(next, Some(Message::AssistantText(_)))
        {
            visible.insert(message.base().id.as_str());
        }
    }
    visible
}

#[derive(Default)]
struct SummaryBuilder {
    items: Vec<SummaryItem>,
    groups: Vec<SummaryGroup>,
    grouped_messages: Vec<Message>,
}

impl SummaryBuilder {
    fn append_summary_group(&mut self, source_messages: Vec<Message>) {
        if source_messages.is_empty() {
            return;
        }
        let started_at =
            source_messages.iter().map(|message| message.base().started_at_or_created()).min();
        self.groups.push(SummaryGroup {
            started_at: started_at.unwrap_or_default(),
            completed_at: None,
            segment_index: Some(self.groups.len()),
            summary_count: summary_count_of(&source_messages),
            source_messages,
        });
        self.items.push(SummaryItem::Summary(self.groups.len() - 1));
    }

    fn flush(&mut self, preserve_last_terminal_message: bool) {
        let source_messages = std::mem::take(&mut self.grouped_messages);
        let terminal = preserve_last_terminal_message
            .then(|| source_messages.iter().rev().find(|message| is_terminal_message(message)))
            .flatten()
            .cloned();
        let Some(terminal) = terminal else {
            self.append_summary_group(source_messages);
            return;
        };
        let terminal_id = terminal.base().id.clone();
        self.append_summary_group(
            source_messages
                .into_iter()
                .filter(|message| message.base().id != terminal_id)
                .collect(),
        );
        self.items.push(SummaryItem::Message(terminal));
    }
}

fn group_summary_messages(
    turn: &ProjectedTurn,
    summary_messages: &[Message],
    terminal_message: Option<&Message>,
) -> (Vec<SummaryItem>, Vec<SummaryGroup>) {
    let external_boundary_seqs = turn.external_user_boundary_seqs.as_deref().unwrap_or_default();
    let visible_response_ids =
        find_visible_response_message_ids(summary_messages, terminal_message);
    if external_boundary_seqs.is_empty()
        && visible_response_ids.is_empty()
        && !summary_messages.iter().any(is_ungroupable_message)
    {
        let group = SummaryGroup {
            started_at: turn.started_at,
            completed_at: turn.completed_at,
            segment_index: None,
            source_messages: summary_messages.to_vec(),
            summary_count: summary_count_of(summary_messages),
        };
        return (vec![SummaryItem::Summary(0)], vec![group]);
    }
    let mut builder = SummaryBuilder::default();
    let mut external_boundary_index = 0;
    for message in summary_messages {
        while external_boundary_seqs
            .get(external_boundary_index)
            .is_some_and(|boundary| *boundary < message.base().source_seq_start)
        {
            builder.flush(true);
            external_boundary_index += 1;
        }
        if visible_response_ids.contains(message.base().id.as_str()) {
            builder.flush(false);
            builder.items.push(SummaryItem::Message(message.clone()));
        } else if is_ungroupable_message(message) {
            builder.flush(is_user_initiated(message));
            builder.items.push(SummaryItem::Message(message.clone()));
        } else {
            builder.grouped_messages.push(message.clone());
        }
    }
    while external_boundary_index < external_boundary_seqs.len() {
        builder.flush(true);
        external_boundary_index += 1;
    }
    builder.flush(false);
    if let [only_group] = builder.groups.as_mut_slice() {
        only_group.started_at = turn.started_at;
        only_group.completed_at = turn.completed_at;
    }
    (builder.items, builder.groups)
}

/// `TimelineRowPlan`: a message to convert, or a turn summary row and the messages it summarizes.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimelineRowPlan {
    Message { message: Message },
    Summary { row: TurnRow, messages: Vec<Message> },
}

fn message_plan(message: Message) -> TimelineRowPlan {
    TimelineRowPlan::Message { message }
}

fn summary_plan(
    turn: &ProjectedTurn,
    group: SummaryGroup,
    row_id_prefix: &str,
) -> Option<TimelineRowPlan> {
    let SummaryGroup { source_messages, segment_index, .. } = group;
    if is_singleton_context_management_operation(&source_messages) {
        return source_messages.into_iter().next().map(message_plan);
    }
    if group.summary_count == 0 && source_messages.is_empty() {
        return None;
    }
    let use_turn_bounds = segment_index.is_none() || source_messages.is_empty();
    let bases = || source_messages.iter().map(Message::base);
    let suffix = segment_index.map(|index| format!(":{index}")).unwrap_or_default();
    let max_created = bases().map(|base| base.created_at).max();
    let row = TurnRow {
        base: RowBase {
            id: format!("{row_id_prefix}{}:{}:turn{suffix}", turn.thread_id, turn.turn_id),
            thread_id: turn.thread_id.clone(),
            turn_id: Some(turn.turn_id.clone()),
            source_seq_start: if use_turn_bounds {
                turn.source_seq_start
            } else {
                bases().map(|base| base.source_seq_start).min().unwrap_or_default()
            },
            source_seq_end: if use_turn_bounds {
                turn.source_seq_end
            } else {
                bases().map(|base| base.source_seq_end).max().unwrap_or_default()
            },
            started_at: group.started_at,
            created_at: if use_turn_bounds {
                turn.created_at
            } else {
                bases().map(|base| base.created_at).min().unwrap_or_default()
            },
        },
        kind: TurnTag,
        status: turn.status,
        summary_count: group.summary_count,
        completed_at: group.completed_at.or(max_created),
        children: None,
    };
    Some(TimelineRowPlan::Summary { row, messages: source_messages })
}

fn plan_turn(turn: &ProjectedTurn, flat: bool, row_id_prefix: &str) -> Vec<TimelineRowPlan> {
    let messages = &turn.messages;
    if turn.status == RowStatus::Pending || turn.completed_at.is_none() || flat {
        return messages.iter().cloned().map(message_plan).collect();
    }
    let terminal_index = messages
        .iter()
        .rposition(is_terminal_message)
        .and_then(|last| {
            let id = &messages[last].base().id;
            messages.iter().position(|message| &message.base().id == id)
        })
        .unwrap_or(messages.len());
    let (items, groups) =
        group_summary_messages(turn, &messages[..terminal_index], messages.get(terminal_index));
    let mut groups: Vec<Option<SummaryGroup>> = groups.into_iter().map(Some).collect();
    let mut plans = Vec::new();
    for item in items {
        match item {
            SummaryItem::Message(message) => plans.push(message_plan(message)),
            SummaryItem::Summary(index) => {
                if let Some(group) = groups[index].take() {
                    plans.extend(summary_plan(turn, group, row_id_prefix));
                }
            }
        }
    }
    plans.extend(messages[terminal_index..].iter().cloned().map(message_plan));
    plans
}

/// `CompletedTurnDisplay`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompletedTurnDisplay {
    Collapse,
    Flat,
}

/// `planTimelineRows`: the row plan for each entry; completed turns collapse into summary rows
/// unless `completed_turn_display` is `Flat`.
pub fn plan_timeline_rows(
    entries: &[ProjectionEntry],
    completed_turn_display: CompletedTurnDisplay,
    row_id_prefix: &str,
) -> Vec<TimelineRowPlan> {
    let flat = completed_turn_display == CompletedTurnDisplay::Flat;
    entries
        .iter()
        .flat_map(|entry| match entry {
            ProjectionEntry::ProjectedMessage(message) => vec![message_plan(message.clone())],
            ProjectionEntry::Turn(turn) => plan_turn(turn, flat, row_id_prefix),
        })
        .collect()
}
