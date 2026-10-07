//! Golden tests for `build_thread_timeline` and `thread_state_extraction` against
//! `fixtures/timeline/*.json`, produced by the TypeScript `buildThreadTimelineFromEvents` and
//! `compactThreadTimelineSummaryEvents`, plus hand-written cases for the extraction functions.

use std::path::PathBuf;

use bb_thread_view::build_thread_timeline::{
    ThreadTimelineArgs, ThreadTimelineOptions, build_thread_timeline_from_projection,
};
use bb_thread_view::thread_state_extraction::{
    compact_thread_timeline_summary_events, extract_thread_context_window_usage,
    extract_thread_timeline_goal, extract_thread_timeline_model_fallback,
    extract_thread_timeline_pending_todos,
};
use bb_thread_view::types::{Projection, ThreadEventWithMeta};
use serde_json::{Value, json};

fn fixtures() -> Vec<(String, Value)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/timeline");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("fixture dir")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).expect("read fixture");
            (name, serde_json::from_str(&text).expect("fixture json"))
        })
        .collect()
}

fn events(value: &Value) -> Vec<ThreadEventWithMeta> {
    serde_json::from_value(value.clone()).expect("events")
}

/// The first JSON path where `actual` and `expected` differ.
fn first_difference(path: &str, actual: &Value, expected: &Value) -> Option<String> {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            let mut keys: Vec<&String> = a.keys().chain(e.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                let child = format!("{path}.{key}");
                match (a.get(key), e.get(key)) {
                    (Some(a), Some(e)) => first_difference(&child, a, e),
                    (a, e) => Some(format!("{child}: actual {a:?}, expected {e:?}")),
                }
            })
        }
        (Value::Array(a), Value::Array(e)) => a
            .iter()
            .zip(e)
            .enumerate()
            .find_map(|(index, (a, e))| first_difference(&format!("{path}[{index}]"), a, e))
            .or_else(|| {
                (a.len() != e.len())
                    .then(|| format!("{path}: length {} vs expected {}", a.len(), e.len()))
            }),
        _ if actual == expected => None,
        _ => Some(format!("{path}: actual {actual}, expected {expected}")),
    }
}

