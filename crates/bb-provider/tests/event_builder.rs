use std::sync::Arc;

use bb_provider::CloseOptions;
use bb_provider::{
    DeltaChannel, EventBuilder, EventBuilderOptions, ItemKey, ItemOptions, TextChannel,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

const REQUEST: &str = "creq_aaaaaaaaaa";

fn matches(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|found| matches(found, value))),
        (Value::Array(actual), Value::Array(expected)) => {
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(found, value)| matches(found, value))
        }
        _ => actual == expected,
    }
}

fn assert_match(actual: &[Value], expected: Value) {
    let actual = Value::Array(actual.to_vec());
    assert!(matches(&actual, &expected), "{actual:#}\n does not match\n{expected:#}");
}

fn recorder(now: i64) -> (EventBuilder, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let mut options = EventBuilderOptions::new(Arc::new(move |event| sink.lock().push(event)));
    options.now = Arc::new(move || now);
    (EventBuilder::with_options(options), events)
}

fn turn(turn: &str) -> ItemOptions {
    ItemOptions { turn: Some(turn.to_owned()), presentation: None }
}

#[test]
fn holds_events_until_identity_mints_parent_ids_early_drops_stray_traffic() {
    let command = json!({ "type": "commandExecution", "command": "ls", "cwd": "/" });
    let (builder, events) = recorder(1_000);
    builder.started();
    builder.accept_input(REQUEST, None);
    let child = builder.open_turn(Some("child"), Some("call-1"));
    assert!(events.lock().is_empty());
    builder.identity("prov-1");
    let root = builder.open_turn(Some("root"), None);
    let shape = json!({ "type": "delegation", "childRef": "c", "label": "x", "background": false });
    let parent = builder.open_item(&ItemKey::provider("call-1"), shape, turn("root")).unwrap();
    let pattern = regex::Regex::new(r"^da[0-9a-f]{8}-t2$").unwrap();
    assert!(pattern.is_match(&root), "{root}");
    assert!(parent.ends_with("-i1"), "{parent}");
    assert_eq!(builder.provider_turn_id(&child).as_deref(), Some("child"));
    assert_eq!(builder.active_turn_id(), Some(root.clone()));
    assert_match(
        &events.lock(),
        json!([
            { "type": "thread/identity", "scope": { "kind": "thread" } },
            { "type": "thread/started", "scope": { "kind": "thread" } },
            { "type": "turn/started", "providerThreadId": "prov-1", "parentToolCallId": parent },
            { "type": "turn/started", "scope": { "turnId": root } },
            { "clientRequestId": REQUEST, "scope": { "turnId": root } },
            { "type": "item/started", "item": { "id": parent } },
        ]),
    );
    let key = ItemKey::provider("cmd-1").with_parent_ref(Some("call-1"));
    let done = || CloseOptions { turn: Some("child".into()), ..CloseOptions::new("completed") };
    let item = builder.open_item(&key, command.clone(), turn("child")).unwrap();
    builder.delta(&key, DeltaChannel::Command, "out", Some("child"));
    let tail = {
        let all = events.lock();
        all[all.len() - 2..].to_vec()
    };
    assert_match(
        &tail,
        json!([
            { "item": { "status": "pending", "parentToolCallId": parent } },
            { "delta": "out", "parentToolCallId": parent },
        ]),
    );
    builder.close_item(&key, command.clone(), done());
    builder.close_item(&key, command, done());
    builder.delta(&key, DeltaChannel::Command, "late", Some("child"));
    builder.close_turn(Some("never-opened"), "completed", None, None);
    let all = events.lock().clone();
    assert_match(&all[all.len() - 2..], json!([{ "delta": "out" }, { "type": "item/completed" }]));
    let completed = serde_json::to_string(&all[all.len() - 1]).unwrap();
    let expected = format!(
        r#"{{"type":"item/completed","item":{{"type":"commandExecution","command":"ls","cwd":"/","id":"{item}","parentToolCallId":"{parent}","status":"completed","approvalStatus":null}},"providerThreadId":"prov-1","scope":{{"kind":"turn","turnId":"{child}"}}}}"#
    );
    assert_eq!(completed, expected);
}

#[test]
fn text_deltas_open_and_close_text_items() {
    let (builder, events) = recorder(0);
    builder.identity("prov");
    let turn_id = builder.open_turn(Some("t"), None);
    let key = ItemKey::provider("msg");
    builder.delta(&key, TextChannel::AgentMessage.into(), "Hel", None);
    builder.text_close(&key, TextChannel::AgentMessage, None, None);
    builder.settle("interrupted", Some("stopped"));
    let all = events.lock().clone();
    let id = builder.bb_item_id("msg").unwrap();
    assert_eq!(
        all[2..],
        [
            json!({ "type": "item/started", "item": { "type": "agentMessage", "text": "", "id": id }, "providerThreadId": "prov", "scope": { "kind": "turn", "turnId": turn_id } }),
            json!({ "type": "item/agentMessage/delta", "itemId": id, "delta": "Hel", "providerThreadId": "prov", "scope": { "kind": "turn", "turnId": turn_id } }),
            json!({ "type": "item/completed", "item": { "type": "agentMessage", "text": "Hel", "id": id }, "providerThreadId": "prov", "scope": { "kind": "turn", "turnId": turn_id } }),
            json!({ "type": "turn/completed", "status": "interrupted", "error": { "message": "stopped" }, "providerThreadId": "prov", "scope": { "kind": "turn", "turnId": turn_id } }),
        ]
    );
    assert_eq!(builder.active_turn_id(), None);
}
