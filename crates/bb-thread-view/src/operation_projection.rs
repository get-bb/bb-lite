//! Port of `operation-projection.ts`: lifecycle (operation and interaction) messages, file edits
//! and compactions.

use crate::build_event_projection::{MsgRef, ProjectionState};
use crate::event::EventScope;
use crate::format::message_id;
use crate::item_lifecycle::{CompactionLifecycleEvent, FileEditPartial, LifecycleKind};
use crate::parse_operation_message::{merge_transcript_entries, provisioning_title_for_status};
use crate::rows::{ApprovalDetail, RowStatus, WorkDetail};
use crate::tool_activity_projection::merge_approval_status;
use crate::types::{
    EventMeta, FileEditChange, FileEditMessage, InteractionMessage, Message, MessageBase,
    OperationMessage, OperationType, extend_message_bounds, scope_for_turn,
};
use indexmap::IndexMap;
use std::collections::HashSet;

/// `CompactionTurnFinalizationStatus`: `TimelineRowStatus` without `"pending"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CompactionTurnFinalizationStatus {
    Completed,
    Error,
    Interrupted,
}

impl CompactionTurnFinalizationStatus {
    pub fn row_status(self) -> RowStatus {
        match self {
            Self::Completed => RowStatus::Completed,
            Self::Error => RowStatus::Error,
            Self::Interrupted => RowStatus::Interrupted,
        }
    }
}

/// `mergeOperationDetail`: the distinct non-empty details joined by newlines.
pub(crate) fn merge_operation_detail(
    existing: Option<&str>,
    incoming: Option<&str>,
) -> Option<String> {
    let mut details: Vec<&str> = Vec::new();
    for detail in [existing, incoming].into_iter().flatten() {
        if !detail.is_empty() && !details.contains(&detail) {
            details.push(detail);
        }
    }
    (!details.is_empty()).then(|| details.join("\n"))
}

/// The `interactionId` of an approval, question or form interaction.
fn interaction_id(work: &WorkDetail) -> Option<&str> {
    match work {
        WorkDetail::Approval(work) => Some(&work.interaction_id),
        WorkDetail::Question(work) => Some(&work.interaction_id),
        WorkDetail::Form(work) => Some(&work.interaction_id),
        _ => None,
    }
}

/// `lifecycleIndexKey`: `<workKind|opType>:<thread|turn:id>:<interactionId|mergeKey>`, or `None`
/// without a key. `message` is an operation or interaction message.
pub(crate) fn lifecycle_index_key(message: &Message) -> Option<String> {
    let (kind, key, base) = match message {
        Message::Interaction(message) => {
            (message.work.work_kind(), interaction_id(&message.work), &message.base)
        }
        Message::Operation(message) => {
            (message.op_type.as_str(), message.merge_key.as_deref(), &message.base)
        }
        _ => return None,
    };
    let key = key.filter(|key| !key.is_empty())?;
    let scope_key = match &base.scope {
        EventScope::Thread => "thread".to_string(),
        EventScope::Turn { turn_id } => format!("turn:{turn_id}"),
    };
    Some(format!("{kind}:{scope_key}:{key}"))
}

/// `upsertLifecycleMessage`: merges `incoming` (an operation or interaction message from
/// `parse_operation_message`) into the message with the same lifecycle key, or appends it.
pub(crate) fn upsert_lifecycle_message(state: &mut ProjectionState, incoming: Message) {
    let index_key = lifecycle_index_key(&incoming);
    let existing =
        index_key.as_ref().and_then(|key| state.lifecycle_messages_by_key.get(key).copied());
    let Some(existing) = existing else {
        let r = state.push_message(incoming);
        if let Some(key) = index_key {
            state.lifecycle_messages_by_key.insert(key, r);
        }
        return;
    };
    let existing = state.message_mut(existing);
    merge_lifecycle_bounds(existing.base_mut(), incoming.base());
    match (existing, incoming) {
        (Message::Interaction(existing), Message::Interaction(incoming)) => {
            merge_interaction(existing, incoming);
        }
        (Message::Operation(existing), Message::Operation(incoming)) => {
            merge_operation(existing, incoming);
        }
        _ => {}
    }
}

