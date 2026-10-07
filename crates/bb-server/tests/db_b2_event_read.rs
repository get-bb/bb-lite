use bb_server::db::Db;
use bb_server::db::event_read::*;
use serde_json::{Map, Value, json};

const CLAUDE_APPROVAL: &str =
    include_str!("../../../packages/runner/test/fixtures/claude/approval-allow.events.json");

fn open() -> Db {
    let db = Db::open_in_memory(None).unwrap();
    db.run(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_demo', 'demo', 1000, 1000)",
        [],
    )
    .unwrap();
    db
}

fn seed_thread(db: &Db, id: &str) {
    db.run(
        "INSERT INTO threads (id, project_id, provider_id, title, status, latest_attention_at, created_at, updated_at)
         VALUES (?, 'proj_demo', 'codex', 'Thread', 'idle', 1000, 1000, 1000)",
        [id],
    )
    .unwrap();
}

fn append(db: &Db, thread_id: &str, event_type: &str, turn_id: Option<&str>, data: Value) -> i64 {
    let sequence = latest_sequence(db, thread_id).unwrap() + 1;
    let item = data.get("item");
    let item_id =
        item.and_then(|item| item.get("id")).or_else(|| data.get("itemId")).and_then(Value::as_str);
    let item_kind = item.and_then(|item| item.get("type")).and_then(Value::as_str);
    let parent = item
        .and_then(|item| item.get("parentToolCallId"))
        .or_else(|| data.get("parentToolCallId"))
        .and_then(Value::as_str);
    let provider = data.get("providerThreadId").and_then(Value::as_str);
    db.run(
        "INSERT INTO events (id, thread_id, scope_kind, turn_id, provider_thread_id, sequence,
           type, item_id, item_kind, parent_tool_call_id, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            format!("evt_{thread_id}_{sequence}"),
            thread_id,
            if turn_id.is_some() { "turn" } else { "thread" },
            turn_id,
            provider,
            sequence,
            event_type,
            item_id,
            item_kind,
            parent,
            data.to_string(),
            1000 + sequence,
        ],
    )
    .unwrap();
    sequence
}

fn load_fixture(db: &Db, thread_id: &str) -> Vec<Value> {
    let events: Vec<Value> = serde_json::from_str(CLAUDE_APPROVAL).unwrap();
    for event in &events {
        let mut data: Map<String, Value> = event.as_object().unwrap().clone();
        let event_type = data.shift_remove("type").unwrap();
        let scope = data.shift_remove("scope").unwrap();
        let turn_id = scope.get("turnId").and_then(Value::as_str);
        append(db, thread_id, event_type.as_str().unwrap(), turn_id, Value::Object(data));
    }
    events
}

fn types(rows: &[StoredEventRow]) -> Vec<&str> {
    rows.iter().map(|row| row.event_type.as_str()).collect()
}

#[test]
fn fixture_rows_decode_to_the_original_events() {
    let db = open();
    seed_thread(&db, "thr_a");
    let events = load_fixture(&db, "thr_a");
    let rows = list_events(&db, &EventQuery::new("thr_a")).unwrap();
    assert_eq!(rows.len(), events.len());
    assert_eq!(latest_sequence(&db, "thr_a").unwrap(), events.len() as i64);
    assert_eq!(latest_sequence(&db, "missing").unwrap(), 0);
    let decoded = decode_events(&db, &rows);
    for (decoded, original) in decoded.iter().zip(&events) {
        let mut expected = original.as_object().unwrap().clone();
        expected.insert("threadId".into(), json!("thr_a"));
        let mut actual = decoded.event.as_object().unwrap().clone();
        expected.sort_keys();
        actual.sort_keys();
        assert_eq!(actual, expected);
    }
    assert_eq!(decoded[0].meta, EventMeta { id: "evt_thr_a_1".into(), seq: 1, created_at: 1001 });
    let again = decode_events(&db, &rows);
    assert_eq!(again, decoded);
}

