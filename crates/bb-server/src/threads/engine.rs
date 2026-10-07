//! The thread engine. The port of `apps/server/src/threads/engine.ts`: the
//! `Engine` class becomes [`EngineState`] (reached as `ctx.engine`) plus the
//! free functions of this module; `createThreadEngine` is [`ops`].

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::Duration;

use bb_core::SharedRunner;
use bb_core::events::{RunnerEvent, RunnerEventBody};
use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::core::{Outbox, ThreadRuntime, ThreadSerial, not_writable};
use super::dispatch::{self, DispatchArgs};
use super::interactions::{
    self, InputWaiter, ProviderInteractionCancel, ProviderInteractionRequest,
};
use super::parent_notices::{self, ChildOutcome, NoticeBatch};
use super::thread_display::{ThreadResponse, to_thread_list_entries, to_thread_response};
use super::tool_calls::{self, ToolCallEvent};
use super::{ingest, lifecycle, provisioning};
use crate::context::{Ctx, ServerContext};
use crate::db::environments::get_environment;
use crate::db::event_read::last_output;
use crate::db::events::{EventSource, append_events, last_system_error_message};
use crate::db::queued_messages::{
    QueuedMessageWaitingOn, list_queued_messages, parse_queued_wait, set_queued_message_wait,
};
use crate::db::thread_read::{ThreadListRow, find_thread_list_row};
use crate::db::threads::{self as store, LifecycleOutcome, ThreadPatch, ThreadRow};
use crate::domain::changes::{ThreadChangeKind, ThreadChangeMetadata, ThreadStatusChange};
use crate::domain::events::thread_scope;
use crate::domain::thread::{ThreadLifecycleEventType, ThreadStatus};
use crate::error::{ApiError, ApiResult, thread_not_found};
use crate::plugins::api::InputResult;

pub mod ops;

const SWEEP_INTERVAL_MS: u64 = 10_000;
const CLOSE_GRACE_MS: u64 = 2_000;

/// A `system/error` event's fields.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadFailure {
    pub code: String,
    pub message: String,
    pub detail: String,
}

type Disposer = Box<dyn FnOnce() + Send>;

pub struct EngineState {
    pub input_waiters: Mutex<HashMap<String, InputWaiter>>,
    pub tool_calls: Mutex<HashMap<String, CancellationToken>>,
    pub notice_batches: Mutex<HashMap<String, NoticeBatch>>,
    pub deleting: Mutex<HashSet<String>>,
    pub host_instances: Mutex<HashMap<String, String>>,
    pub serial: ThreadSerial,
    runtimes: Mutex<HashMap<String, ThreadRuntime>>,
    pending: watch::Sender<usize>,
    disposers: Mutex<Vec<Disposer>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            input_waiters: Mutex::default(),
            tool_calls: Mutex::default(),
            notice_batches: Mutex::default(),
            deleting: Mutex::default(),
            host_instances: Mutex::default(),
            serial: ThreadSerial::new(),
            runtimes: Mutex::default(),
            pending: watch::Sender::new(0),
            disposers: Mutex::default(),
        }
    }
}

/// Queues `work` behind everything already queued for `thread_id`. The place
/// is reserved when this is called, not when the future is first polled.
pub fn in_thread<T, F>(
    ctx: &Ctx,
    thread_id: &str,
    work: F,
) -> impl Future<Output = T> + Send + 'static
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    ctx.engine.serial.run(thread_id, work)
}

struct PendingGuard(watch::Sender<usize>);

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.send_modify(|count| *count -= 1);
    }
}

/// Spawns `work`, logs its failure and lets [`settled`] wait for it.
pub fn background<T, F>(ctx: &Ctx, label: &str, work: F)
where
    F: Future<Output = ApiResult<T>> + Send + 'static,
    T: Send + 'static,
{
    ctx.engine.pending.send_modify(|count| *count += 1);
    let guard = PendingGuard(ctx.engine.pending.clone());
    let (ctx, label) = (ctx.clone(), label.to_owned());
    tokio::spawn(async move {
        if let Err(error) = work.await {
            let err = error.to_string();
            ctx.log.error("Thread engine work failed", json!({ "err": err, "label": label }));
        }
        drop(guard);
    });
}

pub fn later<T, F>(ctx: &Ctx, thread_id: &str, label: &str, work: F)
where
    F: Future<Output = ApiResult<T>> + Send + 'static,
    T: Send + 'static,
{
    background(ctx, label, in_thread(ctx, thread_id, work));
}

