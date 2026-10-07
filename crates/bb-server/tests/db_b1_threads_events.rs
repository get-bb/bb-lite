use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bb_server::db::events::{
    EventSource, append_events, is_queue_auto_send_paused, last_system_error_message,
    upsert_search_segment,
};
use bb_server::db::threads::{
    LifecycleOutcome, LifecycleRefusal, NewThread, ThreadRow, ancestry, apply_lifecycle_event,
    get_thread, insert_thread, list_archive_tree, list_child_threads, list_expired_archives,
    list_starting_threads, list_threads_on_host, list_tombstoned_threads, patch_thread,
    reorder_pinned_thread, require_thread, subtree_depth,
};
use bb_server::db::{Db, OnConflict, RowValues, insert_row};
use bb_server::domain::events::{
    ThreadEventScopePolicy, event_parent_tool_call_id, scope_policy, thread_scope, turn_scope,
    validate_thread_event_scope,
};
use bb_server::domain::thread::{ThreadLifecycleEventType as E, ThreadStatus as S};
use bb_server::row;
use serde_json::{Value, json};

fn open() -> (Db, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000));
    let ticks = clock.clone();
    let db =
        Db::open_in_memory(Some(Arc::new(move || ticks.fetch_add(1, Ordering::SeqCst)))).unwrap();
    let at = |values: RowValues| values.set("createdAt", 1).set("updatedAt", 1);
    insert_row(&db, "hosts", &at(row! { "id" => "host_1", "name" => "bee" }), OnConflict::Fail)
        .unwrap();
    insert_row(
        &db,
        "projects",
        &at(row! { "id" => "proj_demo", "name" => "demo" }),
        OnConflict::Fail,
    )
    .unwrap();
    let env = row! {
        "id" => "env_demo", "projectId" => "proj_demo", "hostId" => "host_1",
        "path" => "/work/demo", "status" => "ready",
    };
    insert_row(&db, "environments", &at(env), OnConflict::Fail).unwrap();
    (db, clock)
}

fn seed(db: &Db, id: &str, status: S, extra: RowValues) {
    let mut values = row! {
        "id" => id, "projectId" => "proj_demo", "environmentId" => "env_demo",
        "providerId" => "codex", "status" => status.as_str(), "activeTurnId" => "turn_1",
        "startupContext" => "ctx", "latestAttentionAt" => 5, "createdAt" => 1, "updatedAt" => 1,
    };
    for key in extra.keys() {
        values.put(key, extra.get(key).unwrap().clone());
    }
    insert_row(db, "threads", &values, OnConflict::Fail).unwrap();
}

fn thread(db: &Db, id: &str) -> ThreadRow {
    get_thread(db, id).unwrap().unwrap()
}

#[test]
fn applies_every_lifecycle_transition_and_refuses_the_rest() {
    let applies = [
        (S::Pending, E::RunPreparing, S::Starting),
        (S::Idle, E::RunPreparing, S::Starting),
        (S::Idle, E::RunStarted, S::Active),
        (S::Starting, E::RunStarted, S::Active),
        (S::Starting, E::RunSucceeded, S::Idle),
        (S::Starting, E::RunFailed, S::Error),
        (S::Starting, E::StopRequested, S::Stopping),
        (S::Active, E::RunSucceeded, S::Idle),
        (S::Active, E::RunFailed, S::Error),
        (S::Active, E::StopRequested, S::Stopping),
        (S::Stopping, E::StopSettled, S::Idle),
        (S::Stopping, E::RunSucceeded, S::Idle),
        (S::Stopping, E::RunFailed, S::Error),
        (S::Error, E::RunPreparing, S::Starting),
        (S::Error, E::RunStarted, S::Active),
    ];
    let (db, _) = open();
    let mut index = 0;
    for from in S::ALL {
        for event in E::ALL {
            index += 1;
            let id = format!("thr_{index}");
            seed(&db, &id, from, RowValues::new());
            let outcome = apply_lifecycle_event(&db, &id, event).unwrap();
            let expected = applies.iter().find(|(f, e, _)| *f == from && *e == event);
            match (expected, outcome) {
                (Some((_, _, to)), LifecycleOutcome::Applied { from: was, thread: next }) => {
                    assert_eq!((was, next.status), (from, *to));
                    assert_eq!(thread(&db, &id), *next);
                }
                (None, LifecycleOutcome::NotApplied { reason }) => {
                    assert_eq!(reason, LifecycleRefusal::IllegalTransition);
                    assert_eq!(thread(&db, &id).status, from);
                }
                (expected, outcome) => panic!("{from:?} {event:?}: {expected:?} vs {outcome:?}"),
            }
        }
    }
}

