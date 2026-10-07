//! Stub added by the engine skeleton; replaced by the port of `db/queued-messages.ts`.

use super::{Db, DbResult};

pub type QueuedMessageRow = serde_json::Map<String, serde_json::Value>;
/// `QueuedMessageWaitingOn` of `@bb/domain` (`{kind, ...}`).
pub type QueuedMessageWaitingOn = serde_json::Value;

pub fn list_queued_messages(_db: &Db, _thread_id: &str) -> DbResult<Vec<QueuedMessageRow>> {
    todo!("queued_messages port")
}

pub fn parse_queued_wait(_row: &QueuedMessageRow) -> Option<QueuedMessageWaitingOn> {
    todo!("queued_messages port")
}

pub fn set_queued_message_wait(
    _db: &Db,
    _rows: &[QueuedMessageRow],
    _wait: Option<&QueuedMessageWaitingOn>,
) -> DbResult<()> {
    todo!("queued_messages port")
}