pub fn on_host<T, F, Fut>(
    ctx: &Ctx,
    host_id: &str,
    call: F,
) -> impl Future<Output = ApiResult<T>> + Send + 'static
where
    F: FnOnce(SharedRunner) -> Fut + Send + 'static,
    Fut: Future<Output = ApiResult<T>> + Send + 'static,
    T: Send + 'static,
{
    let (ctx, host_id) = (ctx.clone(), host_id.to_owned());
    async move {
        let runner = ctx.runners.get(&host_id)?;
        call(runner).await
    }
}

/// Runs `work` in one transaction; what it put in the outbox is released only
/// after the transaction commits.
pub fn commit<T>(ctx: &Ctx, work: impl FnOnce(&Outbox) -> ApiResult<T>) -> ApiResult<T> {
    let out = Outbox::new(ctx.hub.clone());
    let result = ctx.db.transaction(|| work(&out))?;
    out.flush();
    Ok(result)
}

/// `runtimeOf`: the thread's runtime state, created empty on first use.
pub fn runtime_of<R>(ctx: &Ctx, thread_id: &str, work: impl FnOnce(&mut ThreadRuntime) -> R) -> R {
    let mut runtimes = ctx.engine.runtimes.lock();
    work(runtimes.entry(thread_id.to_owned()).or_default())
}

pub fn forget(ctx: &Ctx, thread_id: &str) {
    ctx.engine.runtimes.lock().remove(thread_id);
}

