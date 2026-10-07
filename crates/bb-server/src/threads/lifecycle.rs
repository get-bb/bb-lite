//! Stop, archive, delete, context reset and host reconciliation. Skeleton of
//! `apps/server/src/threads/lifecycle.ts`.

use crate::context::Ctx;
use crate::db::projects::DeletedProject;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;

pub async fn stop_thread(_ctx: &Ctx, _thread_id: &str) -> ApiResult<()> {
    todo!("lifecycle port")
}

/// Returns the ids of the threads it archived.
pub async fn archive_thread_tree(_ctx: &Ctx, _thread_id: &str) -> ApiResult<Vec<String>> {
    todo!("lifecycle port")
}

pub fn unarchive_thread(_ctx: &Ctx, _thread_id: &str) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub async fn delete_thread_tree(
    _ctx: &Ctx,
    _thread_id: &str,
    _child_threads_confirmed: bool,
) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub fn release_deleted_project(_ctx: &Ctx, _deleted: &DeletedProject) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub async fn clear_context(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let thread = crate::threads::engine::require_thread(ctx, thread_id)?;
    reset_context(ctx, &thread).await
}

pub async fn reset_context(_ctx: &Ctx, _thread: &ThreadRow) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub async fn reconcile_host(_ctx: &Ctx, _host_id: &str) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub fn on_host_disconnected(_ctx: &Ctx, _host_id: &str) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub fn recover_after_restart(_ctx: &Ctx) -> ApiResult<()> {
    todo!("lifecycle port")
}

pub fn sweep(_ctx: &Ctx) -> ApiResult<()> {
    todo!("lifecycle port")
}