fn merge_lifecycle_bounds(existing: &mut MessageBase, incoming: &MessageBase) {
    existing.source_seq_start = existing.source_seq_start.min(incoming.source_seq_start);
    extend_message_bounds(existing, incoming.source_seq_end, incoming.created_at);
    existing.started_at =
        Some(existing.started_at_or_created().min(incoming.started_at_or_created()));
}

fn merge_operation(existing: &mut OperationMessage, incoming: OperationMessage) {
    let settles = existing.status == RowStatus::Pending && incoming.status != RowStatus::Pending;
    if settles {
        existing.status = incoming.status;
        existing.completed_at = Some(incoming.completed_at.unwrap_or(incoming.base.created_at));
    }
    if existing.op_type == OperationType::ThreadProvisioning {
        existing.title = provisioning_title_for_status(existing.status).to_string();
        existing.transcript = merge_transcript_entries(
            existing.transcript.as_deref(),
            incoming.transcript.as_deref(),
        );
    } else if settles {
        existing.title = incoming.title;
        existing.parent_change = incoming.parent_change;
    }
    existing.detail =
        merge_operation_detail(existing.detail.as_deref(), incoming.detail.as_deref());
}

fn merge_interaction(existing: &mut InteractionMessage, incoming: InteractionMessage) {
    match (&mut existing.work, incoming.work) {
        (WorkDetail::Approval(existing_work), WorkDetail::Approval(incoming_work)) => {
            existing_work.target = incoming_work.target;
            if existing.status != RowStatus::Pending {
                return;
            }
            existing.status = incoming.status;
            match (&mut existing_work.approval, incoming_work.approval) {
                (ApprovalDetail::FileEdit(existing), ApprovalDetail::FileEdit(incoming)) => {
                    existing.lifecycle = incoming.lifecycle;
                }
                (
                    ApprovalDetail::PermissionGrant(existing),
                    ApprovalDetail::PermissionGrant(incoming),
                ) => existing.lifecycle = incoming.lifecycle,
                _ => {}
            }
        }
        _ if existing.status != RowStatus::Pending => {}
        (WorkDetail::Question(existing_work), WorkDetail::Question(incoming_work)) => {
            existing.status = incoming.status;
            existing_work.lifecycle = incoming_work.lifecycle;
            existing_work.questions = incoming_work.questions;
            existing_work.answers = incoming_work.answers;
            existing_work.status_reason = incoming_work.status_reason;
        }
        (WorkDetail::Form(existing_work), WorkDetail::Form(incoming_work)) => {
            existing.status = incoming.status;
            existing_work.lifecycle = incoming_work.lifecycle;
            existing_work.title = incoming_work.title;
            existing_work.status_reason = incoming_work.status_reason;
            existing_work.presentation = incoming_work.presentation;
            existing_work.payload = incoming_work.payload;
        }
        _ => {}
    }
}

/// `scopeKey`: the turn id, or `thread`.
fn scope_key(scope: &EventScope) -> &str {
    match scope {
        EventScope::Turn { turn_id } => turn_id,
        EventScope::Thread => "thread",
    }
}

/// `flushPendingFileEditOutput`: shows the held-back partial stdout line of every file edit.
pub(crate) fn flush_pending_file_edit_output(state: &mut ProjectionState) {
    let flushed: HashSet<String> = state
        .file_edit_stdout_buffers_by_scoped_call_key
        .iter_mut()
        .filter_map(|(key, buffer)| buffer.flush().then(|| key.clone()))
        .collect();
    if flushed.is_empty() {
        return;
    }
    let edits: Vec<(String, MsgRef)> = state
        .file_edits_by_call_id
        .iter()
        .flat_map(|(call_id, refs)| refs.iter().map(move |r| (call_id.clone(), *r)))
        .collect();
    for (call_id, r) in edits {
        let key = format!("{}:{call_id}", scope_key(&state.file_edit(r).base.scope));
        if !flushed.contains(&key) {
            continue;
        }
        let visible = state.file_edit_stdout_buffers_by_scoped_call_key[&key].visible.clone();
        state.file_edit_mut(r).stdout = Some(visible);
    }
}

