//! Stop, archive, delete, context reset and host reconciliation. Port of
//! `apps/server/src/threads/lifecycle.ts`.

use bb_core::ids::new_id;
use serde_json::{Value, json};

use super::core::Outbox;
use super::engine::{
    announce_status, append, background, commit, connected_host_of, forget, host_of, in_thread,
    later, notify_parent, on_host, require_thread, respond, runtime_of, schedule_drain,
    status_metadata, tell, transition,
};
use super::interactions;
use super::parent_notices::{ChildOutcome, flush_due_notices};
use super::provisioning::cancel_provisioning;
use crate::context::Ctx;
use crate::db::pending_interactions as pending;
use crate::db::projects::DeletedProject;
use crate::db::queued_messages::list_thread_ids_waiting_on;
use crate::db::threads::{self as store, LifecycleOutcome, ThreadPatch, ThreadRow};
use crate::domain::changes::{ProjectChangeKind, ThreadChangeKind, ThreadChangeMetadata};
use crate::domain::events::{thread_scope, turn_scope};
use crate::domain::queued_message::QueuedMessageWaitingOnKind;
use crate::domain::thread::{ThreadLifecycleEventType as Lifecycle, ThreadStatus};
use crate::environments::manager::on_thread_detached;
use crate::error::{ApiError, ApiResult, conflict};
use crate::terminals::sessions::close_terminals_for;

const ARCHIVE_UNDO_GRACE_MS: i64 = 30_000;
const STOPPED_REASON: &str = "Thread stopped by user request";
const CONNECTION_LOST: &str = "host-connection-lost";
const CONTEXT_CLEAR_OPERATION: &str = "context_clear";
const CONTEXT_CLEARED_MESSAGE: &str =
    "Earlier chat is hidden from the active timeline. Durable history and workspace are unchanged.";

fn manual_stop() -> Value {
    json!({ "reason": "manual-stop" })
}

fn restarted() -> Value {
    json!({ "reason": "host-daemon-restarted" })
}

fn connection_lost() -> Value {
    json!({ "reason": "host-daemon-restarted", "cause": CONNECTION_LOST })
}