pub fn require_thread(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadRow> {
    store::require_thread(&ctx.db, thread_id)
}

pub fn host_of(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<Option<String>> {
    let Some(environment_id) = &thread.environment_id else { return Ok(None) };
    Ok(get_environment(&ctx.db, environment_id)?.map(|environment| environment.host_id))
}

pub fn connected_host_of(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<Option<String>> {
    let host_id = host_of(ctx, thread)?;
    Ok(host_id.filter(|host_id| ctx.runners.is_connected(host_id)))
}

fn listed(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadListRow> {
    find_thread_list_row(&ctx.db, thread_id)?.ok_or_else(thread_not_found)
}

pub fn status_metadata(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadChangeMetadata> {
    let entries = to_thread_list_entries(ctx, &[listed(ctx, thread_id)?])?;
    let entry = entries.into_iter().next().ok_or_else(thread_not_found)?;
    let change = ThreadStatusChange {
        status: entry.thread.status.as_str().to_owned(),
        runtime: serde_json::to_value(&entry.runtime)?,
        activity: serde_json::to_value(&entry.activity)?,
        latest_attention_at: entry.thread.latest_attention_at,
        updated_at: entry.thread.updated_at,
    };
    Ok(ThreadChangeMetadata {
        project_id: Some(entry.thread.project_id.clone()),
        status_change: Some(Box::new(change)),
        ..ThreadChangeMetadata::default()
    })
}

pub fn announce_status(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    if store::get_thread(&ctx.db, thread_id)?.is_none() {
        return Ok(());
    }
    let metadata = status_metadata(ctx, thread_id)?;
    ctx.hub.thread(thread_id, vec![ThreadChangeKind::StatusChanged], Some(metadata));
    Ok(())
}

pub fn respond(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadResponse> {
    to_thread_response(ctx, &listed(ctx, thread_id)?)
}

pub fn append(ctx: &Ctx, out: &Outbox, thread: &ThreadRow, events: &[Value]) -> ApiResult<()> {
    append_events(&ctx.db, thread, events, EventSource::Server)?;
    let mut event_types: Vec<String> = Vec::new();
    for event in events {
        let kind = event["type"].as_str().unwrap_or_default();
        if !event_types.iter().any(|seen| seen == kind) {
            event_types.push(kind.to_owned());
        }
    }
    let metadata = ThreadChangeMetadata { event_types: Some(event_types), ..Default::default() };
    out.thread(&thread.id, vec![ThreadChangeKind::EventsAppended], Some(metadata));
    Ok(())
}

fn emit_status(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<()> {
    let (db, plugins) = (&ctx.db, &ctx.plugins);
    let response = respond(ctx, &thread.id)?;
    match thread.status {
        ThreadStatus::Active => plugins.emit("thread.active", json!({ "thread": response })),
        ThreadStatus::Idle => {
            let text = last_output(db, &thread.id)?;
            let payload = json!({ "thread": response, "lastAssistantText": text });
            plugins.emit("thread.idle", payload);
        }
        ThreadStatus::Error => {
            let error = last_system_error_message(db, &thread.id)?;
            plugins.emit("thread.failed", json!({ "thread": response, "error": error }));
        }
        _ => {}
    }
    Ok(())
}

fn follow_up(ctx: &Ctx, result: ApiResult<()>) {
    if let Err(error) = result {
        ctx.log.error("Thread follow-up failed", json!({ "err": error.to_string() }));
    }
}

pub fn transition(
    ctx: &Ctx,
    out: &Outbox,
    thread_id: &str,
    event: ThreadLifecycleEventType,
) -> ApiResult<LifecycleOutcome> {
    let outcome = store::apply_lifecycle_event(&ctx.db, thread_id, event)?;
    let LifecycleOutcome::Applied { thread, .. } = &outcome else { return Ok(outcome) };
    let metadata = status_metadata(ctx, thread_id)?;
    out.thread(thread_id, vec![ThreadChangeKind::StatusChanged], Some(metadata));
    let (ctx, thread) = (ctx.clone(), thread.clone());
    out.after(move || follow_up(&ctx, emit_status(&ctx, &thread)));
    Ok(outcome)
}

pub fn fail_thread(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    failure: &ThreadFailure,
    failure_context: Option<&str>,
) -> ApiResult<()> {
    let event = json!({
        "type": "system/error",
        "scope": thread_scope(),
        "code": failure.code,
        "message": failure.message,
        "detail": failure.detail,
    });
    append(ctx, out, thread, &[event])?;
    let stopping = thread.status == ThreadStatus::Stopping;
    let settlement = if stopping {
        ThreadLifecycleEventType::StopSettled
    } else {
        ThreadLifecycleEventType::RunFailed
    };
    let outcome = transition(ctx, out, &thread.id, settlement)?;
    let LifecycleOutcome::Applied { thread: failed, .. } = outcome else { return Ok(()) };
    if stopping {
        return Ok(());
    }
    let outcome = ChildOutcome {
        status: "failed".to_owned(),
        failure_context: failure_context.map(str::to_owned),
        interruption: None,
    };
    notify_parent(ctx, out, &failed, outcome);
    Ok(())
}

/// Moves the thread's queued rows whose wait kind is one of `from` (`None`
/// matches rows without a wait) to `to`.
pub fn relabel_waits(
    ctx: &Ctx,
    out: &Outbox,
    thread_id: &str,
    from: &[Option<&str>],
    to: Option<&QueuedMessageWaitingOn>,
) -> ApiResult<()> {
    let rows: Vec<_> = list_queued_messages(&ctx.db, thread_id)?
        .into_iter()
        .filter(|row| {
            let wait = parse_queued_wait(row);
            let kind = wait.as_ref().and_then(|wait| wait["kind"].as_str());
            from.contains(&kind)
        })
        .collect();
    if rows.is_empty() {
        return Ok(());
    }
    set_queued_message_wait(&ctx.db, &rows, to)?;
    out.thread(thread_id, vec![ThreadChangeKind::QueueChanged], None);
    Ok(())
}

pub fn set_title(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    title: Option<&str>,
) -> ApiResult<()> {
    let patch = ThreadPatch::new().set("title", title.map(str::to_owned));
    store::patch_thread(&ctx.db, &thread.id, &patch, true)?;
    let metadata =
        ThreadChangeMetadata { project_id: Some(thread.project_id.clone()), ..Default::default() };
    out.thread(&thread.id, vec![ThreadChangeKind::TitleChanged], Some(metadata));
    Ok(())
}

/// Fires `call` at the thread's machine in the background when it is online.
pub fn tell<F, Fut>(ctx: &Ctx, thread: &ThreadRow, label: &str, call: F) -> ApiResult<()>
where
    F: FnOnce(SharedRunner, String) -> Fut + Send + 'static,
    Fut: Future<Output = ApiResult<Value>> + Send + 'static,
{
    let Some(host_id) = connected_host_of(ctx, thread)? else { return Ok(()) };
    let thread_id = thread.id.clone();
    let told = on_host(ctx, &host_id, move |runner| call(runner, thread_id));
    background(ctx, label, told);
    Ok(())
}

pub fn rename_session(ctx: &Ctx, thread: &ThreadRow, title: &str) -> ApiResult<()> {
    let title = title.to_owned();
    tell(ctx, thread, "rename session", move |runner, thread_id| async move {
        let params = json!({ "threadId": thread_id, "title": title });
        Ok(runner.call("renameSession", params).await?)
    })
}

pub fn adopt_title(ctx: &Ctx, thread_id: &str, title: &str) -> ApiResult<()> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    if thread.title.is_some() {
        return Ok(());
    }
    commit(ctx, |out| set_title(ctx, out, &thread, Some(title)))?;
    if thread.provider_thread_id.is_some() {
        rename_session(ctx, &thread, title)?;
    }
    Ok(())
}

pub fn schedule_drain(ctx: &Ctx, thread_id: &str) {
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    later(
        ctx,
        thread_id,
        "drain queue",
        async move { dispatch::drain_queue(&task_ctx, &id).await },
    );
}

pub fn begin_provisioning(ctx: &Ctx, thread: &ThreadRow, args: DispatchArgs) -> ApiResult<()> {
    provisioning::begin_provisioning(ctx, thread, args)
}

pub async fn reset_context(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<()> {
    lifecycle::reset_context(ctx, thread).await
}

pub fn notify_parent(ctx: &Ctx, out: &Outbox, child: &ThreadRow, outcome: ChildOutcome) {
    let (ctx, child) = (ctx.clone(), child.clone());
    out.after(move || {
        follow_up(&ctx, parent_notices::queue_child_outcome(&ctx, &child, outcome));
    });
}

pub fn require_unarchived(ctx: &Ctx, thread_id: &str) -> ApiResult<ThreadRow> {
    let thread = require_thread(ctx, thread_id)?;
    if thread.archived_at.is_none() {
        return Ok(thread);
    }
    Err(not_writable(&thread, "archived", "Thread is archived"))
}

pub fn sender_of(
    ctx: &Ctx,
    thread: &ThreadRow,
    sender_thread_id: Option<&str>,
) -> ApiResult<Option<String>> {
    let Some(sender_thread_id) = sender_thread_id.filter(|id| *id != thread.id) else {
        return Ok(None);
    };
    let sender = store::get_thread(&ctx.db, sender_thread_id)?;
    if let Some(sender) = &sender
        && sender.deleted_at.is_none()
    {
        return Ok(Some(sender.id.clone()));
    }
    let reason = if sender.is_none() { "not_found" } else { "deleted" };
    let details = json!({ "reason": reason, "subject": "sender" });
    Err(ApiError::new(400, "parent_thread_invalid", "Sender thread is invalid").details(details))
}

fn handler(
    ctx: &Ctx,
    handle: impl Fn(&Ctx, RunnerEventBody, String) -> BoxFuture<'static, ApiResult<()>>
    + Send
    + Sync
    + 'static,
) -> crate::runners::registry::RunnerEventHandler {
    let weak: Weak<ServerContext> = Arc::downgrade(ctx);
    Arc::new(move |event: RunnerEvent, host_id: String| match weak.upgrade() {
        Some(ctx) => handle(&ctx, event.body, host_id),
        None => async { Ok(()) }.boxed(),
    })
}

fn ready(result: ApiResult<()>) -> BoxFuture<'static, ApiResult<()>> {
    async move { result }.boxed()
}

pub fn start(ctx: &Ctx) -> ApiResult<()> {
    let runners = &ctx.runners;
    let registrations = [
        runners.on_event(
            "thread.events",
            handler(ctx, |ctx, body, _| match body {
                RunnerEventBody::ThreadEvents { thread_id, events } => {
                    let task_ctx = ctx.clone();
                    let id = thread_id.clone();
                    in_thread(ctx, &thread_id, async move {
                        ingest::ingest_thread_events(&task_ctx, &id, &events)
                    })
                    .boxed()
                }
                _ => ready(Ok(())),
            }),
        ),
        runners.on_event(
            "interaction.requested",
            handler(ctx, |ctx, body, host_id| match body {
                RunnerEventBody::InteractionRequested {
                    thread_id,
                    turn_id,
                    request_id,
                    provider_id,
                    provider_thread_id,
                    payload,
                } => {
                    let event = ProviderInteractionRequest {
                        thread_id: thread_id.clone(),
                        turn_id,
                        request_id,
                        provider_id,
                        provider_thread_id,
                        payload,
                    };
                    let task_ctx = ctx.clone();
                    in_thread(ctx, &thread_id, async move {
                        interactions::register_provider_interaction(&task_ctx, &host_id, event)
                    })
                    .boxed()
                }
                _ => ready(Ok(())),
            }),
        ),
        runners.on_event(
            "interaction.cancelled",
            handler(ctx, |ctx, body, _| match body {
                RunnerEventBody::InteractionCancelled { thread_id, request_id, reason } => {
                    let event = ProviderInteractionCancel {
                        thread_id: thread_id.clone(),
                        request_id,
                        reason,
                    };
                    let task_ctx = ctx.clone();
                    in_thread(ctx, &thread_id, async move {
                        interactions::cancel_provider_interaction(&task_ctx, event)
                    })
                    .boxed()
                }
                _ => ready(Ok(())),
            }),
        ),
        runners.on_event(
            "toolCall.requested",
            handler(ctx, |ctx, body, host_id| match body {
                RunnerEventBody::ToolCallRequested {
                    thread_id,
                    turn_id,
                    request_id,
                    call_id,
                    tool,
                    arguments,
                } => {
                    let event =
                        ToolCallEvent { thread_id, turn_id, request_id, call_id, tool, arguments };
                    ready(tool_calls::start_tool_call(ctx, &host_id, event))
                }
                _ => ready(Ok(())),
            }),
        ),
        runners.on_event(
            "toolCall.cancelled",
            handler(ctx, |ctx, body, _| match body {
                RunnerEventBody::ToolCallCancelled { request_id, .. } => {
                    tool_calls::cancel_tool_call(ctx, &request_id);
                    ready(Ok(()))
                }
                _ => ready(Ok(())),
            }),
        ),
    ];
    let weak = Arc::downgrade(ctx);
    let connected = runners.on_connected(Arc::new(move |host_id: &str| {
        let Some(ctx) = weak.upgrade() else { return };
        let (task_ctx, host_id) = (ctx.clone(), host_id.to_owned());
        let reconciled = async move { lifecycle::reconcile_host(&task_ctx, &host_id).await };
        background(&ctx, "reconcile host", reconciled);
    }));
    let weak = Arc::downgrade(ctx);
    let disconnected = runners.on_disconnected(Arc::new(move |host_id: &str| {
        let Some(ctx) = weak.upgrade() else { return };
        follow_up(&ctx, lifecycle::on_host_disconnected(&ctx, host_id));
    }));
    {
        let mut disposers = ctx.engine.disposers.lock();
        for registration in registrations.into_iter().chain([connected, disconnected]) {
            disposers.push(Box::new(move || registration.remove()));
        }
    }
    lifecycle::recover_after_restart(ctx)?;
    let stop = CancellationToken::new();
    let (weak, stopped) = (Arc::downgrade(ctx), stop.clone());
    tokio::spawn(async move {
        let period = Duration::from_millis(SWEEP_INTERVAL_MS);
        let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            tokio::select! {
                _ = stopped.cancelled() => return,
                _ = timer.tick() => {}
            }
            let Some(ctx) = weak.upgrade() else { return };
            follow_up(&ctx, lifecycle::sweep(&ctx));
        }
    });
    ctx.engine.disposers.lock().push(Box::new(move || stop.cancel()));
    lifecycle::sweep(ctx)
}

pub async fn close(ctx: &Ctx) {
    let disposers = std::mem::take(&mut *ctx.engine.disposers.lock());
    for dispose in disposers {
        dispose();
    }
    for (_, batch) in ctx.engine.notice_batches.lock().drain() {
        batch.timer.abort();
    }
    for runtime in ctx.engine.runtimes.lock().values() {
        if let Some(provisioning) = &runtime.provisioning {
            provisioning.abort.cancel();
        }
    }
    for abort in ctx.engine.tool_calls.lock().values() {
        abort.cancel();
    }
    let waiters: Vec<_> = ctx.engine.input_waiters.lock().drain().collect();
    for (_, waiter) in waiters {
        (waiter.dispose)();
        let cancelled = InputResult::Cancelled { reason: "server-restarted".to_owned() };
        let _ = waiter.resolve.send(cancelled);
    }
    let _ = tokio::time::timeout(Duration::from_millis(CLOSE_GRACE_MS), settled(ctx)).await;
}

/// Resolves once no thread has queued work and no background work is pending.
pub async fn settled(ctx: &Ctx) {
    loop {
        ctx.engine.serial.idle().await;
        let mut pending = ctx.engine.pending.subscribe();
        if *pending.borrow_and_update() == 0 {
            return;
        }
        let _ = pending.wait_for(|count| *count == 0).await;
    }
}

#[cfg(test)]
mod tests;
