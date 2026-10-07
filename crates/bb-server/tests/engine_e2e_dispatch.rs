mod engine_e2e_dispatch_support;

use bb_server::db::event_read::last_output;
use bb_server::db::thread_read::{
    PromptHistoryScope, ThreadListQuery, list_prompt_history_entries, list_thread_rows,
};
use bb_server::threads::create::CreateThreadRequest;
use bb_server::threads::engine::ops;
use bb_server::threads::mutations::{CreateQueuedMessageRequest, SendMessageRequest};
use bb_server::threads::thread_display::to_thread_list_entries;
use engine_e2e_dispatch_support::{HOST, World, events, text};
use serde_json::{Value, json};

fn question() -> Value {
    json!({
        "kind": "user_question",
        "questions": [{ "id": "q1", "prompt": "Push?", "multiSelect": false,
            "allowFreeText": true }],
    })
}

#[tokio::test]
async fn steers_queues_and_drains_around_a_running_turn() {
    let server = World::new();
    let id = server.spawn().await;
    let send = |mode: &'static str, message: &'static str| server.send(&id, mode, message, None);

    assert_eq!(send("steer-if-active", "one").await, json!([200, "queued", "turn-starting"]));
    server.ingest(&id, vec![events::identity(), events::started("t1")]).await;
    assert_eq!([server.queued(&id), server.last_submit()], [json!([]), json!(["one", "auto"])]);

    assert_eq!(send("steer", "two").await, json!([200, "sent"]));
    let steer = json!({ "kind": "steer", "expectedTurnId": "t1" });
    assert_eq!(server.submitted().last().unwrap()["mode"], steer);
    assert_eq!(send("queue-if-active", "three").await, json!([200, "queued", "thread-busy"]));
    assert_eq!(send("start", "nope").await, json!([409, "already_active"]));
    let explicit: CreateQueuedMessageRequest =
        serde_json::from_value(json!({ "input": text("four") })).unwrap();
    ops::create_queued_message(&server.ctx, &id, explicit).await.map_err(|e| e.body).unwrap();
    server.settle().await;
    assert_eq!(server.submitted().len(), 3);

    server.ingest(&id, vec![events::completed("t1", "completed")]).await;
    assert_eq!(server.last_submit(), json!(["three", "start"]));
    assert_eq!(server.queued(&id), json!(["thread-busy"]));
    let requests = server.event_data(&id, "client/turn/requested");
    let targets: Vec<&Value> = requests.iter().map(|request| &request["target"]["kind"]).collect();
    assert_eq!(targets, ["thread-start", "auto", "steer", "new-turn"]);
    let batch = vec![events::started("t2"), events::completed("t2", "failed")];
    server.ingest(&id, batch).await;
    assert_eq!([server.status(&id), server.queued(&id)], [json!("error"), json!(["thread-busy"])]);
}

#[tokio::test]
async fn holds_messages_on_time_interactions_hosts_and_provisioning() {
    let server = World::new();
    let id = server.spawn().await;
    server.run_turn(&id, "t1").await;

    let at = server.clock.load(std::sync::atomic::Ordering::SeqCst) + 60_000;
    let later = server.send(&id, "auto", "later", Some(at)).await;
    assert_eq!(later, json!([200, "queued", "time"]));
    server.advance(1_000).await;
    assert_eq!(server.queued(&id), json!(["time"]));
    server.advance(59_000).await;
    assert_eq!(server.last_submit(), json!(["later", "start"]));

    server.ingest(&id, vec![events::started("t2")]).await;
    server.interact(&id, "req-1", question(), "t2").await;
    let waiting = server.send(&id, "steer-if-active", "answer first", None).await;
    assert_eq!(waiting, json!([200, "queued", "interaction"]));
    let cancelled = json!({ "kind": "interaction.cancelled", "threadId": id,
        "requestId": "req-1", "reason": "gave up" });
    server.emit(cancelled).await;
    assert_eq!(server.last_submit(), json!(["answer first", "auto"]));
    server.ingest(&id, vec![events::completed("t2", "completed")]).await;

    server.ctx.runners.disconnect(HOST, None);
    let offline = server.send(&id, "auto", "when back", None).await;
    assert_eq!(offline, json!([200, "queued", "host-offline"]));
    server.reconnect().await;
    assert_eq!(server.last_submit(), json!(["when back", "start"]));

    let gate = server.defer_environment();
    let other = server.spawn_with(json!({ "origin": "cli" }), false).await;
    let follow_up: SendMessageRequest =
        serde_json::from_value(json!({ "input": text("also this"), "mode": "auto" })).unwrap();
    let held = ops::send(&server.ctx, &other, follow_up).await.map_err(|e| e.body).unwrap();
    let held = serde_json::to_value(held).unwrap();
    assert_eq!(held["queuedMessage"]["waitingOn"]["kind"], "provisioning");
    server.release(gate).await;
    assert_eq!(server.queued(&other), json!(["turn-starting"]));
    server.ingest(&other, vec![events::started("o1")]).await;
    assert_eq!(server.last_submit(), json!(["also this", "auto"]));
}

