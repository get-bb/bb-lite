use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadEventScopePolicy {
    Thread,
    Turn,
    ThreadOrTurn,
}

impl ThreadEventScopePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadEventScopePolicy::Thread => "thread",
            ThreadEventScopePolicy::Turn => "turn",
            ThreadEventScopePolicy::ThreadOrTurn => "thread-or-turn",
        }
    }
}

/// The fixed scope policy of each known thread event type (`scopePolicyByType`).
pub fn scope_policy(event_type: &str) -> Option<ThreadEventScopePolicy> {
    use ThreadEventScopePolicy::{Thread, ThreadOrTurn, Turn};
    Some(match event_type {
        "thread/started" => Thread,
        "thread/identity" => Thread,
        "turn/started" => Turn,
        "turn/completed" => Turn,
        "turn/input/accepted" => Turn,
        "thread/name/updated" => Thread,
        "thread/compacted" => Turn,
        "thread/context/cleared" => Turn,
        "thread/goal/updated" => Thread,
        "thread/goal/cleared" => Thread,
        "item/started" => Turn,
        "item/completed" => Turn,
        "item/agentMessage/delta" => Turn,
        "item/commandExecution/outputDelta" => Turn,
        "item/fileChange/outputDelta" => Turn,
        "item/reasoning/summaryTextDelta" => Turn,
        "item/reasoning/textDelta" => Turn,
        "item/plan/delta" => Turn,
        "item/mcpToolCall/progress" => Turn,
        "item/toolCall/progress" => Turn,
        "item/backgroundTask/progress" => Thread,
        "item/backgroundTask/completed" => Thread,
        "item/delegation/progress" => Thread,
        "item/delegation/completed" => Thread,
        "thread/tokenUsage/updated" => Turn,
        "thread/contextWindowUsage/updated" => ThreadOrTurn,
        "turn/plan/updated" => Turn,
        "turn/diff/updated" => Turn,
        "provider/error" => ThreadOrTurn,
        "provider/rateLimits/updated" => Thread,
        "provider.env-resolved" => Thread,
        "thread/extensionState/updated" => Thread,
        "provider/warning" => ThreadOrTurn,
        "provider/modelFallback" => ThreadOrTurn,
        "provider/unhandled" => ThreadOrTurn,
        "client/thread/start" => Thread,
        "client/turn/requested" => Thread,
        "client/turn/rejected" => Thread,
        "client/turn/start" => Thread,
        "system/error" => ThreadOrTurn,
        "system/manager/user_message" => ThreadOrTurn,
        "system/thread/interrupted" => Thread,
        "system/operation" => ThreadOrTurn,
        "system/interaction/lifecycle" => ThreadOrTurn,
        "system/permissionGrant/lifecycle" => Turn,
        "system/userQuestion/lifecycle" => Turn,
        "system/thread-provisioning" => Thread,
        "system/provider-turn-watchdog" => Thread,
        _ => return None,
    })
}

pub fn thread_scope() -> Value {
    json!({ "kind": "thread" })
}

pub fn turn_scope(turn_id: &str) -> Value {
    json!({ "kind": "turn", "turnId": turn_id })
}

fn str_field<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

pub fn event_type(event: &Value) -> Option<&str> {
    str_field(event, "type")
}

pub fn event_scope(event: &Value) -> Option<&Value> {
    event.get("scope")
}

/// `"thread"` or `"turn"`.
pub fn scope_kind(scope: &Value) -> Option<&str> {
    str_field(scope, "kind")
}

/// `getThreadEventScopeTurnId`: the turn id of a turn scope.
pub fn scope_turn_id(scope: &Value) -> Option<&str> {
    match scope_kind(scope) {
        Some("turn") => str_field(scope, "turnId"),
        _ => None,
    }
}

pub fn event_scope_kind(event: &Value) -> Option<&str> {
    event_scope(event).and_then(scope_kind)
}

pub fn event_turn_id(event: &Value) -> Option<&str> {
    event_scope(event).and_then(scope_turn_id)
}

pub fn require_thread_event_scope_turn_id<'a>(
    event_type: &str,
    scope: &'a Value,
) -> Result<&'a str, String> {
    let kind = scope_kind(scope).unwrap_or("undefined");
    match scope_turn_id(scope) {
        Some(turn_id) => Ok(turn_id),
        None => Err(format!("{event_type} requires turn scope but received {kind} scope")),
    }
}

/// `validateThreadEventScope`: `Err(message)` when the scope breaks the type's policy.
pub fn validate_thread_event_scope(event_type: &str, scope: &Value) -> Result<(), String> {
    let policy = scope_policy(event_type);
    let kind = scope_kind(scope).unwrap_or("undefined");
    if policy == Some(ThreadEventScopePolicy::ThreadOrTurn)
        || policy.is_some_and(|policy| policy.as_str() == kind)
    {
        return Ok(());
    }
    let required = policy.map_or("undefined", ThreadEventScopePolicy::as_str);
    Err(format!("{event_type} requires {required} scope but received {kind} scope"))
}

/// The event's `item` object, when it carries one.
pub fn event_item(event: &Value) -> Option<&Map<String, Value>> {
    event.get("item").and_then(Value::as_object)
}

/// `item.id`, else the event's own `itemId`.
pub fn event_item_id(event: &Value) -> Option<&str> {
    let own = event_item(event).and_then(|item| item.get("id")).and_then(Value::as_str);
    own.or_else(|| str_field(event, "itemId"))
}

/// `item.type`.
pub fn event_item_kind(event: &Value) -> Option<&str> {
    event_item(event).and_then(|item| item.get("type")).and_then(Value::as_str)
}

/// `item.parentToolCallId`, else the event's own `parentToolCallId`; empty counts as none.
pub fn event_parent_tool_call_id(event: &Value) -> Option<&str> {
    let own = event_item(event).and_then(|item| item.get("parentToolCallId"));
    let own = own.filter(|value| !value.is_null());
    let parent = own.or_else(|| event.get("parentToolCallId").filter(|value| !value.is_null()));
    parent.and_then(Value::as_str).filter(|parent| !parent.is_empty())
}

/// The event's `providerThreadId` when it is a string.
pub fn event_provider_thread_id(event: &Value) -> Option<&str> {
    str_field(event, "providerThreadId")
}

/// The event without its `type` and `scope`, as stored in the `data` column.
pub fn event_data(event: &Value) -> Map<String, Value> {
    match event.as_object() {
        Some(object) => object
            .iter()
            .filter(|(key, _)| key.as_str() != "type" && key.as_str() != "scope")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        None => Map::new(),
    }
}
