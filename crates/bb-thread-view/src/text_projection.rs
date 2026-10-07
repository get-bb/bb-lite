//! Port of `text-projection.ts`: assistant text and reasoning (thinking) messages, their
//! line-buffered streaming, and the projection's `activeThinking`.

use serde_json::{Value, json};

use crate::build_event_projection::{MsgRef, ProjectionState};
use crate::event::{self, EventScope};
use crate::format::{duration_to_compact_string, format_diff_count, js_trim, message_id};
use crate::rows::RowStatus;
use crate::tool_activity_projection::flush_active_tool_cell;
use crate::types::{
    AssistantMessage, AssistantTextStatus, EventMeta, Message, MessageBase, OperationMessage,
    OperationType, VisibleTextBuffer,
};

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

impl BufferedTextKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Assistant => "assistant",
            Self::Reasoning => "reasoning",
        }
    }
}

impl ReasoningCompletionStatus {
    fn row_status(self) -> RowStatus {
        match self {
            Self::Completed => RowStatus::Completed,
            Self::Interrupted => RowStatus::Interrupted,
        }
    }
}

/// A missing id interpolates as `undefined` in the TypeScript key template.
fn js_string(value: Option<&str>) -> &str {
    value.unwrap_or("undefined")
}

/// `bufferedTextItem`: the buffer kind and item id of an assistant-text or reasoning event.
fn buffered_text_item(decoded: &Value) -> Option<(BufferedTextKind, &str)> {
    let event_type = event::event_type(decoded);
    match event_type {
        "item/agentMessage/delta" | "item/plan/delta" => {
            Some((BufferedTextKind::Assistant, js_string(event::item_id_field(decoded))))
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            Some((BufferedTextKind::Reasoning, js_string(event::item_id_field(decoded))))
        }
        "item/started" | "item/completed" => {
            let item = event::item(decoded)?;
            let id = js_string(event::item_id(item));
            match event::item_type(item) {
                Some("reasoning") => Some((BufferedTextKind::Reasoning, id)),
                Some("agentMessage" | "plan") if event_type == "item/completed" => {
                    Some((BufferedTextKind::Assistant, id))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// `bufferedTextIdentity`: the buffer key of an assistant-text or reasoning event, or `None` when
/// the event is neither or has no turn.
pub(crate) fn buffered_text_identity(
    decoded: &Value,
    turn_id_override: Option<&str>,
    parent_tool_call_id_override: Option<&str>,
) -> Option<BufferedTextIdentity> {
    let (kind, item_id) = buffered_text_item(decoded)?;
    let turn_id =
        turn_id_override.or_else(|| event::turn_id(decoded)).filter(|id| !id.is_empty())?;
    let parent = parent_tool_call_id_override
        .or_else(|| event::parent_tool_call_id(decoded))
        .unwrap_or("root");
    Some(BufferedTextIdentity {
        key: format!("kind:{}|turn:{turn_id}|parent:{parent}|item:{item_id}", kind.as_str()),
        kind,
        turn_id: turn_id.to_owned(),
    })
}

/// `syncAssistantMessage`: shows the buffer's visible text, listing the message the first time
/// it has any.
fn sync_assistant_message(
    state: &mut ProjectionState,
    message_key: &str,
    r: MsgRef,
    status: AssistantTextStatus,
) {
    let visible = state
        .assistant_text_buffers_by_key
        .get(message_key)
        .map(|buffer| buffer.visible.as_str())
        .filter(|visible| !visible.is_empty());
    let Message::AssistantText(message) = &mut state.arena[r.0] else {
        panic!("{r:?} is not an assistant-text message");
    };
    let Some(visible) = visible else {
        if status == AssistantTextStatus::Completed {
            message.status = AssistantTextStatus::Completed;
        }
        return;
    };
    if message.text != visible {
        message.text.clear();
        message.text.push_str(visible);
    }
    message.status = status;
    if state.visible_assistant_message_keys.contains(message_key) {
        return;
    }
    // `flushActiveToolCell` returns early without an active cell.
    if state.tool_activity.active_cell.is_some() {
        flush_active_tool_cell(state);
    }
    state.messages.push(r);
    state.visible_assistant_message_keys.insert(message_key.to_owned());
}

/// `closeAssistantMessage`.
fn close_assistant_message(state: &mut ProjectionState, message_key: &str) {
    state.finalized_assistant_message_keys.insert(message_key.to_owned());
    state.open_assistant_messages_by_key.shift_remove(message_key);
    state.assistant_text_buffers_by_key.shift_remove(message_key);
    state.visible_assistant_message_keys.remove(message_key);
}

/// `flushBufferedAssistantMessages`: shows the held-back partial line of every open assistant
/// message (of `turn_id` only, when given).
pub(crate) fn flush_buffered_assistant_messages(
    state: &mut ProjectionState,
    turn_id: Option<&str>,
) {
    let mut pending: Vec<(String, MsgRef)> = state
        .open_assistant_messages_by_key
        .iter()
        .filter(|(_, r)| {
            turn_id.is_none_or(|turn_id| {
                matches!(&state.assistant(**r).base.scope, EventScope::Turn { turn_id: t } if t == turn_id)
            })
        })
        .map(|(key, r)| (key.clone(), *r))
        .collect();
    pending.sort_by_key(|(_, r)| {
        let base = &state.assistant(*r).base;
        (base.source_seq_start, base.source_seq_end, base.created_at)
    });
    for (message_key, r) in pending {
        if let Some(buffer) = state.assistant_text_buffers_by_key.get_mut(&message_key) {
            buffer.flush();
            sync_assistant_message(state, &message_key, r, AssistantTextStatus::Completed);
        } else {
            state.assistant_mut(r).status = AssistantTextStatus::Completed;
        }
        close_assistant_message(state, &message_key);
    }
}

/// `projectAssistantText`.
fn project_assistant_text(
    state: &mut ProjectionState,
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id: Option<&str>,
    identity: Option<&BufferedTextIdentity>,
    is_final: bool,
    text: &str,
) -> bool {
    if text.is_empty() {
        return false;
    }
    let Some(identity) = identity else {
        return true;
    };
    let key = identity.key.as_str();
    if state.closed_turn_ids.contains(&identity.turn_id)
        || state.finalized_assistant_message_keys.contains(key)
    {
        return true;
    }
    state.open_turn_ids.insert(identity.turn_id.clone());
    let r = if let Some(&r) = state.open_assistant_messages_by_key.get(key) {
        let message = state.assistant_mut(r);
        message.base.source_seq_end = meta.seq;
        message.base.created_at = meta.created_at;
        r
    } else {
        let thread_id = event::thread_id(decoded).unwrap_or_default();
        let r = state.alloc(Message::AssistantText(AssistantMessage {
            base: MessageBase {
                id: message_id(thread_id, "assistant", key),
                thread_id: thread_id.to_owned(),
                source_seq_start: meta.seq,
                source_seq_end: meta.seq,
                created_at: meta.created_at,
                scope: event::scope_or_thread(decoded),
                started_at: Some(meta.created_at),
                parent_tool_call_id: parent_tool_call_id
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
            },
            text: String::new(),
            status: AssistantTextStatus::Streaming,
        }));
        state.open_assistant_messages_by_key.insert(key.to_owned(), r);
        r
    };
    let buffer = state.assistant_text_buffers_by_key.entry(key.to_owned()).or_default();
    if !is_final {
        buffer.append(text);
        sync_assistant_message(state, key, r, AssistantTextStatus::Streaming);
        return true;
    }
    buffer.set(text, true);
    sync_assistant_message(state, key, r, AssistantTextStatus::Completed);
    close_assistant_message(state, key);
    true
}

/// `openReasoningBuffer`: the reasoning buffer of `identity`, or `None` once its turn or item is
/// closed.
fn open_reasoning_buffer<'a>(
    state: &'a mut ProjectionState,
    identity: &BufferedTextIdentity,
) -> Option<&'a mut VisibleTextBuffer> {
    if state.closed_turn_ids.contains(&identity.turn_id)
        || state.finalized_reasoning_keys.contains(&identity.key)
    {
        return None;
    }
    state.open_turn_ids.insert(identity.turn_id.clone());
    Some(state.reasoning_text_buffers_by_key.entry(identity.key.clone()).or_default())
}

#[derive(Clone, Copy)]
enum ReasoningChannel {
    Summary,
    Content,
}

/// `projectReasoningDelta`.
fn project_reasoning_delta(
    state: &mut ProjectionState,
    identity: Option<&BufferedTextIdentity>,
    channel: ReasoningChannel,
    text: &str,
) -> bool {
    if text.is_empty() {
        return false;
    }
    let Some(identity) = identity else {
        return true;
    };
    let Some(buffer) = open_reasoning_buffer(state, identity) else {
        return true;
    };
    buffer.append(text);
    let deltas = state.reasoning_delta_text_by_key.entry(identity.key.clone()).or_default();
    match channel {
        ReasoningChannel::Summary => deltas.summary.push_str(text),
        ReasoningChannel::Content => deltas.content.push_str(text),
    }
    true
}

/// `normalizeReasoningDetail`: trims and caps the detail at [`MAX_REASONING_DETAIL_CHARS`] UTF-16
/// units. A cut through a surrogate pair yields U+FFFD where JavaScript keeps a lone surrogate
/// (not representable in a Rust string).
fn normalize_reasoning_detail(detail: &str) -> String {
    let trimmed = js_trim(detail);
    let length = trimmed.encode_utf16().count();
    if length <= MAX_REASONING_DETAIL_CHARS {
        return trimmed.to_owned();
    }
    let dropped = length - MAX_REASONING_DETAIL_CHARS;
    let units: Vec<u16> = trimmed.encode_utf16().take(MAX_REASONING_DETAIL_CHARS).collect();
    format!(
        "{}\n…[{} more characters truncated]",
        String::from_utf16_lossy(&units),
        format_diff_count(dropped as i64)
    )
}

/// `buildProjectionActiveThinking`: the domain `ActiveThinking` JSON for the latest open reasoning
/// lifecycle, or `None` (also when the thread status means nothing is running).
pub(crate) fn build_projection_active_thinking(
    state: &ProjectionState,
    thread_status: &str,
) -> Option<Value> {
    if thread_status != "active" {
        return None;
    }
    let mut latest: Option<&ActiveThinkingLifecycle> = None;
    for lifecycle in state.open_reasoning_lifecycles_by_key.values() {
        let newer = latest.is_none_or(|latest| {
            if lifecycle.updated_seq != latest.updated_seq {
                lifecycle.updated_seq > latest.updated_seq
            } else {
                lifecycle.updated_at > latest.updated_at
            }
        });
        if newer {
            latest = Some(lifecycle);
        }
    }
    let latest = latest?;
    let text = state
        .reasoning_text_buffers_by_key
        .get(&latest.message_key)
        .map_or("", |buffer| js_trim(&buffer.visible));
    Some(json!({
        "id": message_id(&latest.thread_id, "op", &format!("reasoning:{}", latest.message_key)),
        "text": text,
        "startedAt": latest.started_at,
        "updatedAt": latest.updated_at,
    }))
}

/// `upsertReasoningLifecycle`.
fn upsert_reasoning_lifecycle(
    state: &mut ProjectionState,
    meta: &EventMeta,
    identity: &BufferedTextIdentity,
    parent_tool_call_id: Option<&str>,
    thread_id: &str,
) {
    let BufferedTextIdentity { key, turn_id, .. } = identity;
    if state.closed_turn_ids.contains(turn_id) || state.finalized_reasoning_keys.contains(key) {
        return;
    }
    state.open_turn_ids.insert(turn_id.clone());
    if let Some(existing) = state.open_reasoning_lifecycles_by_key.get_mut(key) {
        existing.updated_at = meta.created_at;
        existing.updated_seq = meta.seq;
        return;
    }
    state.open_reasoning_lifecycles_by_key.insert(
        key.clone(),
        ActiveThinkingLifecycle {
            message_key: key.clone(),
            parent_tool_call_id: parent_tool_call_id.map(str::to_owned),
            source_seq_start: meta.seq,
            started_at: meta.created_at,
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.clone(),
            updated_at: meta.created_at,
            updated_seq: meta.seq,
        },
    );
}

/// `finalizeReasoningLifecycleByKey`: lists the reasoning operation message of an open lifecycle
/// (none without text) and marks the item finalized.
fn finalize_reasoning_lifecycle_by_key(
    state: &mut ProjectionState,
    meta: &EventMeta,
    message_key: &str,
    status: ReasoningCompletionStatus,
) -> Option<MsgRef> {
    let lifecycle = state.open_reasoning_lifecycles_by_key.shift_remove(message_key);
    let buffer = state.reasoning_text_buffers_by_key.shift_remove(message_key);
    state.finalized_reasoning_keys.insert(message_key.to_owned());
    let (lifecycle, buffer) = (lifecycle?, buffer?);
    let detail = format!("{}{}", buffer.visible, buffer.pending);
    if js_trim(&detail).is_empty() {
        return None;
    }
    let duration_ms = meta.created_at - lifecycle.started_at;
    let title = if duration_ms > 0 {
        format!("Thought for {}", duration_to_compact_string(duration_ms as f64))
    } else {
        "Thought".to_owned()
    };
    let message = OperationMessage {
        base: MessageBase {
            id: message_id(&lifecycle.thread_id, "op", &format!("reasoning:{message_key}")),
            thread_id: lifecycle.thread_id,
            source_seq_start: lifecycle.source_seq_start,
            source_seq_end: meta.seq,
            created_at: meta.created_at,
            scope: EventScope::Turn { turn_id: lifecycle.turn_id },
            started_at: Some(lifecycle.started_at),
            parent_tool_call_id: lifecycle.parent_tool_call_id.filter(|id| !id.is_empty()),
        },
        op_type: OperationType::Reasoning,
        title,
        detail: Some(normalize_reasoning_detail(&detail)),
        status: status.row_status(),
        completed_at: Some(meta.created_at),
        merge_key: None,
        transcript: None,
        parent_change: None,
    };
    Some(state.push_message(Message::Operation(message)))
}

/// `finalizeOpenReasoningLifecycles`: closes open reasoning lifecycles (of `turn_id` only, when
/// given) into reasoning operation messages with the given status.
pub(crate) fn finalize_open_reasoning_lifecycles(
    state: &mut ProjectionState,
    meta: &EventMeta,
    status: ReasoningCompletionStatus,
    turn_id: Option<&str>,
) {
    let keys: Vec<String> = state
        .open_reasoning_lifecycles_by_key
        .iter()
        .filter(|(_, lifecycle)| turn_id.is_none_or(|turn_id| lifecycle.turn_id == turn_id))
        .map(|(key, _)| key.clone())
        .collect();
    for message_key in keys {
        if let Some(r) = finalize_reasoning_lifecycle_by_key(state, meta, &message_key, status) {
            state.reasoning_messages_awaiting_completion.insert(message_key, r);
        }
    }
}

/// `completeReasoningItem`.
fn complete_reasoning_item(
    state: &mut ProjectionState,
    meta: &EventMeta,
    identity: Option<&BufferedTextIdentity>,
    summary: &str,
    content: &str,
) -> bool {
    let final_text = format!("{summary}{content}");
    let Some(identity) = identity else {
        return !final_text.is_empty();
    };
    let key = identity.key.as_str();
    let streamed = state
        .reasoning_delta_text_by_key
        .get(key)
        .is_some_and(|deltas| deltas.summary == summary && deltas.content == content);
    let completion_text = if streamed { "" } else { final_text.as_str() };
    if !completion_text.is_empty()
        && let Some(buffer) = open_reasoning_buffer(state, identity)
    {
        buffer.set(completion_text, true);
    }
    state.reasoning_delta_text_by_key.shift_remove(key);
    if let Some(awaiting) = state.reasoning_messages_awaiting_completion.shift_remove(key) {
        let message = state.operation_mut(awaiting);
        message.base.source_seq_end = meta.seq;
        if !js_trim(completion_text).is_empty() {
            message.detail = Some(normalize_reasoning_detail(completion_text));
        }
    } else {
        finalize_reasoning_lifecycle_by_key(state, meta, key, ReasoningCompletionStatus::Completed);
    }
    !final_text.is_empty()
}

/// `projectAssistantAndReasoningEvent`: applies an assistant-text or reasoning event; `true` when
/// the event was consumed.
pub(crate) fn project_assistant_and_reasoning_event(
    state: &mut ProjectionState,
    decoded: &Value,
    meta: &EventMeta,
    turn_id: Option<&str>,
    parent_tool_call_id: Option<&str>,
) -> bool {
    let identity = buffered_text_identity(decoded, turn_id, parent_tool_call_id);
    if let Some(identity) = identity.as_ref().filter(|i| i.kind == BufferedTextKind::Reasoning) {
        let thread_id = event::thread_id(decoded).unwrap_or_default();
        upsert_reasoning_lifecycle(state, meta, identity, parent_tool_call_id, thread_id);
    }
    let identity = identity.as_ref();
    let delta = || event::delta(decoded).unwrap_or_default();
    match event::event_type(decoded) {
        "item/agentMessage/delta" | "item/plan/delta" => project_assistant_text(
            state,
            decoded,
            meta,
            parent_tool_call_id,
            identity,
            false,
            delta(),
        ),
        "item/reasoning/summaryTextDelta" => {
            project_reasoning_delta(state, identity, ReasoningChannel::Summary, delta())
        }
        "item/reasoning/textDelta" => {
            project_reasoning_delta(state, identity, ReasoningChannel::Content, delta())
        }
        "item/completed" => {
            let Some(item) = event::item(decoded) else {
                return false;
            };
            match event::item_type(item) {
                Some("agentMessage" | "plan") => project_assistant_text(
                    state,
                    decoded,
                    meta,
                    parent_tool_call_id,
                    identity,
                    true,
                    event::item_text(item).unwrap_or_default(),
                ),
                Some("reasoning") => complete_reasoning_item(
                    state,
                    meta,
                    identity,
                    &event::string_array_field(item, "summary").concat(),
                    &event::string_array_field(item, "content").concat(),
                ),
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "text_projection_tests.rs"]
mod tests;
