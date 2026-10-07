mod engine_e2e_lifecycle_support;
mod http_e2e_support;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bb_core::{RunnerEvent, RunnerEventSink};
use bb_server::threads::engine;
use engine_e2e_lifecycle_support::{Fake, PROVIDER_THREAD, Script, default_script, events};
use http_e2e_support::{BootOptions, Server, boot_with};
use parking_lot::Mutex;
use reqwest::StatusCode;
use serde_json::{Value, json};

struct Machine {
    sink: Arc<Mutex<Option<RunnerEventSink>>>,
    seq: AtomicU64,
}

impl Machine {
    async fn emit(&self, server: &Server, event: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut event = event;
        event["lane"] = json!("reliable");
        event["seq"] = json!(seq);
        let event: RunnerEvent = serde_json::from_value(event).unwrap();
        let sink = self.sink.lock().clone().expect("runner connected");
        sink(event);
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        engine::settled(&server.server.ctx).await;
    }

    async fn ingest(&self, server: &Server, thread_id: &str, batch: Vec<Value>) {
        let event = json!({ "kind": "thread.events", "threadId": thread_id, "events": batch });
        self.emit(server, event).await;
    }

    async fn run_turn(&self, server: &Server, thread_id: &str, turn_id: &str, reply: &str) {
        self.ingest(server, thread_id, vec![events::identity(), events::started(turn_id)]).await;
        let mut batch = events::message(turn_id, &format!("{turn_id}-i1"), reply);
        batch.push(events::completed(turn_id, "completed"));
        self.ingest(server, thread_id, batch).await;
    }
}

fn approval() -> Value {
    json!({
        "kind": "approval",
        "subject": {
            "kind": "command",
            "itemId": "i1",
            "command": "rm -rf build",
            "cwd": null,
            "actions": [],
            "sessionGrant": null,
        },
        "reason": null,
        "availableDecisions": ["allow_once", "deny"],
    })
}

#[tokio::test]
async fn serves_a_kept_timeline_until_something_it_shows_changes() {
    let mut script = default_script();
    let models = json!({ "models": [{ "model": "gpt-test" }], "selectedOnlyModels": [] });
    script.insert("listModels".to_owned(), Arc::new(move |_: &Value| Ok(models.clone())));
    let workspace: Script = Arc::new(|params: &Value| {
        Ok(json!({ "path": format!("/workspaces/{}", params["key"].as_str().unwrap_or_default()) }))
    });
    script.insert("ensurePersonalWorkspace".to_owned(), workspace);
    let fake = Arc::new(Fake { script: Mutex::new(script), ..Default::default() });
    let sink: Arc<Mutex<Option<RunnerEventSink>>> = Arc::default();
    let machine = Machine { sink: sink.clone(), seq: AtomicU64::new(0) };
    let runner = fake.clone();
    let options = BootOptions {
        runner: Some(Box::new(move |events| {
            *sink.lock() = Some(events);
            runner
        })),
        ..Default::default()
    };
    let server = boot_with(options).await;
    server.wait_until("runner connected", || machine.sink.lock().is_some()).await;
    let thread = server
        .create_thread(json!({
            "projectId": "proj_personal",
            "origin": "app",
            "providerId": "codex",
            "model": "gpt-test",
            "input": [{ "type": "text", "text": "Please refactor the scheduler module today", "mentions": [] }],
            "environment": { "type": "project-default" },
            "startedOnBehalfOf": null,
        }))
        .await;
    let id = thread["id"].as_str().unwrap().to_owned();
    engine::settled(&server.server.ctx).await;
    machine.run_turn(&server, &id, "t1", "first reply").await;

    let timeline = async |query: &str| {
        let (status, body) = server.get(&format!("/threads/{id}/timeline{query}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    };
    let first = timeline("").await;
    assert_eq!(timeline("").await, first);
    let idle = timeline(&format!("?afterSequence={}", first["maxSeq"])).await;
    assert_eq!(json!([idle["rows"], idle["delta"]]), json!([[], { "upsertRows": [] }]));
    machine.run_turn(&server, &id, "t2", "second reply").await;
    let second = timeline("").await;
    assert!(second["rows"].to_string().contains("second reply"), "{second}");
    let delta = timeline(&format!("?afterSequence={}", first["maxSeq"])).await;
    assert!(delta["delta"]["upsertRows"].to_string().contains("second reply"), "{delta}");

    machine.ingest(&server, &id, vec![events::started("t3")]).await;
    let request = json!({
        "kind": "interaction.requested",
        "threadId": id,
        "turnId": "t3",
        "requestId": "req-1",
        "providerId": "codex",
        "providerThreadId": PROVIDER_THREAD,
        "payload": approval(),
    });
    machine.emit(&server, request).await;
    let asked = timeline("").await;
    let pending = server.server.ctx.db.rows("SELECT id FROM pending_interactions", []).unwrap();
    let pending = serde_json::to_value(pending).unwrap()[0]["id"].as_str().unwrap().to_owned();
    let path = format!("/threads/{id}/interactions/{pending}/resolve");
    let (status, resolved) =
        server.post(&path, json!({ "decision": "deny", "grantedPermissions": null })).await;
    assert!(status.is_success(), "{status} {resolved}");
    engine::settled(&server.server.ctx).await;
    let answered = timeline("").await;
    let sequences: Vec<i64> =
        [&second, &asked, &answered].iter().map(|page| page["maxSeq"].as_i64().unwrap()).collect();
    let mut sorted = sequences.clone();
    sorted.sort();
    assert_eq!(sequences, sorted);
    assert_eq!(sequences.iter().collect::<BTreeSet<_>>().len(), 3);

    let (status, renamed) =
        server.patch(&format!("/threads/{id}"), json!({ "title": "Renamed" })).await;
    assert!(status.is_success(), "{status} {renamed}");
    let renamed = timeline("").await;
    let snapshot = &renamed["timelinePage"]["historySnapshot"];
    assert!(snapshot.to_string().contains("Renamed"), "{snapshot}");
    server.close().await;
}
