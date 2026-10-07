#![allow(clippy::result_large_err)]

mod engine_lifecycle_support;

use std::time::Duration;

use bb_server::db::threads::get_thread;
use bb_server::domain::pending_interaction::PendingInteraction;
use bb_server::domain::thread::ThreadStatus;
use bb_server::threads::engine::settled;
use bb_server::threads::lifecycle;
use bb_server::threads::parent_notices::{
    ChildOutcome, NOTICE_BATCH_DELAY_MS, OutcomeItem, blocked_notice, flush_due_notices,
    outcome_notice, queue_child_outcome,
};
use engine_lifecycle_support::{HOST, World};
use serde_json::{Value, json};

fn status(world: &World, id: &str) -> ThreadStatus {
    world.row(id).unwrap().status
}

#[tokio::test]
async fn stopping_an_idle_thread_releases_its_session() {
    let world = World::new();
    world.thread("thr_a", "idle", None);
    lifecycle::stop_thread(&world.ctx, "thr_a").await.unwrap();
    settled(&world.ctx).await;
    assert_eq!(world.fake.calls_to("releaseSession"), vec![json!({ "threadId": "thr_a" })]);
    assert_eq!(status(&world, "thr_a"), ThreadStatus::Idle);
}

#[tokio::test]
async fn stopping_an_active_thread_requests_an_interrupt_and_waits_in_stopping() {
    let world = World::new();
    world.thread("thr_a", "active", None);
    lifecycle::stop_thread(&world.ctx, "thr_a").await.unwrap();
    assert_eq!(world.fake.calls_to("interruptTurn"), vec![json!({ "threadId": "thr_a" })]);
    assert_eq!(status(&world, "thr_a"), ThreadStatus::Stopping);
    let events = world.events("thr_a");
    let interrupted: Vec<&Value> =
        events.iter().filter(|event| event["reason"] == "manual-stop").collect();
    assert_eq!(interrupted.len(), 1, "{events:?}");
}

#[tokio::test]
async fn archives_the_tree_once_and_unarchives_one_thread() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    world.thread("thr_c", "idle", Some("thr_p"));
    let archived = lifecycle::archive_thread_tree(&world.ctx, "thr_p").await.unwrap();
    assert_eq!(archived, vec!["thr_c".to_owned(), "thr_p".to_owned()]);
    assert_eq!(world.row("thr_p").unwrap().archived_at, Some(1_000));
    assert_eq!(world.row("thr_c").unwrap().archived_at, Some(1_000));
    let again = lifecycle::archive_thread_tree(&world.ctx, "thr_p").await.unwrap();
    assert!(again.is_empty());
    lifecycle::unarchive_thread(&world.ctx, "thr_c").unwrap();
    assert_eq!(world.row("thr_c").unwrap().archived_at, None);
    assert_eq!(world.row("thr_p").unwrap().archived_at, Some(1_000));
}

#[tokio::test]
async fn an_archived_running_thread_is_stopped_after_the_undo_window() {
    let world = World::new();
    world.thread("thr_a", "active", None);
    lifecycle::archive_thread_tree(&world.ctx, "thr_a").await.unwrap();
    world.advance(29_999);
    lifecycle::sweep(&world.ctx).unwrap();
    settled(&world.ctx).await;
    assert!(world.fake.calls_to("interruptTurn").is_empty());
    world.advance(2);
    lifecycle::sweep(&world.ctx).unwrap();
    settled(&world.ctx).await;
    assert_eq!(world.fake.calls_to("interruptTurn").len(), 1);
    assert_eq!(status(&world, "thr_a"), ThreadStatus::Stopping);
}

#[tokio::test]
async fn deleting_a_parent_requires_confirmation() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    world.thread("thr_c", "idle", Some("thr_p"));
    let error = lifecycle::delete_thread_tree(&world.ctx, "thr_p", false).await.unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body.code, "child_threads_confirmation_required");
    assert_eq!(
        error.body.message,
        "This thread has child threads. Confirm to delete it; the child threads are kept."
    );
    assert!(world.row("thr_p").unwrap().deleted_at.is_none());
}

#[tokio::test]
async fn a_tombstoned_thread_has_its_storage_removed_and_then_its_row() {
    let world = World::new();
    world.thread("thr_a", "active", None);
    world.exec("UPDATE threads SET deleted_at = 5 WHERE id = ?", "thr_a");
    lifecycle::sweep(&world.ctx).unwrap();
    settled(&world.ctx).await;
    assert_eq!(world.fake.methods(), vec!["interruptTurn", "deleteThreadStorage"]);
    assert!(world.row("thr_a").is_none());
    assert!(world.ctx.engine.deleting.lock().is_empty());
}

