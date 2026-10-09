mod support;

use bb_cli::call::locale_date;
use serde_json::{Value, json};
use support::{Fake, Recorded, fail, ok};

fn thread(id: &str, status: &str) -> Value {
    json!({
        "id": id,
        "status": status,
        "title": null,
        "titleFallback": "Fallback",
        "projectId": "proj_1",
        "parentThreadId": null,
        "archivedAt": null,
        "pinnedAt": null,
        "environmentId": null,
        "createdAt": 1_700_000_000_000_i64,
        "updatedAt": 1_700_000_100_000_i64,
    })
}

fn request(method: &str, path: &str, query: &str, body: Option<Value>) -> Recorded {
    Recorded { method: method.into(), path: path.into(), query: query.into(), body }
}

#[test]
fn list_sends_filters_and_prints_a_table() {
    let mut archived = thread("thr_b", "idle");
    archived["archivedAt"] = json!(1);
    archived["title"] = json!("Named");
    let fake = Fake::json(json!([thread("thr_a", "active"), archived]));
    let out = ok(&fake.url, None, &["thread", "list", "--project", "proj_1", "--archived"]);
    assert_eq!(fake.only(), request("GET", "/threads", "projectId=proj_1&archived=true", None));
    let expected = "\nID     TITLE     PROJECTID  STATUS\nthr_a  Fallback  proj_1     active\n\
                    thr_b  Named     proj_1     archived\n\n";
    assert_eq!(out, expected);
    let out = ok(&fake.url, None, &["thread", "list", "--count", "--json"]);
    assert_eq!(serde_json::from_str::<Value>(&out).expect("json"), json!({ "count": 2 }));
    let error = fail(&fake.url, None, &["thread", "list", "--section", "sec_1", "--unsectioned"]);
    assert_eq!(error.message, "Cannot combine --section with --unsectioned.");
    assert_eq!(error.code, "invalid_value");
}

#[test]
fn show_prints_thread_environment_and_todos() {
    let fake = Fake::start(|request| {
        let body = match request.path.as_str() {
            "/threads/thr_a" => {
                let mut found = thread("thr_a", "idle");
                found["title"] = json!("Fix it");
                found["environmentId"] = json!("env_1");
                found
            }
            "/environments/env_1" => json!({ "id": "env_1", "hostId": "host_1", "path": "/w" }),
            "/ops/pullRequests.get" => return (501, unimplemented()),
            "/environments/env_1/status" => {
                json!({ "outcome": "not_applicable", "message": "No git" })
            }
            "/threads/thr_a/timeline" => json!({ "pendingTodos": { "items": [
                { "status": "completed", "text": "one" },
                { "status": "in_progress", "text": "two" },
            ] } }),
            _ => return (404, "{}".into()),
        };
        (200, body.to_string())
    });
    let out = ok(&fake.url, Some("thr_a"), &["thread", "show", "--self"]);
    let paths: Vec<String> = fake.requests().into_iter().map(|r| r.path + "?" + &r.query).collect();
    let expected_paths = [
        "/threads/thr_a?",
        "/environments/env_1?",
        "/threads/thr_a/timeline?summaryOnly=true",
        "/ops/pullRequests.get?",
    ];
    assert_eq!(paths, expected_paths);
    let expected = format!(
        "Thread: thr_a\n  Status: idle\n  Title: Fix it\n  Project: proj_1\n  Environment: env_1 \
         on host_1 (/w)\n  Created: {}\n  Updated: {}\n\nTODOs (1/2 done):\n  [x] one\n  [>] \
         two\n",
        locale_date(1_700_000_000_000.0),
        locale_date(1_700_000_100_000.0)
    );
    assert_eq!(out, expected);
    let out = ok(&fake.url, None, &["thread", "show", "thr_a", "--work-status", "--json"]);
    let data: Value = serde_json::from_str(&out).expect("json");
    let pull = json!({ "status": "unavailable", "pullRequest": null,
        "message": "The github plugin is not enabled." });
    assert_eq!(data["environment"]["pullRequest"], pull);
    assert_eq!(data["workStatus"], Value::Null);
    let out = ok(&fake.url, None, &["thread", "show", "thr_a", "--work-status"]);
    assert!(out.ends_with("two\n\nWork status: No git\n"));
    let error = fail(&fake.url, None, &["thread", "show"]);
    assert_eq!(error.message, "Missing thread ID. Pass <id> or use --self.");
    assert_eq!(error.code, "missing_required");
}

