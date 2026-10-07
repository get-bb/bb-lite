#![allow(clippy::result_large_err)]

mod engine_interact_support;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::Duration;

use bb_core::types::ProviderId;
use bb_server::context::Ctx;
use bb_server::db::pending_interactions::{get_pending_interaction, list_active_interactions};
use bb_server::domain::changes::ThreadChangeKind;
use bb_server::domain::pending_interaction::PendingInteractionStatus as S;
use bb_server::domain::thread::ThreadStatus;
use bb_server::plugins::api::{DescribeSubmission, InputResult};
use bb_server::row;
use bb_server::threads::engine::{commit, settled};
use bb_server::threads::ingest::ingest_thread_events;
use bb_server::threads::interactions::*;
use engine_interact_support::*;
use futures::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn approval(request_id: &str) -> ProviderInteractionRequest {
    ProviderInteractionRequest {
        thread_id: "thr_a".into(),
        turn_id: None,
        request_id: request_id.into(),
        provider_id: ProviderId::Codex,
        provider_thread_id: "pt_1".into(),
        payload: json!({ "kind": "approval", "title": "Run ls", "availableDecisions": ["accept", "deny"] }),
    }
}

fn active_thread(fx: &Fixture) {
    seed(&fx.ctx, "thr_a", row! { "status" => "active", "activeTurnId" => "turn_1" });
}

fn only_active(ctx: &Ctx) -> String {
    let rows = list_active_interactions(&ctx.db, "thr_a").unwrap();
    assert_eq!(rows.len(), 1);
    rows[0].id.clone()
}

fn plugin_request(
    cancel: Option<CancellationToken>,
    timeout: Option<Duration>,
) -> PluginInputRequest {
    PluginInputRequest {
        thread_id: "thr_a".into(),
        plugin_id: "ask".into(),
        renderer_id: "form".into(),
        title: "Pick".into(),
        payload: json!({ "options": ["a", "b"] }),
        presentation: None,
        cancel,
        timeout,
        describe_submission: None,
    }
}

async fn open_input(
    ctx: &Ctx,
    request: PluginInputRequest,
) -> (tokio::task::JoinHandle<InputResult>, String) {
    let task_ctx = ctx.clone();
    let handle = tokio::spawn(async move { request_input(&task_ctx, request).await.unwrap() });
    for _ in 0..100 {
        if let Some(row) = list_active_interactions(&ctx.db, "thr_a").unwrap().pop() {
            return (handle, row.id);
        }
        tokio::task::yield_now().await;
    }
    panic!("the plugin interaction never opened");
}

#[tokio::test]
async fn registers_one_pending_interaction_and_refuses_the_rest() {
    let fx = fixture();
    active_thread(&fx);
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    let id = only_active(&fx.ctx);
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(row.turn_id.as_deref(), Some("turn_1"));
    assert_eq!(lifecycles(&fx.ctx, "thr_a").len(), 1);
    let changed = fx.changed(ThreadChangeKind::InteractionsChanged);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].as_ref().unwrap().has_pending_interaction, Some(true));

    let mut question = approval("req_2");
    question.payload = json!({ "kind": "user_question", "questions": [] });
    register_provider_interaction(&fx.ctx, HOST, question).unwrap();
    settled(&fx.ctx).await;
    assert_eq!(only_active(&fx.ctx), id);
    let refused = fx.runner.calls("resolveInteraction");
    assert_eq!(
        refused,
        vec![json!({ "threadId": "thr_a", "requestId": "req_2",
            "resolution": { "kind": "user_answer", "answers": {} } })]
    );
}

#[tokio::test]
async fn resolves_through_the_resolving_step() {
    let fx = fixture();
    active_thread(&fx);
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    let id = only_active(&fx.ctx);
    let wrong = resolve_provider_interaction(&fx.ctx, "thr_a", &id, json!({ "decision": "x" }));
    assert_eq!(
        wrong.unwrap_err().body.message,
        "This approval accepts a decision of: accept, deny."
    );
    let accept = json!({ "decision": "accept" });
    let resolving = resolve_provider_interaction(&fx.ctx, "thr_a", &id, accept.clone()).unwrap();
    assert_eq!(resolving.status, S::Resolving);
    let again = resolve_provider_interaction(&fx.ctx, "thr_a", &id, accept.clone()).unwrap();
    assert_eq!(again.status, S::Resolving);
    let other = resolve_provider_interaction(&fx.ctx, "thr_a", &id, json!({ "decision": "deny" }));
    assert_eq!(
        other.unwrap_err().body.message,
        format!("Pending interaction {id} is already resolving")
    );
    settled(&fx.ctx).await;
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(row.status, S::Resolved);
    let calls = fx.runner.calls("resolveInteraction");
    assert_eq!(
        calls,
        vec![json!({ "threadId": "thr_a", "requestId": "req_1", "resolution": accept })]
    );
    assert_eq!(lifecycles(&fx.ctx, "thr_a").len(), 3);
}