#[test]
fn compaction_matches_typescript() {
    let mut failures = Vec::new();
    let all = fixtures();
    assert_eq!(all.len(), 29);
    for (name, fixture) in &all {
        let actual = compact_thread_timeline_summary_events(&events(&fixture["events"]));
        let actual = serde_json::to_value(actual).unwrap();
        if let Some(diff) = first_difference("$", &actual, &fixture["compacted"]) {
            failures.push(format!("{name}: {diff}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn timeline_matches_typescript() {
    let mut failures = Vec::new();
    let mut cases = 0;
    for (name, fixture) in fixtures() {
        let compacted = events(&fixture["compacted"]);
        let context_window_events = events(&fixture["contextWindowEvents"]);
        for (index, result) in fixture["results"].as_array().unwrap().iter().enumerate() {
            cases += 1;
            let options: ThreadTimelineOptions =
                serde_json::from_value(result["options"].clone()).expect("options");
            let projection: Projection = match serde_json::from_value(result["projection"].clone())
            {
                Ok(projection) => projection,
                Err(error) => {
                    failures.push(format!("{name}[{index}]: projection does not load: {error}"));
                    continue;
                }
            };
            let actual = build_thread_timeline_from_projection(
                &projection,
                ThreadTimelineArgs {
                    context_window_events: &context_window_events,
                    head_state_events: &[],
                    events: &compacted,
                    options: &options,
                },
            );
            let actual = serde_json::to_value(actual).unwrap();
            if let Some(diff) = first_difference("$", &actual, &result["expected"]) {
                failures.push(format!("{name}[{index}]: {diff}"));
            }
        }
    }
    assert_eq!(cases, 87);
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn event(seq: i64, event: Value) -> ThreadEventWithMeta {
    serde_json::from_value(json!({
        "event": event,
        "meta": {"id": format!("evt_{seq}"), "seq": seq, "createdAt": 1000 + seq},
    }))
    .unwrap()
}

fn goal_event(seq: i64, payload: Value) -> ThreadEventWithMeta {
    event(
        seq,
        json!({"type": "thread/extensionState/updated", "kind": "provider-codex/goal",
               "scope": {"kind": "thread"}, "threadId": "thr", "payload": payload}),
    )
}

#[test]
fn goal_takes_latest_valid_payload() {
    let goal = json!({"objective": "Ship", "status": "active", "tokenBudget": null,
                      "tokensUsed": 10, "timeUsedSeconds": 2.5, "extra": true});
    let events = vec![
        goal_event(2, goal.clone()),
        goal_event(3, json!({"objective": "Bad", "status": "unknown"})),
    ];
    assert_eq!(
        extract_thread_timeline_goal(&events),
        Some(json!({"sourceSeq": 2, "updatedAt": 1002, "objective": "Ship", "status": "active",
                    "tokenBudget": null, "tokensUsed": 10, "timeUsedSeconds": 2.5}))
    );
    let cleared = vec![goal_event(2, goal), goal_event(4, Value::Null)];
    assert_eq!(extract_thread_timeline_goal(&cleared), None);
    assert_eq!(extract_thread_timeline_goal(&[]), None);
}

#[test]
fn model_fallback_resets_on_new_turn_request() {
    let fallback = event(
        2,
        json!({"type": "provider/modelFallback", "scope": {"kind": "thread"}, "threadId": "thr",
               "originalModel": "big", "fallbackModel": "small", "reason": "overloaded",
               "message": "Switched"}),
    );
    let request = event(3, json!({"type": "client/turn/requested", "threadId": "thr"}));
    assert_eq!(
        extract_thread_timeline_model_fallback(std::slice::from_ref(&fallback)),
        Some(json!({"sourceSeq": 2, "detectedAt": 1002, "originalModel": "big",
                    "fallbackModel": "small", "reason": "overloaded", "message": "Switched"}))
    );
    assert_eq!(extract_thread_timeline_model_fallback(&[fallback, request]), None);
}

#[test]
fn pending_todos_from_latest_plan_steps_when_active() {
    let plan = |seq: i64, steps: Value| {
        event(
            seq,
            json!({"type": "item/completed", "scope": {"kind": "turn", "turnId": "t1"},
                   "threadId": "thr", "item": {"type": "planSteps", "id": "p", "steps": steps}}),
        )
    };
    let long = "x".repeat(300);
    let events = vec![
        plan(2, json!([{"step": "old"}])),
        plan(
            5,
            json!([{"step": "  first  "}, {"step": "   ", "status": "active"},
                   {"step": "second", "status": "active"},
                   {"step": long, "status": "failed"}]),
        ),
    ];
    let expected = json!({"sourceSeq": 5, "updatedAt": 1005, "items": [
        {"id": "seq:5:0", "text": "first", "status": "pending"},
        {"id": "seq:5:2", "text": "second", "status": "in_progress"},
        {"id": "seq:5:3", "text": "x".repeat(240), "status": "completed"},
    ]});
    assert_eq!(extract_thread_timeline_pending_todos("active", &events), Some(expected));
    assert_eq!(extract_thread_timeline_pending_todos("idle", &events), None);
}

#[test]
fn context_window_usage_keeps_matching_snapshot() {
    let usage = |seq: i64, usage: Value| {
        event(
            seq,
            json!({"type": "thread/contextWindowUsage/updated", "scope": {"kind": "thread"},
                   "threadId": "thr", "contextWindowUsage": usage}),
        )
    };
    let events = vec![
        usage(2, json!({"usedTokens": 5, "modelContextWindow": 1000})),
        usage(
            3,
            json!({"usedTokens": 7, "modelContextWindow": 0, "estimated": true,
                   "snapshot": {"usedTokens": 7, "contextWindowTokens": 1000}}),
        ),
    ];
    assert_eq!(
        extract_thread_context_window_usage(&events),
        Some(json!({"snapshot": {"usedTokens": 7, "contextWindowTokens": 1000},
                    "estimated": true, "modelContextWindow": 1000, "usedTokens": 7}))
    );
    assert_eq!(extract_thread_context_window_usage(&events[1..]), None);
}

#[test]
fn compaction_keeps_first_delta_of_completed_messages() {
    let scope = json!({"kind": "turn", "turnId": "t1"});
    let mut events: Vec<ThreadEventWithMeta> = (0..1000)
        .map(|seq| {
            let item = if seq % 2 == 0 { "done" } else { "open" };
            event(
                seq,
                json!({"type": "item/agentMessage/delta", "scope": scope, "threadId": "thr",
                       "itemId": item, "delta": "x"}),
            )
        })
        .collect();
    let completed = json!({"type": "item/completed", "scope": scope, "threadId": "thr",
                           "item": {"type": "agentMessage", "id": "done", "text": "x"}});
    events.push(event(1000, completed));
    let compacted = compact_thread_timeline_summary_events(&events);
    let seqs: Vec<i64> = compacted.iter().map(|entry| entry.meta.seq).collect();
    assert_eq!(compacted.len(), 502);
    assert_eq!(&seqs[..3], &[0, 1, 3]);
    assert_eq!(compact_thread_timeline_summary_events(&events[1..]).len(), 1000);
}

fn timeline_rows(messages: Value, events: &[ThreadEventWithMeta], status: &str) -> Value {
    let entries: Vec<Value> = messages
        .as_array()
        .unwrap()
        .iter()
        .map(|message| json!({"kind": "projected-message", "message": message}))
        .collect();
    let projection: Projection = serde_json::from_value(json!({
        "entries": entries, "activeThinking": null, "activeWorkflows": [],
        "activeBackgroundCommands": [],
    }))
    .unwrap();
    let options: ThreadTimelineOptions = serde_json::from_value(json!({
        "completedTurnDisplay": "collapse", "includeDiagnosticOperations": false,
        "includeNestedRows": false, "isLatestPage": true, "threadStatus": status,
        "threadName": "T", "workspaceRoot": "/ws/",
    }))
    .unwrap();
    let result = build_thread_timeline_from_projection(
        &projection,
        ThreadTimelineArgs {
            context_window_events: &[],
            head_state_events: &[],
            events,
            options: &options,
        },
    );
    serde_json::to_value(result).unwrap()["rows"].clone()
}

fn message(kind: &str, id: &str, fields: Value) -> Value {
    let mut value = json!({"kind": kind, "id": id, "threadId": "thr", "sourceSeqStart": 1,
                           "sourceSeqEnd": 1, "createdAt": 100, "scope": {"kind": "thread"}});
    value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
    value
}

#[test]
fn error_rows_use_category_titles_and_reconnect_progress() {
    let rows = timeline_rows(
        json!([
            message(
                "error",
                "e1",
                json!({"message": "m", "detail": "Rate limited",
                "rawType": "provider/error", "providerErrorInfo": {"category": "rate-limit"}})
            ),
            message(
                "error",
                "e2",
                json!({"message": "x".repeat(81), "detail": null,
                "rawType": "system/error"})
            ),
            message(
                "error",
                "e3",
                json!({"message": "m", "detail": "Reconnecting... 1/5\n why ",
                "rawType": "provider/error", "willRetry": true})
            ),
        ]),
        &[],
        "idle",
    );
    let summary: Vec<Value> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| json!([row["systemKind"], row["title"], row["detail"], row["status"]]))
        .collect();
    assert_eq!(
        summary,
        vec![
            json!(["error", "Provider rate limit reached", "Rate limited", "error"]),
            json!(["error", "System error", "x".repeat(81), "error"]),
            json!(["reconnect", "Reconnecting... 1/5", "why", null]),
        ]
    );
}

#[test]
fn file_edit_rows_relativize_paths_and_show_denied_approvals() {
    let rows = timeline_rows(
        json!([
            message(
                "file-edit",
                "f1",
                json!({"callId": "c1", "changes": [],
                "approvalStatus": "denied", "status": "completed"})
            ),
            message(
                "file-edit",
                "f2",
                json!({"callId": "c2", "approvalStatus": null,
                "status": "completed", "changes": [{"path": "/ws/src/a.rs", "kind": "update",
                "movePath": null, "diff": "@@ -1 +1,2 @@\n-a\n+b\n+c\n"}]})
            ),
        ]),
        &[],
        "idle",
    );
    assert_eq!(rows[0]["workKind"], "approval");
    assert_eq!(rows[0]["lifecycle"], "denied");
    assert_eq!(rows[0]["target"], json!({"itemId": "c1", "toolName": null}));
    assert_eq!(rows[1]["id"], "f2:file-change:0");
    assert_eq!(rows[1]["change"]["path"], "src/a.rs");
    assert_eq!(rows[1]["change"]["diffStats"], json!({"added": 2, "removed": 1}));
}

#[test]
fn pending_steers_become_user_rows_until_rejected() {
    let request = event(
        4,
        json!({"type": "client/turn/requested", "threadId": "thr", "scope": {"kind": "thread"},
               "requestId": "req_1", "initiator": "user",
               "target": {"kind": "turn", "expectedTurnId": "turn_a"},
               "input": [{"type": "text", "text": "hello", "mentions": []}]}),
    );
    let rows = timeline_rows(json!([]), std::slice::from_ref(&request), "active");
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["role"], "user");
    assert_eq!(rows[0]["text"], "hello");
    assert_eq!(rows[0]["turnRequest"]["status"], "pending");
    assert_eq!(rows[0]["turnRequest"]["kind"], "steer");
    let rejected = event(
        5,
        json!({"type": "client/turn/rejected", "threadId": "thr", "scope": {"kind": "thread"},
               "requestId": "req_1"}),
    );
    assert_eq!(timeline_rows(json!([]), &[request, rejected], "active"), json!([]));
}