#[test]
fn tell_sends_each_mode() {
    let fake = Fake::json(json!({ "delivery": "sent" }));
    let cases = [("steer", "steer-if-active", "steered"), ("queue", "queue-if-active", "updated")];
    for (mode, wire, outcome) in cases {
        let argv = ["thread", "tell", "thr_a", "hello", "--mode", mode, "--model", "m1"];
        let out = ok(&fake.url, Some("thr_parent"), &argv);
        assert_eq!(out, format!("Thread thr_a {outcome}\n"));
        let body = json!({
            "input": [{ "type": "text", "text": "hello", "mentions": [] }],
            "mode": wire,
            "model": "m1",
            "senderThreadId": "thr_parent",
        });
        let sent = fake.requests().pop().expect("request");
        assert_eq!(sent, request("POST", "/threads/thr_a/send", "", Some(body)));
    }
    let out = ok(&fake.url, Some("thr_a"), &["thread", "tell", "thr_a", "hi", "--mode", "auto"]);
    assert_eq!(out, "Thread thr_a updated\n");
    let body = fake.requests().pop().expect("request").body.expect("body");
    assert_eq!(body["mode"], "auto");
    assert!(body.get("senderThreadId").is_none());

    let queued =
        json!({ "delivery": "queued", "queuedMessage": { "sendAt": null, "waitingOn": null } });
    let fake = Fake::json(queued);
    let out = ok(&fake.url, None, &["thread", "tell", "thr_a", "later", "--json"]);
    let data: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(data["threadId"], "thr_a");
    assert_eq!(data["mode"], "steer");
    let out = ok(&fake.url, None, &["thread", "tell", "thr_a", "later"]);
    let expected = "Thread thr_a message queued (waiting for the current turn to finish); it \
                    dispatches when that clears\n";
    assert_eq!(out, expected);
    let error = fail(&fake.url, None, &["thread", "tell", "thr_a"]);
    assert_eq!(error.message, "Missing <message>.");
}

#[test]
fn stop_and_other_actions() {
    let fake = Fake::json(json!({}));
    let out = ok(&fake.url, None, &["thread", "stop", "thr_a", "--json"]);
    assert_eq!(fake.only(), request("POST", "/threads/thr_a/stop", "", None));
    let data: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(data, json!({ "ok": true, "threadId": "thr_a" }));
    assert_eq!(ok(&fake.url, None, &["thread", "stop", "thr_a"]), "Thread thr_a stopped\n");

    let fake = Fake::json(json!({ "ok": true, "archivedThreadIds": ["thr_a"] }));
    let out = ok(&fake.url, None, &["thread", "archive", "thr_a", "--json"]);
    assert_eq!(fake.only().path, "/threads/thr_a/archive-all");
    let data: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(data, json!({ "ok": true, "archivedThreadIds": ["thr_a"], "threadId": "thr_a" }));

    let fake = Fake::json(thread("thr_a", "idle"));
    let out = ok(&fake.url, None, &["thread", "read", "thr_a", "--json"]);
    assert_eq!(fake.only().path, "/threads/thr_a/read");
    assert_eq!(serde_json::from_str::<Value>(&out).expect("json"), thread("thr_a", "idle"));
}

