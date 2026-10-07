mod engine_e2e_lifecycle_support;

use std::sync::Arc;

use bb_server::threads::engine::ops;
use engine_e2e_lifecycle_support::{HOST, Server, events, text};
use futures::FutureExt;
use serde_json::{Value, json};

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

fn notice_texts(server: &Server, thread_id: &str) -> Vec<String> {
    let requests = server.event_data(thread_id, "client/turn/requested");
    let system = requests.iter().filter(|request| request["initiator"] == "system");
    system.map(|request| request["input"][0]["text"].as_str().unwrap().to_owned()).collect()
}

fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|found| contains(found, value))),
        _ => actual == expected,
    }
}

#[track_caller]
fn assert_matches(actual: &Value, expected: Value) {
    assert!(contains(actual, &expected), "{actual:#}\ndoes not match\n{expected:#}");
}

fn row(server: &Server, id: &str) -> Value {
    serde_json::to_value(server.thread(id)).unwrap()
}

#[tokio::test]
async fn creates_a_thread_records_provisioning_and_submits_the_first_turn() {
    let server = Server::with_plugins(&["ask-user-question"]).await;
    let fallback = Arc::new(|_: String, _| async { Some("  Refactor the  scheduler ".into()) }.boxed());
    server.ctx.plugins.set_title_fallback(Some(fallback));
    let prompt = text("Please refactor the scheduler module today");
    let image = json!({ "type": "localImage", "path": "shot.png" });
    let input: Vec<Value> = prompt.iter().cloned().chain([image.clone()]).collect();
    let thread_id = server.spawn(json!({ "input": input })).await;

    let types = server.event_types(&thread_id);
    assert_eq!(types[..2], ["client/turn/requested", "client/thread/start"]);
    let steps: Vec<Value> = server
        .event_data(&thread_id, "system/thread-provisioning")
        .iter()
        .map(|event| {
            let entries = event["entries"].as_array().unwrap().iter().map(|e| e["text"].clone());
            Value::Array([event["status"].clone()].into_iter().chain(entries).collect())
        })
        .collect();
    assert_eq!(
        steps,
        [
            json!(["active", "Preparing workspace"]),
            json!(["active", "Generating title"]),
            json!(["active", "Generated title"]),
            json!(["active", "Using workspace: /repo"]),
            json!(["completed"]),
        ]
    );
    let request = server.event_data(&thread_id, "client/turn/requested").remove(0);
    assert_matches(
        &request,
        json!({
            "source": "spawn",
            "initiator": "user",
            "target": { "kind": "thread-start" },
            "request": { "method": "thread/start" },
            "execution": { "model": "gpt-test", "permissionMode": "auto" },
        }),
    );
    let thread = row(&server, &thread_id);
    assert_matches(
        &thread,
        json!({
            "status": "active",
            "title": "Refactor the scheduler",
            "titleFallback": "Please refactor the scheduler module today",
            "model": "gpt-test",
            "reasoningLevel": "medium",
            "startupContext": null,
        }),
    );
    let environments = server.rows("SELECT id, host_id FROM environments", &[]);
    assert_eq!(environments, [json!({ "id": thread["environmentId"], "hostId": HOST })]);

    let submitted = server.submitted();
    assert_eq!(submitted.len(), 1);
    let submit = &submitted[0];
    assert_matches(
        &submit["session"],
        json!({
            "threadId": thread_id,
            "providerId": "codex",
            "cwd": "/repo",
            "providerThreadId": null,
            "env": {
                "BB_THREAD_ID": thread_id,
                "BB_PROJECT_ID": "proj_1",
                "BB_ENVIRONMENT_ID": thread["environmentId"],
            },
        }),
    );
    let instructions = submit["session"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("You are working inside bb"));
    let tools: Vec<&Value> =
        submit["session"]["dynamicTools"].as_array().unwrap().iter().map(|t| &t["name"]).collect();
    assert_eq!(tools, [&json!("AskUserQuestion")]);
    let chosen = json!({
        "model": "gpt-test",
        "permissionEscalation": "ask",
        "providerOptions": { "memoryEnabled": true },
    });
    assert_matches(&submit["options"], chosen);
    let stored = server.ctx.config.data_dir.join("attachments/proj_1/shot.png");
    let stored_image = json!({ "type": "localImage", "path": stored.to_string_lossy() });
    let delivered = json!([prompt[0], stored_image]);
    let sent = json!([{ "kind": "start" }, request["requestId"], delivered]);
    assert_eq!(json!([submit["mode"], submit["clientRequestId"], submit["input"]]), sent);

    let project = json!({ "projectId": "proj_1" });
    let created = server.changed("thread-created");
    assert_eq!(created[0], (json!(["thread-created"]), project));
    let starting = &server.changed("status-changed")[0].1;
    assert_matches(
        starting,
        json!({
            "projectId": "proj_1",
            "statusChange": {
                "status": "starting",
                "runtime": { "displayStatus": "starting" },
                "activity": { "activeBackgroundAgentCount": 0 },
            },
        }),
    );
    let defaults = server.rows("SELECT execution_defaults FROM projects", &[]);
    assert!(json!(defaults).to_string().contains("gpt-test"));
}

