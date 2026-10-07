//! Workspace preparation before the first turn. Skeleton of
//! `apps/server/src/threads/provisioning.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::Outbox;
use super::dispatch::DispatchArgs;
use crate::context::Ctx;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;

/// `startupContextSchema`, stored as JSON in `threads.startup_context`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupContext {
    /// `EnvironmentIntent`.
    pub intent: Value,
    pub title_provided: bool,
}

/// `input` is `PromptInput[]`.
pub fn derive_title_fallback(_input: &[Value]) -> Option<String> {
    todo!("provisioning port")
}

pub fn begin_provisioning(_ctx: &Ctx, _thread: &ThreadRow, _args: DispatchArgs) -> ApiResult<()> {
    todo!("provisioning port")
}

pub fn cancel_provisioning(_ctx: &Ctx, _out: &Outbox, _thread: &ThreadRow) -> ApiResult<()> {
    todo!("provisioning port")
}
