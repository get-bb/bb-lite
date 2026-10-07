//! Events from a runner. The port of `apps/server/src/threads/ingest.ts`.

use serde_json::{Value, json};

use super::core::Outbox;
use super::engine::{
    commit, notify_parent, rename_session, runtime_of, schedule_drain, set_title, tell, transition,
};
use super::interactions::interrupt_all;
use super::parent_notices::ChildOutcome;
use crate::context::Ctx;
use crate::db::events::{EventSource, append_events};
use crate::db::threads::{LifecycleOutcome, ThreadPatch, ThreadRow, get_thread, patch_thread};
use crate::domain::changes::{ThreadChangeKind, ThreadChangeMetadata};
use crate::domain::thread::{ThreadLifecycleEventType, ThreadStatus};
use crate::error::ApiResult;

const FATAL_SYSTEM_ERROR_CODES: [&str; 2] =
    ["provider_process_exited", "provider_turn_start_timeout"];
const PROVIDER_EXIT_REASON: &str =
    "Provider process exited while awaiting user interaction; retry the thread to continue";
const TURN_ENDED_REASON: &str = "The turn ended before the interaction was resolved";
const STOPPED_REASON: &str = "Thread stopped by user request";
const BB_THREAD_NAME_PREFIX: &str = "[bb] ";

fn event_type(event: &Value) -> &str {
    event["type"].as_str().unwrap_or_default()
}

fn is_runner_authored(event: &Value) -> bool {
    let kind = event_type(event);
    kind == "system/error" || !(kind.starts_with("client/") || kind.starts_with("system/"))
}

fn changes_background_activity(event: &Value) -> bool {
    let Some(item) = event.get("item") else { return false };
    if item["type"] != "backgroundTask" {
        return false;
    }
    event_type(event) != "item/backgroundTask/progress" || item["status"] != "pending"
}

fn turn_id_of(event: &Value) -> Option<&str> {
    let scope = &event["scope"];
    if scope["kind"] != "turn" {
        return None;
    }
    scope["turnId"].as_str()
}

fn follow_up(ctx: &Ctx, result: ApiResult<()>) {
    if let Err(error) = result {
        ctx.log.error("Thread follow-up failed", json!({ "err": error.to_string() }));
    }
}

fn drain_after(ctx: &Ctx, out: &Outbox, thread_id: &str) {
    let (ctx, thread_id) = (ctx.clone(), thread_id.to_owned());
    out.after(move || schedule_drain(&ctx, &thread_id));
}

fn outcome_of(status: &str) -> ChildOutcome {
    ChildOutcome { status: status.to_owned(), failure_context: None, interruption: None }
}

fn on_root_turn_started(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    turn_id: &str,
) -> ApiResult<()> {
    let abandoned = runtime_of(ctx, &thread.id, |runtime| {
        let abandoned = runtime.cancelled_start.is_some()
            && (runtime.pending_start.is_none()
                || runtime.pending_start == runtime.cancelled_start);
        runtime.pending_start = None;
        runtime.cancelled_start = None;
        abandoned
    });
    let patch = ThreadPatch::new().set("activeTurnId", Some(turn_id.to_owned()));
    patch_thread(&ctx.db, &thread.id, &patch, false)?;
    if abandoned {
        let (ctx, thread) = (ctx.clone(), thread.clone());
        out.after(move || {
            let told = tell(&ctx, &thread, "interrupt turn", |runner, thread_id| async move {
                Ok(runner.call("interruptTurn", json!({ "threadId": thread_id })).await?)
            });
            follow_up(&ctx, told);
        });
        return Ok(());
    }
    transition(ctx, out, &thread.id, ThreadLifecycleEventType::RunStarted)?;
    drain_after(ctx, out, &thread.id);
    Ok(())
}