#[test]
fn spawn_with_parent_self() {
    let fake = Fake::json(thread("thr_new", "pending"));
    let argv = ["thread", "spawn", "--project", "proj_1", "--prompt", "go", "--parent-self"];
    let out = ok(&fake.url, Some("thr_me"), &argv);
    let body = json!({
        "projectId": "proj_1",
        "environment": { "type": "project-default" },
        "parentThreadId": "thr_me",
        "input": [{ "type": "text", "text": "go", "mentions": [] }],
        "origin": "cli",
        "startedOnBehalfOf": null,
    });
    assert_eq!(fake.only(), request("POST", "/threads", "", Some(body)));
    assert!(out.starts_with(
        "Thread spawned: thr_new\nYou will be notified when this thread is done.\n\nThread: \
         thr_new\n  Status: pending\n"
    ));
    assert!(out.ends_with("\n\n"));
    let error = fail(&fake.url, None, &argv);
    assert_eq!(error.message, "--parent-self requires BB_THREAD_ID to be set.");
    let argv = ["thread", "spawn", "--prompt", "go"];
    let error = fail(&fake.url, None, &argv);
    assert_eq!(error.message, "Missing required option --project <id>.");
    assert_eq!(error.hint.as_deref(), Some("Add --project <id> (see `bb project list`)."));
    let argv =
        ["thread", "spawn", "--project", "proj_1", "--prompt", "go", "--environment", "env_1"];
    ok(&fake.url, None, &argv);
    let body = fake.requests().pop().expect("request").body.expect("body");
    assert_eq!(body["environment"], json!({ "type": "reuse", "environmentId": "env_1" }));
}

#[test]
fn wait_polls_until_status_and_reports_failures() {
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    let fake = Fake::start(move |_| {
        let n = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let status = if n < 2 { "active" } else { "idle" };
        (200, thread("thr_a", status).to_string())
    });
    let out = ok(&fake.url, None, &["thread", "wait", "thr_a", "--poll-interval", "1ms"]);
    assert_eq!(out, "Thread thr_a reached status idle.\n");
    assert_eq!(fake.requests().len(), 3);
    assert!(fake.requests().iter().all(|r| r.method == "GET" && r.path == "/threads/thr_a"));

    let fake = Fake::json(thread("thr_a", "error"));
    let error = fail(&fake.url, None, &["thread", "wait", "thr_a"]);
    assert_eq!((error.code.as_str(), error.exit_code), ("unreachable", 4));
    let fake = Fake::json(thread("thr_a", "active"));
    let error = fail(&fake.url, None, &["thread", "wait", "thr_a", "--timeout", "0"]);
    assert_eq!(error.message, "Timed out waiting for thread thr_a to reach status idle.");
    assert_eq!((error.code.as_str(), error.exit_code), ("timeout", 2));
    let argv = ["thread", "wait", "thr_a", "--status", "idle", "--event", "x"];
    let error = fail(&fake.url, None, &argv);
    assert_eq!(error.message, "Provide only one of --status or --event.");
    assert_eq!((error.code.as_str(), error.exit_code), ("invalid_value", 3));

    let fake = Fake::json(json!({ "seq": 7 }));
    let argv = ["thread", "wait", "thr_a", "--event", "turn.completed", "--json"];
    let out = ok(&fake.url, None, &argv);
    let sent = fake.only();
    assert_eq!(sent.path, "/threads/thr_a/events/wait");
    assert!(sent.query.starts_with("type=turn.completed&waitMs="));
    let data: Value = serde_json::from_str(&out).expect("json");
    let target = json!({ "kind": "event", "eventType": "turn.completed" });
    assert_eq!(data, json!({ "threadId": "thr_a", "matched": true, "target": target }));
}

#[test]
fn queue_commands() {
    let rows = json!([{
        "id": "qm_1", "threadId": "thr_a", "failureReason": null, "sendAt": null,
        "waitingOn": { "kind": "provisioning" },
        "content": [{ "type": "text", "text": "do it" }, { "type": "image" }],
    }]);
    let fake = Fake::json(rows);
    let out = ok(&fake.url, Some("thr_a"), &["thread", "queue", "list", "--self"]);
    assert_eq!(fake.only(), request("GET", "/threads/thr_a/queued-messages", "", None));
    let expected = "\nID    THREAD  MESSAGE  WAITING\nqm_1  thr_a   do it    waiting for the \
                    workspace\n\n";
    assert_eq!(out, expected);

    let fake = Fake::json(json!({ "delivery": "steered" }));
    let out = ok(&fake.url, None, &["thread", "queue", "send", "thr_a", "qm_1", "--mode", "steer"]);
    let body = Some(json!({ "mode": "steer" }));
    let sent = request("POST", "/threads/thr_a/queued-messages/qm_1/send", "", body);
    assert_eq!(fake.only(), sent);
    assert_eq!(out, "Queued message qm_1 steered\n");

    let fake = Fake::start(|_| (204, String::new()));
    let out = ok(&fake.url, None, &["thread", "queue", "delete", "thr_a", "qm_1", "--json"]);
    assert_eq!(fake.only(), request("DELETE", "/threads/thr_a/queued-messages/qm_1", "", None));
    let data: Value = serde_json::from_str(&out).expect("json");
    assert_eq!(data, json!({ "threadId": "thr_a", "queuedMessageId": "qm_1", "ok": true }));
}

