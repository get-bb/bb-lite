//! Accessors over a stored thread event (`serde_json::Value`). Every accessor tolerates missing or
//! oddly-typed fields by returning `None` (or the documented default) and never panics.
//!
//! Event-level helpers take the whole event; `item_*` helpers take the event's `item` object
//! (from [`item`]). The generic `*_field` helpers read any key of any object.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `ThreadEventScope`: `{ "kind": "thread" }` or `{ "kind": "turn", "turnId": "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EventScope {
    Thread,
    Turn {
        #[serde(rename = "turnId")]
        turn_id: String,
    },
}

impl EventScope {
    /// `scopeForTurn`: a turn scope for a non-empty id, otherwise the thread scope.
    pub fn for_turn(turn_id: Option<&str>) -> Self {
        match turn_id {
            Some(id) if !id.is_empty() => Self::Turn { turn_id: id.to_string() },
            _ => Self::Thread,
        }
    }

    /// `getThreadEventScopeTurnId`.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::Thread => None,
            Self::Turn { turn_id } => Some(turn_id),
        }
    }
}

pub fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

pub fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    field(value, key)?.as_str()
}

/// A string field that is present and not empty (`getNonEmptyStringField`).
pub fn non_empty_str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    str_field(value, key).filter(|text| !text.is_empty())
}

pub fn bool_field(value: &Value, key: &str) -> Option<bool> {
    field(value, key)?.as_bool()
}

/// An integral number field (a float with no fractional part also counts).
pub fn i64_field(value: &Value, key: &str) -> Option<i64> {
    let number = field(value, key)?;
    number.as_i64().or_else(|| {
        number.as_f64().filter(|float| float.fract() == 0.0 && float.is_finite()).map(|f| f as i64)
    })
}

pub fn f64_field(value: &Value, key: &str) -> Option<f64> {
    field(value, key)?.as_f64()
}

pub fn array_field<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    field(value, key)?.as_array()
}

pub fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    field(value, key)?.as_object()
}

/// A field that is present and not JSON `null`.
pub fn present_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    field(value, key).filter(|inner| !inner.is_null())
}

/// Strings of a string-array field, skipping non-string entries; empty when absent.
pub fn string_array_field<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
    array_field(value, key)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The event `type`; `""` when missing.
pub fn event_type(event: &Value) -> &str {
    str_field(event, "type").unwrap_or("")
}

pub fn is_type(event: &Value, event_type_name: &str) -> bool {
    event_type(event) == event_type_name
}

/// The event `scope`; `None` when missing or malformed.
pub fn scope(event: &Value) -> Option<EventScope> {
    let scope = field(event, "scope")?;
    match str_field(scope, "kind")? {
        "thread" => Some(EventScope::Thread),
        "turn" => {
            non_empty_str_field(scope, "turnId").map(|id| EventScope::Turn { turn_id: id.into() })
        }
        _ => None,
    }
}

/// The event scope, treating a missing or malformed scope as the thread scope.
pub fn scope_or_thread(event: &Value) -> EventScope {
    scope(event).unwrap_or(EventScope::Thread)
}

/// `getEventTurnId`: `scope.turnId` when the scope is a turn scope.
pub fn turn_id(event: &Value) -> Option<&str> {
    let scope = field(event, "scope")?;
    if str_field(scope, "kind")? != "turn" {
        return None;
    }
    non_empty_str_field(scope, "turnId")
}

/// `getEventProviderThreadId`: `providerThreadId`, never for `system/provider-turn-watchdog`.
pub fn provider_thread_id(event: &Value) -> Option<&str> {
    if is_type(event, "system/provider-turn-watchdog") {
        return None;
    }
    str_field(event, "providerThreadId")
}

/// `getEventParentToolCallId`: the item's `parentToolCallId` when the event has an item,
/// otherwise the event's own `parentToolCallId`.
pub fn parent_tool_call_id(event: &Value) -> Option<&str> {
    match item(event) {
        Some(item) => item_parent_tool_call_id(item),
        None => str_field(event, "parentToolCallId"),
    }
}

pub fn thread_id(event: &Value) -> Option<&str> {
    str_field(event, "threadId")
}

/// The top-level `itemId` (delta and progress events), not `item.id`.
pub fn item_id_field(event: &Value) -> Option<&str> {
    str_field(event, "itemId")
}

pub fn request_id(event: &Value) -> Option<&str> {
    str_field(event, "requestId")
}

pub fn client_request_id(event: &Value) -> Option<&str> {
    str_field(event, "clientRequestId")
}

pub fn delta(event: &Value) -> Option<&str> {
    str_field(event, "delta")
}

pub fn message(event: &Value) -> Option<&str> {
    str_field(event, "message")
}

pub fn status(event: &Value) -> Option<&str> {
    str_field(event, "status")
}

pub fn kind(event: &Value) -> Option<&str> {
    str_field(event, "kind")
}

pub fn initiator(event: &Value) -> Option<&str> {
    str_field(event, "initiator")
}

pub fn sender_thread_id(event: &Value) -> Option<&str> {
    str_field(event, "senderThreadId")
}

pub fn system_message_kind(event: &Value) -> Option<&str> {
    str_field(event, "systemMessageKind")
}

/// `systemMessageSubject` when present and not `null`.
pub fn system_message_subject(event: &Value) -> Option<&Value> {
    present_field(event, "systemMessageSubject")
}

/// The event's `item` object, when it is an object.
pub fn item(event: &Value) -> Option<&Value> {
    field(event, "item").filter(|item| item.is_object())
}

/// `item.type` of the event's item (`commandExecution`, `agentMessage`, `delegation`, ...).
pub fn event_item_type(event: &Value) -> Option<&str> {
    item(event).and_then(item_type)
}

/// `item.id` of the event's item.
pub fn event_item_id(event: &Value) -> Option<&str> {
    item(event).and_then(item_id)
}

pub fn item_id(item: &Value) -> Option<&str> {
    str_field(item, "id")
}

pub fn item_type(item: &Value) -> Option<&str> {
    str_field(item, "type")
}

/// `item.kind` (file-change kinds, extension kinds, ...).
pub fn item_kind(item: &Value) -> Option<&str> {
    str_field(item, "kind")
}

/// `item.status` (`pending`, `completed`, `failed`, ...).
pub fn item_status(item: &Value) -> Option<&str> {
    str_field(item, "status")
}

pub fn item_text(item: &Value) -> Option<&str> {
    str_field(item, "text")
}

pub fn item_parent_tool_call_id(item: &Value) -> Option<&str> {
    str_field(item, "parentToolCallId")
}

/// `item.presentation` (a `ThreadEventItemPresentation` object) when it is an object.
pub fn item_presentation(item: &Value) -> Option<&Value> {
    field(item, "presentation").filter(|presentation| presentation.is_object())
}

/// `item.approvalStatus` (`waiting_for_approval`, `denied`) when a string.
pub fn item_approval_status(item: &Value) -> Option<&str> {
    str_field(item, "approvalStatus")
}

pub fn item_exit_code(item: &Value) -> Option<i64> {
    i64_field(item, "exitCode")
}
