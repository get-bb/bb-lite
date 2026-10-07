//! Compares the turn grouping with the TypeScript `group-event-projection-turns.ts` over a corpus
//! captured from the recorded runner fixtures plus generated cases.

use bb_thread_view::group_turns::{
    CompletedTurnDisplay, ExternalUserBoundaryTurnSpan, build_projection_entries,
    get_ordered_thread_events, is_external_user_boundary_for_turn, plan_timeline_rows,
    sort_messages_by_source,
};
use bb_thread_view::types::{Message, ProjectionEntry, ThreadEventWithMeta};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn cases() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/group_turns_cases.json"
    ))
    .expect("read corpus");
    serde_json::from_str(&text).expect("parse corpus")
}

fn load<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{error}: {value:#}"))
}

/// `FileEditChange.move_path` is `Option<String>`, so `movePath: null` and an absent `movePath`
/// load the same; both sides drop `movePath: null` before comparing.
fn normalized(mut value: Value) -> Value {
    match &mut value {
        Value::Object(fields) => {
            if fields.get("movePath") == Some(&Value::Null) {
                fields.shift_remove("movePath");
            }
            for field in fields.values_mut() {
                *field = normalized(field.take());
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = normalized(item.take());
            }
        }
        _ => {}
    }
    value
}

/// The first path where `left` and `right` differ, for failure messages.
fn first_difference(left: &Value, right: &Value, path: &str) -> Option<String> {
    match (left, right) {
        (Value::Object(l), Value::Object(r)) => {
            for key in l.keys().chain(r.keys()) {
                let (a, b) =
                    (l.get(key).unwrap_or(&Value::Null), r.get(key).unwrap_or(&Value::Null));
                if l.contains_key(key) != r.contains_key(key) {
                    return Some(format!("{path}.{key}: {a} vs {b}"));
                }
                if let Some(found) = first_difference(a, b, &format!("{path}.{key}")) {
                    return Some(found);
                }
            }
            None
        }
        (Value::Array(l), Value::Array(r)) if l.len() == r.len() => l
            .iter()
            .zip(r)
            .enumerate()
            .find_map(|(index, (a, b))| first_difference(a, b, &format!("{path}[{index}]"))),
        _ => (left != right).then(|| format!("{path}: {left:.200} vs {right:.200}")),
    }
}

fn list<'a>(cases: &'a Value, key: &str) -> &'a Vec<Value> {
    cases[key].as_array().expect("case list")
}

#[test]
fn messages_round_trip_through_json() {
    let cases = cases();
    let mut count = 0;
    for case in list(&cases, "sort") {
        for message in case["input"].as_array().unwrap() {
            let parsed: Message = load(message);
            let output = normalized(serde_json::to_value(&parsed).unwrap());
            let message = &normalized(message.clone());
            assert!(output == *message, "{:?}", first_difference(&output, message, ""));
            count += 1;
        }
    }
    assert!(count > 0);
}

#[test]
fn ordered_thread_events_match_typescript() {
    let cases = cases();
    for case in list(&cases, "ordered") {
        let events: Vec<ThreadEventWithMeta> = load(&case["input"]);
        let output = serde_json::to_value(get_ordered_thread_events(&events)).unwrap();
        assert_eq!(output, case["output"]);
    }
}

#[test]
fn sorted_messages_match_typescript() {
    let cases = cases();
    for case in list(&cases, "sort") {
        let messages: Vec<Message> = load(&case["input"]);
        let output = normalized(serde_json::to_value(sort_messages_by_source(messages)).unwrap());
        let expected = normalized(case["output"].clone());
        assert!(output == expected, "{:?}", first_difference(&output, &expected, ""));
    }
}

#[test]
fn external_user_boundaries_match_typescript() {
    let cases = cases();
    for case in list(&cases, "boundary") {
        let turn: ExternalUserBoundaryTurnSpan = load(&case["turn"]);
        let sequence = case["message"]["sequence"].as_i64().unwrap();
        let turn_id = case["message"]["turnId"].as_str();
        let output = is_external_user_boundary_for_turn(&turn, sequence, turn_id);
        assert_eq!(json!(output), case["output"], "{case}");
    }
}

#[test]
fn projection_entries_match_typescript() {
    let cases = cases();
    let mut failures = Vec::new();
    let all = list(&cases, "entries");
    for case in all {
        let events: Vec<ThreadEventWithMeta> = load(&case["events"]);
        let messages: Vec<Message> = load(&case["messages"]);
        let output = match build_projection_entries(&events, &messages) {
            Ok(entries) => json!({ "ok": entries }),
            Err(error) => json!({ "error": error.to_string() }),
        };
        let (output, expected) = (normalized(output), normalized(case["output"].clone()));
        if output != expected {
            let difference = first_difference(&output, &expected, "");
            failures.push(format!("{} {difference:?}", case["name"].as_str().unwrap()));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ: {failures:?}", failures.len(), all.len());
}

#[test]
fn timeline_row_plans_match_typescript() {
    let cases = cases();
    let mut failures = Vec::new();
    let mut total = 0;
    for case in list(&cases, "plans") {
        let entries: Vec<ProjectionEntry> = load(&case["entries"]);
        for expected in case["outputs"].as_array().unwrap() {
            total += 1;
            let display: CompletedTurnDisplay = load(&expected["completedTurnDisplay"]);
            let prefix = expected["rowIdPrefix"].as_str().unwrap();
            let output = plan_timeline_rows(&entries, display, prefix);
            let output = normalized(serde_json::to_value(output).unwrap());
            let expected = normalized(expected["output"].clone());
            if output != expected {
                let difference = first_difference(&output, &expected, "");
                let name = case["name"].as_str().unwrap();
                failures.push(format!("{name} {display:?} {prefix:?} {difference:?}"));
            }
        }
    }
    assert!(total > 1000);
    assert!(failures.is_empty(), "{} of {total} differ: {failures:?}", failures.len());
}

#[test]
fn delegation_message_loads() {
    let value = json!({"id": "d", "threadId": "t", "sourceSeqStart": 1, "sourceSeqEnd": 1, "createdAt": 1,
        "scope": {"kind": "thread"}, "kind": "exec", "workKind": "delegation", "status": "completed",
        "callId": "c", "toolName": "delegation", "childRef": null, "background": false, "output": "",
        "completedAt": null, "children": []});
    let parsed: Message = load(&value);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
}