fn on_turn_completed(ctx: &Ctx, out: &Outbox, thread: &ThreadRow, event: &Value) -> ApiResult<()> {
    let Some(turn_id) = turn_id_of(event) else { return Ok(()) };
    if thread.active_turn_id.as_deref() != Some(turn_id) {
        return Ok(());
    }
    let patch = ThreadPatch::new().set("activeTurnId", None::<String>);
    patch_thread(&ctx.db, &thread.id, &patch, false)?;
    let status = event["status"].as_str().unwrap_or_default();
    let stopping = thread.status == ThreadStatus::Stopping;
    let stopped = status == "interrupted" && stopping;
    let reason = if stopped { STOPPED_REASON } else { TURN_ENDED_REASON };
    if status != "completed" {
        interrupt_all(ctx, out, thread, reason)?;
    }
    let lifecycle = if status == "failed" {
        ThreadLifecycleEventType::RunFailed
    } else if stopping {
        ThreadLifecycleEventType::StopSettled
    } else {
        ThreadLifecycleEventType::RunSucceeded
    };
    let outcome = transition(ctx, out, &thread.id, lifecycle)?;
    let LifecycleOutcome::Applied { thread: settled, .. } = outcome else { return Ok(()) };
    if !stopped {
        notify_parent(ctx, out, &settled, outcome_of(status));
    }
    if settled.status == ThreadStatus::Idle {
        drain_after(ctx, out, &thread.id);
    }
    Ok(())
}

fn adopt_provider_thread(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    provider_thread_id: &str,
) -> ApiResult<()> {
    if thread.provider_thread_id.as_deref() == Some(provider_thread_id) {
        return Ok(());
    }
    let patch = ThreadPatch::new().set("providerThreadId", Some(provider_thread_id.to_owned()));
    patch_thread(&ctx.db, &thread.id, &patch, false)?;
    if let Some(title) = thread.title.clone() {
        let (ctx, thread) = (ctx.clone(), thread.clone());
        out.after(move || follow_up(&ctx, rename_session(&ctx, &thread, &title)));
    }
    Ok(())
}

fn apply_effect(ctx: &Ctx, out: &Outbox, thread_id: &str, event: &Value) -> ApiResult<()> {
    let Some(thread) = get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    match event_type(event) {
        "thread/identity" => match event["providerThreadId"].as_str() {
            Some(provider_thread_id) => {
                adopt_provider_thread(ctx, out, &thread, provider_thread_id)
            }
            None => Ok(()),
        },
        "thread/name/updated" => {
            if thread.title.is_some() {
                return Ok(());
            }
            let raw = event["threadName"].as_str().unwrap_or_default();
            let name = raw.strip_prefix(BB_THREAD_NAME_PREFIX).unwrap_or(raw).trim();
            if name.is_empty() {
                return Ok(());
            }
            set_title(ctx, out, &thread, Some(name))
        }
        "turn/started" => {
            let nested = event
                .get("parentToolCallId")
                .is_some_and(|id| !(id.is_null() || id == "" || id == false));
            match turn_id_of(event) {
                Some(turn_id) if !nested => on_root_turn_started(ctx, out, &thread, turn_id),
                _ => Ok(()),
            }
        }
        "turn/completed" => on_turn_completed(ctx, out, &thread, event),
        "system/error" => {
            let code = event["code"].as_str().unwrap_or_default();
            if !FATAL_SYSTEM_ERROR_CODES.contains(&code) {
                return Ok(());
            }
            interrupt_all(ctx, out, &thread, PROVIDER_EXIT_REASON)?;
            let outcome = transition(ctx, out, thread_id, ThreadLifecycleEventType::RunFailed)?;
            if let LifecycleOutcome::Applied { thread: failed, .. } = outcome {
                notify_parent(ctx, out, &failed, outcome_of("failed"));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `events` are `RunnerThreadEvent`s.
pub fn ingest_thread_events(ctx: &Ctx, thread_id: &str, events: &[Value]) -> ApiResult<()> {
    let thread = match get_thread(&ctx.db, thread_id)? {
        Some(thread) if thread.deleted_at.is_none() => thread,
        _ => return Ok(()),
    };
    commit(ctx, |out| {
        let accepted: Vec<Value> =
            events.iter().filter(|e| is_runner_authored(e)).cloned().collect();
        let stored = append_events(&ctx.db, &thread, &accepted, EventSource::Runner)?;
        if stored.is_empty() {
            return Ok(());
        }
        let mut event_types: Vec<String> = Vec::new();
        for event in &stored {
            let kind = event_type(event);
            if !event_types.iter().any(|seen| seen == kind) {
                event_types.push(kind.to_owned());
            }
        }
        let background = stored.iter().any(changes_background_activity);
        let metadata = ThreadChangeMetadata {
            event_types: Some(event_types),
            background_activity_changed: background.then_some(true),
            ..Default::default()
        };
        out.thread(thread_id, vec![ThreadChangeKind::EventsAppended], Some(metadata));
        for event in &stored {
            apply_effect(ctx, out, thread_id, event)?;
        }
        Ok(())
    })
}
