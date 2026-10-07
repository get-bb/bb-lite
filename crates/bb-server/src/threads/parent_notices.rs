//! Batched child-outcome notices to parent threads. Skeleton of
//! `apps/server/src/threads/parent-notices.ts`.

use serde_json::Value;

use crate::context::Ctx;
use crate::db::pending_interactions::PendingInteraction;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;

pub const NOTICE_BATCH_DELAY_MS: i64 = 2_000;

#[derive(Clone, Debug, PartialEq)]
pub struct ChildOutcome {
    /// `ThreadEventTurnStatus`.
    pub status: String,
    pub failure_context: Option<String>,
    /// `ChildThreadOutcome["interruption"]`.
    pub interruption: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutcomeItem {
    pub outcome: ChildOutcome,
    pub child: ThreadRow,
    pub output: Option<String>,
}

pub struct NoticeBatch {
    pub items: Vec<OutcomeItem>,
    pub due_at: i64,
    pub timer: tokio::task::AbortHandle,
}

pub fn flush_due_notices(_ctx: &Ctx, _now: i64) -> ApiResult<()> {
    todo!("parent_notices port")
}

pub fn queue_child_outcome(
    _ctx: &Ctx,
    _child: &ThreadRow,
    _outcome: ChildOutcome,
) -> ApiResult<()> {
    todo!("parent_notices port")
}

pub fn notify_parent_blocked(
    _ctx: &Ctx,
    _child: &ThreadRow,
    _interaction: &PendingInteraction,
) -> ApiResult<()> {
    todo!("parent_notices port")
}