fn append_interrupted(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    interruption: &Value,
) -> ApiResult<()> {
    let mut event = json!({ "type": "system/thread/interrupted", "scope": thread_scope() });
    if let (Some(event), Some(fields)) = (event.as_object_mut(), interruption.as_object()) {
        event.extend(fields.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    append(ctx, out, thread, &[event])
}

fn close_active_turn(ctx: &Ctx, out: &Outbox, thread: &ThreadRow) -> ApiResult<()> {
    let Some(active_turn_id) = &thread.active_turn_id else { return Ok(()) };
    let event = json!({
        "type": "turn/completed",
        "scope": turn_scope(active_turn_id),
        "providerThreadId": thread.provider_thread_id,
        "status": "interrupted",
    });
    append(ctx, out, thread, &[event])?;
    let patch = ThreadPatch::new().set("activeTurnId", None::<String>);
    store::patch_thread(&ctx.db, &thread.id, &patch, false)?;
    Ok(())
}

fn request_stop(ctx: &Ctx, thread_id: &str) -> ApiResult<Option<String>> {
    let thread = require_thread(ctx, thread_id)?;
    let host_id = host_of(ctx, &thread)?;
    match thread.status {
        ThreadStatus::Stopping => return Ok(host_id),
        ThreadStatus::Active => {
            commit(ctx, |out| {
                append_interrupted(ctx, out, &thread, &manual_stop())?;
                transition(ctx, out, thread_id, Lifecycle::StopRequested)?;
                Ok(())
            })?;
            runtime_of(ctx, thread_id, |runtime| {
                runtime.cancelled_start = runtime.pending_start.clone();
            });
            return Ok(host_id);
        }
        ThreadStatus::Starting => {}
        _ => {
            tell(ctx, &thread, "release session", |runner, thread_id| async move {
                Ok(runner.call("releaseSession", json!({ "threadId": thread_id })).await?)
            })?;
            return Ok(None);
        }
    }
    commit(ctx, |out| {
        cancel_provisioning(ctx, out, &thread)?;
        append_interrupted(ctx, out, &thread, &manual_stop())?;
        interactions::interrupt_all(ctx, out, &thread, STOPPED_REASON)?;
        transition(ctx, out, thread_id, Lifecycle::StopRequested)?;
        transition(ctx, out, thread_id, Lifecycle::StopSettled)?;
        Ok(())
    })?;
    Ok(None)
}

fn finalize_stop(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    if thread.status != ThreadStatus::Stopping {
        return Ok(());
    }
    commit(ctx, |out| {
        close_active_turn(ctx, out, &thread)?;
        interactions::interrupt_all(ctx, out, &thread, STOPPED_REASON)?;
        transition(ctx, out, thread_id, Lifecycle::StopSettled)?;
        let (ctx, id) = (ctx.clone(), thread_id.to_owned());
        out.after(move || schedule_drain(&ctx, &id));
        Ok(())
    })
}

pub async fn stop_thread(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    let requested = in_thread(ctx, thread_id, async move { request_stop(&task_ctx, &id) });
    let Some(host_id) = requested.await? else { return Ok(()) };
    let id = thread_id.to_owned();
    let interrupted = on_host(ctx, &host_id, move |runner| async move {
        Ok(runner.call("interruptTurn", json!({ "threadId": id })).await?)
    })
    .await
    .map(|result| result["interrupted"].as_bool() == Some(true))
    .unwrap_or(false);
    if interrupted {
        return Ok(());
    }
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    in_thread(ctx, thread_id, async move { finalize_stop(&task_ctx, &id) }).await
}

fn interrupt_thread(ctx: &Ctx, thread_id: &str, interruption: Value) -> ApiResult<()> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    let running = [ThreadStatus::Starting, ThreadStatus::Active, ThreadStatus::Stopping];
    if !running.contains(&thread.status) {
        return Ok(());
    }
    runtime_of(ctx, thread_id, |runtime| {
        if let Some(provisioning) = runtime.provisioning.take() {
            provisioning.abort.cancel();
        }
    });
    let stopping = thread.status == ThreadStatus::Stopping;
    let lost = interruption["cause"].as_str() == Some(CONNECTION_LOST);
    let cause = if lost { "Connection to host was lost" } else { "Host daemon restarted" };
    let reason = format!("{cause} while awaiting user interaction");
    commit(ctx, |out| {
        close_active_turn(ctx, out, &thread)?;
        append_interrupted(ctx, out, &thread, &interruption)?;
        interactions::interrupt_all(ctx, out, &thread, &reason)?;
        let settlement = if stopping { Lifecycle::StopSettled } else { Lifecycle::RunFailed };
        let outcome = transition(ctx, out, thread_id, settlement)?;
        let LifecycleOutcome::Applied { thread: settled, .. } = outcome else { return Ok(()) };
        if stopping {
            return Ok(());
        }
        let outcome = ChildOutcome {
            status: "interrupted".to_owned(),
            failure_context: None,
            interruption: Some(interruption.clone()),
        };
        notify_parent(ctx, out, &settled, outcome);
        Ok(())
    })
}

fn change_membership(
    ctx: &Ctx,
    thread: &ThreadRow,
    patch: ThreadPatch,
    change: ThreadChangeKind,
    event: &'static str,
) -> ApiResult<()> {
    let (id, project_id) = (thread.id.clone(), thread.project_id.clone());
    commit(ctx, |out| {
        store::patch_thread(&ctx.db, &id, &patch, true)?;
        let metadata =
            ThreadChangeMetadata { project_id: Some(project_id.clone()), ..Default::default() };
        out.thread(&id, vec![change], Some(metadata));
        out.project(&project_id, vec![ProjectChangeKind::ThreadsChanged]);
        let (ctx, id) = (ctx.clone(), id.clone());
        out.after(move || {
            match respond(&ctx, &id) {
                Ok(thread) => ctx.plugins.emit(event, json!({ "thread": thread })),
                Err(error) => {
                    let err = error.to_string();
                    ctx.log.error("Thread follow-up failed", json!({ "err": err }));
                }
            }
            on_thread_detached(&ctx, &id);
        });
        Ok(())
    })
}

fn archive_one(ctx: &Ctx, thread_id: &str) -> ApiResult<bool> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(false) };
    if thread.deleted_at.is_some() || thread.archived_at.is_some() {
        return Ok(false);
    }
    let archived = ThreadPatch::new().set("archivedAt", ctx.now());
    let change = ThreadChangeKind::ArchivedChanged;
    change_membership(ctx, &thread, archived, change, "thread.archived")?;
    Ok(true)
}