/// `fileEditChangeMatchKeys`.
fn file_edit_change_match_keys(change: &FileEditChange) -> Vec<String> {
    match &change.move_path {
        Some(move_path) if *move_path != change.path => {
            vec![change.path.clone(), move_path.clone()]
        }
        _ => vec![change.path.clone()],
    }
}

/// `groupFileEditRowsByChangeMatchKey`.
fn group_file_edit_rows_by_change_match_key(
    state: &ProjectionState,
    rows: &[MsgRef],
) -> IndexMap<String, Vec<MsgRef>> {
    let mut grouped: IndexMap<String, Vec<MsgRef>> = IndexMap::new();
    for &r in rows {
        let Some(change) = state.file_edit(r).changes.first() else {
            continue;
        };
        for match_key in file_edit_change_match_keys(change) {
            grouped.entry(match_key).or_default().push(r);
        }
    }
    grouped
}

/// `takeUnusedFileEditRow`.
fn take_unused_file_edit_row(
    grouped_rows: &mut IndexMap<String, Vec<MsgRef>>,
    match_key: &str,
    used_rows: &mut HashSet<MsgRef>,
) -> Option<MsgRef> {
    let rows = grouped_rows.get_mut(match_key)?;
    if rows.is_empty() {
        return None;
    }
    let mut row = None;
    while row.is_none() && !rows.is_empty() {
        let candidate = rows.remove(0);
        if !used_rows.contains(&candidate) {
            row = Some(candidate);
        }
    }
    if rows.is_empty() {
        grouped_rows.shift_remove(match_key);
    }
    if let Some(row) = row {
        used_rows.insert(row);
    }
    row
}

/// `partial.status`: always present on output deltas, optional on item events.
fn partial_status(partial: &FileEditPartial) -> Option<RowStatus> {
    match partial {
        FileEditPartial::Output { status, .. } => Some(*status),
        FileEditPartial::Changes { status, .. } => *status,
    }
}

fn partial_parent_tool_call_id(partial: &FileEditPartial) -> Option<&String> {
    match partial {
        FileEditPartial::Output { parent_tool_call_id, .. }
        | FileEditPartial::Changes { parent_tool_call_id, .. } => {
            parent_tool_call_id.as_ref().filter(|id| !id.is_empty())
        }
    }
}

fn partial_presentation(partial: &FileEditPartial) -> Option<&serde_json::Value> {
    match partial {
        FileEditPartial::Changes { presentation, .. } => presentation.as_ref(),
        FileEditPartial::Output { .. } => None,
    }
}

/// `updateFileEditMessage`.
fn update_file_edit_message(
    existing: &mut FileEditMessage,
    meta: &EventMeta,
    partial: &FileEditPartial,
    change: Option<&FileEditChange>,
    stdout: Option<&str>,
) {
    existing.base.source_seq_end = meta.seq;
    existing.base.created_at = meta.created_at;
    if existing.base.parent_tool_call_id.as_ref().is_none_or(|id| id.is_empty())
        && let Some(parent) = partial_parent_tool_call_id(partial)
    {
        existing.base.parent_tool_call_id = Some(parent.clone());
    }
    if let Some(presentation) = partial_presentation(partial) {
        existing.presentation = Some(presentation.clone());
    }
    if let Some(change) = change {
        let next = match existing.changes.first() {
            Some(previous) => FileEditChange {
                path: change.path.clone(),
                kind: change.kind.clone().or_else(|| previous.kind.clone()),
                move_path: change.move_path.clone().or_else(|| previous.move_path.clone()),
                diff: change.diff.clone().or_else(|| previous.diff.clone()),
            },
            None => change.clone(),
        };
        existing.changes = vec![next];
    }
    existing.stdout = stdout.map(str::to_string);
    let incoming_approval = match partial {
        FileEditPartial::Changes { approval_status, .. } => approval_status.map(Some),
        FileEditPartial::Output { .. } => None,
    };
    let status = partial_status(partial);
    existing.approval_status =
        merge_approval_status(existing.approval_status, incoming_approval, status);
    if status == Some(RowStatus::Error) {
        existing.status = RowStatus::Error;
    } else if matches!(existing.status, RowStatus::Pending | RowStatus::Interrupted) {
        if let Some(status) = status {
            existing.status = status;
        }
    } else if existing.status != RowStatus::Error && status == Some(RowStatus::Completed) {
        existing.status = RowStatus::Completed;
    }
}

