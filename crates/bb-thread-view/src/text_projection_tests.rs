//! Isolated golden comparison for the text projection: drives a `ProjectionState` with only the
//! turn, assistant-text and reasoning events and compares the resulting assistant-text and
//! reasoning-operation messages and `activeThinking` with the recorded TypeScript projections
//! (`tests/fixtures/timeline/*.json` and the focused `tests/fixtures/text_projection/*.json`).

use std::path::PathBuf;

use serde_json::Value;

use super::*;
use crate::group_turns::get_ordered_thread_events;
use crate::types::ThreadEventWithMeta;
use crate::user_message_parsing::should_preserve_pending_messages;

/// A copy of the event loop's turn handling, without the tool-activity and operation parts.
fn drive(events: &[ThreadEventWithMeta], thread_status: &str) -> (Vec<Value>, Option<Value>) {
    let mut state = ProjectionState::new();
    for ThreadEventWithMeta { event: decoded, meta } in get_ordered_thread_events(events) {
        let decoded = &decoded;
        let meta = &meta;
        let turn_id = event::turn_id(decoded);
        let parent = event::parent_tool_call_id(decoded).filter(|id| !id.is_empty());
        match event::event_type(decoded) {
            "turn/started" => {
                if let Some(turn_id) = turn_id {
                    state.open_turn_ids.insert(turn_id.to_owned());
                }
            }
            "turn/completed" => {
                let Some(turn_id) = turn_id else { continue };
                state.closed_turn_ids.insert(turn_id.to_owned());
                state.open_turn_ids.shift_remove(turn_id);
                let status = if event::status(decoded) == Some("completed") {
                    ReasoningCompletionStatus::Completed
                } else {
                    ReasoningCompletionStatus::Interrupted
                };
                finalize_open_reasoning_lifecycles(&mut state, meta, status, Some(turn_id));
                flush_buffered_assistant_messages(&mut state, Some(turn_id));
            }
            "system/thread/interrupted" => {
                for turn_id in std::mem::take(&mut state.open_turn_ids) {
                    state.closed_turn_ids.insert(turn_id);
                }
                finalize_open_reasoning_lifecycles(
                    &mut state,
                    meta,
                    ReasoningCompletionStatus::Interrupted,
                    None,
                );
                flush_buffered_assistant_messages(&mut state, None);
            }
            _ => {
                project_assistant_and_reasoning_event(&mut state, decoded, meta, turn_id, parent);
            }
        }
    }
    if !should_preserve_pending_messages(thread_status) {
        flush_buffered_assistant_messages(&mut state, None);
    }
    let active_thinking = build_projection_active_thinking(&state, thread_status);
    let mut messages: Vec<Value> = state
        .messages
        .iter()
        .map(|r| serde_json::to_value(state.message(*r)).expect("message serializes"))
        .filter(is_text_message)
        .collect();
    sort_by_id(&mut messages);
    (messages, active_thinking)
}

fn is_text_message(message: &Value) -> bool {
    match message["kind"].as_str() {
        Some("assistant-text") => true,
        Some("operation") => message["opType"] == "reasoning",
        _ => false,
    }
}

fn sort_by_id(messages: &mut [Value]) {
    messages.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
}

/// Every assistant-text and reasoning message anywhere in the recorded projection entries.
fn collect_recorded(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if is_text_message(value) && map.contains_key("sourceSeqStart") {
                out.push(value.clone());
            }
            map.values().for_each(|child| collect_recorded(child, out));
        }
        Value::Array(items) => items.iter().for_each(|child| collect_recorded(child, out)),
        _ => {}
    }
}

fn first_difference(path: &str, actual: &Value, expected: &Value) -> Option<String> {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            let mut keys: Vec<&String> = a.keys().chain(e.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                first_difference(
                    &format!("{path}.{key}"),
                    a.get(key).unwrap_or(&Value::Null),
                    e.get(key).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(a), Value::Array(e)) if a.len() == e.len() => a
            .iter()
            .zip(e)
            .enumerate()
            .find_map(|(i, (a, e))| first_difference(&format!("{path}[{i}]"), a, e)),
        _ if actual == expected => None,
        _ => {
            let show = |v: &Value| v.to_string().chars().take(160).collect::<String>();
            Some(format!("{path}: actual {} expected {}", show(actual), show(expected)))
        }
    }
}

