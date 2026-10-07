//! Stub added by the engine skeleton; replaced by the port of `threads/thread-display.ts`.

use crate::context::Ctx;
use crate::db::thread_read::ThreadListRow;
use crate::error::ApiResult;

/// `ThreadResponse` of `@bb/server-contract`.
pub type ThreadResponse = serde_json::Value;
/// `ThreadListEntry` of `@bb/server-contract`.
pub type ThreadListEntry = serde_json::Value;

pub fn to_thread_list_entries(
    _ctx: &Ctx,
    _rows: Vec<ThreadListRow>,
) -> ApiResult<Vec<ThreadListEntry>> {
    todo!("thread_display port")
}

pub fn to_thread_response(_ctx: &Ctx, _row: ThreadListRow) -> ApiResult<ThreadResponse> {
    todo!("thread_display port")
}