#[test]
fn list_events_applies_every_query_option() {
    let db = open();
    seed_thread(&db, "thr_q");
    load_fixture(&db, "thr_q");
    let all = list_events(&db, &EventQuery::new("thr_q")).unwrap();
    let count = all.len() as i64;

    let window = EventQuery { after: Some(2), before: Some(5), ..EventQuery::new("thr_q") };
    let seqs: Vec<i64> = list_events(&db, &window).unwrap().iter().map(|r| r.sequence).collect();
    assert_eq!(seqs, vec![3, 4]);

    let typed = EventQuery {
        types: Some(vec!["turn/started".into(), "turn/completed".into()]),
        ..EventQuery::new("thr_q")
    };
    assert_eq!(types(&list_events(&db, &typed).unwrap()), vec!["turn/started", "turn/completed"]);
    let single =
        EventQuery { types: Some(vec!["turn/started".into()]), ..EventQuery::new("thr_q") };
    assert_eq!(list_events(&db, &single).unwrap().len(), 1);

    let turn_id = all.iter().find_map(|row| row.turn_id.clone()).unwrap();
    let by_turn = EventQuery { turn_ids: Some(vec![turn_id.clone()]), ..EventQuery::new("thr_q") };
    let turn_rows = list_events(&db, &by_turn).unwrap();
    assert!(turn_rows.iter().all(|row| row.turn_id.as_deref() == Some(&turn_id)));
    assert_eq!(list_turn_ids(&db, &EventQuery::new("thr_q")).unwrap(), vec![turn_id.clone()]);

    let item_id = all
        .iter()
        .find(|row| row.event_type == "item/started")
        .and_then(|row| row.item_id.clone())
        .unwrap();
    let started =
        EventQuery { started_item_ids: Some(vec![item_id.clone()]), ..EventQuery::new("thr_q") };
    assert_eq!(types(&list_events(&db, &started).unwrap()), vec!["item/started", "item/completed"]);

    let timeline = EventQuery {
        timeline: Some(TimelineFilter { exclude_diagnostics: true, horizon: None }),
        ..EventQuery::new("thr_q")
    };
    let visible = list_events(&db, &timeline).unwrap();
    assert!(
        visible
            .iter()
            .all(|row| !THREAD_TIMELINE_EXCLUDED_EVENT_TYPES.contains(&row.event_type.as_str()))
    );
    assert!(visible.len() < all.len());

    let desc = EventQuery {
        order: Some(SortOrder::Desc),
        limit: Some(2),
        offset: Some(1),
        ..EventQuery::new("thr_q")
    };
    let seqs: Vec<i64> = list_events(&db, &desc).unwrap().iter().map(|r| r.sequence).collect();
    assert_eq!(seqs, vec![count - 1, count - 2]);

    let filtered = EventQuery {
        where_sql: Some("item_kind = 'agentMessage'".into()),
        ..EventQuery::new("thr_q")
    };
    assert!(
        list_events(&db, &filtered)
            .unwrap()
            .iter()
            .all(|r| r.item_kind.as_deref() == Some("agentMessage"))
    );

    let req = append(&db, "thr_q", "client/turn/requested", None, json!({ "requestId": "req_1" }));
    append(
        &db,
        "thr_q",
        "client/turn/requested",
        None,
        json!({ "clientRequestId": "req_2", "requestId": "x" }),
    );
    let by_request = EventQuery {
        request_ids: Some(vec!["req_1".into(), "req_2".into()]),
        ..EventQuery::new("thr_q")
    };
    let seqs: Vec<i64> =
        list_events(&db, &by_request).unwrap().iter().map(|r| r.sequence).collect();
    assert_eq!(seqs, vec![req, req + 1]);

    let parent = append(
        &db,
        "thr_q",
        "item/completed",
        Some(&turn_id),
        json!({ "item": { "type": "agentMessage", "id": "child", "text": "x", "parentToolCallId": "tool_1" } }),
    );
    let parented = EventQuery {
        parent_tool_call_ids: Some(vec!["tool_1".into()]),
        ..EventQuery::new("thr_q")
    };
    assert_eq!(list_events(&db, &parented).unwrap()[0].sequence, parent);
}

#[test]
fn inline_outputs_truncate_long_results() {
    let db = open();
    seed_thread(&db, "thr_i");
    let long = "a".repeat(40_000);
    append(
        &db,
        "thr_i",
        "item/completed",
        Some("turn_1"),
        json!({ "item": { "type": "commandExecution", "id": "cmd", "aggregatedOutput": long } }),
    );
    let inline = EventQuery { outputs: Some(EventOutputs::Inline), ..EventQuery::new("thr_i") };
    let row = &list_events(&db, &inline).unwrap()[0];
    let data: Value = serde_json::from_str(&row.data).unwrap();
    let output = data["item"]["aggregatedOutput"].as_str().unwrap();
    assert!(output.ends_with("\n…[8,000 more characters truncated]"));
    let full = &list_events(&db, &EventQuery::new("thr_i")).unwrap()[0];
    assert!(full.data.len() > 40_000);
}

