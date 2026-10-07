//! Port of `operation-projection.ts`: lifecycle (operation and interaction) messages, file edits
//! and compactions.

// Remove once text, tool-activity and operation projection are ported: until then much of the
// shared state is only written, never read.
#![allow(dead_code)]

use crate::build_event_projection::{MsgRef, ProjectionState};
use crate::item_lifecycle::{CompactionLifecycleEvent, FileEditPartial};
use crate::rows::RowStatus;
use crate::types::{EventMeta, Message};

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
    _existing: Option<&str>,
    _incoming: Option<&str>,
) -> Option<String> {
    todo!("operation_projection port")
}

/// `lifecycleIndexKey`: `<workKind|opType>:<thread|turn:id>:<interactionId|mergeKey>`, or `None`
/// without a key. `message` is an operation or interaction message.
pub(crate) fn lifecycle_index_key(_message: &Message) -> Option<String> {
    todo!("operation_projection port")
}

/// `upsertLifecycleMessage`: merges `incoming` (an operation or interaction message from
/// `parse_operation_message`) into the message with the same lifecycle key, or appends it.
pub(crate) fn upsert_lifecycle_message(_state: &mut ProjectionState, _incoming: Message) {
    todo!("operation_projection port")
}

/// `flushPendingFileEditOutput`: shows the held-back partial stdout line of every file edit.
pub(crate) fn flush_pending_file_edit_output(_state: &mut ProjectionState) {
    todo!("operation_projection port")
}

/// `upsertFileEdit`: creates or updates the file-edit rows of a call (one per changed file); may
/// reorder `state.messages` so a call's rows stay together.
pub(crate) fn upsert_file_edit(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
    _turn_id: Option<&str>,
    _partial: FileEditPartial,
) {
    todo!("operation_projection port")
}

/// `applyCompactionEvent`: opens, updates or finalizes a compaction operation message.
pub(crate) fn apply_compaction_event(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
    _turn_id: Option<&str>,
    _payload: CompactionLifecycleEvent,
) {
    todo!("operation_projection port")
}

/// `finalizeOpenCompactionsForTurn`: settles the open compactions of `turn_id` (or of the thread)
/// with `status`; `true` when a pending compaction was settled.
pub(crate) fn finalize_open_compactions_for_turn(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
    _turn_id: Option<&str>,
    _status: CompactionTurnFinalizationStatus,
    _detail: Option<&str>,
) -> bool {
    todo!("operation_projection port")
}

/// `interruptOpenCompactions`: marks every open compaction interrupted.
pub(crate) fn interrupt_open_compactions(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _thread_id: &str,
) {
    todo!("operation_projection port")
}

/// Refs of the listed file-edit messages of `call_id` (helper for `upsertFileEdit`'s `ofCall`).
pub(crate) fn file_edit_refs_of_call(_state: &ProjectionState, _call_id: &str) -> Vec<MsgRef> {
    todo!("operation_projection port")
}
