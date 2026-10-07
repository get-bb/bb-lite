//! Compares the item-lifecycle parsers against the TypeScript outputs recorded in
//! `fixtures/item_lifecycle_corpus.json` (hand-written item events plus every `item/*` and
//! `thread/compacted` event of the runner's recorded Claude and Codex fixtures).

use bb_thread_view::item_lifecycle::{
    item_status_to_exec_status, js_json_stringify, parse_compaction_lifecycle_event,
    parse_exec_lifecycle_event, parse_file_edit_from_item_event, parse_item_lifecycle_event,
    parse_tool_call_lifecycle_event, should_suppress_low_value_tool_call,
};
use bb_thread_view::rows::RowStatus;
use bb_thread_view::types::EventMeta;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    id: String,
    seq: i64,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    exec: Value,
    tool_call: Value,
    item: Value,
    file_edit: Value,
    compaction: Value,
    suppress: bool,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    event: Value,
    meta: Meta,
    parent: Option<String>,
    expected: Expected,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn clip(text: &str) -> String {
    text.chars().take(400).collect()
}

fn to_json<T: Serialize>(value: Option<T>) -> Value {
    serde_json::to_value(value).expect("serializes")
}

#[test]
fn matches_typescript_on_every_corpus_entry() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/item_lifecycle_corpus.json")).expect("parses");
    assert!(fixture.cases.len() >= 400, "corpus has {} cases", fixture.cases.len());
    let mut failures = Vec::new();
    for case in &fixture.cases {
        let meta = EventMeta {
            id: case.meta.id.clone(),
            seq: case.meta.seq,
            created_at: case.meta.created_at,
        };
        let parent = case.parent.as_deref();
        let event = &case.event;
        let actual = [
            ("exec", to_json(parse_exec_lifecycle_event(event, &meta, parent))),
            ("toolCall", to_json(parse_tool_call_lifecycle_event(event, &meta, parent))),
            ("item", to_json(parse_item_lifecycle_event(event, &meta, parent))),
            ("fileEdit", to_json(parse_file_edit_from_item_event(event, parent))),
            ("compaction", to_json(parse_compaction_lifecycle_event(event, &meta, parent))),
            ("suppress", Value::Bool(should_suppress_low_value_tool_call(event))),
        ];
        let expected = [
            &case.expected.exec,
            &case.expected.tool_call,
            &case.expected.item,
            &case.expected.file_edit,
            &case.expected.compaction,
            &Value::Bool(case.expected.suppress),
        ];
        for ((label, actual), expected) in actual.iter().zip(expected) {
            if actual != expected {
                failures.push(format!(
                    "{} [{label}]\n  rust: {}\n  ts:   {}",
                    case.name,
                    clip(&actual.to_string()),
                    clip(&expected.to_string())
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn item_status_maps_failed_to_error() {
    assert_eq!(item_status_to_exec_status(Some("failed")), Some(RowStatus::Error));
    assert_eq!(item_status_to_exec_status(Some("interrupted")), Some(RowStatus::Interrupted));
    assert_eq!(item_status_to_exec_status(Some("pending")), Some(RowStatus::Pending));
    assert_eq!(item_status_to_exec_status(None), None);
}

#[test]
fn js_json_stringify_matches_javascript() {
    let value: Value =
        serde_json::from_str(r#"{"b":1,"10":2,"2":3,"01":4,"a":[1.0,1e21,1e-7,0.5,-0.0,null]}"#)
            .expect("parses");
    assert_eq!(
        js_json_stringify(&value),
        r#"{"2":3,"10":2,"b":1,"01":4,"a":[1,1e+21,1e-7,0.5,0,null]}"#
    );
    assert_eq!(js_json_stringify(&json!("é\n")), "\"é\\n\"");
}