#[tokio::test]
async fn an_undelivered_resolution_interrupts_the_interaction() {
    let fx = fixture();
    active_thread(&fx);
    fx.runner.0.lock().delivered = false;
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    let id = only_active(&fx.ctx);
    resolve_provider_interaction(&fx.ctx, "thr_a", &id, json!({ "decision": "deny" })).unwrap();
    settled(&fx.ctx).await;
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(row.status, S::Interrupted);
    let reason = "The provider is no longer waiting for this interaction";
    assert_eq!(row.status_reason.as_deref(), Some(reason));
}

#[tokio::test]
async fn a_provider_cancel_interrupts_and_plugin_rules_hold() {
    let fx = fixture();
    active_thread(&fx);
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    let id = only_active(&fx.ctx);
    let refused = cancel_by_user(&fx.ctx, "thr_a", &id).unwrap_err();
    assert_eq!(
        refused.body.message,
        "A provider's request cannot be cancelled; stop the turn instead"
    );
    let event = ProviderInteractionCancel {
        thread_id: "thr_a".into(),
        request_id: "req_1".into(),
        reason: "provider gave up".into(),
    };
    cancel_provider_interaction(&fx.ctx, event).unwrap();
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(
        (row.status, row.status_reason.as_deref()),
        (S::Interrupted, Some("provider gave up"))
    );
    let last = fx.changed(ThreadChangeKind::InteractionsChanged).pop().unwrap().unwrap();
    assert_eq!(last.has_pending_interaction, Some(false));
    assert_eq!(lifecycles(&fx.ctx, "thr_a").len(), 2);
    let missing = resolve_provider_interaction(&fx.ctx, "thr_a", "pint_x", json!({}));
    assert_eq!(missing.unwrap_err().body.message, "Pending interaction not found");
}

#[tokio::test]
async fn plugin_input_is_submitted_with_a_description() {
    let fx = fixture();
    seed(&fx.ctx, "thr_a", row! {});
    let describe: DescribeSubmission = Arc::new(|value: Value| {
        async move { Some(json!({ "title": format!("  Chose {} ", value["pick"]), "extra": 1 })) }
            .boxed()
    });
    let mut request = plugin_request(None, None);
    request.describe_submission = Some(describe);
    let (handle, id) = open_input(&fx.ctx, request).await;
    let busy = request_input(&fx.ctx, plugin_request(None, None)).await.unwrap_err();
    assert_eq!(busy.body.message, "Thread thr_a is already awaiting user interaction");
    let value = json!({ "pick": 1 });
    let settled_row = respond_to_interaction(&fx.ctx, "thr_a", &id, value.clone()).await.unwrap();
    assert_eq!(settled_row.status, S::Resolved);
    assert_eq!(
        settled_row.resolution,
        Some(json!({ "kind": "plugin_submitted", "description": { "title": "Chose 1" } }))
    );
    assert_eq!(handle.await.unwrap(), InputResult::Submitted { value });
    let lifecycle = lifecycles(&fx.ctx, "thr_a");
    assert_eq!(lifecycle.len(), 2);
    let again = respond_to_interaction(&fx.ctx, "thr_a", &id, json!(2)).await.unwrap_err();
    assert_eq!(again.body.message, format!("Pending interaction {id} is already resolved"));
}

