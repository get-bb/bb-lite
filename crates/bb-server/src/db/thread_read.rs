//! Stub added by the engine skeleton; replaced by the port of `db/thread-read.ts`.

use super::{Db, DbResult};

pub type ThreadListRow = serde_json::Map<String, serde_json::Value>;

pub fn find_thread_list_row(_db: &Db, _thread_id: &str) -> DbResult<Option<ThreadListRow>> {
    todo!("thread_read port")
}