#[tokio::test]
async fn stops_a_running_turn_and_pauses_the_turn_bound_queue() {
    let server = World::new();
    let id = server.spawn().await;
    server.ingest(&id, vec![events::identity(), events::started("t1")]).await;
    let held = server.send(&id, "queue-if-active", "held", None).await;
    assert_eq!(held.as_array().unwrap().len(), 3);
    server.interact(&id, "req-1", question(), "t1").await;

    ops::stop(&server.ctx, &id).await.map_err(|e| e.body).unwrap();
    server.settle().await;
    assert_eq!(server.status(&id), "stopping");
    assert_eq!(server.calls_to("interruptTurn"), [json!({ "threadId": id })]);
    let stopping = server.send(&id, "auto", "after stop", None).await;
    assert_eq!(stopping, json!([200, "queued", "stopping"]));
    server.ingest(&id, vec![events::completed("t1", "interrupted")]).await;
    let interrupted = server.event_data(&id, "system/thread/interrupted");
    assert_eq!(interrupted, [json!({ "reason": "manual-stop" })]);
    let reasons = server.rows("SELECT status_reason FROM pending_interactions", &[]);
    assert_eq!(reasons[0]["statusReason"], "Thread stopped by user request");
    assert_eq!(reasons.len(), 1);
    assert_eq!(server.last_submit(), json!(["after stop", "start"]));
    assert_eq!(server.queued(&id), json!(["thread-busy"]));
    let batch = vec![events::started("t2"), events::completed("t2", "completed")];
    server.ingest(&id, batch).await;
    assert_eq!(server.last_submit(), json!(["held", "start"]));
}

#[tokio::test]
async fn stops_a_thread_that_is_still_provisioning_or_about_to_start() {
    let server = World::new();
    let gate = server.defer_environment();
    let id = server.spawn_with(json!({}), false).await;
    ops::stop(&server.ctx, &id).await.map_err(|e| e.body).unwrap();
    assert_eq!(server.status(&id), "idle");
    let provisioning = server.event_data(&id, "system/thread-provisioning");
    assert_eq!(provisioning.last().unwrap()["status"], "cancelled");
    server.release(gate).await;
    let environment = server.thread(&id)["environmentId"].clone();
    assert_eq!(server.submitted().len(), 0);
    assert!(environment.as_str().is_some_and(|e| e.starts_with("env_")), "{environment}");

    assert_eq!(server.send(&id, "auto", "now go", None).await, json!([200, "sent"]));
    let row = server.thread(&id);
    assert_eq!([&row["status"], &row["activeTurnId"]], [&json!("active"), &Value::Null]);
    server.script.refuse_interrupt.store(true, std::sync::atomic::Ordering::SeqCst);
    ops::stop(&server.ctx, &id).await.map_err(|e| e.body).unwrap();
    assert_eq!(server.status(&id), "idle");
    let before = server.calls_to("interruptTurn").len();
    server.ingest(&id, vec![events::started("t1")]).await;
    assert_eq!(server.status(&id), "idle");
    assert_eq!(server.calls_to("interruptTurn").len(), before + 1);
    server.ingest(&id, vec![events::completed("t1", "interrupted")]).await;
    let row = server.thread(&id);
    assert_eq!([&row["status"], &row["activeTurnId"]], [&json!("idle"), &Value::Null]);
}