#[test]
fn lifecycle_side_effects_and_supersession() {
    let (db, _) = open();
    seed(&db, "thr_root", S::Active, RowValues::new());
    let LifecycleOutcome::Applied { thread: done, .. } =
        apply_lifecycle_event(&db, "thr_root", E::RunSucceeded).unwrap()
    else {
        panic!("not applied")
    };
    assert_eq!(done.latest_attention_at, done.updated_at);
    assert_eq!((done.active_turn_id.as_deref(), done.startup_context.as_deref()), (None, None));

    seed(&db, "thr_child", S::Active, row! { "parentThreadId" => "thr_root" });
    apply_lifecycle_event(&db, "thr_child", E::RunSucceeded).unwrap();
    assert_eq!(thread(&db, "thr_child").latest_attention_at, 5);

    seed(&db, "thr_stop", S::Active, row! { "environmentId" => () });
    apply_lifecycle_event(&db, "thr_stop", E::StopRequested).unwrap();
    let stopping = thread(&db, "thr_stop");
    assert_eq!(
        (stopping.active_turn_id.as_deref(), stopping.latest_attention_at),
        (Some("turn_1"), 5)
    );
    apply_lifecycle_event(&db, "thr_stop", E::RunSucceeded).unwrap();
    assert_eq!(thread(&db, "thr_stop").startup_context.as_deref(), Some("ctx"));

    seed(&db, "thr_archived", S::Idle, row! { "archivedAt" => 9 });
    let refused = apply_lifecycle_event(&db, "thr_archived", E::RunPreparing).unwrap();
    assert_eq!(refused, LifecycleOutcome::NotApplied { reason: LifecycleRefusal::Superseded });
    seed(&db, "thr_deleted", S::Active, row! { "deletedAt" => 9 });
    let refused = apply_lifecycle_event(&db, "thr_deleted", E::RunFailed).unwrap();
    assert_eq!(refused, LifecycleOutcome::NotApplied { reason: LifecycleRefusal::Superseded });
    let stopped = apply_lifecycle_event(&db, "thr_deleted", E::StopRequested).unwrap();
    assert!(matches!(stopped, LifecycleOutcome::Applied { .. }));
    let missing = apply_lifecycle_event(&db, "thr_none", E::RunFailed).unwrap();
    assert_eq!(missing, LifecycleOutcome::NotApplied { reason: LifecycleRefusal::Missing });
    assert_eq!(require_thread(&db, "thr_deleted").unwrap_err().status, 404);
}

fn data_of(db: &Db, sequence: i64) -> serde_json::Map<String, Value> {
    db.rows("SELECT * FROM events WHERE thread_id = 'thr_1' AND sequence = ?", [sequence])
        .unwrap()
        .remove(0)
}