/// `upsertFileEdit`: creates or updates the file-edit rows of a call (one per changed file); may
/// reorder `state.messages` so a call's rows stay together.
pub(crate) fn upsert_file_edit(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    partial: FileEditPartial,
) {
    let call_id = match &partial {
        FileEditPartial::Output { call_id, .. } | FileEditPartial::Changes { call_id, .. } => {
            call_id.clone()
        }
    };
    let scope = scope_for_turn(turn_id);
    let existing_rows = state.file_edits_by_call_id.get(&call_id).cloned().unwrap_or_default();
    let (mut compatible_rows, foreign_rows): (Vec<MsgRef>, Vec<MsgRef>) =
        existing_rows.into_iter().partition(|&r| state.file_edit(r).base.scope == scope);
    let foreign_message_ids: HashSet<String> =
        foreign_rows.iter().map(|&r| state.file_edit(r).base.id.clone()).collect();
    let scoped_call_key = format!("{}:{call_id}", scope_key(&scope));
    let buffer =
        state.file_edit_stdout_buffers_by_scoped_call_key.entry(scoped_call_key).or_default();
    match &partial {
        FileEditPartial::Output { stdout, .. } => buffer.append(stdout),
        FileEditPartial::Changes { status, .. } => {
            if *status != Some(RowStatus::Pending) {
                buffer.flush();
            }
        }
    }
    let stdout = (!buffer.visible.is_empty()).then(|| buffer.visible.clone());
    let create_message = |change: Option<&FileEditChange>, base_key: &str| -> FileEditMessage {
        let foreign = foreign_message_ids.contains(&message_id(thread_id, "file-edit", base_key));
        let message_key = if foreign {
            format!("{}:{base_key}", scope_key(&scope))
        } else {
            base_key.to_string()
        };
        let approval_status = match &partial {
            FileEditPartial::Changes { approval_status, .. } => *approval_status,
            FileEditPartial::Output { .. } => None,
        };
        FileEditMessage {
            base: MessageBase {
                id: message_id(thread_id, "file-edit", &message_key),
                thread_id: thread_id.to_string(),
                source_seq_start: meta.seq,
                source_seq_end: meta.seq,
                created_at: meta.created_at,
                scope: scope.clone(),
                started_at: Some(meta.created_at),
                parent_tool_call_id: partial_parent_tool_call_id(&partial).cloned(),
            },
            call_id: call_id.clone(),
            changes: change.into_iter().cloned().collect(),
            stdout: stdout.clone(),
            approval_status,
            // An item event without a status is malformed; such a row starts pending.
            status: partial_status(&partial).unwrap_or(RowStatus::Pending),
            presentation: partial_presentation(&partial).cloned(),
        }
    };
    if let FileEditPartial::Changes { changes, .. } = &partial
        && !changes.is_empty()
    {
        let mut rows_by_match_key =
            group_file_edit_rows_by_change_match_key(state, &compatible_rows);
        let mut used_rows: HashSet<MsgRef> = HashSet::new();
        let mut seen_identity_counts: IndexMap<String, usize> = IndexMap::new();
        let mut next_rows: Vec<MsgRef> = Vec::with_capacity(changes.len());
        for change in changes {
            let identity = change.move_path.as_ref().unwrap_or(&change.path).clone();
            let seen_count = seen_identity_counts.entry(identity.clone()).or_insert(0);
            let base_key = if *seen_count == 0 {
                format!("{call_id}:{identity}")
            } else {
                format!("{call_id}:{identity}:{seen_count}")
            };
            *seen_count += 1;
            let mut existing = None;
            for match_key in file_edit_change_match_keys(change) {
                if existing.is_none() {
                    existing = take_unused_file_edit_row(
                        &mut rows_by_match_key,
                        &match_key,
                        &mut used_rows,
                    );
                }
            }
            let r = match existing {
                Some(r) => {
                    update_file_edit_message(
                        state.file_edit_mut(r),
                        meta,
                        &partial,
                        Some(change),
                        stdout.as_deref(),
                    );
                    r
                }
                None => {
                    let message = create_message(Some(change), &base_key);
                    state.alloc(Message::FileEdit(message))
                }
            };
            next_rows.push(r);
        }
        let all_rows: Vec<MsgRef> = foreign_rows.into_iter().chain(next_rows).collect();
        let of_call: HashSet<MsgRef> =
            file_edit_refs_of_call(state, &call_id).into_iter().collect();
        let insertion_index = state.messages.iter().position(|r| of_call.contains(r));
        let mut other_messages: Vec<MsgRef> =
            state.messages.iter().copied().filter(|r| !of_call.contains(r)).collect();
        match insertion_index {
            None => other_messages.extend(all_rows.iter().copied()),
            Some(index) => {
                other_messages.splice(index..index, all_rows.iter().copied());
            }
        }
        state.messages = other_messages;
        state.file_edits_by_call_id.insert(call_id, all_rows);
        return;
    }
    if compatible_rows.is_empty() {
        let message = create_message(None, &format!("{call_id}:0"));
        let r = state.push_message(Message::FileEdit(message));
        compatible_rows.push(r);
    } else {
        for &r in &compatible_rows {
            update_file_edit_message(
                state.file_edit_mut(r),
                meta,
                &partial,
                None,
                stdout.as_deref(),
            );
        }
    }
    let all_rows: Vec<MsgRef> = foreign_rows.into_iter().chain(compatible_rows).collect();
    state.file_edits_by_call_id.insert(call_id, all_rows);
}