fn fixture_paths(dir: &str) -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(dir);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

/// Runs every case of the fixtures in `dir`; returns (cases, failures). With `drop_unparented`
/// the driver's nested messages are dropped before comparing, as `buildProjectionEntries` drops
/// nested messages whose parent is not a delegation call (the focused cases have none).
fn compare_fixtures(dir: &str, drop_unparented: bool) -> (usize, Vec<String>) {
    let mut cases = 0;
    let mut failures = Vec::new();
    for path in fixture_paths(dir) {
        let raw = std::fs::read_to_string(&path).expect("fixture reads");
        // JavaScript keeps the lone high surrogate where the 32,000-unit cap splits a pair;
        // `normalize_reasoning_detail` writes U+FFFD there instead.
        let raw = raw.replace("\\ud83d\\n…", "\u{fffd}\\n…");
        let fixture: Value = serde_json::from_str(&raw).expect("fixture parses");
        let events: Vec<ThreadEventWithMeta> =
            serde_json::from_value(fixture["compacted"].clone()).expect("events decode");
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        for result in fixture["results"].as_array().expect("results") {
            cases += 1;
            let status = result["options"]["threadStatus"].as_str().unwrap_or("idle");
            let (mut actual, active_thinking) = drive(&events, status);
            if drop_unparented {
                actual.retain(|message| message["parentToolCallId"].is_null());
            }
            let mut expected = Vec::new();
            collect_recorded(&result["projection"]["entries"], &mut expected);
            sort_by_id(&mut expected);
            let actual =
                serde_json::json!({ "messages": actual, "activeThinking": active_thinking });
            let expected = serde_json::json!({
                "messages": expected,
                "activeThinking": result["projection"]["activeThinking"],
            });
            if let Some(difference) = first_difference("$", &actual, &expected) {
                failures.push(format!("{name} [{status}]: {difference}"));
            }
        }
    }
    (cases, failures)
}

#[test]
fn text_projection_matches_recorded_timeline_fixtures() {
    let (cases, failures) = compare_fixtures("timeline", false);
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(cases, 87);
}

#[test]
fn text_projection_matches_focused_typescript_cases() {
    let (cases, failures) = compare_fixtures("text_projection", true);
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(cases, 27);
}

#[test]
fn reasoning_detail_cap_counts_utf16_units() {
    let detail = format!("  {}😀😀  ", "a".repeat(MAX_REASONING_DETAIL_CHARS - 2));
    assert_eq!(
        normalize_reasoning_detail(&detail),
        format!("{}😀\n…[2 more characters truncated]", "a".repeat(MAX_REASONING_DETAIL_CHARS - 2))
    );
    assert_eq!(normalize_reasoning_detail(" \u{a0}short\u{3000} "), "short");
}

/// The nested messages `buildProjectionEntries` hides in `parents-and-scopes.json`: keyed and
/// tagged by their parent call (the item's own `parentToolCallId` wins over the event's).
#[test]
fn nested_text_keeps_parent_tool_call_id() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/text_projection/parents-and-scopes.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let events: Vec<ThreadEventWithMeta> =
        serde_json::from_value(fixture["compacted"].clone()).unwrap();
    let (messages, _) = drive(&events, "idle");
    let nested: Vec<(&str, &str, &str)> = messages
        .iter()
        .filter(|m| !m["parentToolCallId"].is_null())
        .map(|m| {
            let text = m["text"].as_str().or(m["detail"].as_str()).unwrap();
            (m["id"].as_str().unwrap(), m["parentToolCallId"].as_str().unwrap(), text)
        })
        .collect();
    assert_eq!(
        nested,
        vec![
            (
                "thr_text:assistant:kind:assistant|turn:t1|parent:call_1|item:a1",
                "call_1",
                "child text\nend"
            ),
            (
                "thr_text:op:reasoning:kind:reasoning|turn:t1|parent:call_2|item:r1",
                "call_2",
                "child thinking"
            ),
        ]
    );
}
