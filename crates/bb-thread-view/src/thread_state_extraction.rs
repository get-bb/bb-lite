//! Port of `thread-state-extraction.ts`: thread state read off the event log for the timeline
//! (context window usage, the legacy Codex goal, model fallback, pending todos) and the summary
//! compaction of agent-message deltas.
//!
//! The results are JSON values with exactly the shapes of the TypeScript results
//! (`ThreadContextWindowUsage`, `ThreadTimelineGoal`, `ThreadTimelineModelFallback`,
//! `ThreadTimelinePendingTodos`); numbers are copied from the events untouched.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::event::{
    event_item_id, event_type, field, is_type, item, item_type, parent_tool_call_id, str_field,
    turn_id,
};
use crate::format::js_trim;
use crate::group_turns::get_ordered_thread_events;
use crate::types::ThreadEventWithMeta;

/// `THREAD_TIMELINE_EXCLUDED_EVENT_TYPES`.
pub const THREAD_TIMELINE_EXCLUDED_EVENT_TYPES: [&str; 5] = [
    "thread/started",
    "thread/identity",
    "thread/contextWindowUsage/updated",
    "thread/tokenUsage/updated",
    "turn/diff/updated",
];

/// `LEGACY_CODEX_GOAL_EXTENSION_KIND`.
pub const LEGACY_CODEX_GOAL_EXTENSION_KIND: &str = "provider-codex/goal";

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION: usize = 1000;
const TODO_TEXT_MAX_LENGTH: usize = 240;
const GOAL_STATUSES: [&str; 4] = ["active", "paused", "budgetLimited", "complete"];

/// The `key` of `bufferedTextIdentity` for the event kinds the compaction looks at
/// (`item/agentMessage/delta` and completed `agentMessage` items).
fn assistant_text_key(event: &Value) -> Option<String> {
    let item_id = match event_type(event) {
        "item/agentMessage/delta" | "item/plan/delta" => str_field(event, "itemId")?,
        "item/completed" => {
            let item = item(event)?;
            match item_type(item) {
                Some("agentMessage" | "plan") => event_item_id(event)?,
                _ => return None,
            }
        }
        _ => return None,
    };
    let turn = turn_id(event)?;
    let parent = parent_tool_call_id(event).unwrap_or("root");
    Some(format!("kind:assistant|turn:{turn}|parent:{parent}|item:{item_id}"))
}

/// `compactThreadTimelineSummaryEvents`: with at least 1000 agent-message deltas, keeps only the
/// first delta of every assistant message that later completed.
pub fn compact_thread_timeline_summary_events(
    events: &[ThreadEventWithMeta],
) -> Vec<ThreadEventWithMeta> {
    let is_delta = |entry: &ThreadEventWithMeta| is_type(&entry.event, "item/agentMessage/delta");
    let delta_count = events.iter().filter(|entry| is_delta(entry)).count();
    let completed_keys: HashSet<String> = events
        .iter()
        .filter(|entry| {
            is_type(&entry.event, "item/completed")
                && item(&entry.event).and_then(item_type) == Some("agentMessage")
        })
        .filter_map(|entry| assistant_text_key(&entry.event))
        .collect();
    if delta_count < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION || completed_keys.is_empty() {
        return events.to_vec();
    }
    let mut retained = HashSet::new();
    events
        .iter()
        .filter(|entry| {
            if !is_delta(entry) {
                return true;
            }
            match assistant_text_key(&entry.event) {
                Some(key) if completed_keys.contains(&key) => retained.insert(key),
                _ => true,
            }
        })
        .cloned()
        .collect()
}

fn positive_number(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0))
}

