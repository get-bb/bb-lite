use bb_thread_view::parse_operation_message::{
    finalize_operation_message, interrupt_operation_message, merge_transcript_entries,
    parse_error_message, parse_operation_message, provisioning_title_for_status,
};
use bb_thread_view::rows::RowStatus;
use bb_thread_view::types::{
    ErrorMessage, EventMeta, InteractionMessage, Message, MessageBase, OperationMessage,
    ProjectionOptions,
};
use serde_json::{Map, Value, json};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/parse_operation_corpus.json")).unwrap()
}

fn meta(value: &Value) -> EventMeta {
    EventMeta {
        id: value["id"].as_str().unwrap().to_string(),
        seq: value["seq"].as_i64().unwrap(),
        created_at: value["createdAt"].as_i64().unwrap(),
    }
}

fn options(value: &Value) -> ProjectionOptions {
    ProjectionOptions {
        include_diagnostic_operations: value["includeDiagnosticOperations"].as_bool().unwrap(),
        thread_status: value["threadStatus"].as_str().unwrap().to_string(),
        thread_name: value["threadName"].as_str().unwrap().to_string(),
    }
}

fn base_json(kind: &str, base: &MessageBase) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("kind".into(), json!(kind));
    map.insert("id".into(), json!(base.id));
    map.insert("threadId".into(), json!(base.thread_id));
    map.insert("sourceSeqStart".into(), json!(base.source_seq_start));
    map.insert("sourceSeqEnd".into(), json!(base.source_seq_end));
    map.insert("createdAt".into(), json!(base.created_at));
    map.insert("scope".into(), serde_json::to_value(&base.scope).unwrap());
    if let Some(started_at) = base.started_at {
        map.insert("startedAt".into(), json!(started_at));
    }
    map
}

fn operation_json(message: &OperationMessage) -> Value {
    let mut map = base_json("operation", &message.base);
    map.insert("completedAt".into(), json!(message.completed_at));
    map.insert("opType".into(), json!(message.op_type.as_str()));
    map.insert("title".into(), json!(message.title));
    map.insert("status".into(), serde_json::to_value(message.status).unwrap());
    if let Some(detail) = &message.detail {
        map.insert("detail".into(), json!(detail));
    }
    if let Some(merge_key) = &message.merge_key {
        map.insert("mergeKey".into(), json!(merge_key));
    }
    if let Some(transcript) = &message.transcript {
        map.insert("transcript".into(), json!(transcript));
    }
    if let Some(parent_change) = &message.parent_change {
        map.insert("parentChange".into(), serde_json::to_value(parent_change).unwrap());
    }
    Value::Object(map)
}

fn interaction_json(message: &InteractionMessage) -> Value {
    let mut map = base_json("interaction", &message.base);
    map.insert("status".into(), serde_json::to_value(message.status).unwrap());
    let Value::Object(work) = serde_json::to_value(&message.work).unwrap() else { panic!() };
    map.extend(work);
    Value::Object(map)
}

fn error_json(message: &ErrorMessage) -> Value {
    let mut map = base_json("error", &message.base);
    map.insert("rawType".into(), json!(message.raw_type));
    map.insert("message".into(), json!(message.message));
    map.insert("detail".into(), json!(message.detail));
    if let Some(info) = &message.provider_error_info {
        map.insert("providerErrorInfo".into(), info.clone());
    }
    if let Some(will_retry) = message.will_retry {
        map.insert("willRetry".into(), json!(will_retry));
    }
    Value::Object(map)
}

#[test]
fn matches_typescript_for_every_corpus_event() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let meta = meta(&case["meta"]);
        let options = options(&case["options"]);
        let parsed = parse_operation_message(&case["event"], &meta, &options);
        let (mut interrupted, mut finalized) = (Value::Null, Value::Null);
        let parsed_json = match &parsed {
            None => Value::Null,
            Some(Message::Operation(message)) => {
                let mut copy = message.clone();
                interrupt_operation_message(&mut copy);
                interrupted = operation_json(&copy);
                let mut copy = message.clone();
                finalize_operation_message(&mut copy, &options);
                finalized = operation_json(&copy);
                operation_json(message)
            }
            Some(Message::Interaction(message)) => interaction_json(message),
            Some(other) => panic!("unexpected message kind {}", other.kind()),
        };
        let error =
            parse_error_message(&case["event"], &meta).as_ref().map_or(Value::Null, error_json);
        let actual = json!({
            "parsed": parsed_json,
            "interrupted": interrupted,
            "finalized": finalized,
            "error": error,
        });
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
fn merge_transcript_entries_matches_typescript() {
    for case in corpus()["merge"].as_array().unwrap() {
        let existing = case["existing"].as_array().map(Vec::as_slice);
        let incoming = case["incoming"].as_array().map(Vec::as_slice);
        let actual = merge_transcript_entries(existing, incoming);
        assert_eq!(json!(actual), case["expected"], "{case}");
    }
}

#[test]
fn provisioning_titles_match_typescript() {
    let corpus = corpus();
    for status in
        [RowStatus::Pending, RowStatus::Completed, RowStatus::Error, RowStatus::Interrupted]
    {
        let key = serde_json::to_value(status).unwrap();
        let title = provisioning_title_for_status(status);
        assert_eq!(corpus["statusTitles"][key.as_str().unwrap()], json!(title));
    }
}