#[test]
fn section_commands() {
    let fake = Fake::json(json!([{ "id": "sec_1", "name": "Work" }]));
    let out = ok(&fake.url, None, &["thread", "section", "list"]);
    assert_eq!(fake.only(), request("GET", "/sections", "", None));
    assert_eq!(out, "\nID     NAME\nsec_1  Work\n\n");

    let fake = Fake::json(json!({ "id": "sec_2", "name": "New" }));
    let out = ok(&fake.url, None, &["thread", "section", "create", "New"]);
    let body = Some(json!({ "name": "New" }));
    assert_eq!(fake.only(), request("POST", "/sections", "", body));
    assert_eq!(out, "Section sec_2 created\n");
    let out = ok(&fake.url, None, &["thread", "section", "rename", "sec_2", "New"]);
    let body = Some(json!({ "id": "sec_2", "name": "New" }));
    assert_eq!(fake.requests()[1], request("PATCH", "/sections", "", body));
    assert_eq!(out, "Section sec_2 renamed to New\n");

    let fake = Fake::json(json!({ "id": "sec_2", "updatedThreadCount": 3 }));
    let out = ok(&fake.url, None, &["thread", "section", "delete", "sec_2", "--yes"]);
    let body = Some(json!({ "id": "sec_2" }));
    assert_eq!(fake.only(), request("DELETE", "/sections", "", body));
    assert_eq!(out, "Section sec_2 deleted; 3 thread(s) unsectioned\n");
}

#[test]
fn update_delete_output_and_search() {
    let fake = Fake::json(thread("thr_a", "idle"));
    let argv = ["thread", "update", "thr_a", "--title", "T", "--clear-section"];
    let out = ok(&fake.url, None, &argv);
    let body = Some(json!({ "title": "T", "sectionId": null }));
    assert_eq!(fake.only(), request("PATCH", "/threads/thr_a", "", body));
    assert_eq!(out, "Thread thr_a updated\n  title: T\n  sectionId: none\n");
    let error = fail(&fake.url, None, &["thread", "update", "thr_a"]);
    assert_eq!(error.message, "No changes requested.");
    let hint =
        "Change one of: title, parentThreadId, sectionId, model, reasoningLevel, visibility.";
    assert_eq!(error.hint.as_deref(), Some(hint));

    let fake = Fake::start(|_| (204, String::new()));
    let argv = ["thread", "delete", "thr_a", "--yes", "--confirm-child-threads"];
    assert_eq!(ok(&fake.url, None, &argv), "Thread thr_a deleted\n");
    let body = Some(json!({ "childThreadsConfirmed": true }));
    assert_eq!(fake.only(), request("DELETE", "/threads/thr_a", "", body));

    let fake = Fake::json(json!({ "output": "" }));
    assert_eq!(ok(&fake.url, None, &["thread", "output", "thr_a"]), "(no output)\n");
    let fake = Fake::json(json!({ "groups": [] }));
    ok(&fake.url, None, &["thread", "search", "needle here", "--limit", "5"]);
    let sent = fake.only();
    assert_eq!(
        (sent.path.as_str(), sent.query.as_str()),
        ("/threads/search", "limitPerGroup=5&query=needle%20here")
    );
}

fn interaction_server(payload: Value) -> Fake {
    Fake::start(move |request| {
        let body = if request.method == "GET" {
            json!({ "id": "pint_1", "status": "pending", "payload": payload })
        } else {
            json!({ "id": "pint_1", "status": "resolving" })
        };
        (200, body.to_string())
    })
}