/// `COMPACTION_SETTLED_TITLES`.
fn compaction_settled_title(status: CompactionTurnFinalizationStatus) -> &'static str {
    match status {
        CompactionTurnFinalizationStatus::Error => "Context compaction failed",
        CompactionTurnFinalizationStatus::Completed => "Context compaction skipped",
        CompactionTurnFinalizationStatus::Interrupted => "Context compaction interrupted",
    }
}

/// `applyCompactionEvent`: opens, updates or finalizes a compaction operation message.
pub(crate) fn apply_compaction_event(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    payload: CompactionLifecycleEvent,
) {
    let key = payload.key;
    let completed = payload.kind == LifecycleKind::End;
    let mut message = state.open_compactions_by_key.get(&key).copied();
    if message.is_none() && !state.finalized_compaction_keys.contains(&key) {
        message = Some(state.push_message(Message::Operation(OperationMessage {
            base: MessageBase {
                id: message_id(thread_id, "op", &format!("compaction:{key}")),
                thread_id: thread_id.to_string(),
                source_seq_start: meta.seq,
                source_seq_end: meta.seq,
                created_at: meta.created_at,
                scope: scope_for_turn(turn_id),
                started_at: Some(meta.created_at),
                parent_tool_call_id: None,
            },
            op_type: OperationType::Compaction,
            title: "Compacting context".to_string(),
            detail: None,
            status: RowStatus::Pending,
            completed_at: None,
            merge_key: None,
            transcript: None,
            parent_change: None,
        })));
    }
    if let Some(r) = message {
        let operation = state.operation_mut(r);
        extend_message_bounds(&mut operation.base, meta.seq, meta.created_at);
        if payload.detail.is_some() {
            operation.detail = payload.detail;
        }
        if payload.parent_tool_call_id.is_some() {
            operation.base.parent_tool_call_id = payload.parent_tool_call_id;
        }
        if completed {
            operation.completed_at = Some(meta.created_at);
            operation.status = RowStatus::Completed;
            operation.title = "Context compacted".to_string();
            state.open_compactions_by_key.shift_remove(&key);
        } else {
            operation.status = RowStatus::Pending;
            operation.title = "Compacting context".to_string();
            state.open_compactions_by_key.insert(key.clone(), r);
        }
    }
    if completed {
        state.finalized_compaction_keys.insert(key);
    }
}