/// Returns the ids of the threads it archived.
pub async fn archive_thread_tree(ctx: &Ctx, thread_id: &str) -> ApiResult<Vec<String>> {
    let root = require_thread(ctx, thread_id)?;
    let mut archived_thread_ids = Vec::new();
    for thread in store::list_archive_tree(&ctx.db, &root)? {
        let (task_ctx, id) = (ctx.clone(), thread.id.clone());
        let archived = in_thread(ctx, &thread.id, async move { archive_one(&task_ctx, &id) });
        if archived.await? {
            archived_thread_ids.push(thread.id.clone());
        }
    }
    Ok(archived_thread_ids)
}

pub fn unarchive_thread(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let thread = require_thread(ctx, thread_id)?;
    if thread.archived_at.is_none() {
        return Ok(());
    }
    let restored = ThreadPatch::new().set("archivedAt", None::<i64>);
    let change = ThreadChangeKind::ArchivedChanged;
    change_membership(ctx, &thread, restored, change, "thread.unarchived")?;
    schedule_drain(ctx, thread_id);
    Ok(())
}

async fn finalize_deletion(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let db = &ctx.db;
    let Some(thread) = store::get_thread(db, thread_id)? else { return Ok(()) };
    if thread.deleted_at.is_none() {
        return Ok(());
    }
    if let Some(host_id) = host_of(ctx, &thread)?
        && thread.storage_deleted_at.is_none()
    {
        if !ctx.runners.is_connected(&host_id) {
            return Ok(());
        }
        let runner = ctx.runners.get(&host_id)?;
        let params = json!({ "threadId": thread_id });
        if matches!(thread.status, ThreadStatus::Active | ThreadStatus::Stopping) {
            let _ = runner.call("interruptTurn", params.clone()).await;
        }
        runner.call("deleteThreadStorage", params).await?;
        let patch = ThreadPatch::new().set("storageDeletedAt", db.now());
        store::patch_thread(db, thread_id, &patch, false)?;
    }
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    in_thread(ctx, thread_id, async move {
        close_terminals_for(&task_ctx, "thread_id", &id, "thread-deleted");
        store::delete_thread_row(&task_ctx.db, &id)?;
        forget(&task_ctx, &id);
        Ok(())
    })
    .await
}

fn retry_deletions(ctx: &Ctx) -> ApiResult<()> {
    for thread in store::list_tombstoned_threads(&ctx.db)? {
        if !ctx.engine.deleting.lock().insert(thread.id.clone()) {
            continue;
        }
        let (task_ctx, id) = (ctx.clone(), thread.id.clone());
        background(ctx, "delete thread storage", async move {
            let finalized = finalize_deletion(&task_ctx, &id).await;
            task_ctx.engine.deleting.lock().remove(&id);
            finalized
        });
    }
    Ok(())
}

