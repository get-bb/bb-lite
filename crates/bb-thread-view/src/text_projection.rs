//! Port of `text-projection.ts`: assistant text and reasoning (thinking) messages, their
//! line-buffered streaming, and the projection's `activeThinking`.

// Remove once text, tool-activity and operation projection are ported: until then much of the
// shared state is only written, never read.
#![allow(dead_code)]

use serde_json::Value;

use crate::build_event_projection::ProjectionState;
use crate::types::EventMeta;

/// `BufferedTextKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum BufferedTextKind {
    Assistant,
    Reasoning,
}

/// `BufferedTextIdentity`; `key` is `kind:<kind>|turn:<turnId>|parent:<parent>|item:<itemId>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BufferedTextIdentity {
    pub(crate) key: String,
    pub(crate) kind: BufferedTextKind,
    pub(crate) turn_id: String,
}

/// `ActiveThinkingLifecycle`: an open reasoning item, kept until its turn ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveThinkingLifecycle {
    pub(crate) message_key: String,
    pub(crate) parent_tool_call_id: Option<String>,
    pub(crate) source_seq_start: i64,
    pub(crate) started_at: i64,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) updated_at: i64,
    pub(crate) updated_seq: i64,
}

/// `ReasoningCompletionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ReasoningCompletionStatus {
    Completed,
    Interrupted,
}

/// `MAX_REASONING_DETAIL_CHARS`.
pub(crate) const MAX_REASONING_DETAIL_CHARS: usize = 32_000;

/// `bufferedTextIdentity`: the buffer key of an assistant-text or reasoning event, or `None` when
/// the event is neither or has no turn.
pub(crate) fn buffered_text_identity(
    _decoded: &Value,
    _turn_id_override: Option<&str>,
    _parent_tool_call_id_override: Option<&str>,
) -> Option<BufferedTextIdentity> {
    todo!("text_projection port")
}

/// `flushBufferedAssistantMessages`: shows the held-back partial line of every open assistant
/// message (of `turn_id` only, when given).
pub(crate) fn flush_buffered_assistant_messages(
    _state: &mut ProjectionState,
    _turn_id: Option<&str>,
) {
    todo!("text_projection port")
}

/// `buildProjectionActiveThinking`: the domain `ActiveThinking` JSON for the latest open reasoning
/// lifecycle, or `None` (also when the thread status means nothing is running).
pub(crate) fn build_projection_active_thinking(
    _state: &ProjectionState,
    _thread_status: &str,
) -> Option<Value> {
    todo!("text_projection port")
}

/// `finalizeOpenReasoningLifecycles`: closes open reasoning lifecycles (of `turn_id` only, when
/// given) into reasoning operation messages with the given status.
pub(crate) fn finalize_open_reasoning_lifecycles(
    _state: &mut ProjectionState,
    _meta: &EventMeta,
    _status: ReasoningCompletionStatus,
    _turn_id: Option<&str>,
) {
    todo!("text_projection port")
}

/// `projectAssistantAndReasoningEvent`: applies an assistant-text or reasoning event; `true` when
/// the event was consumed.
pub(crate) fn project_assistant_and_reasoning_event(
    _state: &mut ProjectionState,
    _decoded: &Value,
    _meta: &EventMeta,
    _turn_id: Option<&str>,
    _parent_tool_call_id: Option<&str>,
) -> bool {
    todo!("text_projection port")
}