#[test]
fn interactions_resolve_approval_and_answers() {
    let payload = json!({
        "kind": "approval",
        "availableDecisions": ["allow_once", "allow_for_session", "deny"],
        "subject": { "kind": "command", "sessionGrant": { "commands": ["ls"] } },
    });
    let fake = interaction_server(payload);
    let argv = ["thread", "interactions", "resolve", "pint_1", "thr_a", "--grant", "session"];
    let out = ok(&fake.url, None, &argv);
    assert_eq!(out, "Interaction pint_1 submitted; delivering to the provider\n");
    let sent = fake.requests();
    assert_eq!(sent[0], request("GET", "/threads/thr_a/interactions/pint_1", "", None));
    let body =
        json!({ "decision": "allow_for_session", "grantedPermissions": { "commands": ["ls"] } });
    let resolve = request("POST", "/threads/thr_a/interactions/pint_1/resolve", "", Some(body));
    assert_eq!(sent[1], resolve);
    let argv = ["thread", "interactions", "resolve", "pint_1", "thr_a", "--approve", "--deny"];
    let error = fail(&fake.url, None, &argv);
    let message = "Provide exactly one of --approve, --deny, --grant, --answer/--text or --value.";
    assert_eq!(error.message, message);

    let payload =
        json!({ "kind": "user_question", "questions": [{ "id": "env" }, { "id": "why" }] });
    let fake = interaction_server(payload);
    let argv = [
        "thread",
        "interactions",
        "resolve",
        "pint_1",
        "thr_a",
        "--answer",
        "env=staging",
        "--text",
        "why=because",
    ];
    ok(&fake.url, None, &argv);
    let answers = json!({ "env": { "selected": ["staging"] }, "why": { "selected": [], "freeText": "because" } });
    let body = json!({ "kind": "user_answer", "answers": answers });
    assert_eq!(fake.requests()[1].body, Some(body));
    let argv = ["thread", "interactions", "resolve", "pint_1", "thr_a", "--answer", "x"];
    let error = fail(&fake.url, None, &argv);
    assert_eq!(error.message, "'x' must start with a question ID: env, why.");

    let fake = interaction_server(json!({}));
    let argv = ["thread", "interactions", "resolve", "pint_1", "thr_a", "--value", "{\"a\":1}"];
    ok(&fake.url, None, &argv);
    let body = Some(json!({ "value": { "a": 1 } }));
    let respond = request("POST", "/threads/thr_a/interactions/pint_1/respond", "", body);
    assert_eq!(fake.only(), respond);
}

#[test]
fn remaining_actions_post_to_their_routes() {
    let acknowledged = [
        ("unarchive", "/unarchive", "unarchived"),
        ("compact", "/compact", "compaction requested"),
        ("clear", "/context/clear", "context cleared"),
    ];
    for (word, tail, done) in acknowledged {
        let fake = Fake::json(json!({}));
        let out = ok(&fake.url, None, &["thread", word, "thr_a"]);
        assert_eq!(fake.only(), request("POST", &format!("/threads/thr_a{tail}"), "", None));
        assert_eq!(out, format!("Thread thr_a {done}\n"));
    }
    for (word, tail) in [("pin", "/pin"), ("unpin", "/unpin"), ("unread", "/unread")] {
        let fake = Fake::json(thread("thr_a", "idle"));
        let out = ok(&fake.url, None, &["thread", word, "thr_a", "--json"]);
        assert_eq!(fake.only(), request("POST", &format!("/threads/thr_a{tail}"), "", None));
        assert_eq!(serde_json::from_str::<Value>(&out).expect("json"), thread("thr_a", "idle"));
    }
}

fn unimplemented() -> String {
    json!({ "code": "unimplemented", "message": "Nothing implements it" }).to_string()
}

#[test]
fn prompt_history_lists_pages() {
    let fake = Fake::json(json!({
        "entries": [{ "id": "p1", "text": "hello", "threadId": "thr_a", "projectId": "proj_1",
            "scope": "thread", "sentAt": 1_700_000_000_123_u64 }],
        "nextCursor": "c1",
    }));
    let out = ok(&fake.url, None, &["prompt-history", "list", "--limit", "1"]);
    assert_eq!(fake.only(), request("GET", "/threads/prompt-history", "limit=1", None));
    let expected = "\nCREATED                   THREAD  PROMPT\n2023-11-14T22:13:20.123Z  thr_a   \
                    hello\n\nNext page: bb prompt-history list --cursor c1 --limit 1\n";
    assert_eq!(out, expected);
}