fn assistant_texts(server: &World, id: &str) -> Vec<String> {
    let completed = server.event_data(id, "item/completed");
    let replies = completed.iter().filter(|event| event["item"]["type"] == "agentMessage");
    replies.map(|event| event["item"]["text"].as_str().unwrap_or_default().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_an_echo_thread_on_the_real_local_runner_and_steers_it() {
    let (server, directory) = World::echo();
    let request: CreateThreadRequest = serde_json::from_value(json!({
        "projectId": "proj_1", "origin": "app", "providerId": "echo",
        "input": text("delay:5000 first"), "environment": { "type": "project-default" },
        "startedOnBehalfOf": null,
    }))
    .unwrap();
    let id = ops::create(&server.ctx, request).await.map_err(|e| e.body).unwrap().thread.id;
    server.wait_for("an active turn", |s| !s.thread(&id)["activeTurnId"].is_null()).await;
    let running = ops::get(&server.ctx, &id).unwrap().unwrap();
    assert_eq!(serde_json::to_value(running.runtime).unwrap()["displayStatus"], "active");
    let listed = || {
        let query: ThreadListQuery =
            serde_json::from_value(json!({ "projectId": "proj_1" })).unwrap();
        let rows = list_thread_rows(&server.ctx.db, &query).unwrap();
        serde_json::to_value(to_thread_list_entries(&server.ctx, &rows).unwrap()).unwrap()
    };
    let entries = listed();
    assert_eq!(entries.as_array().map(Vec::len), Some(1), "{entries}");
    assert_eq!(
        [&entries[0]["id"], &entries[0]["runtime"]["displayStatus"]],
        [&json!(id), &json!("active")]
    );

    let steer: SendMessageRequest =
        serde_json::from_value(json!({ "input": text("second release_turn"), "mode": "steer" }))
            .unwrap();
    let sent = ops::send(&server.ctx, &id, steer).await.map_err(|e| e.body).unwrap();
    assert_eq!(serde_json::to_value(sent).unwrap()["delivery"], "sent");
    server.wait_for("turn/completed", |s| !s.event_data(&id, "turn/completed").is_empty()).await;
    server.wait_for("idle", |s| s.status(&id) == "idle").await;
    let idle = serde_json::to_value(ops::get(&server.ctx, &id).unwrap().unwrap()).unwrap();
    assert_eq!(idle["runtime"]["displayStatus"], "idle");
    let environment_id = server.thread(&id)["environmentId"].as_str().unwrap().to_owned();
    let environment = server.rows("SELECT * FROM environments WHERE id = ?", &[&environment_id]);
    assert_eq!(environment[0]["path"], directory.to_str().unwrap());
    assert_eq!([&environment[0]["hostId"], &environment[0]["status"]], [HOST, "ready"]);
    let host = server.rows("SELECT * FROM hosts WHERE id = ?", &[HOST]);
    assert_eq!(host.len(), 1);
    assert!(server.ctx.runners.is_connected(HOST));
    let said = server.event_data(&id, "client/turn/requested");
    let first = said.iter().any(|event| event["input"][0]["text"] == "delay:5000 first");
    assert!(first, "{said:?}");
    let replies = assistant_texts(&server, &id);
    assert!(replies.contains(&"Steered: second release_turn".to_owned()), "{replies:?}");
    let max_seq = "SELECT CAST(MAX(sequence) AS TEXT) AS seq FROM events WHERE thread_id = ?";
    let max_seq = server.rows(max_seq, &[&id])[0]["seq"].as_str().unwrap().to_owned();

    let again: SendMessageRequest =
        serde_json::from_value(json!({ "input": text("third pineapple"), "mode": "start" }))
            .unwrap();
    ops::send(&server.ctx, &id, again).await.map_err(|e| e.body).unwrap();
    server
        .wait_for("the third reply", |s| {
            let replies = assistant_texts(s, &id);
            s.status(&id) == "idle"
                && replies.last().is_some_and(|r| r == "Response to: third pineapple")
        })
        .await;
    let output = last_output(&server.ctx.db, &id).unwrap();
    assert_eq!(output.as_deref(), Some("Response to: third pineapple"));
    assert_eq!(listed()[0]["runtime"]["displayStatus"], "idle");
    let prompts = |scope| {
        let entries = list_prompt_history_entries(&server.ctx.db, scope, 50).unwrap();
        let texts = entries.iter().flat_map(|entry| entry.input.iter().map(|p| p["text"].clone()));
        texts.collect::<Vec<Value>>()
    };
    let steers = json!(["third pineapple", "second release_turn"]);
    assert_eq!(json!(prompts(PromptHistoryScope::Thread(&id))), steers);
    let started = json!(["delay:5000 first"]);
    assert_eq!(json!(prompts(PromptHistoryScope::Project("proj_1"))), started);
    let after = "SELECT type FROM events WHERE thread_id = ? AND sequence > CAST(? AS INTEGER)";
    let types: Vec<Value> =
        server.rows(after, &[&id, &max_seq]).into_iter().map(|row| row["type"].clone()).collect();
    assert!(types.contains(&json!("turn/completed")));
    assert!(!types.contains(&json!("client/thread/start")));
    bb_server::threads::engine::close(&server.ctx).await;
}

async fn echo_turn(server: &World, id: &str, message: &str, mode: &str) {
    let request = json!({ "input": text(message), "mode": mode });
    let request: SendMessageRequest = serde_json::from_value(request).unwrap();
    ops::send(&server.ctx, id, request).await.map_err(|e| e.body).unwrap();
}

async fn pending_interaction(server: &World, id: &str) -> (String, Value) {
    let sql =
        "SELECT id, payload FROM pending_interactions WHERE thread_id = ? AND status = 'pending'";
    server.wait_for("a pending interaction", |s| !s.rows(sql, &[id]).is_empty()).await;
    let row = server.rows(sql, &[id]).remove(0);
    let payload = serde_json::from_str(row["payload"].as_str().unwrap()).unwrap();
    (row["id"].as_str().unwrap().to_owned(), payload)
}

async fn idle_with_reply(server: &World, id: &str, reply: &str) {
    let what = format!("idle with reply {reply:?}");
    server
        .wait_for(&what, |s| {
            s.status(id) == "idle" && assistant_texts(s, id).last().is_some_and(|r| r == reply)
        })
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_echo_steers_approvals_questions_and_tool_calls() {
    let (server, _directory) = World::echo();
    let request: CreateThreadRequest = serde_json::from_value(json!({
        "projectId": "proj_1", "origin": "app", "providerId": "echo",
        "input": text("hold_turn"), "environment": { "type": "project-default" },
        "startedOnBehalfOf": null,
    }))
    .unwrap();
    let id = ops::create(&server.ctx, request).await.map_err(|e| e.body).unwrap().thread.id;
    server.wait_for("an active turn", |s| !s.thread(&id)["activeTurnId"].is_null()).await;
    echo_turn(&server, &id, "release_turn", "steer").await;
    idle_with_reply(&server, &id, "Steered: release_turn").await;

    echo_turn(&server, &id, "approve", "start").await;
    let (approval, payload) = pending_interaction(&server, &id).await;
    assert_eq!(payload["kind"], "approval");
    let decision = json!({ "decision": "allow_once" });
    let resolved = ops::resolve_interaction(&server.ctx, &id, &approval, decision).await;
    resolved.map_err(|e| e.body).unwrap();
    idle_with_reply(&server, &id, "Response to: approve").await;

    echo_turn(&server, &id, "ask_user", "start").await;
    let (question, payload) = pending_interaction(&server, &id).await;
    let question_id = payload["questions"][0]["id"].as_str().unwrap().to_owned();
    let answer = json!({ "selected": ["staging"], "freeText": "soon" });
    let answers = json!({ "kind": "user_answer", "answers": { question_id: answer } });
    let answered = ops::resolve_interaction(&server.ctx, &id, &question, answers).await;
    answered.map_err(|e| e.body).unwrap();
    idle_with_reply(&server, &id, "Question answered: staging, soon").await;
    let statuses =
        server.rows("SELECT status FROM pending_interactions WHERE thread_id = ?", &[&id]);
    assert!(statuses.iter().all(|row| row["status"] == "resolved"), "{statuses:?}");

    echo_turn(&server, &id, r#"call_tool:lookup tool_input:{"q":1}"#, "start").await;
    idle_with_reply(&server, &id, "Tool called: lookup").await;
    let items = server.event_data(&id, "item/completed");
    let call = items.iter().find(|event| event["item"]["type"] == "toolCall").unwrap();
    assert_eq!(
        [&call["item"]["tool"], &call["item"]["arguments"]],
        [&json!("lookup"), &json!({ "q": 1 })]
    );
    assert!(call["item"]["result"].as_str().is_some_and(|r| !r.is_empty()), "{call}");
    bb_server::threads::engine::close(&server.ctx).await;
}