#[test]
fn appends_events_with_sequences_and_envelope_columns() {
    let (db, _) = open();
    seed(&db, "thr_1", S::Active, RowValues::new());
    let row = thread(&db, "thr_1");
    let item = json!({
        "type": "item/started", "scope": turn_scope("turn_1"), "providerThreadId": "pt_1",
        "item": { "id": "item_1", "type": "commandExecution", "parentToolCallId": "call_1" },
    });
    let error = json!({ "type": "system/error", "scope": thread_scope(), "message": "boom" });
    let stored = append_events(&db, &row, &[item.clone(), error], EventSource::Server).unwrap();
    assert_eq!(stored.len(), 2);
    let later = json!({ "type": "thread/name/updated", "scope": thread_scope(), "itemId": "x" });
    append_events(&db, &row, &[later], EventSource::Server).unwrap();
    let sequences: Vec<i64> = db
        .rows("SELECT sequence FROM events ORDER BY sequence", [])
        .unwrap()
        .iter()
        .map(|row| row["sequence"].as_i64().unwrap())
        .collect();
    assert_eq!(sequences, [1, 2, 3]);

    let first = data_of(&db, 1);
    let columns = ["scopeKind", "turnId", "providerThreadId", "itemId", "itemKind"];
    let values: Vec<&Value> = columns.iter().map(|key| &first[*key]).collect();
    assert_eq!(
        values,
        [
            &json!("turn"),
            &json!("turn_1"),
            &json!("pt_1"),
            &json!("item_1"),
            &json!("commandExecution")
        ]
    );
    assert_eq!(first["parentToolCallId"], "call_1");
    assert_eq!(first["environmentId"], "env_demo");
    let data: Value = serde_json::from_str(first["data"].as_str().unwrap()).unwrap();
    assert_eq!(data, json!({ "providerThreadId": "pt_1", "item": item["item"] }));

    let second = data_of(&db, 2);
    assert_eq!((&second["scopeKind"], &second["turnId"]), (&json!("thread"), &Value::Null));
    assert_eq!((&second["itemId"], &second["parentToolCallId"]), (&Value::Null, &Value::Null));
    assert_eq!(second["data"], r#"{"message":"boom"}"#);
    assert_eq!(data_of(&db, 3)["itemId"], "x");
    assert_eq!(last_system_error_message(&db, "thr_1").unwrap().as_deref(), Some("boom"));
}

#[test]
fn drops_redundant_runner_events_and_prunes_deltas() {
    let (db, _) = open();
    seed(&db, "thr_1", S::Active, RowValues::new());
    let row = thread(&db, "thr_1");
    let turn = turn_scope("turn_1");
    let delta = |text: &str| json!({ "type": "item/agentMessage/delta", "scope": turn, "itemId": "msg_1", "delta": text });
    let completed = json!({
        "type": "item/completed", "scope": turn,
        "item": { "id": "msg_1", "type": "agentMessage", "text": " Hello there " },
    });
    let events = [
        json!({ "type": "thread/tokenUsage/updated", "scope": turn }),
        json!({ "type": "turn/started", "scope": turn }),
        json!({ "type": "turn/started", "scope": turn }),
        json!({ "type": "turn/diff/updated", "scope": turn }),
        json!({ "type": "thread/tokenUsage/updated", "scope": turn }),
        delta("a"),
        delta("b"),
        completed.clone(),
        completed,
    ];
    let stored = append_events(&db, &row, &events, EventSource::Runner).unwrap();
    let kinds: Vec<&str> = stored.iter().map(|event| event["type"].as_str().unwrap()).collect();
    let expected = ["turn/started", "thread/tokenUsage/updated", "item/agentMessage/delta"];
    assert_eq!(kinds[..3], expected);
    assert_eq!(kinds.len(), 5);
    let deltas: i64 = db
        .scalar("SELECT COUNT(*) FROM events WHERE type = 'item/agentMessage/delta'", [])
        .unwrap()
        .unwrap();
    assert_eq!(deltas, 1);
    let text: String = db
        .scalar(
            "SELECT text FROM thread_search_segments WHERE source_kind = 'assistant_message'",
            [],
        )
        .unwrap()
        .unwrap();
    assert_eq!(text, "Hello there");
    let server = [json!({ "type": "turn/diff/updated", "scope": turn })];
    assert_eq!(append_events(&db, &row, &server, EventSource::Server).unwrap().len(), 1);
}

#[test]
fn records_turn_requests_and_pauses_the_queue() {
    let (db, _) = open();
    seed(&db, "thr_1", S::Idle, row! { "lastReadAt" => 1 });
    let row = thread(&db, "thr_1");
    let request = |initiator: &str, kind: &str| {
        json!({
            "type": "client/turn/requested", "scope": thread_scope(), "initiator": initiator,
            "target": { "kind": kind },
            "input": [
                { "type": "text", "text": "fix it" },
                { "type": "text", "text": "secret", "visibility": "agent-only" },
            ],
        })
    };
    let stop = json!({ "type": "system/thread/interrupted", "scope": thread_scope(), "reason": "manual-stop" });
    append_events(&db, &row, &[request("user", "thread-start"), stop], EventSource::Server)
        .unwrap();
    assert!(is_queue_auto_send_paused(&db, "thr_1").unwrap());
    append_events(&db, &row, &[request("agent", "turn")], EventSource::Server).unwrap();
    assert!(!is_queue_auto_send_paused(&db, "thr_1").unwrap());

    let history = db.rows("SELECT * FROM prompt_history_entries", []).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        (&history[0]["scope"], &history[0]["requestSequence"]),
        (&json!("project"), &json!(1))
    );
    assert_eq!(history[0]["input"], r#"[{"type":"text","text":"fix it"}]"#);
    assert!(thread(&db, "thr_1").last_read_at.unwrap() > 1);
    let texts = db.rows("SELECT text FROM thread_search_segments ORDER BY source_seq", []).unwrap();
    assert_eq!(texts.len(), 2);
    assert_eq!(texts[0]["text"], "fix it");
    upsert_search_segment(&db, "thr_1", "user_message", "event:1", Some(1), Some("  ")).unwrap();
    assert_eq!(db.rows("SELECT 1 FROM thread_search_segments", []).unwrap().len(), 1);
}

#[test]
fn orders_pinned_threads() {
    let (db, _) = open();
    let new = |pinned| NewThread {
        project_id: "proj_demo".into(),
        provider_id: "codex".into(),
        title: Some("Title".into()),
        pinned,
        ..NewThread::default()
    };
    let first = insert_thread(&db, new(true)).unwrap();
    let second = insert_thread(&db, new(true)).unwrap();
    let loose = insert_thread(&db, new(false)).unwrap();
    assert_eq!(first.status, S::Pending);
    let (a, b) = (first.pin_sort_key.clone().unwrap(), second.pin_sort_key.clone().unwrap());
    assert_eq!(a, "U");
    assert!(b < a);
    reorder_pinned_thread(&db, &second.id, Some(&first.id), None).unwrap();
    assert!(thread(&db, &second.id).pin_sort_key.unwrap() > a);

    let error = reorder_pinned_thread(&db, &loose.id, None, None).unwrap_err();
    assert_eq!((error.status, error.body.message.as_str()), (409, "Thread is not pinned"));
    let error = reorder_pinned_thread(&db, &first.id, Some(&first.id), None).unwrap_err();
    assert_eq!(error.body.message, "Pinned order changed");
    let error =
        reorder_pinned_thread(&db, &first.id, Some(&second.id), Some(&first.id)).unwrap_err();
    assert_eq!(error.body.message, "Pinned order changed");

    let titles =
        db.rows("SELECT * FROM thread_search_segments WHERE thread_id = ?", [&first.id]).unwrap();
    assert_eq!(titles.len(), 1);
    patch_thread(&db, &first.id, &row! { "title" => () }, true).unwrap();
    let titles =
        db.rows("SELECT * FROM thread_search_segments WHERE thread_id = ?", [&first.id]).unwrap();
    assert!(titles.is_empty());
}

#[test]
fn walks_the_thread_hierarchy() {
    let (db, _) = open();
    seed(&db, "thr_a", S::Idle, RowValues::new());
    seed(&db, "thr_b", S::Idle, row! { "parentThreadId" => "thr_a" });
    seed(&db, "thr_c", S::Idle, row! { "parentThreadId" => "thr_b" });
    seed(&db, "thr_d", S::Idle, row! { "parentThreadId" => "thr_a", "deletedAt" => 3 });
    seed(
        &db,
        "thr_e",
        S::Starting,
        row! { "lifecycleOwnerThreadId" => "thr_a", "archivedAt" => 2 },
    );
    let root = thread(&db, "thr_a");
    assert_eq!(subtree_depth(&db, &root).unwrap(), 3);
    assert_eq!(ancestry(&db, &thread(&db, "thr_c")).unwrap(), ["thr_c", "thr_b", "thr_a"]);
    assert_eq!(list_child_threads(&db, "thr_a").unwrap().len(), 1);
    let tree: Vec<String> =
        list_archive_tree(&db, &root).unwrap().into_iter().map(|row| row.thread.id).collect();
    assert_eq!(tree, ["thr_e", "thr_c", "thr_b", "thr_a"]);
    let ids = |rows: Vec<ThreadRow>| rows.into_iter().map(|row| row.thread.id).collect::<Vec<_>>();
    assert_eq!(ids(list_starting_threads(&db).unwrap()), ["thr_e"]);
    assert_eq!(ids(list_tombstoned_threads(&db).unwrap()), ["thr_d"]);
    assert_eq!(ids(list_expired_archives(&db, 2).unwrap()), ["thr_e"]);
    assert!(list_expired_archives(&db, 1).unwrap().is_empty());
    assert_eq!(list_threads_on_host(&db, "host_1", &[S::Idle]).unwrap().len(), 3);
    assert_eq!(list_threads_on_host(&db, "host_1", &[S::Starting, S::Active]).unwrap().len(), 1);
}

#[test]
fn reads_event_scope_policies() {
    assert_eq!(scope_policy("item/started"), Some(ThreadEventScopePolicy::Turn));
    assert_eq!(scope_policy("system/error"), Some(ThreadEventScopePolicy::ThreadOrTurn));
    assert!(validate_thread_event_scope("system/error", &turn_scope("t")).is_ok());
    let message = validate_thread_event_scope("turn/started", &thread_scope()).unwrap_err();
    assert_eq!(message, "turn/started requires turn scope but received thread scope");
    let nested = json!({ "item": { "parentToolCallId": null }, "parentToolCallId": "call_2" });
    assert_eq!(event_parent_tool_call_id(&nested), Some("call_2"));
    assert_eq!(event_parent_tool_call_id(&json!({ "parentToolCallId": "" })), None);
}