#[tokio::test]
async fn ingests_a_turn_sequences_dedupes_pruning_search_and_status() {
    let server = Server::new().await;
    let thread_id = server.spawn(json!({ "providerId": "codex" })).await;
    let before = server.thread(&thread_id).latest_attention_at;
    let base = server.event_types(&thread_id).len();
    server.changes.lock().clear();
    server.clock.fetch_add(5_000, std::sync::atomic::Ordering::SeqCst);

    server.ingest(&thread_id, vec![events::identity(), events::started("t1")]).await;
    let turn = json!({ "status": "active", "activeTurnId": "t1", "providerThreadId": "prov-1" });
    assert_matches(&row(&server, &thread_id), turn);
    let message = events::message("t1", "i1", "the scheduler is refactored");
    let scope = message[0]["scope"].clone();
    let mut batch = vec![events::started("t1")];
    batch.extend(message.iter().cloned());
    batch.push(message[message.len() - 1].clone());
    batch.push(json!({ "type": "turn/diff/updated", "scope": scope, "providerThreadId": "prov-1" }));
    batch.extend([events::completed("t1", "completed"), events::completed("t1", "completed")]);
    server.ingest(&thread_id, batch).await;

    assert_eq!(
        server.event_types(&thread_id)[base..],
        [
            "thread/identity",
            "turn/started",
            "item/started",
            "item/agentMessage/delta",
            "item/completed",
            "turn/completed",
        ]
    );
    let sql = "SELECT sequence FROM events WHERE thread_id = ? ORDER BY sequence";
    let sequences: Vec<i64> = server
        .rows(sql, &[&thread_id])
        .iter()
        .map(|row| row["sequence"].as_i64().unwrap() - base as i64)
        .collect();
    assert_eq!(sequences[base..], [1, 2, 3, 4, 8, 9]);
    let noticed = json!({ "status": "idle", "activeTurnId": null, "latestAttentionAt": before + 5_000 });
    assert_matches(&row(&server, &thread_id), noticed);
    let hits = |term: &str| {
        let sql = "SELECT s.source_kind FROM thread_search_segments_fts f
          JOIN thread_search_segments s ON s.rowid = f.rowid WHERE f.text MATCH ?";
        server.rows(sql, &[term])
    };
    assert_eq!(hits("refactored"), [json!({ "sourceKind": "assistant_message" })]);
    assert_eq!(hits("scheduler").len(), 3);

    let (kinds, metadata) = server.changed("status-changed").remove(0);
    assert_eq!(kinds, json!(["status-changed"]));
    assert_matches(&metadata, json!({ "statusChange": { "status": "idle" } }));
    let changes = server.changes.lock().clone();
    let appended = changes.iter().find(|c| c["metadata"].to_string().contains("turn/completed"));
    assert_eq!(appended.unwrap()["changes"], json!(["events-appended"]));
}

