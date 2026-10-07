use bb_thread_view::rows::{TurnRequestKind, TurnRequestStatus};
use bb_thread_view::types::{EventMeta, ThreadEventWithMeta, UserMessage};
use bb_thread_view::user_message_parsing::{
    AcceptedClientRequest, ParsedPromptInput, build_accepted_client_request_by_id,
    client_request_user_messages, parse_prompt_input, parse_provider_user_message,
    should_preserve_pending_messages, turn_request_kind,
};
use serde_json::{Map, Value, json};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/user_message_corpus.json")).unwrap()
}

fn meta(value: &Value) -> EventMeta {
    EventMeta {
        id: value["id"].as_str().unwrap().to_string(),
        seq: value["seq"].as_i64().unwrap(),
        created_at: value["createdAt"].as_i64().unwrap(),
    }
}

fn meta_json(meta: &EventMeta) -> Value {
    json!({ "id": meta.id, "seq": meta.seq, "createdAt": meta.created_at })
}

fn accepted(value: &Value) -> Option<AcceptedClientRequest> {
    (!value.is_null()).then(|| AcceptedClientRequest {
        meta: meta(&value["meta"]),
        turn_id: value["turnId"].as_str().unwrap().to_string(),
    })
}

fn user_json(message: &UserMessage) -> Value {
    let base = &message.base;
    let mut map = Map::new();
    map.insert("kind".into(), json!("user"));
    map.insert("id".into(), json!(base.id));
    map.insert("threadId".into(), json!(base.thread_id));
    map.insert("sourceSeqStart".into(), json!(base.source_seq_start));
    map.insert("sourceSeqEnd".into(), json!(base.source_seq_end));
    map.insert("createdAt".into(), json!(base.created_at));
    map.insert("scope".into(), serde_json::to_value(&base.scope).unwrap());
    assert_eq!(base.started_at, None);
    if let Some(parent) = &base.parent_tool_call_id {
        map.insert("parentToolCallId".into(), json!(parent));
    }
    map.insert("text".into(), json!(message.text));
    map.insert("attachments".into(), serde_json::to_value(&message.attachments).unwrap());
    let Value::Object(fields) = serde_json::to_value(&message.fields).unwrap() else { panic!() };
    map.extend(fields);
    Value::Object(map)
}

fn prompt_json(parsed: &ParsedPromptInput) -> Value {
    json!({ "text": parsed.text, "mentions": parsed.mentions, "attachments": parsed.attachments })
}

fn kind_str(kind: TurnRequestKind) -> Value {
    serde_json::to_value(kind).unwrap()
}

fn status(value: &Value) -> TurnRequestStatus {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn matches_typescript_for_every_corpus_event() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let meta = meta(&case["meta"]);
        let actual = if case["kind"] == "client" {
            let accepted = accepted(&case["accepted"]);
            let messages = client_request_user_messages(
                &case["event"],
                &meta,
                status(&case["status"]),
                accepted.as_ref(),
            );
            json!({
                "messages": messages.iter().map(user_json).collect::<Vec<_>>(),
                "turnRequestKind": kind_str(turn_request_kind(&case["event"], accepted.as_ref())),
            })
        } else {
            parse_provider_user_message(&case["event"], &meta)
                .as_ref()
                .map_or(Value::Null, user_json)
        };
        if actual != case["expected"] {
            failures.push(format!(
                "case {index}: {}\n  expected {}\n  actual   {}",
                case["event"], case["expected"], actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn parse_prompt_input_matches_typescript() {
    for case in corpus()["prompts"].as_array().unwrap() {
        let actual = parse_prompt_input(case["input"].as_array().unwrap());
        assert_eq!(actual.as_ref().map_or(Value::Null, prompt_json), case["expected"], "{case}");
    }
}

#[test]
fn accepted_client_requests_match_typescript() {
    for case in corpus()["accepted"].as_array().unwrap() {
        let events: Vec<ThreadEventWithMeta> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| ThreadEventWithMeta {
                event: entry["event"].clone(),
                meta: meta(&entry["meta"]),
            })
            .collect();
        let actual: Map<String, Value> = build_accepted_client_request_by_id(&events)
            .into_iter()
            .map(|(id, accepted)| {
                (id, json!({ "meta": meta_json(&accepted.meta), "turnId": accepted.turn_id }))
            })
            .collect();
        assert_eq!(Value::Object(actual), case["expected"]);
    }
}

#[test]
fn should_preserve_pending_messages_matches_typescript() {
    for (status, expected) in corpus()["preserve"].as_object().unwrap() {
        assert_eq!(json!(should_preserve_pending_messages(status)), *expected, "{status}");
    }
}
