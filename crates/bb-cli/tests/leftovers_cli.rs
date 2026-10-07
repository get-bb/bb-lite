mod support_b;

use bb_cli::call::CliEnv;
use bb_cli::commands::thread_more::pending_interaction_summary;
use serde_json::{Value, json};
use support_b::{FakeServer, route, run};

#[test]
fn interaction_summaries_follow_core_ui() {
    let summary = |payload: Value| pending_interaction_summary(&json!({ "payload": payload }));
    let question = json!({ "kind": "user_question", "questions": [{ "prompt": "Pick one" }] });
    assert_eq!(summary(question), "Pick one");
    assert_eq!(
        summary(json!({ "kind": "user_question", "questions": [] })),
        "User answer requested"
    );
    assert_eq!(summary(json!({ "kind": "plugin_form", "title": "Fill in" })), "Fill in");
    let approval = |subject: Value| json!({ "kind": "approval", "subject": subject });
    assert_eq!(summary(approval(json!({ "kind": "command", "command": "ls" }))), "ls");
    assert_eq!(
        summary(approval(json!({ "kind": "file_change" }))),
        "File changes pending approval"
    );
    assert_eq!(summary(approval(json!({ "kind": "plan" }))), "Plan ready for review");
    let tool =
        json!({ "kind": "tool_use", "presentation": { "label": { "pending": "Run Bash" } } });
    assert_eq!(summary(approval(tool)), "Run Bash");
    assert_eq!(summary(approval(json!({ "kind": "permission_grant" }))), "Permission request");
    let grant = json!({ "kind": "permission_grant", "toolName": "Edit" });
    assert_eq!(summary(approval(grant)), "Edit");
    let reasoned =
        json!({ "kind": "approval", "reason": "Because", "subject": { "kind": "plan" } });
    assert_eq!(summary(reasoned), "Because");
}

#[test]
fn interactions_list_prints_a_table() {
    let interactions = json!([{
        "id": "int_1",
        "status": "pending",
        "payload": { "kind": "approval", "subject": { "kind": "command", "command": "rm -rf x" } },
    }]);
    let server =
        FakeServer::start(vec![route("GET", "/threads/thr_1/interactions", interactions.clone())]);
    let (result, printed) =
        run(&server, &["thread", "interactions", "list", "thr_1"], CliEnv::default());
    result.unwrap();
    let expected = "ID     KIND      STATUS   SUMMARY\nint_1  approval  pending  rm -rf x\n";
    assert_eq!(printed.trim_matches('\n'), expected.trim_end());
    let words = ["thread", "interactions", "list", "thr_1", "--json"];
    let (result, printed) = run(&server, &words, CliEnv::default());
    result.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&printed).unwrap(), interactions);
}

#[test]
fn send_at_accepts_durations_and_timestamps() {
    use bb_cli::call::{send_at_ms, timestamp_ms};
    let now = 1_700_000_000_000.0;
    assert_eq!(send_at_ms(None, now).unwrap(), None);
    assert_eq!(send_at_ms(Some("10m"), now).unwrap(), Some(now + 600_000.0));
    assert_eq!(send_at_ms(Some(" 2h "), now).unwrap(), Some(now + 7_200_000.0));
    let utc_ms = 1_787_648_400_000.0;
    let utc = Some(utc_ms);
    assert_eq!(send_at_ms(Some("2026-08-25T09:00Z"), now).unwrap(), utc);
    assert_eq!(send_at_ms(Some("2026-08-25 11:00:00+02:00"), now).unwrap(), utc);
    assert_eq!(send_at_ms(Some("2026-08-25T04:00-0500"), now).unwrap(), utc);
    assert_eq!(timestamp_ms("2026-08-25T09:00:00.25Z"), Some(1_787_648_400_250.0));
    let local = timestamp_ms("2026-08-25T09:00").unwrap();
    assert!((local - utc_ms).abs() <= 14.0 * 3_600_000.0);
    let message = "Invalid --send-at '{}'. Expected a future ISO 8601 timestamp (2026-08-25T09:00) \
                   or a duration from now (30s, 10m, 2h, 7d).";
    for bad in ["2001-01-01T00:00Z", "10", "10M", "tomorrow", "2026-13-01T00:00", "2026-08-25"] {
        let error = send_at_ms(Some(bad), now).unwrap_err();
        assert_eq!(error.message, message.replace("{}", bad), "{bad}");
    }
}

#[test]
fn spawn_and_tell_send_send_at() {
    let thread = json!({ "id": "thr_9", "status": "pending", "title": null });
    let server = FakeServer::start(vec![
        route("POST", "/threads", thread),
        route("POST", "/threads/thr_9/send", json!({ "delivery": "scheduled" })),
    ]);
    let words = [
        "thread",
        "spawn",
        "--prompt",
        "hi",
        "--project",
        "prj_1",
        "--send-at",
        "2099-01-01T00:00Z",
    ];
    let (result, printed) = run(&server, &words, CliEnv::default());
    result.unwrap();
    assert!(printed.contains("First message scheduled for "), "{printed}");
    let words = ["thread", "tell", "thr_9", "hello", "--send-at", "5m"];
    run(&server, &words, CliEnv::default()).0.unwrap();
    let requests = server.requests();
    let spawned = requests.iter().find(|r| r.path == "/threads").unwrap();
    assert_eq!(spawned.body.as_ref().unwrap()["sendAt"], json!(4_070_908_800_000_i64));
    let told = requests.iter().find(|r| r.path == "/threads/thr_9/send").unwrap();
    assert!(told.body.as_ref().unwrap()["sendAt"].is_i64());
}
