//! Creates, prepares, retires and removes the directories threads run in.
//! The port of `apps/server/src/environments/manager.ts`.
//!
//! The signatures below are the seam the rest of the server calls; the
//! bodies are filled in by the environments port.

use super::types::{EnsureEnvironmentArgs, ThreadEnvironment};
use crate::context::Ctx;
use crate::db::projects::DeletedProject;
use crate::error::ApiResult;

/// The manager's in-memory state (per-environment queue, what is being retired).
#[derive(Default)]
pub struct EnvironmentsState {}

/// Starts the retirement sweep; the returned guard stops it when dropped.
pub fn start(_ctx: &Ctx) -> tokio_util::sync::DropGuard {
    todo!("environments port")
}

pub async fn ensure_for_thread(
    _ctx: &Ctx,
    _job: EnsureEnvironmentArgs,
) -> ApiResult<ThreadEnvironment> {
    todo!("environments port")
}

pub fn path_for(_ctx: &Ctx, _environment_id: &str) -> ApiResult<Option<String>> {
    todo!("environments port")
}

/// The trimmed workspace instructions file of an environment, when it has one.
pub async fn workspace_instructions(_ctx: &Ctx, _environment_id: &str) -> Option<String> {
    todo!("environments port")
}

pub fn on_thread_detached(_ctx: &Ctx, _thread_id: &str) {
    todo!("environments port")
}

/// Tears an environment down now and deletes its row when no thread references it.
pub async fn remove(_ctx: &Ctx, _environment_id: &str) -> ApiResult<()> {
    todo!("environments port")
}

pub async fn sweep(_ctx: &Ctx) -> ApiResult<()> {
    todo!("environments port")
}

pub async fn remove_project_workspaces(_ctx: &Ctx, _deleted: &DeletedProject) {
    todo!("environments port")
}