fn tombstone(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    if thread.deleted_at.is_some() {
        return Ok(());
    }
    runtime_of(ctx, thread_id, |runtime| {
        if let Some(provisioning) = runtime.provisioning.take() {
            provisioning.abort.cancel();
        }
    });
    commit(ctx, |out| interactions::interrupt_all(ctx, out, &thread, "thread-deleted"))?;
    let deleted = ThreadPatch::new().set("deletedAt", ctx.now());
    change_membership(ctx, &thread, deleted, ThreadChangeKind::ThreadDeleted, "thread.deleted")?;
    retry_deletions(ctx)
}

pub async fn delete_thread_tree(
    ctx: &Ctx,
    thread_id: &str,
    child_threads_confirmed: bool,
) -> ApiResult<()> {
    let root = require_thread(ctx, thread_id)?;
    let children = store::list_child_threads(&ctx.db, &root.id)?;
    if !child_threads_confirmed && !children.is_empty() {
        return Err(ApiError::new(
            409,
            "child_threads_confirmation_required",
            "This thread has child threads. Confirm to delete it; the child threads are kept.",
        ));
    }
    let (task_ctx, id) = (ctx.clone(), root.id.clone());
    in_thread(ctx, &root.id, async move { tombstone(&task_ctx, &id) }).await
}

pub fn release_deleted_project(ctx: &Ctx, deleted: &DeletedProject) -> ApiResult<()> {
    let mut online: Vec<&str> = Vec::new();
    for environment in &deleted.environments {
        let host_id = environment.host_id.as_str();
        if !online.contains(&host_id) && ctx.runners.is_connected(host_id) {
            online.push(host_id);
        }
    }
    for thread_id in &deleted.thread_ids {
        runtime_of(ctx, thread_id, |runtime| {
            if let Some(provisioning) = &runtime.provisioning {
                provisioning.abort.cancel();
            }
        });
        forget(ctx, thread_id);
        for host_id in &online {
            let id = thread_id.clone();
            let removed = on_host(ctx, host_id, move |runner| async move {
                Ok(runner.call("deleteThreadStorage", json!({ "threadId": id })).await?)
            });
            background(ctx, "delete project thread storage", removed);
        }
    }
    Ok(())
}

pub async fn clear_context(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let thread = crate::threads::engine::require_thread(ctx, thread_id)?;
    reset_context(ctx, &thread).await
}