#[tokio::test]
async fn plugin_input_is_cancelled_by_the_user() {
    let fx = fixture();
    seed(&fx.ctx, "thr_a", row! {});
    let (handle, id) = open_input(&fx.ctx, plugin_request(None, None)).await;
    let row = cancel_by_user(&fx.ctx, "thr_a", &id).unwrap();
    assert_eq!((row.status, row.status_reason.as_deref()), (S::Interrupted, Some("user")));
    assert_eq!(handle.await.unwrap(), InputResult::Cancelled { reason: "user".into() });
    assert!(fx.ctx.engine.input_waiters.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn plugin_input_times_out() {
    let fx = fixture();
    seed(&fx.ctx, "thr_a", row! {});
    let request = plugin_request(None, Some(Duration::from_secs(30)));
    let (handle, id) = open_input(&fx.ctx, request).await;
    assert_eq!(handle.await.unwrap(), InputResult::Cancelled { reason: "timeout".into() });
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(row.status_reason.as_deref(), Some("timeout"));
}

#[tokio::test]
async fn plugin_input_is_aborted_by_its_signal() {
    let fx = fixture();
    seed(&fx.ctx, "thr_a", row! {});
    let early = CancellationToken::new();
    early.cancel();
    let result = request_input(&fx.ctx, plugin_request(Some(early), None)).await.unwrap();
    assert_eq!(result, InputResult::Cancelled { reason: "request-aborted".into() });
    assert!(lifecycles(&fx.ctx, "thr_a").is_empty());
    let signal = CancellationToken::new();
    let (handle, id) = open_input(&fx.ctx, plugin_request(Some(signal.clone()), None)).await;
    signal.cancel();
    assert_eq!(handle.await.unwrap(), InputResult::Cancelled { reason: "request-aborted".into() });
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    assert_eq!(row.status, S::Interrupted);
}

#[tokio::test]
async fn interrupt_all_cancels_waiting_plugins_with_the_reason() {
    let fx = fixture();
    let thread = seed(&fx.ctx, "thr_a", row! {});
    let (handle, _) = open_input(&fx.ctx, plugin_request(None, None)).await;
    let reason = "Thread stopped by user request";
    commit(&fx.ctx, |out| interrupt_all(&fx.ctx, out, &thread, reason)).unwrap();
    assert_eq!(handle.await.unwrap(), InputResult::Cancelled { reason: reason.into() });
    assert!(list_active_interactions(&fx.ctx.db, "thr_a").unwrap().is_empty());
}

fn turn(kind: &str, turn_id: &str, extra: Value) -> Value {
    let mut event = json!({ "type": kind, "scope": { "kind": "turn", "turnId": turn_id } });
    for (key, value) in extra.as_object().unwrap() {
        event[key] = value.clone();
    }
    event
}

#[tokio::test]
async fn ingests_a_root_turn_through_start_and_completion() {
    let fx = fixture();
    seed(&fx.ctx, "thr_a", row! {});
    let started = turn("turn/started", "turn_1", json!({}));
    let client = json!({ "type": "client/userMessage", "scope": { "kind": "thread" } });
    ingest_thread_events(&fx.ctx, "thr_a", &[client, started]).unwrap();
    let after_start = thread(&fx.ctx, "thr_a");
    assert_eq!(after_start.status, ThreadStatus::Active);
    assert_eq!(after_start.active_turn_id.as_deref(), Some("turn_1"));
    assert_eq!(events(&fx.ctx, "thr_a").len(), 1);
    let appended = fx.changed(ThreadChangeKind::EventsAppended);
    assert_eq!(appended[0].as_ref().unwrap().event_types, Some(vec!["turn/started".to_owned()]));
    assert_eq!(fx.changed(ThreadChangeKind::StatusChanged).len(), 1);

    let identity = json!({ "type": "thread/identity", "scope": { "kind": "thread" },
        "providerThreadId": "pt_9" });
    ingest_thread_events(&fx.ctx, "thr_a", &[identity]).unwrap();
    assert_eq!(thread(&fx.ctx, "thr_a").provider_thread_id.as_deref(), Some("pt_9"));

    let child = turn("turn/started", "turn_c", json!({ "parentToolCallId": "call_1" }));
    let child_done = turn("turn/completed", "turn_c", json!({ "status": "completed" }));
    ingest_thread_events(&fx.ctx, "thr_a", &[child, child_done]).unwrap();
    let still = thread(&fx.ctx, "thr_a");
    assert_eq!(
        (still.status, still.active_turn_id.as_deref()),
        (ThreadStatus::Active, Some("turn_1"))
    );

    let done = turn("turn/completed", "turn_1", json!({ "status": "completed" }));
    let ingested =
        catch_unwind(AssertUnwindSafe(|| ingest_thread_events(&fx.ctx, "thr_a", &[done])));
    drop(ingested);
    let idle = thread(&fx.ctx, "thr_a");
    assert_eq!((idle.status, idle.active_turn_id), (ThreadStatus::Idle, None));
}

#[tokio::test]
async fn a_failed_turn_interrupts_pending_interactions_and_errors_the_thread() {
    let fx = fixture();
    active_thread(&fx);
    register_provider_interaction(&fx.ctx, HOST, approval("req_1")).unwrap();
    let id = only_active(&fx.ctx);
    let failed = turn("turn/completed", "turn_1", json!({ "status": "failed" }));
    let ingested =
        catch_unwind(AssertUnwindSafe(|| ingest_thread_events(&fx.ctx, "thr_a", &[failed])));
    drop(ingested);
    assert_eq!(thread(&fx.ctx, "thr_a").status, ThreadStatus::Error);
    let row = get_pending_interaction(&fx.ctx.db, &id).unwrap().unwrap();
    let reason = "The turn ended before the interaction was resolved";
    assert_eq!((row.status, row.status_reason.as_deref()), (S::Interrupted, Some(reason)));
}