fn numbers_equal(left: Option<&Value>, right: &Value) -> bool {
    match (left.and_then(Value::as_f64), right.as_f64()) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// `extractThreadContextWindowUsage`: the latest `thread/contextWindowUsage/updated` usage, with
/// the latest positive model context window; `None` when either is missing.
pub fn extract_thread_context_window_usage(events: &[ThreadEventWithMeta]) -> Option<Value> {
    let ordered = get_ordered_thread_events(events);
    let signals: Vec<Option<&Value>> = ordered
        .iter()
        .rev()
        .filter(|entry| is_type(&entry.event, "thread/contextWindowUsage/updated"))
        .map(|entry| field(&entry.event, "contextWindowUsage"))
        .collect();
    let latest = (*signals.first()?)?;
    let used_tokens = field(latest, "usedTokens").filter(|value| !value.is_null())?;
    let used = used_tokens.as_f64()?;
    if !used.is_finite() || used < 0.0 {
        return None;
    }
    let model_context_window = signals
        .iter()
        .flatten()
        .find_map(|signal| positive_number(field(signal, "modelContextWindow")))?;
    let mut result = Map::new();
    let matching_snapshot = field(latest, "snapshot").filter(|snapshot| {
        is_truthy(snapshot)
            && numbers_equal(field(snapshot, "usedTokens"), used_tokens)
            && numbers_equal(field(snapshot, "contextWindowTokens"), model_context_window)
    });
    if let Some(snapshot) = matching_snapshot {
        result.insert("snapshot".into(), snapshot.clone());
    }
    if let Some(estimated) = field(latest, "estimated") {
        result.insert("estimated".into(), estimated.clone());
    }
    result.insert("modelContextWindow".into(), model_context_window.clone());
    result.insert("usedTokens".into(), used_tokens.clone());
    Some(Value::Object(result))
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The goal payload schema: an object with the five goal fields (unknown keys dropped), or null.
/// `None` when the payload does not parse.
fn parse_goal_payload(payload: Option<&Value>) -> Option<Option<Map<String, Value>>> {
    let payload = payload?;
    if payload.is_null() {
        return Some(None);
    }
    let objective = field(payload, "objective").filter(|v| v.is_string())?;
    let status = field(payload, "status")
        .filter(|v| v.as_str().is_some_and(|s| GOAL_STATUSES.contains(&s)))?;
    let token_budget = field(payload, "tokenBudget").filter(|v| v.is_number() || v.is_null())?;
    let tokens_used = field(payload, "tokensUsed").filter(|v| v.is_number())?;
    let time_used = field(payload, "timeUsedSeconds").filter(|v| v.is_number())?;
    let mut goal = Map::new();
    goal.insert("objective".into(), objective.clone());
    goal.insert("status".into(), status.clone());
    goal.insert("tokenBudget".into(), token_budget.clone());
    goal.insert("tokensUsed".into(), tokens_used.clone());
    goal.insert("timeUsedSeconds".into(), time_used.clone());
    Some(Some(goal))
}

/// `extractThreadTimelineGoal`: the highest-seq valid legacy Codex goal extension state.
pub fn extract_thread_timeline_goal(events: &[ThreadEventWithMeta]) -> Option<Value> {
    let mut best: Option<(i64, Option<Value>)> = None;
    for entry in get_ordered_thread_events(events) {
        let event = &entry.event;
        if !is_type(event, "thread/extensionState/updated")
            || str_field(event, "kind") != Some(LEGACY_CODEX_GOAL_EXTENSION_KIND)
        {
            continue;
        }
        let Some(payload) = parse_goal_payload(field(event, "payload")) else {
            continue;
        };
        if best.as_ref().is_some_and(|(seq, _)| entry.meta.seq <= *seq) {
            continue;
        }
        let goal = payload.map(|data| {
            let mut goal = Map::new();
            goal.insert("sourceSeq".into(), json!(entry.meta.seq));
            goal.insert("updatedAt".into(), json!(entry.meta.created_at));
            goal.extend(data);
            Value::Object(goal)
        });
        best = Some((entry.meta.seq, goal));
    }
    best.and_then(|(_, goal)| goal)
}

/// `extractThreadTimelineModelFallback`: the latest `provider/modelFallback` not followed by a
/// `client/turn/requested` (events in the given order).
pub fn extract_thread_timeline_model_fallback(events: &[ThreadEventWithMeta]) -> Option<Value> {
    let mut latest_relevant_seq = -1;
    let mut fallback = None;
    for entry in events {
        if entry.meta.seq < latest_relevant_seq {
            continue;
        }
        let event = &entry.event;
        if is_type(event, "client/turn/requested") {
            latest_relevant_seq = entry.meta.seq;
            fallback = None;
        } else if is_type(event, "provider/modelFallback") {
            latest_relevant_seq = entry.meta.seq;
            let mut value = Map::new();
            value.insert("sourceSeq".into(), json!(entry.meta.seq));
            value.insert("detectedAt".into(), json!(entry.meta.created_at));
            for key in ["originalModel", "fallbackModel", "reason", "message"] {
                if let Some(v) = field(event, key) {
                    value.insert(key.into(), v.clone());
                }
            }
            fallback = Some(Value::Object(value));
        }
    }
    fallback
}

/// `sliceUtf16Head`: the first `max_chars` UTF-16 code units, never splitting a surrogate pair.
fn slice_utf16_head(value: &str, max_chars: usize) -> &str {
    let mut units = 0;
    for (index, c) in value.char_indices() {
        let width = c.len_utf16();
        if units + width > max_chars {
            return &value[..index];
        }
        units += width;
    }
    value
}

fn plan_step_todo_status(status: Option<&Value>) -> Option<&'static str> {
    match status {
        None | Some(Value::Null) => Some("pending"),
        Some(Value::String(s)) => match s.as_str() {
            "pending" => Some("pending"),
            "active" => Some("in_progress"),
            "completed" | "failed" => Some("completed"),
            _ => None,
        },
        Some(_) => None,
    }
}

/// `extractThreadTimelinePendingTodos`: the highest-seq completed `planSteps` item as todos, only
/// while the thread is active.
pub fn extract_thread_timeline_pending_todos(
    thread_status: &str,
    events: &[ThreadEventWithMeta],
) -> Option<Value> {
    if thread_status != "active" {
        return None;
    }
    let mut best: Option<(i64, Value)> = None;
    for entry in get_ordered_thread_events(events) {
        let event = &entry.event;
        let Some(plan) = item(event).filter(|item| {
            is_type(event, "item/completed") && item_type(item) == Some("planSteps")
        }) else {
            continue;
        };
        if best.as_ref().is_some_and(|(seq, _)| entry.meta.seq <= *seq) {
            continue;
        }
        let steps = field(plan, "steps").and_then(Value::as_array);
        let items: Vec<Value> = steps
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, step)| {
                let text = slice_utf16_head(
                    js_trim(str_field(step, "step").unwrap_or("")),
                    TODO_TEXT_MAX_LENGTH,
                );
                if text.is_empty() {
                    return None;
                }
                let mut todo = Map::new();
                todo.insert("id".into(), json!(format!("seq:{}:{index}", entry.meta.seq)));
                todo.insert("text".into(), json!(text));
                if let Some(status) = plan_step_todo_status(field(step, "status")) {
                    todo.insert("status".into(), json!(status));
                }
                Some(Value::Object(todo))
            })
            .collect();
        let todos = json!({
            "sourceSeq": entry.meta.seq,
            "updatedAt": entry.meta.created_at,
            "items": items,
        });
        best = Some((entry.meta.seq, todos));
    }
    best.map(|(_, todos)| todos)
}