/// `finalizeOpenCompaction`.
fn finalize_open_compaction(
    message: &mut OperationMessage,
    meta: &EventMeta,
    status: CompactionTurnFinalizationStatus,
    detail: Option<&str>,
) {
    extend_message_bounds(&mut message.base, meta.seq, meta.created_at);
    message.completed_at = Some(meta.created_at);
    message.status = status.row_status();
    message.title = compaction_settled_title(status).to_string();
    if let Some(detail) = detail {
        message.detail = Some(detail.to_string());
    }
}

/// `finalizeOpenCompactionsForTurn`: settles the open compactions of `turn_id` (or of the thread)
/// with `status`; `true` when a pending compaction was settled.
pub(crate) fn finalize_open_compactions_for_turn(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
    turn_id: Option<&str>,
    status: CompactionTurnFinalizationStatus,
    detail: Option<&str>,
) -> bool {
    let Some(turn_id) = turn_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    let mut settled_pending = false;
    let open: Vec<MsgRef> = state.open_compactions_by_key.values().copied().collect();
    for r in open {
        let message = state.operation_mut(r);
        if message.base.thread_id != thread_id || message.base.scope.turn_id() != Some(turn_id) {
            continue;
        }
        if message.status == RowStatus::Pending {
            settled_pending = true;
        }
        finalize_open_compaction(message, meta, status, detail);
    }
    settled_pending
}

/// `interruptOpenCompactions`: marks every open compaction interrupted.
pub(crate) fn interrupt_open_compactions(
    state: &mut ProjectionState,
    meta: &EventMeta,
    thread_id: &str,
) {
    let open: Vec<MsgRef> = state.open_compactions_by_key.values().copied().collect();
    for r in open {
        let message = state.operation_mut(r);
        if message.base.thread_id == thread_id
            && message.status == RowStatus::Pending
            && message.base.source_seq_start <= meta.seq
        {
            finalize_open_compaction(
                message,
                meta,
                CompactionTurnFinalizationStatus::Interrupted,
                None,
            );
        }
    }
}

/// Refs of the listed file-edit messages of `call_id` (helper for `upsertFileEdit`'s `ofCall`).
pub(crate) fn file_edit_refs_of_call(state: &ProjectionState, call_id: &str) -> Vec<MsgRef> {
    state
        .messages
        .iter()
        .copied()
        .filter(|&r| matches!(state.message(r), Message::FileEdit(edit) if edit.call_id == call_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_operation_detail_joins_distinct_details() {
        assert_eq!(merge_operation_detail(None, None), None);
        assert_eq!(merge_operation_detail(Some(""), Some("")), None);
        assert_eq!(merge_operation_detail(Some("a"), Some("a")).as_deref(), Some("a"));
        assert_eq!(merge_operation_detail(Some("a"), Some("b")).as_deref(), Some("a\nb"));
        assert_eq!(merge_operation_detail(None, Some("b")).as_deref(), Some("b"));
    }

    #[test]
    fn compaction_lifecycle_opens_and_finalizes() {
        let mut state = ProjectionState::new();
        let meta = |seq| EventMeta { id: format!("evt_{seq}"), seq, created_at: seq * 1000 };
        let event = |kind| CompactionLifecycleEvent {
            key: "cmp1".to_string(),
            kind,
            detail: None,
            parent_tool_call_id: None,
        };
        apply_compaction_event(
            &mut state,
            &meta(1),
            "thr",
            Some("t1"),
            event(LifecycleKind::Begin),
        );
        assert_eq!(state.messages.len(), 1);
        let r = state.messages[0];
        assert_eq!(state.operation(r).title, "Compacting context");
        let settled = finalize_open_compactions_for_turn(
            &mut state,
            &meta(2),
            "thr",
            Some("t1"),
            CompactionTurnFinalizationStatus::Error,
            Some("boom"),
        );
        assert!(settled);
        let operation = state.operation(r);
        assert_eq!(operation.title, "Context compaction failed");
        assert_eq!(operation.detail.as_deref(), Some("boom"));
        assert_eq!(operation.base.source_seq_end, 2);
        apply_compaction_event(&mut state, &meta(3), "thr", Some("t1"), event(LifecycleKind::End));
        apply_compaction_event(&mut state, &meta(4), "thr", Some("t1"), event(LifecycleKind::End));
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.operation(r).title, "Context compacted");
        assert!(state.open_compactions_by_key.is_empty());
    }
}