#[tokio::test]
async fn registers_resolves_and_refuses_provider_interactions() {
    let server = Server::new().await;
    let id = server.spawn(json!({})).await;
    server.ingest(&id, vec![events::identity(), events::started("t1")]).await;
    server.changes.lock().clear();
    for request_id in ["req-1", "req-1", "req-2"] {
        server.interact(&id, request_id, &approval(), "t1").await;
    }
    let pending = server.rows("SELECT id, status FROM pending_interactions", &[]);
    assert_eq!(pending, [json!({ "id": pending[0]["id"], "status": "pending" })]);
    let pending_id = pending[0]["id"].as_str().unwrap();
    let denied = json!({ "threadId": id, "requestId": "req-2", "resolution": { "decision": "deny" } });
    assert_eq!(server.calls_to("resolveInteraction"), [denied]);
    let flagged = json!({ "hasPendingInteraction": true, "projectId": "proj_1" });
    let changed = server.changed("interactions-changed");
    assert_eq!(changed[0], (json!(["interactions-changed"]), flagged));

    let rejected = json!({ "decision": "allow_for_session", "grantedPermissions": null });
    let refused = ops::resolve_interaction(&server.ctx, &id, pending_id, rejected).await;
    assert_eq!(refused.unwrap_err().status, 400);
    let resolution = json!({ "decision": "allow_once", "grantedPermissions": null });
    let resolved = ops::resolve_interaction(&server.ctx, &id, pending_id, resolution.clone());
    let resolved = serde_json::to_value(resolved.await.unwrap()).unwrap();
    server.settle().await;
    assert_eq!(resolved["status"], "resolving");
    let accepted = json!({ "threadId": id, "requestId": "req-1", "resolution": resolution });
    assert_eq!(server.calls_to("resolveInteraction")[1], accepted);
    let lifecycle: Vec<Value> = server
        .event_data(&id, "system/interaction/lifecycle")
        .iter()
        .map(|event| event["interaction"]["status"].clone())
        .collect();
    assert_eq!(lifecycle, [json!("pending"), json!("resolving"), json!("resolved")]);
}

#[tokio::test]
async fn tells_a_parent_about_its_children_in_batches() {
    let server = Server::new().await;
    let parent = server.spawn(json!({ "title": "Parent" })).await;
    server.run_turn(&parent, "p1", "done").await;
    let child = |title: &str| {
        server.spawn(json!({ "title": title, "parentThreadId": parent, "origin": "cli" }))
    };
    let one = child("One").await;
    let two = child("Two").await;
    server.run_turn(&one, "a1", "all green").await;
    server.ingest(&two, vec![events::identity(), events::started("b1")]).await;
    server.ingest(&two, vec![events::completed("b1", "failed")]).await;
    assert!(notice_texts(&server, &parent).is_empty());
    server.advance(2_000).await;
    assert_eq!(
        notice_texts(&server, &parent),
        [format!(
            "[bb system]\n\nChild thread updates:\n\n- @thread:{one} completed.\n- @thread:{two} failed."
        )]
    );
    assert_eq!(row(&server, &parent)["status"], "active");
    let first = server.thread(&one);
    assert_eq!(first.latest_attention_at, first.created_at);
    let requests = server.event_data(&parent, "client/turn/requested");
    assert_matches(
        requests.last().unwrap(),
        json!({
            "systemMessageKind": "child-outcome-batch",
            "systemMessageSubject": { "kind": "thread-batch", "count": 2 },
            "target": { "kind": "new-turn" },
        }),
    );

    server.ingest(&parent, vec![events::started("p2")]).await;
    server.ingest(&one, vec![events::started("a2")]).await;
    server.interact(&one, "child-req", &approval(), "t1").await;
    let blocked = format!("@thread:{one} needs help.\nBlocked on command:\nCommand: rm");
    assert!(notice_texts(&server, &parent)[1].contains(&blocked));
    assert_eq!(server.submitted().last().unwrap()["mode"], json!({ "kind": "auto" }));

    server.interact(&parent, "parent-req", &approval(), "t1").await;
    server.ingest(&one, vec![events::completed("a2", "completed")]).await;
    server.advance(2_000).await;
    assert_eq!(server.queued(&parent), [json!("interaction")]);
    let notices = server.rows("SELECT system_notice FROM queued_thread_messages", &[]);
    assert!(json!(notices).to_string().contains("child-completed"));
    let settled = json!({
        "kind": "interaction.cancelled",
        "threadId": parent,
        "requestId": "parent-req",
        "reason": "gone",
    });
    server.emit(settled).await;
    let completed = format!("[bb system]\n\n@thread:{one} completed:\n\nall green");
    assert_eq!(notice_texts(&server, &parent)[2], completed);
}