#[tokio::test]
async fn a_tombstone_whose_storage_is_gone_only_drops_the_row() {
    let world = World::new();
    world.thread("thr_a", "idle", None);
    world.exec("UPDATE threads SET deleted_at = 5, storage_deleted_at = 6 WHERE id = ?", "thr_a");
    lifecycle::sweep(&world.ctx).unwrap();
    settled(&world.ctx).await;
    assert!(world.fake.methods().is_empty());
    assert!(get_thread(&world.ctx.db, "thr_a").unwrap().is_none());
}

#[tokio::test]
async fn reconcile_keeps_live_turns_on_the_same_instance() {
    let world = World::new();
    world.thread("thr_a", "active", None);
    *world.fake.sessions.lock() = vec![json!({
        "threadId": "thr_a",
        "providerId": "echo",
        "providerThreadId": "p_1",
        "activeTurnId": "turn_1",
    })];
    lifecycle::reconcile_host(&world.ctx, HOST).await.unwrap();
    settled(&world.ctx).await;
    lifecycle::reconcile_host(&world.ctx, HOST).await.unwrap();
    settled(&world.ctx).await;
    assert_eq!(world.ctx.engine.host_instances.lock().get(HOST).unwrap(), "inst_1");
    assert_eq!(status(&world, "thr_a"), ThreadStatus::Active);
    assert!(world.events("thr_a").is_empty());
    let methods = world.fake.methods();
    assert_eq!(methods, vec!["describe", "snapshot", "describe", "snapshot"]);
}

fn child(world: &World, id: &str, title: Option<&str>) -> bb_server::db::threads::ThreadRow {
    world.thread(id, "idle", Some("thr_p"));
    let mut row = world.row(id).unwrap();
    row.title = title.map(str::to_owned);
    row
}

fn item(world: &World, id: &str, status: &str, output: Option<&str>) -> OutcomeItem {
    OutcomeItem {
        outcome: ChildOutcome {
            status: status.to_owned(),
            failure_context: None,
            interruption: None,
        },
        child: child(world, id, Some("  Build the widget ")),
        output: output.map(str::to_owned),
    }
}

#[tokio::test]
async fn a_completed_child_notice_quotes_its_output() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    let notice = outcome_notice(&[item(&world, "thr_c", "completed", Some(" Done. \n"))]);
    assert_eq!(notice.kind, "child-completed");
    let text = "[bb system]\n\n@thread:thr_c completed:\n\nDone.";
    let mention = json!({
        "start": 13,
        "end": 26,
        "resource": { "kind": "thread", "threadId": "thr_c", "projectId": "prj", "label": "Build the widget" },
    });
    assert_eq!(notice.input, vec![json!({ "type": "text", "text": text, "mentions": [mention] })]);
    let outcomes = json!([{ "threadId": "thr_c", "status": "completed" }]);
    let subject = json!({
        "kind": "thread", "threadId": "thr_c", "threadName": "Build the widget", "outcomes": outcomes,
    });
    assert_eq!(notice.subject, subject);
    let empty = outcome_notice(&[item(&world, "thr_d", "completed", None)]);
    let text = empty.input[0]["text"].as_str().unwrap();
    assert!(text.ends_with(" completed:\n\nNo final output was recorded."));
}

#[tokio::test]
async fn a_long_output_is_truncated_with_a_marker() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    let output = "x".repeat(5_000);
    let notice = outcome_notice(&[item(&world, "thr_c", "completed", Some(&output))]);
    let text = notice.input[0]["text"].as_str().unwrap();
    let marker = "\n\n[... output truncated ...]";
    assert!(text.ends_with(marker));
    let excerpt = text.split(" completed:\n\n").nth(1).unwrap();
    assert_eq!(excerpt.len(), 4_000);
}

#[tokio::test]
async fn interrupted_and_batched_notices_name_the_cause() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    let mut lost = item(&world, "thr_c", "interrupted", None);
    let interruption =
        json!({ "reason": "host-daemon-restarted", "cause": "host-connection-lost" });
    lost.outcome.interruption = Some(interruption.clone());
    let single = outcome_notice(std::slice::from_ref(&lost));
    assert_eq!(single.kind, "child-interrupted");
    assert_eq!(
        single.input[0]["text"],
        "[bb system]\n\n@thread:thr_c was interrupted because its host connection was lost.\n\n\
         Review the thread before deciding next steps."
    );
    assert_eq!(single.subject["outcomes"][0]["interruption"], interruption);
    let mut failed = item(&world, "thr_d", "failed", None);
    failed.outcome.failure_context = Some("could not start".to_owned());
    let mut restarted = item(&world, "thr_e", "interrupted", None);
    restarted.outcome.interruption = Some(json!({ "reason": "host-daemon-restarted" }));
    let batch = outcome_notice(&[lost, failed, restarted]);
    assert_eq!(batch.kind, "child-outcome-batch");
    assert_eq!(
        batch.input[0]["text"],
        "[bb system]\n\nChild thread updates:\n\n\
         - @thread:thr_c was interrupted because its host connection was lost.\n\
         - @thread:thr_d could not start.\n\
         - @thread:thr_e was interrupted because its host daemon restarted."
    );
    assert_eq!(batch.input[0]["mentions"].as_array().unwrap().len(), 3);
    assert_eq!(batch.subject["kind"], "thread-batch");
    assert_eq!(batch.subject["count"], 3);
}