#[test]
fn last_output_and_latest_item_states() {
    let db = open();
    seed_thread(&db, "thr_o");
    assert_eq!(last_output(&db, "thr_o").unwrap(), None);
    let message =
        |text: &str| json!({ "item": { "type": "agentMessage", "id": "m", "text": text } });
    append(&db, "thr_o", "item/completed", Some("t1"), message("first"));
    append(&db, "thr_o", "item/completed", Some("t1"), message("second"));
    append(&db, "thr_o", "item/completed", Some("t1"), message(""));
    assert_eq!(last_output(&db, "thr_o").unwrap().as_deref(), Some("second"));

    let task = |status: &str, task_type: &str| json!({ "item": { "type": "backgroundTask", "id": "bg", "status": status, "taskType": task_type } });
    append(&db, "thr_o", "item/started", Some("t1"), task("pending", "local_bash"));
    let progress = append(
        &db,
        "thr_o",
        "item/backgroundTask/progress",
        Some("t1"),
        task("pending", "local_bash"),
    );
    let later = append(
        &db,
        "thr_o",
        "item/backgroundTask/progress",
        Some("t1"),
        task("pending", "local_bash"),
    );
    let states = list_latest_item_states(&db, "thr_o", &["bg".into()], later).unwrap();
    assert_eq!(states.iter().map(|r| r.sequence).collect::<Vec<_>>(), vec![progress]);
    let open = list_open_background_task_states(&db, "thr_o").unwrap();
    assert_eq!(open.iter().map(|r| r.sequence).collect::<Vec<_>>(), vec![later]);

    let ids = vec!["thr_o".to_string()];
    let counts = active_background_task_counts(&db, &ids).unwrap();
    assert_eq!(
        counts,
        vec![BackgroundTaskCounts {
            thread_id: "thr_o".into(),
            active_workflow_count: 0,
            active_background_agent_count: 0,
            active_background_command_count: 1,
        }]
    );
    append(
        &db,
        "thr_o",
        "item/backgroundTask/completed",
        Some("t1"),
        task("completed", "local_bash"),
    );
    assert!(active_background_task_counts(&db, &ids).unwrap().is_empty());
    assert!(list_open_background_task_states(&db, "thr_o").unwrap().is_empty());
}

#[test]
fn context_clear_head_state_and_context_usage() {
    let db = open();
    seed_thread(&db, "thr_c");
    let clear = |status: &str| json!({ "operation": "context_clear", "status": status });
    let done = append(&db, "thr_c", "system/operation", None, clear("completed"));
    append(&db, "thr_c", "system/operation", None, clear("started"));
    assert_eq!(context_clear_sequence(&db, "thr_c", 10).unwrap(), Some(done));
    assert_eq!(context_clear_sequence(&db, "thr_c", done - 1).unwrap(), None);

    append(&db, "thr_c", "turn/plan/updated", Some("t1"), json!({ "plan": [] }));
    let goal = append(&db, "thr_c", "thread/goal/updated", None, json!({ "objective": "ship" }));
    let heads = list_head_state_events(&db, &["thr_c".into()], HeadState::Goal).unwrap();
    assert_eq!(heads[0].sequence, goal);
    assert_eq!(list_head_state_events(&db, &["thr_c".into()], HeadState::Todos).unwrap().len(), 1);

    let usage = |size: Value| json!({ "contextWindowUsage": { "usedTokens": 5, "modelContextWindow": size } });
    let sized = append(&db, "thr_c", "thread/contextWindowUsage/updated", None, usage(json!(1000)));
    let unsized_ =
        append(&db, "thr_c", "thread/contextWindowUsage/updated", None, usage(Value::Null));
    let rows = list_context_window_usage_events(&db, "thr_c", 1).unwrap();
    assert_eq!(rows.iter().map(|r| r.sequence).collect::<Vec<_>>(), vec![sized, unsized_]);
}

#[test]
fn ordering_context_and_parented_boundary() {
    let db = open();
    seed_thread(&db, "thr_p");
    append(&db, "thr_p", "turn/started", Some("t1"), json!({}));
    append(
        &db,
        "thr_p",
        "item/started",
        Some("t1"),
        json!({ "item": { "type": "toolCall", "id": "tool", "tool": "x", "status": "pending", "presentation": {} } }),
    );
    let request = json!({
        "requestId": "r1", "initiator": "user",
        "input": [{ "type": "text", "text": "hi" }],
    });
    let boundary = append(&db, "thr_p", "client/turn/requested", None, request);
    append(
        &db,
        "thr_p",
        "item/completed",
        Some("t1"),
        json!({ "item": { "type": "agentMessage", "id": "c", "text": "x", "parentToolCallId": "tool" } }),
    );
    let context = list_ordering_context(&db, "thr_p", 1, 100).unwrap();
    assert_eq!(context.len(), 2);
    assert_eq!(context[1].request_id.as_deref(), Some("r1"));
    assert_eq!(context[1].has_input, 1);
    assert_eq!(first_parented_boundary(&db, "thr_p", 1, 100).unwrap(), Some(boundary));
    assert_eq!(first_parented_boundary(&db, "thr_p", 1, 2).unwrap(), None);
}

