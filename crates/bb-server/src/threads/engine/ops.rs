//! The public operations of `createThreadEngine` (`ctx.threads` in the
//! TypeScript). Serialized operations reserve their place in the thread's
//! queue when called and return a `'static` future.

use std::future::Future;

use serde_json::Value;

use super::{in_thread, require_thread, respond};
use crate::context::Ctx;
use crate::db::projects::DeletedProject;
use crate::db::threads as store;
use crate::domain::pending_interaction::PendingInteraction;
use crate::error::ApiResult;
use crate::plugins::api::InputResult;
use crate::threads::create::{self, CreateThreadRequest};
use crate::threads::dispatch;
use crate::threads::interactions::{self, PluginInputRequest};
use crate::threads::lifecycle;
use crate::threads::mutations::{
    self, CreateQueuedMessageRequest, ReorderPinnedThreadRequest, SendMessageRequest,
    SendMessageResponse, SendQueuedMessageMode, UpdateQueuedMessageRequest, UpdateThreadRequest,
};
use crate::threads::session_spec::SessionEnvironment;
use crate::threads::thread_display::{ThreadListEntry, ThreadResponse};

fn serialized<T, F, Fut>(
    ctx: &Ctx,
    thread_id: &str,
    run: F,
) -> impl Future<Output = ApiResult<T>> + Send + 'static
where
    F: FnOnce(Ctx, String) -> Fut + Send + 'static,
    Fut: Future<Output = ApiResult<T>> + Send + 'static,
    T: Send + 'static,
{
    let (task_ctx, id) = (ctx.clone(), thread_id.to_owned());
    in_thread(ctx, thread_id, async move { run(task_ctx, id).await })
}

pub fn sweep(ctx: &Ctx) -> ApiResult<()> {
    lifecycle::sweep(ctx)
}

pub async fn create(ctx: &Ctx, request: CreateThreadRequest) -> ApiResult<ThreadResponse> {
    create::create_thread(ctx, request).await
}

pub fn get(ctx: &Ctx, thread_id: &str) -> ApiResult<Option<ThreadResponse>> {
    let thread = store::get_thread(&ctx.db, thread_id)?;
    if thread.is_none_or(|thread| thread.deleted_at.is_some()) {
        return Ok(None);
    }
    respond(ctx, thread_id).map(Some)
}

pub fn workspace_of(ctx: &Ctx, thread_id: &str) -> ApiResult<SessionEnvironment> {
    dispatch::session_environment_of(ctx, &require_thread(ctx, thread_id)?)
}

pub fn send(
    ctx: &Ctx,
    thread_id: &str,
    request: SendMessageRequest,
) -> impl Future<Output = ApiResult<SendMessageResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::send(&ctx, &id, request).await })
}

pub async fn stop(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    lifecycle::stop_thread(ctx, thread_id).await
}

pub async fn compact(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    mutations::compact(ctx, thread_id).await
}

pub fn clear_context(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<()>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { lifecycle::clear_context(&ctx, &id).await })
}

pub async fn archive(ctx: &Ctx, thread_id: &str) -> ApiResult<Vec<String>> {
    lifecycle::archive_thread_tree(ctx, thread_id).await
}

pub fn unarchive(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<()>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { lifecycle::unarchive_thread(&ctx, &id) })
}

pub async fn delete(ctx: &Ctx, thread_id: &str, child_threads_confirmed: bool) -> ApiResult<()> {
    lifecycle::delete_thread_tree(ctx, thread_id, child_threads_confirmed).await
}

pub fn release_deleted_project(ctx: &Ctx, deleted: &DeletedProject) -> ApiResult<()> {
    lifecycle::release_deleted_project(ctx, deleted)
}

pub fn update(
    ctx: &Ctx,
    thread_id: &str,
    patch: UpdateThreadRequest,
) -> impl Future<Output = ApiResult<ThreadResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::update(&ctx, &id, patch) })
}

pub fn pin(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<ThreadResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::pin(&ctx, &id) })
}

pub fn unpin(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<ThreadResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::unpin(&ctx, &id) })
}

pub fn reorder_pinned(
    ctx: &Ctx,
    thread_id: &str,
    request: ReorderPinnedThreadRequest,
) -> ApiResult<Vec<ThreadListEntry>> {
    mutations::reorder_pinned(ctx, thread_id, request)
}

pub fn mark_read(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<ThreadResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::mark_read(&ctx, &id) })
}

pub fn mark_unread(
    ctx: &Ctx,
    thread_id: &str,
) -> impl Future<Output = ApiResult<ThreadResponse>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move { mutations::mark_unread(&ctx, &id) })
}

/// Resolves to the `ThreadQueuedMessage`.
pub fn create_queued_message(
    ctx: &Ctx,
    thread_id: &str,
    request: CreateQueuedMessageRequest,
) -> impl Future<Output = ApiResult<Value>> + Send + 'static {
    serialized(ctx, thread_id, |ctx, id| async move {
        mutations::create_queued_message(&ctx, &id, request)
    })
}

/// Resolves to the `ThreadQueuedMessage`.
pub fn update_queued_message(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
    request: UpdateQueuedMessageRequest,
) -> impl Future<Output = ApiResult<Value>> + Send + 'static {
    let queued = queued_message_id.to_owned();
    serialized(ctx, thread_id, |ctx, id| async move {
        mutations::update_queued_message(&ctx, &id, &queued, request)
    })
}

pub fn delete_queued_message(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
) -> impl Future<Output = ApiResult<()>> + Send + 'static {
    let queued = queued_message_id.to_owned();
    serialized(ctx, thread_id, |ctx, id| async move {
        mutations::delete_queued_message(&ctx, &id, &queued)
    })
}

pub fn send_queued_message_now(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
    mode: SendQueuedMessageMode,
) -> impl Future<Output = ApiResult<SendMessageResponse>> + Send + 'static {
    let queued = queued_message_id.to_owned();
    serialized(ctx, thread_id, move |ctx, id| async move {
        mutations::send_queued_message_now(&ctx, &id, &queued, mode).await
    })
}

/// `resolution` is a `PendingInteractionResolution`.
pub fn resolve_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    resolution: Value,
) -> impl Future<Output = ApiResult<PendingInteraction>> + Send + 'static {
    let interaction = interaction_id.to_owned();
    serialized(ctx, thread_id, |ctx, id| async move {
        interactions::resolve_provider_interaction(&ctx, &id, &interaction, resolution)
    })
}

pub fn respond_to_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
    value: Value,
) -> impl Future<Output = ApiResult<PendingInteraction>> + Send + 'static {
    let interaction = interaction_id.to_owned();
    serialized(ctx, thread_id, |ctx, id| async move {
        interactions::respond_to_interaction(&ctx, &id, &interaction, value)
    })
}

pub fn cancel_interaction(
    ctx: &Ctx,
    thread_id: &str,
    interaction_id: &str,
) -> impl Future<Output = ApiResult<PendingInteraction>> + Send + 'static {
    let interaction = interaction_id.to_owned();
    serialized(ctx, thread_id, |ctx, id| async move {
        interactions::cancel_by_user(&ctx, &id, &interaction)
    })
}

pub async fn request_input(ctx: &Ctx, request: PluginInputRequest) -> ApiResult<InputResult> {
    interactions::request_input(ctx, request).await
}
