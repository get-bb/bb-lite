//! Port of apps/server/test/remote-runner.test.ts: a real server and a real remote runner that
//! dials it over the runner WebSocket through a relay.

mod remote_runner_support;

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

use bb_core::RunnerErrorCode;
use remote_runner_support::{Machine, TestServer, until};
use serde_json::{Value, json};

static TURN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn turn(thread_id: &str, text: &str) -> Value {
    let request = TURN_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    json!({
        "session": {
            "threadId": thread_id, "providerId": "echo",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "providerThreadId": null, "instructions": "",
            "dynamicTools": [], "env": {}, "skillDirs": []
        },
        "clientRequestId": format!("req-{request}"),
        "input": [{ "type": "text", "text": text, "mentions": [] }],
        "mode": { "kind": "start" },
        "options": {
            "model": "echo-1", "reasoningLevel": "medium", "serviceTier": "default",
            "permissionMode": "accept-edits", "permissionEscalation": "ask",
            "providerOptions": {}
        },
    })
}

fn expect_consecutive(machine: &Machine) {
    let seqs = machine.seqs();
    let expected: Vec<u64> = (1..=seqs.len() as u64).collect();
    assert_eq!(seqs, expected);
}

async fn wait_for_type(machine: &Machine, kind: &str) {
    until(|| machine.types().iter().any(|seen| seen == kind).then_some(())).await;
}

async fn wait_for_acked(server: &TestServer, machine: &Machine) {
    let last = machine.seqs().last().copied().unwrap();
    until(|| (server.host_row(&machine.host_id)["lastEventSeq"] == json!(last)).then_some(()))
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enrolls_a_machine_and_runs_an_echo_turn_over_the_socket() {
    let server = TestServer::start().await;
    let mut machine = Machine::enroll(&server).await;
    let file = machine.credentials_file();
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["serverUrl"], json!(machine.relay.url));
    assert_eq!(stored["hostId"], json!(machine.host_id));
    assert_eq!(stored["headers"]["x-bb-connect-machine"], "bbcm_legacy");
    assert_eq!(stored["headers"]["x-extra"], "one=two");
    machine.run().await;
    machine.connected().await;
    let info = machine.remote().call("describe", Value::Null).await.unwrap();
    let row = server.host_row(&machine.host_id);
    assert_eq!(row["phase"], "active", "{row}");
    assert_eq!(row["platform"], if cfg!(target_os = "macos") { "darwin" } else { "linux" });
    assert_eq!(row["lastInstanceId"], info["instanceId"], "{row}");
    assert_eq!(row["lastSeenAt"], json!(server.now()), "{row}");
    let started = machine.remote().call("submitTurn", turn("thr_a", "hello")).await.unwrap();
    assert_eq!(started["outcome"], "started", "{started}");
    wait_for_type(&machine, "turn/completed").await;
    expect_consecutive(&machine);
    wait_for_acked(&server, &machine).await;
    machine.stop().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keeps_a_turn_alive_across_a_dropped_socket_without_duplicates() {
    let server = TestServer::start().await;
    let mut machine = Machine::enroll(&server).await;
    machine.run().await;
    machine.connected().await;
    let described = machine.remote().call("describe", Value::Null).await.unwrap();
    let instance_id = described["instanceId"].clone();
    let slow = "stream:12 pace:150 survive the gap";
    machine.remote().call("submitTurn", turn("thr_gap", slow)).await.unwrap();
    wait_for_type(&machine, "item/agentMessage/delta").await;
    let acknowledgeable = machine.seen_len();
    machine.gate.send_replace(false);
    until(|| (machine.seen_len() > acknowledgeable).then_some(())).await;
    let delivered_before_drop = machine.seen_len();
    let remote = machine.remote();
    let unanswered = tokio::spawn(async move { remote.call("snapshot", Value::Null).await });
    tokio::task::yield_now().await;
    machine.relay.sever();
    let lost = unanswered.await.unwrap().unwrap_err();
    assert_eq!((lost.code, lost.retryable), (RunnerErrorCode::Unavailable, true), "{lost:?}");
    until(|| (!server.is_connected(&machine.host_id)).then_some(())).await;
    machine.connected().await;
    let acked = server.host_row(&machine.host_id)["lastEventSeq"].as_u64().unwrap();
    assert!(acked < delivered_before_drop as u64, "{acked} >= {delivered_before_drop}");
    let snapshot = machine.remote().call("snapshot", Value::Null).await.unwrap();
    let sessions = snapshot["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "{snapshot}");
    assert_eq!(sessions[0]["threadId"], "thr_gap");
    let again = machine.remote().call("describe", Value::Null).await.unwrap();
    assert_eq!(again["instanceId"], instance_id);
    machine.gate.send_replace(true);
    wait_for_type(&machine, "turn/completed").await;
    assert!(machine.seen_len() > delivered_before_drop);
    expect_consecutive(&machine);
    wait_for_acked(&server, &machine).await;
    machine.stop().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runs_a_thread_created_on_the_remote_machine_through_the_engine() {
    let server = TestServer::start().await;
    let mut machine = Machine::enroll(&server).await;
    machine.run().await;
    machine.connected().await;
    let body = json!({
        "projectId": "proj_personal",
        "origin": "app",
        "providerId": "echo",
        "input": [{ "type": "text", "text": "hello remote", "mentions": [] }],
        "environment": {
            "type": "host", "hostId": machine.host_id, "workspace": { "type": "personal" }
        },
        "startedOnBehalfOf": null,
    });
    let (status, thread) = server.api("POST", "/threads", Some(body)).await;
    assert_eq!(status.as_u16(), 201, "{thread}");
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    let db = &server.server.ctx.db;
    let read = || {
        let thread = db.rows("SELECT * FROM threads WHERE id = ?", [&thread_id]).unwrap();
        let events = db
            .rows("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence", [&thread_id])
            .unwrap();
        (serde_json::to_value(thread).unwrap()[0].clone(), serde_json::to_string(&events).unwrap())
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let events = loop {
        let (thread, events) = read();
        if thread["status"] == "idle" && events.contains("turn/completed") {
            break events;
        }
        assert!(std::time::Instant::now() < deadline, "thread stayed {thread}: {events}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(events.contains("hello remote"), "{events}");
    let environment = db
        .rows("SELECT e.* FROM environments e JOIN threads t ON t.environment_id = e.id WHERE t.id = ?", [&thread_id])
        .unwrap();
    let environment = serde_json::to_value(environment).unwrap();
    assert_eq!(environment[0]["hostId"], json!(machine.host_id), "{environment}");
    assert!(machine.types().iter().any(|kind| kind == "turn/completed"));
    expect_consecutive(&machine);
    machine.stop().await;
    server.close().await;
}
