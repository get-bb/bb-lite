mod engine_dispatch_support;

use bb_core::{RunnerError, RunnerErrorCode};
use bb_server::db::queued_messages::parse_queued_wait;
use bb_server::domain::queued_message::QueuedMessageWaitingOn as Wait;
use bb_server::domain::thread::ThreadStatus;
use bb_server::threads::dispatch::{
    Delivery, SendMode, attributed_message, dispatch_message, drain_queue, send_queued_message_now,
};
use bb_server::threads::mutations::SendQueuedMessageMode;
use bb_server::threads::tool_calls::{ToolCallEvent, cancel_tool_call, start_tool_call};
use engine_dispatch_support::*;
use serde_json::{Value, json};

async fn queued_wait(world: &World, mode: SendMode) -> Wait {
    let delivery = dispatch_message(&world.ctx, "thr_1", args(mode, "hi")).await.unwrap();
    let Delivery::Queued { row } = delivery else { panic!("expected a queued row") };
    assert_eq!(world.queue("thr_1"), std::slice::from_ref(&row));
    assert!(world.calls("submitTurn").is_empty());
    parse_queued_wait(&row).unwrap().unwrap()
}

#[tokio::test]
async fn records_each_wait_kind() {
    let world = World::new();
    world.ready_thread("thr_1", "idle", None);
    let mut timed = args(SendMode::Auto, "later");
    timed.send_at = Some(NOW + 60_000);
    let delivery = dispatch_message(&world.ctx, "thr_1", timed).await.unwrap();
    let Delivery::Queued { row } = delivery else { panic!("expected a queued row") };
    assert_eq!(row.waiting_on.as_deref(), Some(r#"{"kind":"time"}"#));
    assert_eq!(row.send_at, Some(NOW + 60_000));

    let cases: &[(&str, Option<&str>, SendMode, Wait)] = &[
        ("stopping", Some("turn_1"), SendMode::Auto, Wait::Stopping),
        ("active", Some("turn_1"), SendMode::QueueIfActive, Wait::ThreadBusy),
        ("active", None, SendMode::Auto, Wait::TurnStarting),
        ("active", None, SendMode::SteerIfActive, Wait::TurnStarting),
        ("starting", None, SendMode::Auto, Wait::Provisioning),
    ];
    for (status, turn, mode, expected) in cases {
        let world = World::new();
        world.ready_thread("thr_1", status, *turn);
        assert_eq!(&queued_wait(&world, *mode).await, expected, "{status} {mode:?}");
    }

    let world = World::new();
    world.environment("env_b", "host_b", "ready", Some("/work"));
    world.thread("thr_1", Some("env_b"), "idle", None);
    let wait = queued_wait(&world, SendMode::Auto).await;
    assert_eq!(wait, Wait::HostOffline { host_name: "Laptop B".into() });

    let world = World::new();
    world.ready_thread("thr_1", "idle", None);
    world.interaction("thr_1");
    assert_eq!(queued_wait(&world, SendMode::Auto).await, Wait::Interaction);
}

#[tokio::test]
async fn refuses_start_on_an_active_thread_and_steer_on_an_errored_one() {
    let world = World::new();
    world.ready_thread("thr_1", "active", Some("turn_1"));
    let error =
        dispatch_message(&world.ctx, "thr_1", args(SendMode::Start, "x")).await.unwrap_err();
    assert_eq!(
        (error.code(), error.to_string().as_str()),
        ("thread_not_writable", "Thread is already active")
    );
    let world = World::new();
    world.ready_thread("thr_1", "error", None);
    let error =
        dispatch_message(&world.ctx, "thr_1", args(SendMode::Steer, "x")).await.unwrap_err();
    assert_eq!(error.to_string(), "Thread is not active");
}

#[tokio::test]
async fn re_recording_a_wait_keeps_the_row_and_relabels_on_change() {
    let world = World::new();
    world.ready_thread("thr_1", "active", None);
    let Delivery::Queued { row } =
        dispatch_message(&world.ctx, "thr_1", args(SendMode::Auto, "a")).await.unwrap()
    else {
        panic!("expected a queued row")
    };
    let mut again = args(SendMode::Auto, "a");
    again.rows = vec![row.clone()];
    let same = dispatch_message(&world.ctx, "thr_1", again.clone()).await.unwrap();
    assert_eq!(same, Delivery::Queued { row: row.clone() });
    again.mode = SendMode::QueueIfActive;
    world.ctx.db.run("UPDATE threads SET active_turn_id = 'turn_1'", []).unwrap();
    let Delivery::Queued { row: moved } =
        dispatch_message(&world.ctx, "thr_1", again).await.unwrap()
    else {
        panic!("expected a queued row")
    };
    assert_eq!(
        (moved.id.as_str(), moved.waiting_on.as_deref()),
        (row.id.as_str(), Some(r#"{"kind":"thread-busy"}"#))
    );
    assert_eq!(world.queue("thr_1").len(), 1);
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn starts_a_turn_on_an_idle_thread_and_consumes_the_row() {
    let world = World::new();
    world.ready_thread("thr_1", "idle", None);
    let mut first = args(SendMode::QueueIfActive, "hello");
    first.send_at = Some(NOW + 1);
    let Delivery::Queued { row } = dispatch_message(&world.ctx, "thr_1", first).await.unwrap()
    else {
        panic!("expected a queued row")
    };
    let mut send = args(SendMode::Auto, "hello");
    send.rows = vec![row];
    assert_eq!(dispatch_message(&world.ctx, "thr_1", send).await.unwrap(), Delivery::Sent);
    assert!(world.queue("thr_1").is_empty());
    assert_eq!(world.get("thr_1").status, ThreadStatus::Active);
    let events = world.events("thr_1");
    let request = events.iter().find(|event| event["type"] == "client/turn/requested").unwrap();
    assert_eq!(request["type"], "client/turn/requested");
    assert_eq!(request["target"], json!({ "kind": "new-turn" }));
    assert_eq!((&request["source"], &request["initiator"]), (&json!("tell"), &json!("user")));
    assert_eq!(request["request"], json!({ "method": "turn/start", "params": {} }));
    assert_eq!(request["execution"]["source"], "client/turn/requested");
    world.settled().await;
    let submits = world.calls("submitTurn");
    assert_eq!(submits.len(), 1);
    let submit = &submits[0];
    assert_eq!(submit["mode"], json!({ "kind": "start" }));
    assert_eq!(submit["clientRequestId"], request["requestId"]);
    assert_eq!(submit["input"], json!([text("hello")]));
    assert!(submit["session"].is_object());
    assert_eq!(world.get("thr_1").provider_thread_id.as_deref(), Some("pt_1"));
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn joins_an_active_turn_by_steering_or_auto() {
    for (mode, kind) in
        [(SendMode::Steer, "steer"), (SendMode::SteerIfActive, "steer"), (SendMode::Auto, "auto")]
    {
        let world = World::new();
        world.ready_thread("thr_1", "active", Some("turn_1"));
        assert_eq!(
            dispatch_message(&world.ctx, "thr_1", args(mode, "more")).await.unwrap(),
            Delivery::Sent
        );
        let request = world.events("thr_1").pop().unwrap();
        assert_eq!(request["target"], json!({ "kind": kind, "expectedTurnId": "turn_1" }));
        world.settled().await;
        let submit = world.calls("submitTurn").pop().unwrap();
        let expected = if kind == "steer" {
            json!({ "kind": "steer", "expectedTurnId": "turn_1" })
        } else {
            json!({ "kind": "auto" })
        };
        assert_eq!(submit["mode"], expected);
        assert_eq!(world.get("thr_1").status, ThreadStatus::Active);
    }
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn a_rejected_steer_appends_the_rejection_without_failing_the_thread() {
    let world = World::new();
    world.ready_thread("thr_1", "active", Some("turn_1"));
    world.answer(Box::new(|method, params| match method {
        "submitTurn" => Err(RunnerError::new(RunnerErrorCode::StaleTurn, "Turn moved on")),
        _ => standard(method, params),
    }));
    dispatch_message(&world.ctx, "thr_1", args(SendMode::Steer, "more")).await.unwrap();
    world.settled().await;
    let rejected = world.events("thr_1").pop().unwrap();
    assert_eq!(rejected["type"], "client/turn/rejected");
    assert_eq!(
        (&rejected["reason"], &rejected["message"]),
        (&json!("stale_turn"), &json!("Turn moved on"))
    );
    assert_eq!(world.get("thr_1").status, ThreadStatus::Active);
}

#[tokio::test]
async fn attributes_messages_from_another_thread() {
    let mut sent = message(vec![
        json!({ "type": "text", "text": "@x hi", "mentions": [{ "start": 0, "end": 2 }] }),
    ]);
    sent.sender_thread_id = Some("thr_9".into());
    let prefix = "[bb message from thread:thr_9]\n\n";
    let input = attributed_message(&sent).input;
    assert_eq!(input[0]["text"], format!("{prefix}@x hi"));
    assert_eq!(input[0]["mentions"][0]["start"], prefix.len());
    sent.input = vec![json!({ "type": "image", "path": "/a.png" })];
    let input = attributed_message(&sent).input;
    assert_eq!(input[0], text(prefix));
}

fn insert_row(world: &World, id: &str, wait: Option<&str>, send_at: Option<i64>, key: &str) {
    let sql = "INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level,
      permission_mode, service_tier, waiting_on, send_at, sort_key, created_at, updated_at)
      VALUES (?, 'thr_1', ?, 'echo-1', 'medium', 'full', 'default', ?, ?, ?, 1, 1)";
    let content = json!([text(id)]).to_string();
    let params = bb_server::db::params![id, content, wait, send_at, key];
    world.ctx.db.run(sql, params).unwrap();
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn drains_the_first_eligible_row_and_records_failures() {
    let world = World::new();
    world.ready_thread("thr_1", "idle", None);
    insert_row(&world, "q_time", Some(r#"{"kind":"time"}"#), Some(NOW + 5_000), "a");
    insert_row(&world, "q_prov", Some(r#"{"kind":"provisioning"}"#), None, "b");
    insert_row(&world, "q_busy", Some(r#"{"kind":"thread-busy"}"#), None, "c");
    insert_row(&world, "q_next", None, None, "d");
    drain_queue(&world.ctx, "thr_1").await.unwrap();
    let left: Vec<String> = world.queue("thr_1").into_iter().map(|row| row.id).collect();
    assert_eq!(left, ["q_time", "q_prov", "q_next"]);
    let request = world.events("thr_1").pop().unwrap();
    assert_eq!(request["input"], json!([text("q_busy")]));
}

#[tokio::test]
async fn a_failed_drain_marks_the_first_eligible_row_and_holds_it() {
    let world = World::new();
    world.environment("env_1", HOST, "ready", None);
    world.thread("thr_1", Some("env_1"), "idle", None);
    insert_row(&world, "q_time", Some(r#"{"kind":"time"}"#), Some(NOW + 5_000), "a");
    insert_row(&world, "q_prov", Some(r#"{"kind":"provisioning"}"#), None, "b");
    insert_row(&world, "q_busy", Some(r#"{"kind":"thread-busy"}"#), None, "c");
    insert_row(&world, "q_next", None, None, "d");
    drain_queue(&world.ctx, "thr_1").await.unwrap();
    let failures: Vec<_> = world.queue("thr_1").into_iter().map(|row| row.failure_reason).collect();
    let failed = Some("Thread environment is not available".to_owned());
    assert_eq!(failures, [None, None, failed.clone(), None]);
    drain_queue(&world.ctx, "thr_1").await.unwrap();
    let failures: Vec<_> = world.queue("thr_1").into_iter().map(|row| row.failure_reason).collect();
    assert_eq!(failures, [None, None, failed.clone(), failed]);
    assert!(world.events("thr_1").is_empty());
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn send_now_skips_the_timer() {
    let world = World::new();
    world.ready_thread("thr_1", "idle", None);
    insert_row(&world, "q_1", Some(r#"{"kind":"time"}"#), Some(NOW + 5_000), "a");
    world.ctx.db.run("UPDATE queued_thread_messages SET failure_reason = 'x'", []).unwrap();
    let sent =
        send_queued_message_now(&world.ctx, "thr_1", "q_1", SendQueuedMessageMode::Auto).await;
    assert_eq!(sent.unwrap(), Delivery::Sent);
    assert!(world.queue("thr_1").is_empty());
}

#[tokio::test]
async fn send_now_clears_the_failure_and_refuses_rows_that_still_wait() {
    let world = World::new();
    world.environment("env_1", HOST, "ready", None);
    world.thread("thr_1", Some("env_1"), "idle", None);
    insert_row(&world, "q_1", Some(r#"{"kind":"time"}"#), Some(NOW + 5_000), "a");
    world.ctx.db.run("UPDATE queued_thread_messages SET failure_reason = 'x'", []).unwrap();
    let sent =
        send_queued_message_now(&world.ctx, "thr_1", "q_1", SendQueuedMessageMode::Auto).await;
    assert_eq!(sent.unwrap_err().to_string(), "Thread environment is not available");
    assert_eq!(world.queue("thr_1")[0].failure_reason, None);

    let world = World::new();
    world.ready_thread("thr_1", "active", None);
    insert_row(&world, "q_1", None, None, "a");
    let error = send_queued_message_now(&world.ctx, "thr_1", "q_1", SendQueuedMessageMode::Auto)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "This message cannot be sent yet: it waits on turn-starting.");
    let missing =
        send_queued_message_now(&world.ctx, "thr_1", "nope", SendQueuedMessageMode::Auto).await;
    assert_eq!(missing.unwrap_err().status, 404);
}

fn tool_event(thread_id: &str) -> ToolCallEvent {
    ToolCallEvent {
        thread_id: thread_id.into(),
        turn_id: None,
        request_id: "req_1".into(),
        call_id: "call_1".into(),
        tool: "nothing".into(),
        arguments: json!({}),
    }
}

#[tokio::test]
async fn tool_calls_resolve_through_the_runner_once() {
    let world = World::new();
    start_tool_call(&world.ctx, HOST, tool_event("thr_missing")).unwrap();
    start_tool_call(&world.ctx, HOST, tool_event("thr_missing")).unwrap();
    cancel_tool_call(&world.ctx, "req_1");
    world.settled().await;
    let resolved = world.calls("resolveToolCall");
    assert_eq!(resolved.len(), 1);
    let result: &Value = &resolved[0]["result"];
    assert_eq!(resolved[0]["requestId"], "req_1");
    assert_eq!(result["success"], false);
    assert_eq!(result["contentItems"][0]["text"], "Thread not found.");
    assert!(world.ctx.engine.tool_calls.lock().is_empty());
}

#[tokio::test]
#[ignore = "reaches providers::catalog / providers::settings, still todo!() on this branch"]
async fn tool_calls_for_a_thread_resolve_through_the_runner() {
    let world = World::new();
    world.ready_thread("thr_1", "active", Some("turn_1"));
    start_tool_call(&world.ctx, HOST, tool_event("thr_1")).unwrap();
    world.settled().await;
    let resolved = world.calls("resolveToolCall");
    assert_eq!((resolved.len(), &resolved[0]["threadId"]), (1, &json!("thr_1")));
}
