//! Events from a runner. Skeleton of `apps/server/src/threads/ingest.ts`.

use serde_json::Value;

use crate::context::Ctx;
use crate::error::ApiResult;

/// `events` are `RunnerThreadEvent`s.
pub fn ingest_thread_events(_ctx: &Ctx, _thread_id: &str, _events: &[Value]) -> ApiResult<()> {
    todo!("ingest port")
}