pub async fn reset_context(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<()> {
    let db = &ctx.db;
    if thread.status != ThreadStatus::Idle && thread.status != ThreadStatus::Error {
        let state = "the thread is idle or failed";
        return Err(conflict(format!("Context can only be cleared when {state}")));
    }
    if pending::has_turn_bound_interaction(db, &thread.id)? {
        return Err(ApiError::new(
            409,
            "awaiting_user_interaction",
            "Resolve the pending interaction before clearing context",
        ));
    }
    if let Some(host_id) = connected_host_of(ctx, thread)? {
        let runner = ctx.runners.get(&host_id)?;
        runner.call("releaseSession", json!({ "threadId": thread.id })).await?;
    }
    commit(ctx, |out| {
        let event = json!({
            "type": "system/operation",
            "scope": thread_scope(),
            "operation": CONTEXT_CLEAR_OPERATION,
            "operationId": new_id("evt"),
            "status": "completed",
            "message": CONTEXT_CLEARED_MESSAGE,
        });
        append(ctx, out, thread, &[event])?;
        let patch = ThreadPatch::new().set("providerThreadId", None::<String>);
        store::patch_thread(db, &thread.id, &patch, false)?;
        let metadata = status_metadata(ctx, &thread.id)?;
        let changes = vec![ThreadChangeKind::HistoryRewritten, ThreadChangeKind::StatusChanged];
        out.thread(&thread.id, changes, Some(metadata));
        let (ctx, id) = (ctx.clone(), thread.id.clone());
        out.after(move || schedule_drain(&ctx, &id));
        Ok(())
    })
}

pub async fn reconcile_host(ctx: &Ctx, host_id: &str) -> ApiResult<()> {
    let db = &ctx.db;
    let runner = ctx.runners.get(host_id)?;
    let (info, snapshot) =
        tokio::try_join!(runner.call("describe", json!({})), runner.call("snapshot", json!({})))?;
    let instance_id = info["instanceId"].as_str().unwrap_or_default().to_owned();
    let restarted = {
        let mut instances = ctx.engine.host_instances.lock();
        let previous = instances.insert(host_id.to_owned(), instance_id.clone());
        previous.is_some_and(|previous| previous != instance_id)
    };
    let sessions = snapshot["sessions"].as_array().cloned().unwrap_or_default();
    let live: Vec<String> = sessions
        .iter()
        .filter(|session| session["activeTurnId"].is_string())
        .filter_map(|session| session["threadId"].as_str().map(str::to_owned))
        .collect();
    let statuses = [ThreadStatus::Active, ThreadStatus::Stopping];
    for thread in store::list_threads_on_host(db, host_id, &statuses)? {
        let is_live = live.contains(&thread.id);
        let (task_ctx, id) = (ctx.clone(), thread.id.clone());
        later(ctx, &thread.id, "reconcile thread", async move {
            if !restarted && is_live {
                return announce_status(&task_ctx, &id);
            }
            let interruption = if restarted { self::restarted() } else { connection_lost() };
            interrupt_thread(&task_ctx, &id, interruption)
        });
    }
    let offline = QueuedMessageWaitingOnKind::HostOffline;
    for thread_id in list_thread_ids_waiting_on(db, offline, None)? {
        schedule_drain(ctx, &thread_id);
    }
    retry_deletions(ctx)
}

pub fn on_host_disconnected(ctx: &Ctx, host_id: &str) -> ApiResult<()> {
    for thread in store::list_threads_on_host(&ctx.db, host_id, &[ThreadStatus::Active])? {
        announce_status(ctx, &thread.id)?;
    }
    Ok(())
}

pub fn recover_after_restart(ctx: &Ctx) -> ApiResult<()> {
    let db = &ctx.db;
    for row in pending::list_active_plugin_interactions(db)? {
        let (task_ctx, thread_id, id) = (ctx.clone(), row.thread_id.clone(), row.id);
        later(ctx, &row.thread_id, "interrupt plugin interaction", async move {
            let reason = "server-restarted";
            interactions::cancel_plugin_interaction(&task_ctx, &thread_id, &id, reason).map(drop)
        });
    }
    let statuses = [ThreadStatus::Active, ThreadStatus::Stopping];
    let local_host_id = ctx.runners.local_host_id();
    let mut interrupted = store::list_threads_on_host(db, local_host_id, &statuses)?;
    interrupted.extend(store::list_starting_threads(db)?);
    for thread in interrupted {
        let (task_ctx, id) = (ctx.clone(), thread.id.clone());
        later(ctx, &thread.id, "restart recovery", async move {
            interrupt_thread(&task_ctx, &id, restarted())
        });
    }
    Ok(())
}

pub fn sweep(ctx: &Ctx) -> ApiResult<()> {
    let db = &ctx.db;
    let time = ctx.now();
    flush_due_notices(ctx, time)?;
    let expired = time - ARCHIVE_UNDO_GRACE_MS;
    for thread in store::list_expired_archives(db, expired)? {
        close_terminals_for(ctx, "thread_id", &thread.id, "thread-archived");
        if !matches!(thread.status, ThreadStatus::Starting | ThreadStatus::Active) {
            continue;
        }
        let (task_ctx, id) = (ctx.clone(), thread.id.clone());
        background(ctx, "stop archived thread", async move { stop_thread(&task_ctx, &id).await });
    }
    let waiting = list_thread_ids_waiting_on(db, QueuedMessageWaitingOnKind::Time, Some(time))?;
    for thread_id in waiting {
        schedule_drain(ctx, &thread_id);
    }
    retry_deletions(ctx)
}