fn interaction(payload: Value) -> PendingInteraction {
    serde_json::from_value(json!({
        "id": "int_1",
        "threadId": "thr_c",
        "status": "pending",
        "statusReason": null,
        "createdAt": 1,
        "resolvedAt": null,
        "turnId": null,
        "origin": { "kind": "plugin", "pluginId": "p", "rendererId": "r" },
        "payload": payload,
        "resolution": null,
    }))
    .unwrap()
}

#[tokio::test]
async fn the_blocked_notice_summarizes_the_interaction() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    let row = child(&world, "thr_c", None);
    let command =
        json!({ "kind": "approval", "subject": { "kind": "command", "command": "rm -rf x" } });
    let notice = blocked_notice(&row, &interaction(command));
    assert_eq!(notice.kind, "child-needs-attention");
    assert_eq!(
        notice.subject,
        json!({ "kind": "thread", "threadId": "thr_c", "threadName": "thr_c" })
    );
    assert_eq!(
        notice.input[0]["text"],
        "[bb system]\n\n@thread:thr_c needs help.\nBlocked on command:\nCommand: rm -rf x\n\n\
         Review the blocker. If you can resolve it from existing context, reply to the thread \
         with guidance. Otherwise, ask the user for the missing decision."
    );
    let prompts: Vec<Value> =
        (1..=6).map(|index| json!({ "prompt": format!(" Question {index} ") })).collect();
    let question = json!({ "kind": "user_question", "questions": prompts });
    let text = blocked_notice(&row, &interaction(question)).input[0]["text"].clone();
    let text = text.as_str().unwrap();
    assert!(
        text.contains("\nBlocked on request:\nQuestion 1\nQuestion 2\nQuestion 3\nQuestion 4\n\n")
    );
    let file = json!({ "kind": "approval", "subject": { "kind": "file_change" } });
    let text = blocked_notice(&row, &interaction(file)).input[0]["text"].clone();
    assert!(
        text.as_str()
            .unwrap()
            .contains(" needs help.\nIt is blocked on a pending interaction.\n\n")
    );
}

fn outcome(status: &str, failure_context: Option<&str>) -> ChildOutcome {
    ChildOutcome {
        status: status.to_owned(),
        failure_context: failure_context.map(str::to_owned),
        interruption: None,
    }
}

#[tokio::test(start_paused = true)]
async fn outcomes_are_batched_per_parent_for_two_seconds() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    world.exec("UPDATE threads SET archived_at = 1 WHERE id = ?", "thr_p");
    let first = child(&world, "thr_c", Some("First"));
    let second = child(&world, "thr_d", Some("Second"));
    queue_child_outcome(&world.ctx, &first, outcome("failed", Some("x"))).unwrap();
    queue_child_outcome(&world.ctx, &first, outcome("failed", Some("x"))).unwrap();
    queue_child_outcome(&world.ctx, &first, outcome("failed", None)).unwrap();
    world.advance(500);
    queue_child_outcome(&world.ctx, &second, outcome("completed", None)).unwrap();
    {
        let batches = world.ctx.engine.notice_batches.lock();
        let batch = batches.get("thr_p").unwrap();
        assert_eq!(batch.items.len(), 3);
        assert_eq!(batch.due_at, 1_500 + NOTICE_BATCH_DELAY_MS);
    }
    tokio::time::sleep(Duration::from_millis(1_999)).await;
    assert!(world.ctx.engine.notice_batches.lock().contains_key("thr_p"));
    tokio::time::sleep(Duration::from_millis(2)).await;
    world.settle().await;
    assert!(world.ctx.engine.notice_batches.lock().is_empty());
    let mut orphan = first.clone();
    orphan.parent_thread_id = None;
    queue_child_outcome(&world.ctx, &orphan, outcome("completed", None)).unwrap();
    assert!(world.ctx.engine.notice_batches.lock().is_empty());
}

#[tokio::test]
async fn the_sweep_flushes_due_batches() {
    let world = World::new();
    world.thread("thr_p", "idle", None);
    world.exec("UPDATE threads SET archived_at = 1 WHERE id = ?", "thr_p");
    let first = child(&world, "thr_c", None);
    queue_child_outcome(&world.ctx, &first, outcome("failed", None)).unwrap();
    flush_due_notices(&world.ctx, 2_999).unwrap();
    assert_eq!(world.ctx.engine.notice_batches.lock().len(), 1);
    world.advance(NOTICE_BATCH_DELAY_MS);
    lifecycle::sweep(&world.ctx).unwrap();
    assert!(world.ctx.engine.notice_batches.lock().is_empty());
    settled(&world.ctx).await;
}