fn row(event_type: &str, turn_id: Option<&str>, data: Value) -> StoredEventRow {
    StoredEventRow {
        id: "evt".into(),
        thread_id: "thr".into(),
        scope_kind: if turn_id.is_some() { "turn" } else { "thread" }.into(),
        turn_id: turn_id.map(str::to_string),
        provider_thread_id: Some("prov".into()),
        sequence: 3,
        event_type: event_type.into(),
        item_id: None,
        item_kind: None,
        parent_tool_call_id: None,
        data: data.to_string(),
        created_at: 9,
    }
}

#[test]
fn merge_event_rows_dedupes_and_sorts() {
    let mut a = row("turn/started", Some("t"), json!({}));
    a.sequence = 5;
    let mut b = a.clone();
    b.id = "other".into();
    b.sequence = 2;
    let merged = merge_event_rows(vec![a.clone(), b.clone(), a.clone()]);
    assert_eq!(merged, vec![b, a]);
}

#[test]
fn decodes_turn_and_thread_scoped_events() {
    let turn = decode_event(&row(
        "item/completed",
        Some("t1"),
        json!({ "item": { "type": "agentMessage", "id": "m", "text": "hi" }, "scope": "stale", "turnId": "x", "extra": 1 }),
    ));
    assert_eq!(
        turn,
        json!({
            "item": { "type": "agentMessage", "id": "m", "text": "hi" },
            "extra": 1,
            "providerThreadId": "prov",
            "scope": { "kind": "turn", "turnId": "t1" },
            "threadId": "thr",
            "type": "item/completed",
        })
    );
    let thread = decode_event(&row("thread/goal/cleared", None, json!({})));
    assert_eq!(thread["type"], "thread/extensionState/updated");
    assert_eq!(thread["kind"], "provider-codex/goal");
    assert_eq!(thread["payload"], Value::Null);
    assert_eq!(thread["scope"], json!({ "kind": "thread" }));

    let table = to_thread_event_row(&row("thread/goal/cleared", None, json!({})));
    assert_eq!(table.event_type, "thread/extensionState/updated");
    assert!(!table.data.contains_key("scope") && table.data.contains_key("providerThreadId"));
    assert!(decode_event(&row("x/unknown", None, json!("not an object"))).is_object());
}

#[test]
fn decodes_legacy_shapes_and_turn_request_defaults() {
    let read = decode_event(&row(
        "item/started",
        Some("t1"),
        json!({ "item": { "type": "toolCall", "id": "r", "tool": "mcp:Read", "status": "pending",
            "arguments": { "file_path": "/a.txt" } } }),
    ));
    assert_eq!(
        read["item"],
        json!({ "type": "fileRead", "id": "r", "status": "pending", "path": "/a.txt",
            "cmd": "mcp:Read { file_path: /a.txt }" })
    );
    let plan = decode_event(&row(
        "turn/plan/updated",
        Some("t1"),
        json!({ "plan": [{ "step": "a", "status": "completed" }], "explanation": "why" }),
    ));
    assert_eq!(plan["type"], "item/completed");
    assert_eq!(plan["item"]["type"], "planSteps");
    assert_eq!(plan["item"]["explanation"], "why");
    assert_eq!(plan["item"]["id"], "legacy-plan:t1:9fkhjx");
    let empty = decode_event(&row("turn/plan/updated", None, json!({})));
    assert_eq!(empty["item"]["id"], "legacy-plan:thread:1wxqr7i");

    let request = decode_event(&row(
        "client/turn/requested",
        None,
        json!({ "requestId": "r", "input": [{ "type": "text", "text": "hi" },
            { "type": "text", "text": "x", "mentions": [{ "start": 0, "end": 1,
              "resource": { "kind": "folder", "folderId": "f1", "label": "F" } }] }] }),
    ));
    assert_eq!(request["senderThreadId"], Value::Null);
    assert_eq!(request["target"], json!({ "kind": "new-turn" }));
    assert_eq!(request["systemMessageKind"], "unlabeled");
    assert_eq!(request["systemMessageSubject"], Value::Null);
    assert_eq!(request["input"][0]["mentions"], json!([]));
    assert_eq!(
        request["input"][1]["mentions"][0]["resource"],
        json!({ "kind": "section", "label": "F", "sectionId": "f1" })
    );
}

#[test]
fn recent_cache_keeps_the_newest_entries() {
    let cache = RecentCache::new(2);
    remember_recent(&cache, "a", 1);
    remember_recent(&cache, "b", 2);
    remember_recent(&cache, "a", 3);
    remember_recent(&cache, "c", 4);
    assert_eq!(cache.get("a"), Some(3));
    assert_eq!(cache.get("b"), None);
    assert_eq!(cache.get("c"), Some(4));
    assert_eq!(cache.len(), 2);
}
